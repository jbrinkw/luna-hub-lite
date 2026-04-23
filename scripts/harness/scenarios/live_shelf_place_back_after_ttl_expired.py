"""Scenario: item placed back after a TTL-expired in-flight revives the lot.

Context (2026-04-27 fix)
------------------------
Complementary to ``live_shelf_in_flight_ttl_reap_removes_whole_lot``:

  1. Earlier, the TTL reaper removed the whole lot on cloud (qty=0,
     in_flight_since=NULL, pickup_event_id=NULL).
  2. User comes back and places the (same) container on the shelf.
  3. Pi: classifier matches the recently_out lot. Pi emits a
     ``new_arrival`` cloud event inline via the hot-path out→on_shelf
     branch (new in 2026-04-27).
  4. Cloud: ``apply_shelf_event`` consumes the ``added`` event. The
     ``resolve_add_to_shelf_lot`` resolver walks:
        step 1: no in-flight lot (pickup was cleared earlier)
        step 2: no qty>0 live_shelf lot
        step 3: no weight-matching pantry lot
        step 4: empty-lot reuse — finds the qty=0 lot we just reaped
                and flips it back to qty=N.

Net effect: the cloud lot is revived in place (no mint, no orphan qty).
This scenario walks the full end-to-end.

Walk-through
------------
1. Seed cloud state as IF the TTL reap just ran — stock_lot
   ``qty_containers=0``, ``in_flight_since=NULL``, ``last_update_source
   = 'live_shelf'``.
2. Mirror into Pi SQLite as ``status='out'`` with ``last_out_at``
   recent.
3. Build handler, record an ADD scale_event.
4. Invoke the classifier-apply path directly with a ``recently_out``
   classification pointing at the out-status lot.
5. Drain the outbox.
6. Assert:
     * Exactly one stock_lots row for the product (no mint).
     * qty_containers revived to ~1.0 (1 container worth of weight).
     * in_flight_since IS NULL (never set during this flow).
     * shelf_event_log reason == 'revived_empty_lot' on the added event.
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


@scenario("live_shelf_place_back_after_ttl_expired")
def _live_shelf_place_back_after_ttl_expired(ctx: HarnessContext) -> None:
    from server.storage import repo as storage_repo
    from server.storage.models import ScaleEventIn

    # 1. Seed cloud state (post-TTL-reap).
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="Place-back revive test",
        net_weight_g=net_weight_g,
    )
    # Empty lot — this is the shape the cloud ends up in after the
    # whole-lot-removal consumed event landed. No in-flight markers.
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=0.0,
        in_flight_since=None,
        pickup_event_id=None,
    )
    # Stamp last_update_source so resolve_add_to_shelf_lot's step-4
    # picks this row as the empty-lot candidate for a live_shelf add.
    # (seed_stock_lot leaves it NULL by default.)
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.stock_lots "
            "   SET last_update_source = 'live_shelf', "
            "       last_update_ts = now() - interval '1 hour' "
            " WHERE lot_id = %s",
            (cloud_lot_id,),
        )

    # 2. Mirror into Pi — status='out' as if the TTL reaper just ran.
    # Use raw SQL to pin the product_id + lot_id to the cloud values
    # (ProductIn / LotIn don't accept pk params; ``create_product`` /
    # ``create_lot`` mint fresh UUIDs).
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cloud_product_id, "HRN-PBK", "Place-back test",
             net_weight_g, net_weight_g, "solid", "jar", 1),
        )
        pi_conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, current_weight_g,
                initial_weight_g, total_consumed_g, shelf_id,
                last_out_at
            ) VALUES (?, ?, 'out', 0.0, ?, ?, 'live_shelf', ?)
            """,
            (cloud_lot_id, cloud_product_id, net_weight_g, net_weight_g,
             _now_iso(offset_s=-300)),
        )
    lot = storage_repo.get_lot(pi_conn, cloud_lot_id)
    assert lot is not None and lot.status == "out"

    # 3. Build handler + record an ADD event (user placed the bottle
    # back on the shelf).
    handler = ctx.build_pi_scale_handler()
    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-10), initial_weight_g=0.0,
    ).session_id
    add_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=_now_iso(),
            delta_g=net_weight_g,  # full bottle back on shelf
            before_weight_g=0.0,
            after_weight_g=net_weight_g,
            direction="add",
            session_id=session_id,
            classifier_status="pending",
        ),
    )

    # 4. Run the classifier-apply path. A real classifier would have
    # produced this classification from a recently_out candidate after
    # seeing the bottle's label. We feed it directly since the scenario
    # focuses on the apply-path fix, not the classifier.
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts=_now_iso(),
        delta_g=net_weight_g,
        session_id=session_id,
        event_id=add_event.event_id,
    )

    pi_lot_after = storage_repo.get_lot(pi_conn, lot.lot_id)
    ctx.check(
        "pi_lot_back_to_on_shelf",
        pi_lot_after is not None and pi_lot_after.status == "on_shelf",
        evidence=(
            f"pi lot status after place-back should be 'on_shelf'; got "
            f"{getattr(pi_lot_after, 'status', None)!r}"
        ),
    )

    # new_arrival resolution was written inline (not waiting for
    # session-close reconciler).
    resolutions = pi_conn.execute(
        "SELECT pattern, lot_id FROM session_resolutions "
        " WHERE session_id = ? ORDER BY created_at",
        (session_id,),
    ).fetchall()
    patterns = [r[0] for r in resolutions]
    ctx.check(
        "pi_wrote_new_arrival_inline",
        "new_arrival" in patterns,
        evidence=(
            f"hot-path out→on_shelf must write a new_arrival session "
            f"resolution so the reconciler skips re-resolving at close. "
            f"Got patterns={patterns!r}"
        ),
    )

    # 5. Drain the outbox. Should have exactly one pending event (the
    # new_arrival / added cloud emit).
    pending_kinds_before_drain = [
        r[0] for r in pi_conn.execute(
            "SELECT json_extract(payload_json, '$.event_kind') "
            "  FROM cloud_outbox "
            " WHERE sent_at IS NULL AND failed_permanently = 0 "
            " ORDER BY outbox_id ASC"
        ).fetchall()
    ]
    ctx.check(
        "outbox_has_single_added_event",
        pending_kinds_before_drain == ["added"],
        evidence=(
            f"out→on_shelf revive should emit exactly one 'added' event; "
            f"got pending_kinds={pending_kinds_before_drain!r}"
        ),
    )

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

    # 6. Cloud state — lot revived in place, no mint.
    lots = ctx.q_all(
        "SELECT lot_id::text, qty_containers::text, in_flight_since::text, "
        "       pickup_event_id::text "
        "  FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "cloud_still_one_lot_no_mint",
        len(lots) == 1,
        evidence=(
            f"resolve_add_to_shelf_lot's step-4 empty-lot-reuse must revive "
            f"the existing qty=0 row instead of minting a new one. "
            f"Got {len(lots)} lots: {lots!r}"
        ),
    )
    if lots:
        only = lots[0]
        ctx.check(
            "cloud_qty_revived_to_one_container",
            float(only[1] or 0) == 1.0,
            evidence=(
                f"Place-back of a full bottle (500g / net_weight_g=500g) "
                f"should revive qty to 1.0 containers. Got {only!r}"
            ),
        )
        ctx.check(
            "cloud_in_flight_since_still_null",
            only[2] is None,
            evidence=(
                f"Place-back flow never sets in_flight_since; got {only!r}"
            ),
        )
        ctx.check(
            "cloud_pickup_event_id_still_null",
            only[3] is None,
            evidence=f"pickup_event_id should stay NULL; got {only!r}",
        )

    # Shelf_event_log confirms the empty-lot-reuse branch ran.
    reason = ctx.q_one(
        "SELECT reason FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        "   AND payload->>'event_kind' = 'added' "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "added_event_took_empty_lot_reuse_branch",
        reason is not None and reason[0] == "revived_empty_lot",
        evidence=(
            f"added event should have reason='revived_empty_lot' — got "
            f"{reason!r}. If 'minted_on_shelf', the resolver went to "
            f"step-5 instead of reusing the empty lot."
        ),
    )
