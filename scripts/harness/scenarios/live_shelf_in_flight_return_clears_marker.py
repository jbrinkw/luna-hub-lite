"""Scenario: fast-path in-flight return emits BOTH consumed + in_flight_return.

EMIT→HANDLE matrix hole (found 2026-04-27)
------------------------------------------
Before the fix, the Pi's return branch in
``handlers/scale_events.py::_apply_in_flight_branch`` emitted ONLY an
``event_kind='consumed'`` cloud event when the user put an in-flight
item back (same container, possibly lighter). The cloud's consumed
branch in ``private.apply_shelf_event`` decrements ``qty_containers``
but NEVER touches ``stock_lots.in_flight_since``. Result: the lot
stayed stuck as in-flight in the cloud UI forever — the user would see
the Fridge item marked "in flight" even hours after they put it back.

Meanwhile ``event_kind='in_flight_return'`` was already defined in the
edge function's ``VALID_EVENT_KINDS`` and handled by the DB migration
``20260425080000_shelf_event_in_flight_pickup.sql`` — it clears the
marker on the matching lot without mutating qty. But no Pi producer
path emitted it. The ``live_shelf_reunite.py`` harness scenario
exercises the cloud handler with a hand-crafted ``_enqueue`` payload;
no integration/unit test pinned the Pi emit path.

Fix
---
``CloudEventEmitter.emit_in_flight_return_marker`` + call sites in
``_apply_in_flight_branch`` (same-item return) and the TTL reaper.
Topped-up returns don't need it because ``refilled`` already routes
through ``private.resolve_add_to_shelf_lot`` which clears the marker
on the ADD path.

Walk-through
------------
1. Seed cloud user + device + product + one stock_lot qty=1 (on shelf).
2. Mirror product + lot into Pi SQLite so classifier ids match.
3. Open a Pi session. Drive a REMOVE event through ``ScaleHandler``
   so the fast-path writes the ``in_flight_pickup`` resolution
   locally + (via the reconciler adapter in
   ``live_shelf_pickup_single_event``) to cloud. We don't need the
   cloud pickup side for this scenario — the point is the return. Seed
   the cloud lot as already-in-flight directly.
4. Drive an ADD event for the SAME lot through ``ScaleHandler``'s
   ``_apply_in_flight_branch`` (the return branch). This must:
     * Write an ``in_flight_return`` session_resolutions row locally.
     * Flip the Pi lot back to ``status='on_shelf'``.
     * Emit TWO cloud events: ``consumed`` (decrements qty) +
       ``in_flight_return`` (clears marker).
5. Drain the outbox.
6. Assert:
     * Cloud lot qty_containers decremented by consumption_g / net_g.
     * Cloud lot in_flight_since IS NULL.
     * Exactly two shelf_event_log rows for this scenario:
       one consumed, one in_flight_return.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@scenario("live_shelf_in_flight_return_clears_marker")
def _live_shelf_in_flight_return_clears_marker(ctx: HarnessContext) -> None:
    from server.storage import repo as storage_repo
    from server.storage.models import LotIn, ProductIn, ScaleEventIn

    # 1. Seed cloud state — lot already in-flight (simulates a prior
    # pickup that emitted in_flight_pickup).
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 750.0
    cloud_product_id = ctx.seed_product(
        name="Return-clears-marker test",
        net_weight_g=net_weight_g,
    )
    in_flight_since = _now_iso(offset_s=-60)
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,
        in_flight_since=in_flight_since,
    )
    baseline = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "baseline_in_flight_set",
        baseline is not None
        and float(baseline[0] or 0) == 1.0
        and baseline[1] is not None,
        evidence=f"baseline={baseline!r}",
    )

    # 2. Mirror into Pi SQLite. The Pi lot is marked in_flight with a
    # pickup_weight_g equal to the container's net weight — the return
    # branch will compute consumption_g = pickup - abs_delta.
    pickup_weight_g = 750.0
    pi_conn = ctx.pi_sqlite
    pickup_ts = _now_iso(offset_s=-60)
    remove_event_id = "remove-" + cloud_lot_id[:8]
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cloud_product_id, "HRN-RET", "Return-clears-marker test",
             net_weight_g, net_weight_g, "liquid", "bottle", 1),
        )
        pi_conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, current_weight_g,
                initial_weight_g, total_consumed_g, shelf_id,
                in_flight_since, pickup_weight_g, pickup_event_id
            ) VALUES (?, ?, 'in_flight', 0.0, ?, 0.0, 'live_shelf',
                      ?, ?, ?)
            """,
            (cloud_lot_id, cloud_product_id, pickup_weight_g,
             pickup_ts, pickup_weight_g, remove_event_id),
        )

    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-5), initial_weight_g=0.0,
    ).session_id

    # 3. Fire the RETURN (ADD) through ScaleHandler._apply_in_flight_branch.
    handler = ctx.build_pi_scale_handler()
    ts_add = _now_iso()
    # Return is lighter by 100g — user drank some, put it back.
    return_mass = 650.0
    abs_delta = return_mass  # fast-path uses abs(delta_g) for in-flight return

    add_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=ts_add, delta_g=return_mass,
            before_weight_g=0.0, after_weight_g=return_mass,
            direction="add", session_id=session_id,
            classifier_status="classified",
        ),
    )

    # Drive the internal method so we don't need to simulate the whole
    # classifier + brightness pipeline for one assertion.
    from server.storage.repo import get_lot as _get_lot
    pi_lot = _get_lot(pi_conn, cloud_lot_id)
    assert pi_lot is not None
    handled = handler._apply_add_against_in_flight_lot(
        lot=pi_lot,
        delta_g=abs_delta,
        event_ts=ts_add,
        event_id=add_event.event_id,
        session_id=session_id,
        action="placed",
    )
    ctx.check(
        "return_branch_fired",
        handled is True,
        evidence=(
            f"expected _apply_add_against_in_flight_lot to return True "
            f"for a same-item return; got {handled!r}. If False, branch "
            f"short-circuited — check pickup_weight_g + new_item_weight_ratio."
        ),
    )

    # Pi lot state: status flipped back to on_shelf; in_flight cleared.
    lot_after = storage_repo.get_lot(pi_conn, cloud_lot_id)
    ctx.check(
        "pi_lot_back_on_shelf",
        lot_after is not None
        and lot_after.status == "on_shelf"
        and lot_after.in_flight_since is None,
        evidence=(
            f"expected pi lot status='on_shelf' + in_flight_since=None; "
            f"got status={getattr(lot_after, 'status', None)!r} "
            f"in_flight_since={getattr(lot_after, 'in_flight_since', None)!r}"
        ),
    )

    # 4. Outbox should contain TWO pending events: consumed + in_flight_return.
    pending = pi_conn.execute(
        "SELECT json_extract(payload_json, '$.event_kind') "
        "  FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0 "
        " ORDER BY outbox_id ASC"
    ).fetchall()
    pending_kinds = [r[0] for r in pending]
    ctx.check(
        "outbox_has_both_events_before_drain",
        pending_kinds == ["consumed", "in_flight_return"],
        evidence=(
            f"expected outbox to hold [consumed, in_flight_return] in that "
            f"order — the consumed emit goes first (qty decrement), then "
            f"the marker-clear. Got {pending_kinds!r}. If only 'consumed' "
            f"appears, the EMIT→HANDLE hole is reopen: stock_lots."
            f"in_flight_since would never get cleared on cloud."
        ),
    )

    # 5. Drain.
    ctx.pi_worker.tick()
    pending_after = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "outbox_drained",
        pending_after == 0,
        evidence=f"pending_after_drain={pending_after}",
    )

    # 6. Cloud-side assertions.
    after_lot = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "cloud_in_flight_since_cleared",
        after_lot is not None and after_lot[1] is None,
        evidence=(
            f"in_flight_since must be NULL after in_flight_return "
            f"event. If non-null, either the marker-clear emit never "
            f"fired, or apply_shelf_event's in_flight_return branch "
            f"silently no-op'd on a lot the Pi insists is in-flight. "
            f"Got lot={after_lot!r}"
        ),
    )

    # Qty decremented by consumption_g / net_g = 100 / 750 = 0.1333…
    expected_qty = 1.0 - (100.0 / net_weight_g)
    ctx.check(
        "cloud_qty_decremented_by_consumption",
        after_lot is not None
        and abs(float(after_lot[0] or 0) - expected_qty) < 0.01,
        evidence=(
            f"expected qty_containers ≈ {expected_qty:.3f} "
            f"(1 - consumption/{net_weight_g}); got {after_lot!r}"
        ),
    )

    # Exactly two cloud event log rows for this scenario.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind', applied "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at ASC",
        (ctx.user_id,),
    )
    log_kinds = [r[0] for r in log_rows]
    ctx.check(
        "exactly_two_cloud_events_consumed_then_return",
        log_kinds == ["consumed", "in_flight_return"],
        evidence=(
            f"expected cloud shelf_event_log to hold exactly two rows "
            f"(consumed → in_flight_return). Got {log_kinds!r}."
        ),
    )
    ctx.check(
        "both_cloud_events_applied",
        all(bool(r[1]) for r in log_rows),
        evidence=f"every shelf_event_log row must have applied=true; got {log_rows!r}",
    )
