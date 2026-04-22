"""Scenario: a single physical REMOVE emits exactly ONE cloud event.

Bug class
---------
2026-04-22 dual-emit: when a user picks up an in-flight-tracked bottle,
the Pi's fast-path writes an ``in_flight_pickup`` session_resolutions
row at REMOVE time AND the reconciler's Pass 2 later writes a
``consumed_or_removed`` row for the same unpaired REMOVE. Before the
fix, BOTH rows mirrored to cloud via the outbox — one for
``event_kind='in_flight_pickup'`` (stamps ``stock_lots.in_flight_since``)
and one for ``event_kind='consumed'`` (decrements
``stock_lots.qty_containers``). The user's bottle would drop to qty=0
in the UI between pickup and return.

Fix
---
``server/cloud/integration.py::should_suppress_cloud_emit_for_remove_event``
imposes a single-winner precedence across
``session_resolutions`` rows that share the same ``remove_event_id``:

    depleted > in_flight_pickup > consumed_or_removed

When both patterns exist, only the higher-precedence cloud event fires.
Local rows are preserved for Pi accounting. The precedence picks
``in_flight_pickup`` because a wrong in-flight is reversible (the
return reconciles it) but a wrong consumption decrement creates
phantom qty that is not.

Scenario walkthrough
--------------------
1. Seed cloud user + device + product + ONE stock_lot (qty=1, NOT
   in_flight). This is the "bottle on shelf" baseline.
2. Directly drive the Pi REMOVE path through the real ScaleHandler
   with a classification that identifies the lot — this exercises the
   fast-path write of ``in_flight_pickup``.
3. Directly write a ``consumed_or_removed`` row for the SAME
   ``remove_event_id`` to simulate the reconciler's Pass 2 emission.
   (We don't call the full reconciler because it needs session-close
   plumbing that's orthogonal to this regression.)
4. Call ``adapter.write_resolution`` for the ``consumed_or_removed``
   row via the adapter path — this is what the reconciler would do at
   session close. The dedup guard must suppress the cloud emit.
5. Drain the Pi outbox onto the cloud via ``pi_worker.tick()``.
6. Assert cloud-side:
   * ``chefbyte.shelf_event_log`` contains EXACTLY ONE row for this
     scenario, with ``event_kind='in_flight_pickup'``.
   * ``chefbyte.stock_lots.qty_containers`` did NOT decrement — the
     ``in_flight_pickup`` branch stamps ``in_flight_since`` without
     mutating qty, and the ``consumed_or_removed`` event was
     suppressed.
   * ``chefbyte.stock_lots.in_flight_since`` IS NOT NULL — the pickup
     marker landed.
"""

from __future__ import annotations

