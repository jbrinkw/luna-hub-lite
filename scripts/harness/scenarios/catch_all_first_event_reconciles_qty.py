"""Scenario: catch-all FIRST measurement reconciles qty without macros.

CATCH_ALL_SCALE_PLAN.md (2026-04-27 delta-capture model). When the user
places a tracked item on the catch-all (scale-02) for the first time:

  1. Pi classifier picks the lot from cloud_lots (Tier 1 in-flight or
     Tier 2 certified-not-on-shelf — this scenario uses Tier 2).
  2. Pi dispatch emits ``catch_all_first_measurement`` cloud event with
     this Pi event_id stamped as pi_event_id.
  3. Cloud apply path:
       * Stamps in_flight_since + in_flight_kind='catch_all' +
         pickup_weight_g + pickup_event_id on stock_lots.
       * Reconciles qty_containers = measured_g / net_weight_g.
       * Writes NO food_logs row.

Locks in the FIRST event branch from migration
20260427130000_catch_all_delta_apply.sql.
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


@scenario("catch_all_first_event_reconciles_qty")
def _scenario(ctx: HarnessContext) -> None:
    from server.handlers.scale_events import ScaleHandler  # noqa: E402
    from server.shelves import DEFAULT_REGISTRY  # noqa: E402
    import threading as _th

    # 1. Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="Catch-all FIRST test",
        net_weight_g=net_g,
        servings_per_container=5.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=0.5,
    )
    ctx.check(
        "cloud_seeded",
        True,
        evidence=f"product (net={net_g}g) + lot qty=0.5 (lot={cloud_lot_id[:8]})",
    )

    # 2. Mirror cloud_lots into Pi SQLite (the catch-all pool reads
    # from cloud_lots).
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                in_flight_kind, pickup_event_id, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
            """,
            (
                cloud_lot_id, cloud_product_id, 0.5,
                "2026-04-27T00:00:00Z", "2026-04-27T00:00:00Z",
            ),
        )

    handler = ScaleHandler(
        conn=pi_conn,
        db_lock=_th.RLock(),
        camera=None,
        candidate_source=type("S", (), {
            "get_on_shelf_lots": staticmethod(lambda shelf_id=None: []),
            "get_recently_out_lots": staticmethod(
                lambda window_seconds, shelf_id=None: []
            ),
            "get_in_flight_lots": staticmethod(
                lambda max_age_seconds=None, shelf_id=None: []
            ),
            "get_certified_not_on_shelf": staticmethod(lambda: []),
        })(),
        events_root=ctx.tmp_dir / "events",
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=dict(DEFAULT_REGISTRY),
        cloud_emitter=ctx.pi_emitter,
        cloud_client=ctx.pi_cloud_client,
    )
    ctx.track_scale_handler(handler)

    # 3. Invoke the dispatch directly with a synthesized classification
    # picking the cloud lot. Pi event_id will be stamped onto cloud
    # stock_lots.pickup_event_id.
    pi_event_id = "11111111-1111-1111-1111-111111111101"
    measured_g = 350.0  # → 350/500 = 0.700 containers
    handled = handler._dispatch_catch_all_add(
        classification={"item_id": cloud_lot_id},
        delta_g=measured_g,
        event_ts=_now_iso(),
        event_id=pi_event_id,
        session_id=None,
    )
    ctx.check(
        "dispatch_returned_true",
        handled is True,
        evidence=f"_dispatch_catch_all_add returned {handled!r}",
    )

    # 4. Drain outbox.
    ctx.pi_worker.tick()
    pending = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check("outbox_drained", pending == 0, evidence=f"pending={pending}")

    # 5. Cloud assertions: qty reconciled, in_flight_kind stamped, NO food_logs.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_kind, "
        "       pickup_weight_g::text, pickup_event_id::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "qty_reconciled_to_measured",
        after is not None and float(after[0] or 0) == 0.700,
        evidence=(
            f"first event must reconcile qty := measured_g/net_g = "
            f"350/500 = 0.700; got lot row={after!r}"
        ),
    )
    ctx.check(
        "in_flight_kind_catch_all",
        after is not None and after[1] == "catch_all",
        evidence=f"first event must stamp in_flight_kind='catch_all'; got {after!r}",
    )
    ctx.check(
        "pickup_weight_stamped",
        after is not None and float(after[2] or 0) == 350.0,
        evidence=f"first event must stamp pickup_weight_g=350; got {after!r}",
    )
    ctx.check(
        "pickup_event_id_stamped",
        after is not None and after[3] == pi_event_id,
        evidence=(
            f"first event must stamp pickup_event_id = Pi event_id "
            f"({pi_event_id!r}); got {after!r}"
        ),
    )

    food_log_count = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.food_logs WHERE user_id = %s",
        (ctx.user_id,),
    )[0]
    ctx.check(
        "no_food_logs_first_event",
        food_log_count == 0,
        evidence=(
            f"first event MUST NOT write food_logs (reconciliation, "
            f"not consumption); got {food_log_count} row(s)"
        ),
    )

    # 6. shelf_event_log: one applied catch_all_first_measurement row.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind', applied, reason "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at ASC",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_records_first_measurement",
        (
            len(log_rows) == 1
            and log_rows[0][0] == "catch_all_first_measurement"
            and log_rows[0][1] is True
            and log_rows[0][2] == "catch_all_first_measurement"
        ),
        evidence=(
            f"shelf_event_log must record one applied "
            f"'catch_all_first_measurement' row; got {log_rows!r}"
        ),
    )
