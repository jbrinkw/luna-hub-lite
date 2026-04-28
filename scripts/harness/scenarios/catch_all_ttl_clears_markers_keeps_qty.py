"""Scenario: catch-all TTL reaper clears markers but keeps qty + macros.

CATCH_ALL_SCALE_PLAN.md (2026-04-27): a catch-all in-flight session
that times out (no second measurement within 6h) means the user
weighed an item but didn't complete the delta-capture cycle.

  * The qty stamped on the FIRST event already reflects what's in the
    container (= measured weight / net_weight_g) — that's accurate
    inventory regardless of whether they came back.
  * The user walking away does NOT imply consumption.

So the TTL reaper for catch-all:
  * Clears in_flight_since + in_flight_kind + pickup_event_id +
    pickup_weight_g.
  * Does NOT change qty_containers.
  * Does NOT write food_logs.

Implemented as ``private.reap_catch_all_in_flight()`` in migration
20260428000000_catch_all_in_flight_ttl_reaper.sql, scheduled via
pg_cron every 30 minutes.
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


@scenario("catch_all_ttl_clears_markers_keeps_qty")
def _scenario(ctx: HarnessContext) -> None:
    # 1. Seed cloud user + product + a stock_lot stamped as catch_all
    # in-flight 7 hours ago (past 6h TTL).
    ctx.seed_cloud_user()
    ctx.seed_device()
    cloud_product_id = ctx.seed_product(
        name="Catch-all TTL test", net_weight_g=500.0,
        servings_per_container=5.0, calories_per_serving=200.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id, qty_containers=0.700,
    )
    # Stamp in-flight markers with old in_flight_since.
    pickup_event_uuid = "33333333-3333-3333-3333-333333333333"
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            UPDATE chefbyte.stock_lots
               SET in_flight_since = now() - interval '7 hours',
                   in_flight_kind  = 'catch_all',
                   pickup_event_id = %s,
                   pickup_weight_g = 350.0,
                   last_update_source = 'catch_all',
                   last_update_ts = now() - interval '7 hours'
             WHERE lot_id = %s
            """,
            (pickup_event_uuid, cloud_lot_id),
        )

    # 2. Run the cloud reaper directly (as if pg_cron fired).
    with ctx.db.cursor() as cur:
        cur.execute(
            "SELECT private.reap_catch_all_in_flight(21600, 100)"
        )
        reaped = cur.fetchone()[0]
    ctx.check(
        "reaper_returned_one",
        reaped == 1,
        evidence=f"reaper should return reap count = 1; got {reaped!r}",
    )

    # 3. Cloud assertions: markers cleared, qty UNCHANGED, no food_logs.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since, in_flight_kind, "
        "       pickup_event_id, pickup_weight_g "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "qty_unchanged_after_reap",
        after is not None and float(after[0] or 0) == 0.700,
        evidence=(
            f"catch-all TTL reap MUST NOT change qty_containers; "
            f"expected 0.700, got {after!r}"
        ),
    )
    ctx.check(
        "in_flight_since_cleared",
        after is not None and after[1] is None,
        evidence=f"in_flight_since must be NULL post-reap; got {after!r}",
    )
    ctx.check(
        "in_flight_kind_cleared",
        after is not None and after[2] is None,
        evidence=f"in_flight_kind must be NULL post-reap; got {after!r}",
    )
    ctx.check(
        "pickup_event_id_cleared",
        after is not None and after[3] is None,
        evidence=f"pickup_event_id must be NULL post-reap; got {after!r}",
    )
    ctx.check(
        "pickup_weight_g_cleared",
        after is not None and after[4] is None,
        evidence=f"pickup_weight_g must be NULL post-reap; got {after!r}",
    )

    food_log_count = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.food_logs WHERE user_id = %s",
        (ctx.user_id,),
    )[0]
    ctx.check(
        "no_food_logs_from_reap",
        food_log_count == 0,
        evidence=(
            f"catch-all TTL reap MUST NOT write food_logs (TTL means "
            f"the user didn't complete the delta-capture cycle, NOT "
            f"that they consumed it); got {food_log_count} row(s)"
        ),
    )
