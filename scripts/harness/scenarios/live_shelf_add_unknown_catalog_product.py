"""Scenario: live_shelf catalog product surfaces in pool + apply path mints lot.

Bug class
---------
2026-04-27 catalog-branch-silent: under decisions.md #45 the live_shelf
ADD pool was restricted to products that already had inventory (Pi
lots OR cloud_lots qty>0). Decision #53 patched the silent-pool case
for cloud_lots qty>0 (inventory_only branch), but a third case
remained UNKNOWN-only: the user has a product in their catalog with
NO inventory at all (e.g. uncertified items, or a freshly-scanned
SKU that was never intaked). The user's expectation, per their
explicit clarification on 2026-04-27: "general products to be
matchable on the live_shelf even if no stock_lots exist yet."

Decision #54 reintroduces the ``catalog_not_on_shelf`` branch in
``pool_for_add`` for ``shelf_id == 'live_shelf'`` only. The
LiveTrack (single_item) scale path KEEPS the inventory-only rule —
its cloud-side resolver was always inventory-aware. The catch_all
path is owned by a separate workstream.

Scenario walkthrough
--------------------
1. Seed cloud: user + device + a certified product, NO stock_lots.
2. Mirror only the product into Pi SQLite (no cloud_lots row, no
   Pi lots row). The product is bare in the catalog only.
3. Verify: Pi's classifier candidate pool for an ADD event MUST
   include this product in the ``catalog_not_on_shelf`` tier.
4. Drive the Pi ADD path through ScaleHandler with a classification
   that picks the product. The apply path's catalog branch should
   mint a Pi lot AND emit ``new_arrival``.
5. Drain the Pi outbox.
6. Cloud-side assertion:
   * ``shelf_event_log`` recorded an ``added`` event for this
     product with kind=live_shelf (NOT UNKNOWN, NOT skipped).

This scenario is the regression guard for decision #54.
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


@scenario("live_shelf_add_unknown_catalog_product")
def _live_shelf_add_unknown_catalog_product(ctx: HarnessContext) -> None:
    from server.adapters.candidate_source import RepoCandidateSource
    from server.classifier.candidate_pool import pool_for_add
    from server.classifier.models import (
        UNKNOWN_CANDIDATE_ID,
        ClassifierContext,
    )
    from server.storage import repo as storage_repo
    from server.storage.models import ScaleEventIn

    import threading

    # 1. Seed cloud — certified product, NO stock_lots row.
    ctx.seed_cloud_user()
    ctx.seed_device()
    cloud_product_id = ctx.seed_product(
        name="Catalog-only Tortillas (harness)",
        net_weight_g=566.0,
    )
    ctx.check(
        "cloud_product_seeded",
        bool(cloud_product_id),
        evidence=f"cloud_product_id={cloud_product_id}",
    )

    # Cloud baseline: ZERO stock_lots rows for (user, product).
    baseline = ctx.q_one(
        "SELECT COUNT(*)::text FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "baseline_no_stock_lots",
        baseline is not None and int(baseline[0]) == 0,
        evidence=(
            f"expected zero stock_lots for catalog-only product, "
            f"got {baseline[0] if baseline else None}"
        ),
    )

    # 2. Mirror ONLY the product into Pi SQLite. No cloud_lots row, no
    # Pi lots row — the product is bare in the catalog only.
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
                cloud_product_id, "TORT-1",
                "Catalog-only Tortillas (harness)",
                566.0, 600.0, "solid", "bag", 1,
            ),
        )

    # Pre-condition: NO Pi lots row, NO cloud_lots row.
    pre_lots = storage_repo.list_lots_by_product(
        pi_conn, product_id=cloud_product_id, shelf_id="live_shelf",
    )
    ctx.check(
        "pre_no_pi_lot_for_product",
        pre_lots == [],
        evidence=f"expected zero Pi lots, got {len(pre_lots)}",
    )

    # 3. Pool-builder regression test: catalog product MUST appear in
    # the pool with why_candidate='catalog_not_on_shelf' on live_shelf.
    refs_root = LIVE_SHELF_DIR / "data" / "refs"
    refs_root.mkdir(parents=True, exist_ok=True)
    candidate_source = RepoCandidateSource(
        pi_conn, refs_root, db_lock=threading.RLock(),
    )
    cls_ctx = ClassifierContext(
        source=candidate_source, shelf_id="live_shelf",
    )
    pool = pool_for_add(560.0, cls_ctx)
    pool_ids = [c.candidate_id for c in pool]
    ctx.check(
        "pool_contains_catalog_product",
        cloud_product_id in pool_ids,
        evidence=(
            f"REGRESSION GUARD (decision #54): catalog product must "
            f"appear in the live_shelf ADD pool when no inventory "
            f"exists. Got pool ids={pool_ids!r}. If only ['UNKNOWN'] "
            f"returned, the catalog branch is silent on live_shelf."
        ),
    )
    ctx.check(
        "pool_size_greater_than_unknown_only",
        len(pool) > 1,
        evidence=(
            f"pool_size={len(pool)}; the regression's smoking gun is "
            f"pool_size=1 (UNKNOWN only)."
        ),
    )
    catalog_entry = next(
        (c for c in pool if c.candidate_id == cloud_product_id),
        None,
    )
    ctx.check(
        "catalog_tier_assigned",
        catalog_entry is not None
        and catalog_entry.why_candidate == "catalog_not_on_shelf",
        evidence=(
            f"expected why_candidate='catalog_not_on_shelf', got "
            f"{catalog_entry.why_candidate if catalog_entry else None!r}"
        ),
    )

    # 4. Drive the ADD path. The classifier "picks" the catalog
    # product; the apply path must mint a Pi lot and emit new_arrival.
    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-30), initial_weight_g=7.0,
    ).session_id
    handler = ctx.build_pi_scale_handler()
    ts_add = _now_iso()
    add_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=ts_add, delta_g=560.0,
            before_weight_g=7.0, after_weight_g=567.0,
            direction="add", session_id=session_id,
            classifier_status="classified",
        ),
    )
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": cloud_product_id,
            "action": "added",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [
                {
                    "candidate_id": cloud_product_id,
                    "product_id": cloud_product_id,
                    "why_candidate": "catalog_not_on_shelf",
                },
                {"candidate_id": UNKNOWN_CANDIDATE_ID},
            ],
        },
        event_ts=ts_add,
        delta_g=560.0,
        session_id=session_id,
        event_id=add_event.event_id,
        shelf_id="live_shelf",
    )

    # 5a. Pi-side: a new lots row was minted for this product.
    post_lots = storage_repo.list_lots_by_product(
        pi_conn, product_id=cloud_product_id, shelf_id="live_shelf",
    )
    ctx.check(
        "pi_lot_minted_for_catalog_pick",
        len(post_lots) == 1 and post_lots[0].status == "on_shelf",
        evidence=(
            f"REGRESSION GUARD (decision #54): the apply path must mint "
            f"a Pi lots row when classifier picks a catalog_not_on_shelf "
            f"candidate on live_shelf. Got "
            f"{[(l.lot_id[:8], l.status) for l in post_lots]!r}"
        ),
    )

    # 5b. Pi-side: outbox has an 'added' / 'live_shelf' emit pending.
    pre_drain = pi_conn.execute(
        "SELECT COUNT(*), GROUP_CONCAT(payload_json) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0",
    ).fetchone()
    ctx.check(
        "outbox_has_added_emit_for_catalog_mint",
        pre_drain is not None and int(pre_drain[0]) >= 1
        and pre_drain[1] is not None
        and "added" in pre_drain[1]
        and "live_shelf" in pre_drain[1],
        evidence=(
            f"REGRESSION GUARD: catalog mint should emit ONE 'added' / "
            f"'live_shelf' cloud event so the user-facing inventory page "
            f"picks up the new lot. Got count={pre_drain[0]} "
            f"payloads={pre_drain[1]!r}"
        ),
    )

    # 6. Drain the outbox + verify cloud side.
    ctx.pi_worker.tick()

    # Cloud-side: a stock_lots row was created (step 5 mint) AND the
    # shelf_event_log records an 'added' event with kind='live_shelf'.
    cloud_lot_count = ctx.q_one(
        "SELECT COUNT(*)::text FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "cloud_stock_lot_minted_for_catalog_first_placement",
        cloud_lot_count is not None and int(cloud_lot_count[0]) == 1,
        evidence=(
            f"REGRESSION GUARD (decision #54): catalog-mint flow should "
            f"create exactly ONE cloud stock_lots row via "
            f"resolve_add_to_shelf_lot step 5. Got "
            f"{cloud_lot_count[0] if cloud_lot_count else None} rows."
        ),
    )

    # The shelf_event_log payload carries event_kind + kind as JSONB
    # fields (the table doesn't have native columns for them).
    shelf_log_payload = ctx.q_one(
        "SELECT applied::text, payload->>'event_kind', payload->>'kind' "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s AND payload->>'product_id' = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "shelf_event_log_records_added_live_shelf",
        shelf_log_payload is not None
        and shelf_log_payload[0] == "true"
        and shelf_log_payload[1] == "added"
        and shelf_log_payload[2] == "live_shelf",
        evidence=(
            f"REGRESSION GUARD: shelf_event_log must record an APPLIED "
            f"event with payload event_kind='added' and kind='live_shelf' "
            f"for the catalog mint. Got applied={shelf_log_payload[0] if shelf_log_payload else None!r} "
            f"event_kind={shelf_log_payload[1] if shelf_log_payload else None!r} "
            f"kind={shelf_log_payload[2] if shelf_log_payload else None!r}. "
            f"A NULL or 'unknown' here means the apply path didn't fire "
            f"the new_arrival branch (decision #54 didn't land)."
        ),
    )
