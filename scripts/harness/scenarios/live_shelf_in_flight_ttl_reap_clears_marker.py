"""Scenario: TTL reaper emits BOTH consumed + in_flight_return.

EMIT→HANDLE matrix hole (found 2026-04-27)
------------------------------------------
When the in-flight TTL expires on the Pi (lot picked up but never
returned within ``in_flight_ttl_seconds``), the reaper flips the Pi
lot status to ``out`` + writes a local ``in_flight_ttl_expired``
resolution. Before the fix, the cloud emit was a single
``event_kind='consumed'`` via :meth:`CloudEventEmitter.emit_in_flight_reap`.

The consumed branch in ``private.apply_shelf_event`` decrements
``qty_containers`` but never touches ``stock_lots.in_flight_since``.
A TTL-reaped lot would therefore be forever stuck in-flight on
/chef/inventory even though qty went to 0.

Fix: reap path now emits TWO events — ``consumed`` then
``in_flight_return`` — so the cloud's marker tracks Pi reality.

Walk-through
------------
1. Seed cloud user + device + product + one stock_lot qty=1 with
   ``in_flight_since`` set (old timestamp — already past the TTL we'll
   configure).
2. Mirror into Pi SQLite as ``status='in_flight'`` with the same
   timestamps so the reaper's SQL (`in_flight_since + ttl < now`)
   matches.
3. Invoke ``ScaleHandler._reap_expired_in_flight`` directly with a
   short TTL so the lot immediately qualifies.
4. Drain outbox.
5. Assert:
     * Cloud lot qty_containers == 0 (consumed event landed).
     * Cloud lot in_flight_since IS NULL (in_flight_return landed).
     * Exactly two shelf_event_log rows (consumed, in_flight_return).
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


@scenario("live_shelf_in_flight_ttl_reap_clears_marker")
def _live_shelf_in_flight_ttl_reap_clears_marker(ctx: HarnessContext) -> None:
    from server.storage import repo as storage_repo

    # 1. Seed cloud state — lot already in-flight, pickup an hour ago.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="TTL reap test",
        net_weight_g=net_weight_g,
    )
    in_flight_since = _now_iso(offset_s=-3600)
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,
        in_flight_since=in_flight_since,
    )

    # 2. Mirror into Pi SQLite — lot in_flight, pickup an hour ago.
    pickup_weight_g = 500.0
    pi_conn = ctx.pi_sqlite
    remove_event_id = "rm-ttl-" + cloud_lot_id[:8]
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cloud_product_id, "HRN-TTL", "TTL reap test",
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
            (cloud_lot_id, cloud_product_id, pickup_weight_g,
             in_flight_since, pickup_weight_g, remove_event_id,
             in_flight_since),
        )

    # 3. Invoke the reaper directly with TTL=1s so the 1-hour-old lot
    # qualifies on this tick. ScaleHandler._reap_expired_in_flight
    # scans lots WHERE status='in_flight' AND in_flight_since + ttl <
    # now. With ttl=1s, our in_flight_since=-3600s is comfortably past.
    # Patch the instance attribute — the constructor default is 14_400s
    # which would leave our 1-hour-old lot still fresh.
    handler = ctx.build_pi_scale_handler()
    handler._in_flight_ttl_seconds = 1
    reaped = handler._reap_expired_in_flight()
    ctx.check(
        "reaper_flipped_one_lot",
        reaped == 1,
        evidence=(
            f"expected exactly 1 lot reaped (ttl=1s, in_flight_since=1h ago); "
            f"got reaped={reaped}. If 0, the reaper's SQL didn't match — "
            f"usually a timezone / column-name drift."
        ),
    )

    pi_lot_after = storage_repo.get_lot(pi_conn, cloud_lot_id)
    ctx.check(
        "pi_lot_status_out",
        pi_lot_after is not None and pi_lot_after.status == "out",
        evidence=(
            f"pi lot after reap must be status='out'; got "
            f"{getattr(pi_lot_after, 'status', None)!r}"
        ),
    )

    # 4. Outbox must hold TWO rows: consumed + in_flight_return.
    pending = pi_conn.execute(
        "SELECT json_extract(payload_json, '$.event_kind') "
        "  FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0 "
        " ORDER BY outbox_id ASC"
    ).fetchall()
    pending_kinds = [r[0] for r in pending]
    ctx.check(
        "outbox_has_both_reap_events",
        pending_kinds == ["consumed", "in_flight_return"],
        evidence=(
            f"TTL reap must emit both consumed + in_flight_return. "
            f"Got outbox={pending_kinds!r}. If only 'consumed' appears, "
            f"stock_lots.in_flight_since would stay set forever on the "
            f"cloud side — lot stuck in-flight in the UI."
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

    # 5. Cloud state.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "cloud_qty_zeroed",
        after is not None and float(after[0] or 0) == 0.0,
        evidence=(
            f"consumed event for full pickup mass ({pickup_weight_g}g / "
            f"{net_weight_g}g = 1 container) should zero qty. Got lot={after!r}"
        ),
    )
    ctx.check(
        "cloud_in_flight_since_cleared",
        after is not None and after[1] is None,
        evidence=(
            f"in_flight_since must be NULL after TTL reap. If not, the "
            f"in_flight_return companion emit is missing from the reaper "
            f"path — same EMIT→HANDLE hole as the same-item return. "
            f"Got lot={after!r}"
        ),
    )

    log_kinds = [
        r[0] for r in ctx.q_all(
            "SELECT payload->>'event_kind' "
            "  FROM chefbyte.shelf_event_log "
            " WHERE user_id = %s "
            " ORDER BY created_at ASC",
            (ctx.user_id,),
        )
    ]
    ctx.check(
        "exactly_two_log_rows_consumed_then_return",
        log_kinds == ["consumed", "in_flight_return"],
        evidence=f"log_kinds={log_kinds!r}",
    )
