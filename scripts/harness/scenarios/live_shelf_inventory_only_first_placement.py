"""Scenario: classifier candidate pool surfaces cloud_lots inventory.

Bug class
---------
2026-04-27 silent-empty-pool: commit 3b99043 restricted the ADD
candidate pool to "products in inventory" but read inventory from the
Pi-local ``lots`` table only — which is empty until the user has
physically placed a product on this shelf at least once. Cloud
inventory mirrored to the Pi's ``cloud_lots`` table was invisible to
the pool builder. Result: the very first place event for any
intaked-but-not-yet-placed product had a candidate pool of size 1
(only ``UNKNOWN``), and the classifier dutifully returned UNKNOWN even
though the user clearly had matching inventory.

The user's repro from 2026-04-27: Gatorade Frost was intaked through
the inventory page (qty=1.0 ctn in cloud) and never placed on the
live-shelf before. Placing it triggered an ADD event with delta_g
~+663g. The classifier saw only ``[{candidate_id: "UNKNOWN", ...}]``
in its prompt and returned UNKNOWN, leaving the cloud lot stuck at
"general inventory" forever.

Fix
---
``server/classifier/candidate_pool.py::pool_for_add`` now unions an
``inventory_only`` branch sourced from the new
``CandidateSource.get_inventory_only_products`` method, which queries
the Pi's ``cloud_lots`` mirror for products that have qty>0 but no
Pi-local lot on this shelf. The apply path
(``_apply_lot_update_from_classification`` →
``_mint_pi_lot_for_inventory_only_pick``) mints a Pi-local ``lots``
row when the classifier picks an inventory-only product, then emits a
``new_arrival`` cloud event. Cloud-side
``private.resolve_add_to_shelf_lot`` step 2/3 promotes the existing
cloud stock_lot to live_shelf-tracked status — this is NOT minting a
new cloud lot (decision #45 still holds: "minting from a place event
is forbidden" applies to the cloud side).

Scenario walkthrough
--------------------
1. Seed cloud: user + device + product + ONE stock_lot at qty=1.0
   with no in_flight markers. This is the "Gatorade in fridge,
   tracked but never on live-shelf" baseline.
2. Mirror the product into Pi SQLite. Insert directly into
   ``cloud_lots`` with the same lot_id + product_id (bypassing the
   poller for speed; ``lot_snapshot_reunite`` already covers the
   poller path).
3. Verify: Pi's classifier candidate pool for an ADD event MUST
   include this product in the ``inventory_only`` tier (this is the
   pool-builder regression test running against real DB shape).
4. Drive the Pi ADD path through the real ScaleHandler with a
   classification that picks the product. Apply path mints a Pi
   lots row and the cloud emit fires.
5. Drain the Pi outbox.
6. Cloud-side assertions:
   * The cloud stock_lot's ``last_update_source`` is now
     ``'live_shelf'`` (promoted by step 2 of the cloud resolver).
   * No NEW stock_lot was minted — there's exactly one row for this
     (user, product) pair.
   * Pi's ``lots`` table has a new on_shelf row for this product.
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


@scenario("live_shelf_inventory_only_first_placement")
def _live_shelf_inventory_only_first_placement(ctx: HarnessContext) -> None:
    # Lazy imports — the harness bootstrap doesn't pay this cost when
    # running unrelated scenarios.
    from server.classifier.candidate_pool import pool_for_add
    from server.classifier.models import (
        UNKNOWN_CANDIDATE_ID,
        ClassifierContext,
    )
    from server.adapters.candidate_source import RepoCandidateSource
    from server.storage import repo as storage_repo
    from server.storage.models import ScaleEventIn

    import threading

    # 1. Seed cloud state — Gatorade Frost, qty=1.0, never on shelf.
    ctx.seed_cloud_user()
    ctx.seed_device()
    cloud_product_id = ctx.seed_product(
        name="Inventory-only Gatorade (harness)",
        net_weight_g=900.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,
        in_flight_since=None,
    )
    ctx.check(
        "cloud_seed_ok",
        bool(cloud_lot_id),
        evidence=(
            f"cloud_lot_id={cloud_lot_id}, product_id={cloud_product_id}"
        ),
    )

    # Cloud baseline: lot has qty=1, NOT live_shelf tracked.
    baseline = ctx.q_one(
        "SELECT qty_containers::text, last_update_source "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "baseline_lot_not_live_shelf_tracked",
        baseline is not None
        and float(baseline[0] or 0) == 1.0
        and (baseline[1] is None or baseline[1] != "live_shelf"),
        evidence=(
            f"baseline qty={baseline[0] if baseline else None}, "
            f"last_update_source={baseline[1] if baseline else None}"
        ),
    )

    # 2. Mirror the product + cloud_lots row into Pi SQLite. We
    # bypass the poller and insert directly so this scenario is
    # deterministic — the poller path is covered by
    # ``lot_snapshot_reunite``.
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
                cloud_product_id, "INV-1",
                "Inventory-only Gatorade (harness)",
                900.0, 920.0, "liquid", "bottle", 1,
            ),
        )
        pi_conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, location_id, qty_containers,
                expires_on, in_flight_since, pickup_event_id,
                updated_at, deleted_at, synced_at
            ) VALUES (?, ?, NULL, 1.0, NULL, NULL, NULL,
                      ?, NULL, datetime('now'))
            """,
            (cloud_lot_id, cloud_product_id, _now_iso()),
        )

    # Pre-condition: NO Pi lots row for this product.
    pre_lots = storage_repo.list_lots_by_product(
        pi_conn, product_id=cloud_product_id, shelf_id="live_shelf",
    )
    ctx.check(
        "pre_no_pi_lot_for_product",
        pre_lots == [],
        evidence=f"expected zero Pi lots, got {len(pre_lots)}",
    )

    # 3. Pool-builder regression test: build the candidate pool the
    # production handler would feed to the classifier. The pool MUST
    # contain the product as ``inventory_only``.
    refs_root = LIVE_SHELF_DIR / "data" / "refs"
    refs_root.mkdir(parents=True, exist_ok=True)
    candidate_source = RepoCandidateSource(
        pi_conn, refs_root, db_lock=threading.RLock(),
    )
    cls_ctx = ClassifierContext(
        source=candidate_source, shelf_id="live_shelf",
    )
    pool = pool_for_add(663.452, cls_ctx)
    pool_ids = [c.candidate_id for c in pool]
    ctx.check(
        "pool_contains_inventory_only_product",
        cloud_product_id in pool_ids,
        evidence=(
            f"REGRESSION GUARD: candidate pool must include "
            f"product_id={cloud_product_id} (Gatorade) when cloud_lots "
            f"has qty>0 inventory. Got pool ids={pool_ids!r}. "
            f"If only ['UNKNOWN'] returned, the inventory_only branch "
            f"is silent — see commit 3b99043 + 2026-04-27 fix."
        ),
    )
    pool_size = len(pool)
    ctx.check(
        "pool_size_greater_than_unknown_only",
        pool_size > 1,
        evidence=(
            f"pool_size={pool_size}; the regression's smoking gun was "
            f"pool_size=1 (UNKNOWN sentinel only)."
        ),
    )
    inv_only_entry = next(
        (c for c in pool if c.candidate_id == cloud_product_id),
        None,
    )
    ctx.check(
        "inventory_only_tier_assigned",
        inv_only_entry is not None
        and inv_only_entry.why_candidate == "inventory_only",
        evidence=(
            f"expected why_candidate='inventory_only', got "
            f"{inv_only_entry.why_candidate if inv_only_entry else None!r}"
        ),
    )

    # 4. Drive the ADD path. Open a Pi session, record the scale
    # event, then call the apply method directly with a classification
    # that picks the inventory-only product.
    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-30), initial_weight_g=7.0,
    ).session_id
    handler = ctx.build_pi_scale_handler()
    ts_add = _now_iso()
    add_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=ts_add, delta_g=663.452,
            before_weight_g=7.0, after_weight_g=670.452,
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
                    "why_candidate": "inventory_only",
                },
                {"candidate_id": UNKNOWN_CANDIDATE_ID},
            ],
        },
        event_ts=ts_add,
        delta_g=663.452,
        session_id=session_id,
        event_id=add_event.event_id,
        shelf_id="live_shelf",
    )

    # 5. Drain the outbox so any cloud emit fires.
    #
    # Pi-side guarantee: the apply path enqueues a ``new_arrival``
    # cloud event for the inventory-only mint case. We assert the
    # outbox row exists, then drain.
    #
    # NOTE on the cloud-side promotion (see check
    # ``cloud_lot_promoted_to_live_shelf`` below): the cloud
    # resolver ``private.resolve_add_to_shelf_lot`` currently
    # rejects this exact case via a unique-index violation when:
    # (a) the existing untracked lot's qty>0, AND (b) the placed
    # weight doesn't match the stored qty*net_weight within ±50g.
    # The chicken/Gatorade scenario hits both — the user said
    # weight mismatches are EXPECTED on live-shelf transfers
    # (decision #45), but the cloud resolver still gates step 3
    # on weight tolerance. Promoting an untracked qty>0 lot to
    # ``last_update_source='live_shelf'`` regardless of weight is
    # a separate cloud-side fix; tracked here as a known gap.
    pre_drain = pi_conn.execute(
        "SELECT COUNT(*), GROUP_CONCAT(payload_json) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0",
    ).fetchone()
    ctx.check(
        "outbox_has_new_arrival_emit_before_drain",
        pre_drain is not None and int(pre_drain[0]) >= 1
        and pre_drain[1] is not None
        and "added" in pre_drain[1] and "live_shelf" in pre_drain[1],
        evidence=(
            f"REGRESSION GUARD: the apply path must emit ONE "
            f"'added' / 'live_shelf' cloud event for the "
            f"inventory-only mint. Got count={pre_drain[0]} "
            f"payloads={pre_drain[1]!r}"
        ),
    )
    ctx.pi_worker.tick()
    post_drain = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0",
    ).fetchone()
    ctx.check(
        "outbox_drained",
        post_drain is not None and int(post_drain[0]) == 0,
        evidence=(
            f"REGRESSION GUARD: pending outbox after drain should be 0. "
            f"Got {post_drain[0] if post_drain else None}. A non-zero "
            f"count means the cloud rejected the new_arrival event "
            f"(check shelf-ingest logs for 23505 against "
            f"stock_lots_merge_key — that means migration 20260427050000 "
            f"step 2.5 didn't fire)."
        ),
    )

    # 6a. Pi-side: a new lots row was minted for this product.
    post_lots = storage_repo.list_lots_by_product(
        pi_conn, product_id=cloud_product_id, shelf_id="live_shelf",
    )
    ctx.check(
        "pi_lot_minted_for_inventory_only_pick",
        len(post_lots) == 1 and post_lots[0].status == "on_shelf",
        evidence=(
            f"expected 1 minted on_shelf Pi lot, got "
            f"{[(l.lot_id[:8], l.status) for l in post_lots]!r}"
        ),
    )
    if post_lots:
        ctx.check(
            "pi_lot_weight_matches_delta",
            post_lots[0].current_weight_g is not None
            and abs(post_lots[0].current_weight_g - 663.452) < 1e-3,
            evidence=(
                f"expected current_weight_g=663.452, got "
                f"{post_lots[0].current_weight_g}"
            ),
        )

    # 6b. Cloud-side: exactly ONE stock_lots row for (user, product).
    # No duplicate mint — the cloud's resolve_add_to_shelf_lot step
    # 2/3 promoted the existing lot rather than minting.
    cloud_lot_count = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "exactly_one_cloud_stock_lot_for_user_product",
        cloud_lot_count is not None and int(cloud_lot_count[0]) == 1,
        evidence=(
            f"expected exactly 1 stock_lots row, got "
            f"{cloud_lot_count[0] if cloud_lot_count else None}. "
            f"A new lot mint here would prove decision #45 is "
            f"violated on the cloud side."
        ),
    )

    # 6c. Cloud-side: the lot was promoted to live_shelf tracking via
    # the new step 2.5 in ``private.resolve_add_to_shelf_lot``
    # (migration 20260427050000). The untracked (last_update_source
    # IS NULL) qty>0 row gets last_update_source flipped to
    # 'live_shelf' and its qty bumped by placed_weight/net_weight.
    after = ctx.q_one(
        "SELECT last_update_source, qty_containers::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "cloud_lot_promoted_to_live_shelf",
        after is not None and after[0] == "live_shelf",
        evidence=(
            f"REGRESSION GUARD: untracked qty>0 lot must be promoted to "
            f"last_update_source='live_shelf' on first place event. "
            f"Got source={after[0] if after else None!r}, "
            f"qty={after[1] if after else None!r}. If source is None, "
            f"step 2.5 of resolve_add_to_shelf_lot didn't fire — check "
            f"that migration 20260427050000 is applied."
        ),
    )
    # Reason audit: the shelf_event_log row should record
    # 'promoted_untracked_lot' (the new code path's audit tag).
    reason = ctx.q_one(
        "SELECT reason FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s AND payload->>'product_id' = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "shelf_event_log_reason_is_promoted_untracked",
        reason is not None and reason[0] == "promoted_untracked_lot",
        evidence=(
            f"shelf_event_log.reason should be 'promoted_untracked_lot' "
            f"for this branch; got {reason[0] if reason else None!r}"
        ),
    )
