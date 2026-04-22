"""Scenario: cloud product soft-delete propagates to Pi within one tick.

Bug class
---------
The Pi maintains a local SQLite copy of ``chefbyte.products`` (cached so
the classifier + intake UI can operate without round-tripping cloud on
every scale event). When a product is soft-deleted in the cloud, the
``ProductSyncPoller`` must tombstone the local row within one tick —
otherwise:

  * the intake UI still lets the operator scan the deleted barcode
    and attach it to the wrong lot
  * the classifier may still suggest the deleted product as a candidate
  * the catalog diverges silently

This scenario pins the propagation contract:

  1. Seed cloud product. Run ``ProductSyncPoller.tick_once()`` — the
     Pi's local ``products`` row lands.
  2. Soft-delete the cloud row (``UPDATE ... SET deleted_at = now()``).
  3. Tick the poller ONE MORE TIME.
  4. Assert the Pi's local row has ``deleted_at`` set AND is
     excluded from ``list_products()`` (which filters
     ``WHERE deleted_at IS NULL``).

The "one tick" clause is important: the catalog-delta poller sends
``updated_since=<high_watermark>`` after its first successful run. The
tombstoned row's ``updated_at`` must have advanced when its
``deleted_at`` was set (via the ``products_set_updated_at`` trigger),
so the second tick's delta query includes the tombstone. If the
trigger wasn't wired, or the watermark logic swallowed the tombstone
row, this scenario would fail.
"""

from __future__ import annotations

import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario

REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))

from server.storage import repo as storage_repo  # noqa: E402


@scenario("device_delete_propagates")
def _device_delete_propagates(ctx: HarnessContext) -> None:
    # 1. Seed cloud user + device + product.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(
        name="Will be deleted (harness)",
        barcode="9999000099990",
    )
    ctx.check(
        "cloud_product_seeded",
        True,
        evidence=f"product_id={product_id}",
    )

    # 2. First sync — pull the row into Pi SQLite.
    poller = ctx.pi_product_sync_poller
    # Run through the full tick path. tick_once returns count of rows
    # upserted; we expect >= 1.
    count = poller.tick_once()
    ctx.check(
        "first_tick_synced_product",
        count >= 1,
        evidence=f"tick_once returned {count}; expected >= 1",
    )

    local = ctx.pi_sqlite.execute(
        "SELECT product_id, name, deleted_at FROM products "
        " WHERE product_id = ?",
        (product_id,),
    ).fetchone()
    ctx.check(
        "pi_has_product_after_first_tick",
        local is not None,
        evidence=(
            f"Pi's local products table must have row {product_id} "
            f"after first poller tick; got {local!r}"
        ),
    )
    if local is not None:
        # sqlite3.Row needs named access; convert explicitly.
        local_dict = dict(local) if hasattr(local, "keys") else {
            "product_id": local[0], "name": local[1], "deleted_at": local[2]
        }
        ctx.check(
            "pi_deleted_at_null_at_first",
            local_dict.get("deleted_at") is None,
            evidence=(
                f"fresh product must land with deleted_at=NULL; "
                f"got {local_dict!r}"
            ),
        )

    # Confirm list_products() includes it (the user-facing filter).
    live_ids = [p.product_id for p in storage_repo.list_products(ctx.pi_sqlite)]
    ctx.check(
        "product_visible_before_delete",
        product_id in live_ids,
        evidence=(
            f"product_id={product_id} should be visible to list_products() "
            f"before soft-delete; live_ids contains "
            f"{[i[:8] for i in live_ids]}"
        ),
    )

    # 3. Soft-delete the cloud row. The products_set_updated_at trigger
    # bumps updated_at so the next delta query includes this row.
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.products "
            "   SET deleted_at = now() "
            " WHERE product_id = %s",
            (product_id,),
        )

    # Confirm the cloud row is actually tombstoned — sanity check for
    # seed path + trigger.
    cloud_after = ctx.q_one(
        "SELECT deleted_at IS NOT NULL, updated_at > created_at "
        "  FROM chefbyte.products WHERE product_id = %s",
        (product_id,),
    )
    ctx.check(
        "cloud_row_tombstoned",
        cloud_after is not None and bool(cloud_after[0]),
        evidence=(
            f"cloud product row must have deleted_at set; got "
            f"{cloud_after!r}"
        ),
    )

    # 4. Second sync — tombstone must propagate.
    count2 = poller.tick_once()
    ctx.check(
        "second_tick_saw_tombstone",
        count2 >= 1,
        evidence=(
            f"expected >=1 row in second delta (the tombstoned product); "
            f"tick_once returned {count2}. If this is 0 the watermark "
            f"logic excluded the tombstone — check that the "
            f"products_set_updated_at trigger fired on the UPDATE."
        ),
    )

    local_after = ctx.pi_sqlite.execute(
        "SELECT deleted_at FROM products WHERE product_id = ?",
        (product_id,),
    ).fetchone()
    ctx.check(
        "pi_row_has_deleted_at_after_second_tick",
        local_after is not None and local_after[0] is not None,
        evidence=(
            f"Pi's local row must have deleted_at set after the "
            f"tombstone propagates. Got row={local_after!r}"
        ),
    )

    # 5. User-facing filter: list_products() excludes tombstoned rows.
    # This is the "gone from Pi" assertion in the VERIFY.md wording —
    # the row is stored for audit but invisible to the classifier +
    # intake UI.
    live_ids_after = [
        p.product_id for p in storage_repo.list_products(ctx.pi_sqlite)
    ]
    ctx.check(
        "product_invisible_after_delete",
        product_id not in live_ids_after,
        evidence=(
            f"tombstoned product_id={product_id} must NOT appear in "
            f"list_products() — otherwise the classifier + intake UI "
            f"still offer it. Live ids after delete: "
            f"{[i[:8] for i in live_ids_after]}"
        ),
    )
