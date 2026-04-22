"""Scenario: cloud stock_lots drift is reconciled by the Pi's lot-snapshot poller.

Bug class
---------
Without a cloud → Pi pull path for lot state, the following drift cases
leave the Pi with a stale view of cloud ``chefbyte.stock_lots``:

  * A ``POST /shelf-ingest/event`` fails (network outage, cloud 5xx)
    but the Pi already applied the event locally → cloud side lags.
  * A user / admin mutates a lot directly via the chef UI or an RPC
    that doesn't round-trip through the Pi.
  * A cloud-side tombstone (soft-delete) never reaches the Pi.

Fix
---
``LotSnapshotPoller`` hits ``GET /shelf-ingest/lot-snapshot?updated_since=...``
on a 60s cadence and mirrors cloud's stock_lots into the Pi's local
``cloud_lots`` table. This scenario pins the three-step reunite loop:

  1. Cloud seeds a stock_lots row → first tick inserts it locally.
  2. Cloud mutates the same row → second tick overwrites the mirror
     with the new values (cloud wins).
  3. Cloud soft-deletes the row → third tick DELETEs the local mirror.

The "one tick per step" clause matters: the stock_lots_set_updated_at
trigger (migration 20260426010000) must fire on every UPDATE so the
next delta query picks up the changed row. If the trigger wasn't wired,
any of steps 2 and 3 would silently fail.
"""

from __future__ import annotations

import uuid

from scripts.harness.orchestrator import HarnessContext, scenario


@scenario("lot_snapshot_reunite")
def _lot_snapshot_reunite(ctx: HarnessContext) -> None:
    # 1. Seed cloud user + device + product + lot.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(name="Lot snapshot product (harness)")
    lot_id = ctx.seed_stock_lot(product_id=product_id, qty_containers=2.5)
    ctx.check(
        "cloud_seed_ok",
        bool(lot_id),
        evidence=f"lot_id={lot_id}, product_id={product_id}",
    )

    # 2. First tick — pull the row into the Pi's cloud_lots mirror.
    poller = ctx.pi_lot_snapshot_poller
    count1 = poller.tick_once()
    ctx.check(
        "first_tick_inserted_row",
        count1 >= 1,
        evidence=(
            f"expected >= 1 mutation on first tick; got {count1}. "
            f"If 0, the /lot-snapshot endpoint returned no rows for a "
            f"user that clearly has one — check route wiring + auth."
        ),
    )

    mirror = ctx.pi_sqlite.execute(
        "SELECT lot_id, product_id, qty_containers, "
        "       in_flight_since, pickup_event_id, deleted_at "
        "  FROM cloud_lots WHERE lot_id = ?",
        (lot_id,),
    ).fetchone()
    ctx.check(
        "pi_has_mirror_after_first_tick",
        mirror is not None,
        evidence=(
            f"Pi cloud_lots must contain lot_id={lot_id} after first "
            f"tick; got {mirror!r}"
        ),
    )
    if mirror is not None:
        mirror_dict = dict(mirror) if hasattr(mirror, "keys") else {
            "lot_id": mirror[0],
            "product_id": mirror[1],
            "qty_containers": mirror[2],
            "in_flight_since": mirror[3],
            "pickup_event_id": mirror[4],
            "deleted_at": mirror[5],
        }
        ctx.check(
            "first_tick_qty_matches_cloud",
            abs(float(mirror_dict["qty_containers"]) - 2.5) < 1e-6,
            evidence=(
                f"Pi qty_containers must equal cloud (2.5); got "
                f"{mirror_dict['qty_containers']!r}"
            ),
        )
        ctx.check(
            "first_tick_in_flight_null",
            mirror_dict["in_flight_since"] is None,
            evidence=(
                f"fresh lot must have in_flight_since=NULL; got "
                f"{mirror_dict['in_flight_since']!r}"
            ),
        )
        ctx.check(
            "first_tick_not_tombstoned",
            mirror_dict["deleted_at"] is None,
            evidence=(
                f"fresh lot must have deleted_at=NULL; got "
                f"{mirror_dict['deleted_at']!r}"
            ),
        )

    # 3. Mutate the cloud row: qty to 0, flag as in-flight. The
    # stock_lots_set_updated_at trigger must bump updated_at so the
    # delta query picks this up. pickup_event_id is UUID-typed in
    # chefbyte.stock_lots — seed a fresh UUID so the UPDATE passes the
    # column's type check.
    pickup_event_id = str(uuid.uuid4())
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            UPDATE chefbyte.stock_lots
               SET qty_containers = 0,
                   in_flight_since = now(),
                   pickup_event_id = %s
             WHERE lot_id = %s
            """,
            (pickup_event_id, lot_id),
        )

    cloud_after_mutate = ctx.q_one(
        "SELECT qty_containers, in_flight_since IS NOT NULL, "
        "       updated_at > created_at "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "cloud_mutation_applied",
        cloud_after_mutate is not None
        and float(cloud_after_mutate[0]) == 0.0
        and bool(cloud_after_mutate[1])
        and bool(cloud_after_mutate[2]),
        evidence=(
            f"cloud row must reflect the mutation + trigger-bumped "
            f"updated_at; got {cloud_after_mutate!r}"
        ),
    )

    # 4. Second tick — delta must carry the mutated row.
    count2 = poller.tick_once()
    ctx.check(
        "second_tick_saw_mutation",
        count2 >= 1,
        evidence=(
            f"expected >= 1 mutation; got {count2}. If 0 the watermark "
            f"logic swallowed the update — verify the "
            f"stock_lots_set_updated_at trigger bumps updated_at on UPDATE."
        ),
    )

    mirror_after = ctx.pi_sqlite.execute(
        "SELECT qty_containers, in_flight_since, pickup_event_id "
        "  FROM cloud_lots WHERE lot_id = ?",
        (lot_id,),
    ).fetchone()
    ctx.check(
        "pi_mirror_updated_to_cloud",
        mirror_after is not None
        and abs(float(mirror_after[0])) < 1e-6
        and mirror_after[1] is not None
        and mirror_after[2] == pickup_event_id,
        evidence=(
            f"Pi cloud_lots row must match cloud post-mutation "
            f"(qty=0, in_flight_since set, pickup_event_id="
            f"{pickup_event_id!r}); got "
            f"{dict(mirror_after) if mirror_after else None!r}"
        ),
    )

    # 5. Soft-delete the cloud row. The trigger bumps updated_at again so
    # the delta query picks up the tombstone.
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.stock_lots "
            "   SET deleted_at = now() "
            " WHERE lot_id = %s",
            (lot_id,),
        )

    cloud_tombstoned = ctx.q_one(
        "SELECT deleted_at IS NOT NULL "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "cloud_tombstoned",
        cloud_tombstoned is not None and bool(cloud_tombstoned[0]),
        evidence=f"cloud row must be tombstoned; got {cloud_tombstoned!r}",
    )

    # 6. Third tick — Pi mirror must delete the row.
    count3 = poller.tick_once()
    ctx.check(
        "third_tick_applied_tombstone",
        count3 >= 1,
        evidence=(
            f"expected >= 1 mutation on tombstone propagation; got {count3}."
        ),
    )

    mirror_gone = ctx.pi_sqlite.execute(
        "SELECT lot_id FROM cloud_lots WHERE lot_id = ?",
        (lot_id,),
    ).fetchone()
    ctx.check(
        "pi_mirror_row_deleted",
        mirror_gone is None,
        evidence=(
            f"Pi cloud_lots row must be DELETEd after tombstone; got "
            f"{dict(mirror_gone) if mirror_gone else None!r}"
        ),
    )
