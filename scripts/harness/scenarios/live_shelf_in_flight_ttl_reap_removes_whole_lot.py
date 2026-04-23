"""Scenario: TTL reaper removes the WHOLE lot on cloud, not a fraction.

User directive (2026-04-27)
---------------------------
"It should have removed the whole lot when the TTL expired. The system
should allow for legal room, so if for some reason there's a mismatch
between the quantities, it should still remove the whole lot when an
item is removed, not just exactly its weight."

This scenario locks in the Option-B fix in migration
``20260427010000_in_flight_pickup_resolve_whole_lot.sql``. The Pi TTL
reaper still emits a ``consumed`` event with the measured pickup_weight_g,
but the cloud's ``apply_shelf_event`` consumed branch now detects that
``p_pi_event_id`` matches the lot's ``pickup_event_id`` and zeroes the
WHOLE lot — tolerant of weight-reading drift.

Walk-through
------------
1. Seed cloud user + device + product (net_weight_g=500) + one stock_lot
   ``qty_containers=1.000`` with ``in_flight_since`` + ``pickup_event_id``
   set (old timestamp — already past the TTL we'll configure).
2. Mirror into Pi SQLite as ``status='in_flight'`` with ``pickup_weight_g``
   set to 150g (SIMULATED DRIFT: 150g = 0.3 containers, NOT the full
   500g = 1.0 containers). This is the "weight-reading mismatch" case
   the user called out.
3. Invoke ``ScaleHandler._reap_expired_in_flight`` directly with TTL=1s
   so the lot immediately qualifies.
4. Drain the outbox.
5. Assert:
     * Cloud lot ``qty_containers == 0`` — the WHOLE lot removed,
       NOT ``1.000 - 0.3 = 0.7``. This is the whole-lot fix — without
       it, the cloud would still show 0.7 phantom containers.
     * Cloud lot ``in_flight_since IS NULL``.
     * Cloud lot ``pickup_event_id IS NULL``.
     * shelf_event_log reason == ``pickup_close_whole_lot`` for the
       consumed event, confirming the whole-lot branch ran.
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


@scenario("live_shelf_in_flight_ttl_reap_removes_whole_lot")
def _live_shelf_in_flight_ttl_reap_removes_whole_lot(ctx: HarnessContext) -> None:
    from server.storage import repo as storage_repo

    # 1. Seed cloud state — lot already in-flight, pickup an hour ago.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="Whole-lot TTL reap test",
        net_weight_g=net_weight_g,
    )
    in_flight_since = _now_iso(offset_s=-3600)
    # The pickup_event_id must be a UUID-shaped string so the cloud
    # parses it into v_pickup_event_id and matches against the lot's
    # pickup_event_id column.
    pickup_event_uuid = "22222222-2222-2222-2222-222222222222"
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,  # full container in flight
        in_flight_since=in_flight_since,
        pickup_event_id=pickup_event_uuid,
    )

    # 2. Mirror into Pi SQLite — lot in_flight with DRIFTED pickup weight.
    # The Pi's scale saw only 150g at pickup time (e.g. two brief
    # readings averaged during jostling). Without the whole-lot fix the
    # cloud's consumed branch would decrement 1.000 - 150/500 = 0.700
    # instead of going to 0.
    pickup_weight_g = 150.0  # DRIFT: 30% of the real 500g container
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cloud_product_id, "HRN-WHL", "Whole-lot TTL test",
             net_weight_g, net_weight_g, "solid", "jar", 1),
        )
        pi_conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, current_weight_g,
                initial_weight_g, total_consumed_g, shelf_id,
                in_flight_since, pickup_weight_g, pickup_event_id,
                last_seen_at
            ) VALUES (?, ?, 'in_flight', 0.0, ?, 0.0, 'live_shelf',
                      ?, ?, ?, ?)
            """,
            (cloud_lot_id, cloud_product_id, net_weight_g,
             in_flight_since, pickup_weight_g, pickup_event_uuid,
             in_flight_since),
        )

    # 3. Reap. TTL=1s so the 1h-old lot qualifies.
    handler = ctx.build_pi_scale_handler()
    handler._in_flight_ttl_seconds = 1
    reaped = handler._reap_expired_in_flight()
    ctx.check(
        "reaper_flipped_one_lot",
        reaped == 1,
        evidence=f"expected reaped=1; got {reaped}",
    )

    # 4. Drain the outbox.
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

    # 5. Cloud state — the WHOLE lot must be gone, not a fractional
    # decrement. This is the user's directive.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text, "
        "       pickup_event_id::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "cloud_qty_zero_whole_lot_removed",
        after is not None and float(after[0] or 0) == 0.0,
        evidence=(
            f"Whole-lot removal: consumed event with pickup_event_id match "
            f"must zero qty regardless of the fractional delta (here 150g / "
            f"500g = 0.3 containers). Got lot={after!r}. A value like 0.700 "
            f"means the fix isn't live — pickup_event_id match isn't kicking "
            f"the whole-lot branch."
        ),
    )
    ctx.check(
        "cloud_in_flight_since_cleared",
        after is not None and after[1] is None,
        evidence=f"in_flight_since must be NULL; got lot={after!r}",
    )
    ctx.check(
        "cloud_pickup_event_id_cleared",
        after is not None and after[2] is None,
        evidence=f"pickup_event_id must be NULL; got lot={after!r}",
    )

    # The consumed event's shelf_event_log reason confirms which branch
    # of apply_shelf_event ran.
    consumed_reason = ctx.q_one(
        "SELECT reason FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        "   AND payload->>'event_kind' = 'consumed' "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "consumed_event_took_whole_lot_branch",
        consumed_reason is not None
        and consumed_reason[0] == "pickup_close_whole_lot",
        evidence=(
            f"consumed event should have reason='pickup_close_whole_lot' — "
            f"got {consumed_reason!r}. If 'decremented' fired, the "
            f"pickup_event_id match didn't trigger (check the UUID shape)."
        ),
    )