import datetime as _dt
import sys
import threading
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@scenario("live_shelf_pickup_single_event")
def _live_shelf_pickup_single_event(ctx: HarnessContext) -> None:
    # Lazy imports so harness bootstrap doesn't pay the cost when
    # running unrelated scenarios.
    from server.adapters.reconciler_repo import RepoReconcilerAdapter
    from server.reconciler.models import SessionResolution
    from server.storage import repo as storage_repo
    from server.storage.models import (
        LotIn,
        ProductIn,
        ScaleEventIn,
        SessionResolutionIn,
    )

    # 1. Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    cloud_product_id = ctx.seed_product(
        name="Single-event pickup (harness)",
        net_weight_g=750.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,
        in_flight_since=None,
    )
    ctx.check(
        "cloud_seed_ok",
        bool(cloud_lot_id),
        evidence=f"cloud_lot_id={cloud_lot_id}, product_id={cloud_product_id}",
    )

    baseline = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "baseline_lot_has_qty_no_in_flight",
        baseline is not None
        and float(baseline[0] or 0) == 1.0
        and baseline[1] is None,
        evidence=f"baseline={baseline!r}",
    )

    # 2. Mirror the same product + lot into the Pi SQLite so the
    # classifier's item_id resolves. This is normally populated by the
    # product-sync + lot-snapshot pollers; we insert directly (bypassing
    # ``storage_repo.create_product`` which always mints a fresh UUID)
    # so the Pi lot_id + product_id match the cloud rows — the cloud
    # event handler keys off those ids on the way through.
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cloud_product_id, "HRN-1", "Single-event pickup (harness)",
                750.0, 750.0, "liquid", "bottle", 1,
            ),
        )
        pi_conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, current_weight_g,
                initial_weight_g, total_consumed_g, shelf_id
            ) VALUES (?, ?, 'on_shelf', 750.0, 750.0, 0.0, 'live_shelf')
            """,
            (cloud_lot_id, cloud_product_id),
        )

    # Thin convenience shim so the rest of the scenario reads naturally.
    class _Ref:
        pass

    pi_product = _Ref()
    pi_product.product_id = cloud_product_id
    pi_lot = _Ref()
    pi_lot.lot_id = cloud_lot_id
    pi_lot.product_id = cloud_product_id
    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-60), initial_weight_g=750.0,
    ).session_id

    # 3. Fire the REMOVE through the real ScaleHandler — this writes
    # the in_flight_pickup session_resolution (fast-path, no cloud
    # emit at this moment).
    handler = ctx.build_pi_scale_handler()
    ts_remove = _now_iso()
    remove_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=ts_remove, delta_g=-750.0,
            before_weight_g=750.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
        ),
    )
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={
            "item_id": pi_lot.lot_id,
            "action": "removed",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": pi_lot.lot_id}],
        },
        event_ts=ts_remove,
        delta_g=-750.0,
        session_id=session_id,
        event_id=remove_event.event_id,
        shelf_id="live_shelf",
    )
    lot_after_remove = storage_repo.get_lot(pi_conn, pi_lot.lot_id)
    ctx.check(
        "fast_path_flipped_lot_to_in_flight",
        lot_after_remove is not None and lot_after_remove.status == "in_flight",
        evidence=(
            f"expected status='in_flight' after REMOVE; got "
            f"{getattr(lot_after_remove, 'status', None)!r}"
        ),
    )

    # 4. Simulate the reconciler's Pass 2 write for an UNPAIRED
    # in_flight_pickup — same remove_event_id, pattern=consumed_or_removed.
    # The adapter's write_resolution goes through the cloud emit path
    # where the single-winner guard must suppress the consumed emit.
    adapter = RepoReconcilerAdapter(
        pi_conn,
        db_lock=threading.RLock(),
        cloud_emitter=ctx.pi_emitter,
    )
    adapter.write_resolution(
        SessionResolution(
            session_id=session_id,
            pattern="consumed_or_removed",
            lot_id=pi_lot.lot_id,
            consumed_g=None,
            remove_event_id=remove_event.event_id,
            confidence=0.95,
        )
    )

    # Assert BOTH local resolution rows persist (Pi accounting intact).
    local_rows = pi_conn.execute(
        "SELECT pattern FROM session_resolutions "
        " WHERE remove_event_id = ? ORDER BY pattern",
        (remove_event.event_id,),
    ).fetchall()
    local_patterns = [r[0] for r in local_rows]
    ctx.check(
        "both_local_rows_persist",
        local_patterns == ["consumed_or_removed", "in_flight_pickup"],
        evidence=(
            f"expected both local resolutions, got {local_patterns!r}. "
            f"Pi accounting requires BOTH rows; only the cloud emit is "
            f"deduped."
        ),
    )

    # 5. Drain the outbox.
    #
    # NB: the fast-path REMOVE itself does NOT cloud-emit
    # ``in_flight_pickup`` — scale_events.py writes via
    # ``storage_repo.write_resolution`` directly (bypasses the adapter).
    # The in_flight_pickup only lands on the cloud via the backfill
    # scan at next boot. In this scenario we emit it manually through
    # the adapter to exercise the dedup winner lane: even when we
    # explicitly write the pickup after the suppressed consumed row,
    # only the in_flight_pickup reaches the outbox.
    adapter.write_resolution(
        SessionResolution(
            session_id=session_id,
            pattern="in_flight_pickup",
            lot_id=pi_lot.lot_id,
            remove_event_id=remove_event.event_id,
            confidence=0.95,
        )
    )
    ctx.pi_worker.tick()

    pending = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "pi_outbox_drained",
        pending == 0,
        evidence=f"pending_after_drain={pending}",
    )

    # 6. Cloud-side assertions.
    # 6a. Exactly ONE shelf_event_log row landed for this scenario —
    # the in_flight_pickup. The consumed_or_removed row was suppressed
    # before it ever hit the outbox. shelf_event_log keeps the cloud
    # event_kind inside the payload jsonb; extract it for the check.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind' "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at ASC",
        (ctx.user_id,),
    )
    event_kinds = [r[0] for r in log_rows]
    ctx.check(
        "exactly_one_cloud_event_and_it_is_in_flight_pickup",
        event_kinds == ["in_flight_pickup"],
        evidence=(
            f"expected exactly one shelf_event_log row with "
            f"event_kind='in_flight_pickup'; got {event_kinds!r}. "
            f"If 'consumed' appears, the consumed_or_removed emit leaked "
            f"through the dedup guard — the 2026-04-22 dual-emit bug is "
            f"reopen."
        ),
    )

    # 6b. stock_lots.qty_containers UNCHANGED — the in_flight_pickup
    # branch stamps in_flight_since WITHOUT decrementing qty, and the
    # consumed_or_removed was suppressed so no decrement fired.
    after_lot = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "qty_not_decremented",
        after_lot is not None
        and float(after_lot[0] or 0) == float(baseline[0] or 0),
        evidence=(
            f"qty_containers must be unchanged from baseline "
            f"{baseline[0]!r}; got {after_lot and after_lot[0]!r}. "
            f"A drop to 0 indicates the suppressed consumed_or_removed "
            f"leaked through."
        ),
    )

    # 6c. stock_lots.in_flight_since IS NOT NULL — the winner landed.
    ctx.check(
        "in_flight_since_stamped",
        after_lot is not None and after_lot[1] is not None,
        evidence=(
            f"in_flight_since must be set after the in_flight_pickup "
            f"event; got {after_lot!r}"
        ),
    )
