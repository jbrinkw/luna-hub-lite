"""Scenario: catch-all full delta-capture cycle logs macros for the delta.

Walk-through (CATCH_ALL_SCALE_PLAN.md 2026-04-27):
  1. Place full container on catch-all → FIRST event:
     qty reconciled, in_flight markers stamped, NO food_logs.
  2. Pick up, eat some, place back → SECOND event:
     qty updated to measured weight, markers cleared,
     food_logs row written for the consumed delta (pickup-second).

Locks in the second-measurement branch from migration
20260427130000_catch_all_delta_apply.sql plus the Pi runtime first/second
branching in scale_events._dispatch_catch_all_add.
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


@scenario("catch_all_full_session_logs_macros")
def _scenario(ctx: HarnessContext) -> None:
    from server.handlers.scale_events import ScaleHandler  # noqa: E402
    from server.shelves import DEFAULT_REGISTRY  # noqa: E402
    import threading as _th

    ctx.seed_cloud_user()
    ctx.seed_device()
    net_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="Catch-all delta-cycle test",
        net_weight_g=net_g,
        servings_per_container=5.0,
        # 200 cal/serving → 1 serving = 200 cal
        calories_per_serving=200.0,
        protein_per_serving=4.0,
        carbs_per_serving=24.0,
        fat_per_serving=12.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=0.5,
    )

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

    # FIRST event (350g placed).
    first_pi_event_id = "11111111-1111-1111-1111-111111111101"
    handler._dispatch_catch_all_add(
        classification={"item_id": cloud_lot_id},
        delta_g=350.0,
        event_ts=_now_iso(),
        event_id=first_pi_event_id,
        session_id=None,
    )
    ctx.pi_worker.tick()

    # Refresh Pi's cloud_lots mirror (the second event's dispatch
    # reads in_flight_kind from cloud_lots). Skip lot-snapshot poller —
    # write the post-first state directly so the SECOND event's lookup
    # finds in_flight_kind='catch_all' + pickup_event_id.
    with pi_conn:
        pi_conn.execute(
            """
            UPDATE cloud_lots
               SET in_flight_kind = 'catch_all',
                   pickup_event_id = ?,
                   in_flight_since = ?
             WHERE lot_id = ?
            """,
            (first_pi_event_id, _now_iso(-60.0), cloud_lot_id),
        )

    # SECOND event (250g placed back — 100g delta = 0.2 containers
    # = 1 serving = 200cal/24carbs/4protein/12fat).
    second_pi_event_id = "11111111-1111-1111-1111-111111111102"
    handler._dispatch_catch_all_add(
        classification={"item_id": cloud_lot_id},
        delta_g=250.0,
        event_ts=_now_iso(60.0),
        event_id=second_pi_event_id,
        session_id=None,
    )
    ctx.pi_worker.tick()

    # Cloud assertions.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_kind, "
        "       pickup_event_id::text, pickup_weight_g::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "qty_updated_to_second_measured",
        after is not None and float(after[0] or 0) == 0.500,
        evidence=(
            f"qty must be measured/net = 250/500 = 0.500 after second "
            f"event; got {after!r}"
        ),
    )
    ctx.check(
        "markers_cleared_after_second",
        after is not None and after[1] is None and after[2] is None and after[3] is None,
        evidence=f"in-flight markers must be cleared; got {after!r}",
    )

    food_logs = ctx.q_all(
        "SELECT calories::text, protein::text, qty_consumed::text "
        "  FROM chefbyte.food_logs WHERE user_id = %s",
        (ctx.user_id,),
    )
    ctx.check(
        "exactly_one_food_log_for_delta",
        len(food_logs) == 1,
        evidence=f"second event must write exactly one food_logs row; got {food_logs!r}",
    )
    if food_logs:
        cal = float(food_logs[0][0] or 0)
        prot = float(food_logs[0][1] or 0)
        qty = float(food_logs[0][2] or 0)
        # 100g/500g × 5 servings/container = 1 serving × 200cal = 200cal.
        ctx.check(
            "food_log_calories_match_delta",
            abs(cal - 200.0) < 0.5,
            evidence=f"calories must be 1 serving × 200 cal = 200; got {cal}",
        )
        ctx.check(
            "food_log_protein_match_delta",
            abs(prot - 4.0) < 0.05,
            evidence=f"protein must be 1 serving × 4g = 4.0; got {prot}",
        )
        ctx.check(
            "food_log_qty_one_serving",
            abs(qty - 1.0) < 0.005,
            evidence=f"qty_consumed must be 1.000 servings; got {qty}",
        )

    # shelf_event_log: two rows, both applied.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind', applied, reason "
        "  FROM chefbyte.shelf_event_log WHERE user_id = %s "
        "ORDER BY created_at ASC",
        (ctx.user_id,),
    )
    kinds = [r[0] for r in log_rows]
    ctx.check(
        "shelf_event_log_first_then_second",
        kinds == [
            "catch_all_first_measurement",
            "catch_all_second_measurement",
        ],
        evidence=f"shelf_event_log kinds must be FIRST then SECOND; got {kinds!r}",
    )
    ctx.check(
        "both_events_applied",
        all(r[1] for r in log_rows),
        evidence=f"both events must apply=true; got applied={[r[1] for r in log_rows]!r}",
    )
