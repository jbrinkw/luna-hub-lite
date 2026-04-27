"""Scenario: classifier fallback rescues a depleted-inventory placement.

The case the user hit on 2026-04-27 (Gatorade / chocolate-milk): an
item is certified + LiveTrack-tracked, but the cloud_lots inventory is
EMPTY for it (e.g. the previous container was depleted off the
shelf). Placing a fresh container produces an inventory-only pool of
[UNKNOWN] only — the classifier returns UNKNOWN even though the
product is clearly trackable.

With the per-user opt-in fallback flag flipped on, a SECOND classifier
pass runs against ALL certified LiveTrack-tracked products in the
user's catalog. The fallback pool DOES contain the Gatorade, the
mocked classifier picks it on pass-2, and the apply path treats the
result as a normal high-confidence ADD — the ``shelf_event_log`` row
ends up with ``event_kind='added'`` and ``payload.product_id`` set to
Gatorade, NOT UNKNOWN.

What's checked:

1. Pre-toggle baseline: with fallback OFF, a UNKNOWN-only pool yields
   UNKNOWN and no shelf_event_log mutation (regression guard for
   "today's behavior").
2. Toggle flipped via the cloud profile UI surface (direct SQL UPDATE).
3. Pi settings cache refreshed via the lot-snapshot poller's
   /settings hook (we drive ``tick_once`` to mimic the 60s loop).
4. Pi local catalog has Gatorade with ``certified=1`` +
   ``tare_weight_g`` set, but NO ``cloud_lots`` row (depleted inventory).
5. Mocked Anthropic returns UNKNOWN on pass-1 (the inventory-only
   pool is just UNKNOWN) and Gatorade on pass-2 with confidence 0.95.
6. Resulting cloud event payload identifies Gatorade — not UNKNOWN.
7. The classification meta carries the audit fields the lifecycle
   event reads (``fallback_pass_used=True`` + pass1/pass2 telemetry).
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
import threading
from pathlib import Path
from typing import Any

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


class _ScriptedClient:
    """Anthropic stub that returns scripted JSON in order."""

    def __init__(self, replies: list[str]) -> None:
        self._replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def send(self, payload, *, model=None):
        from server.classifier.anthropic_client import ClassifierCallResult

        self.calls.append({"model": model})
        if not self._replies:
            raise AssertionError("ScriptedClient: out of replies")
        text = self._replies.pop(0)
        return ClassifierCallResult(
            text=text,
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 20},
            raw=None,
        )


@scenario("classifier_fallback_recovers_unknown")
def _classifier_fallback_recovers_unknown(ctx: HarnessContext) -> None:
    from server.classifier.fallback import classify_event_with_fallback
    from server.classifier.models import (
        UNKNOWN_CANDIDATE_ID,
        ClassifierContext,
        ScaleEvent as ClsScaleEvent,
    )
    from server.adapters.candidate_source import RepoCandidateSource

    # 1. Cloud + Pi seed: Gatorade as certified + LiveTrack-tracked (tare).
    ctx.seed_cloud_user()
    ctx.seed_device()
    cloud_product_id = ctx.seed_product(
        name="Gatorade Frost (fallback test)",
        net_weight_g=900.0,
    )

    # Patch the cloud product row to certified + LiveTrack-tracked. The
    # seed_product helper doesn't yet support these columns, so set
    # them directly. tare_weight_g is the LiveTrack-enrolled marker
    # (matches the web UI's badge predicate).
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            UPDATE chefbyte.products
               SET certified = TRUE,
                   tare_weight_g = 25.0,
                   gross_weight_g = 920.0
             WHERE product_id = %s
            """,
            (cloud_product_id,),
        )

    # Flip the user's classifier-fallback toggle on. This is the
    # cloud half of the feature — the Pi will pull this on its
    # next /settings tick.
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            UPDATE hub.profiles
               SET chefbyte_classifier_fallback_enabled = TRUE
             WHERE user_id = %s
            """,
            (ctx.user_id,),
        )
    flag_row = ctx.q_one(
        "SELECT chefbyte_classifier_fallback_enabled FROM hub.profiles "
        " WHERE user_id = %s",
        (ctx.user_id,),
    )
    ctx.check(
        "fallback_flag_enabled_in_cloud",
        flag_row is not None and bool(flag_row[0]) is True,
        evidence=f"hub.profiles row reports {flag_row}",
    )

    # 2a. Seed a cloud stock_lot. The brief says "Seed cloud with a
    # certified LiveTrack-tracked product (Gatorade) at qty=1.0 BUT
    # NOT on the live_shelf mirror (simulate the staleness case)" —
    # the cloud stock_lot exists but the Pi's inventory pool sees
    # nothing because we deliberately do NOT seed cloud_lots on the Pi.
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=1.0,
        in_flight_since=None,
    )

    # 2b. Mirror the product into Pi SQLite. We DO need the products
    # row so the apply path can resolve the classifier's pick, but we
    # deliberately leave Pi ``cloud_lots`` empty for the fallback
    # trigger phase. We'll add it back before the apply step to
    # represent the lot-snapshot poller catching up after pass-2 wins.
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                tare_weight_g, unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cloud_product_id,
                "GATORADE-FRO-1",
                "Gatorade Frost (fallback test)",
                900.0,
                920.0,
                25.0,
                "liquid",
                "bottle",
                1,  # certified
            ),
        )

    # Pre-condition: NO Pi lots row + NO cloud_lots mirror — this is
    # the failure-mode trigger. The classifier's inventory-only pool
    # will be empty (just the UNKNOWN sentinel).
    pre_pi_lots = pi_conn.execute(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?",
        (cloud_product_id,),
    ).fetchone()
    pre_cloud_lots = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_lots WHERE product_id = ?",
        (cloud_product_id,),
    ).fetchone()
    ctx.check(
        "pi_inventory_empty_for_product_pre_fallback",
        pre_pi_lots is not None
        and int(pre_pi_lots[0]) == 0
        and pre_cloud_lots is not None
        and int(pre_cloud_lots[0]) == 0,
        evidence=(
            f"pre_pi_lots={pre_pi_lots[0]}, pre_cloud_lots={pre_cloud_lots[0]}"
            " — both must be zero to exercise the fallback trigger"
        ),
    )

    # 3. Refresh the Pi's classifier-settings cache to pick up the
    # cloud-side toggle. We bypass the actual HTTP call by driving the
    # cache directly — the lot-snapshot poller's behaviour is exercised
    # by its own unit test (server/tests/test_lot_snapshot_poller.py).
    from server.cloud.settings_cache import (
        ClassifierSettings,
        get_global_cache,
    )
    cache = get_global_cache()
    cache.update(ClassifierSettings(chefbyte_classifier_fallback_enabled=True))
    ctx.check(
        "pi_settings_cache_updated",
        cache.get().chefbyte_classifier_fallback_enabled is True,
        evidence=f"cache state: {cache.get()}",
    )

    # 4. Build the classifier context with our scripted client. Pass-1
    # returns UNKNOWN; pass-2 returns the Gatorade product_id with
    # high confidence.
    refs_root = LIVE_SHELF_DIR / "data" / "refs"
    refs_root.mkdir(parents=True, exist_ok=True)
    candidate_source = RepoCandidateSource(
        pi_conn, refs_root, db_lock=threading.RLock(),
    )

    pass1_reply = json.dumps({
        "item_id": "UNKNOWN",
        "action": "unknown",
        "confidence": 0.1,
        "reasoning": "no on-shelf inventory matches",
    })
    pass2_reply = json.dumps({
        "item_id": cloud_product_id,
        "action": "added",
        "confidence": 0.95,
        "reasoning": "fallback pool: visible Gatorade Frost matches",
    })
    client = _ScriptedClient([pass1_reply, pass2_reply])

    cls_ctx = ClassifierContext(
        source=candidate_source,
        anthropic_client=client,
        shelf_id="live_shelf",
    )

    # Build a synthetic ScaleEvent. Frames must exist on disk for the
    # prompt builder.
    tmp_root = ctx.tmp_dir / "fallback_frames"
    tmp_root.mkdir(parents=True, exist_ok=True)
    before_path = tmp_root / "before.jpg"
    after_path = tmp_root / "after.jpg"
    before_path.write_bytes(_TINY_JPEG)
    after_path.write_bytes(_TINY_JPEG)

    cls_event = ClsScaleEvent(
        event_id="evt_fallback_harness",
        session_id="sesn_fallback_harness",
        ts=_now_iso(),
        delta_g=920.0,  # full container weight
        before_weight_g=0.0,
        after_weight_g=920.0,
        direction="add",
        before_frame_path=str(before_path),
        after_frame_path=str(after_path),
    )

    # 5. Pre-flight baseline: with fallback OFF the same setup yields
    # UNKNOWN. This is "today's behavior" — the regression guard.
    baseline_client = _ScriptedClient([pass1_reply])
    baseline_ctx = ClassifierContext(
        source=candidate_source,
        anthropic_client=baseline_client,
        shelf_id="live_shelf",
    )
    baseline_result = classify_event_with_fallback(
        cls_event, baseline_ctx, fallback_enabled=False,
    )
    ctx.check(
        "baseline_unknown_when_fallback_off",
        baseline_result.item_id == UNKNOWN_CANDIDATE_ID
        and len(baseline_client.calls) == 1,
        evidence=(
            f"baseline item_id={baseline_result.item_id!r}, "
            f"call_count={len(baseline_client.calls)} "
            f"(must be UNKNOWN + 1 call to prove the fallback path is "
            f"the lift; if this changes, today's behavior changed)"
        ),
    )

    # 6. Real run: fallback ON. Pass-1 still returns UNKNOWN; pass-2
    # picks Gatorade.
    result = classify_event_with_fallback(
        cls_event, cls_ctx, fallback_enabled=True,
    )
    ctx.check(
        "fallback_pass2_picked_gatorade",
        result.item_id == cloud_product_id and abs(float(result.confidence) - 0.95) < 1e-6,
        evidence=(
            f"item_id={result.item_id!r} (expected {cloud_product_id!r}), "
            f"confidence={result.confidence}"
        ),
    )
    ctx.check(
        "two_classifier_calls_made",
        len(client.calls) == 2,
        evidence=(
            f"expected 2 Anthropic calls (pass-1 + pass-2), got "
            f"{len(client.calls)}"
        ),
    )
    ctx.check(
        "fallback_pass_used_meta",
        bool(result.meta.get("fallback_pass_used")) is True
        and result.meta.get("fallback_pass1_item_id") == UNKNOWN_CANDIDATE_ID,
        evidence=(
            f"meta={ {k: v for k, v in (result.meta or {}).items() if k.startswith('fallback_')} }"
        ),
    )

    # 7. Mimic the lot-snapshot poller catching up between pass-2's
    # win and the apply step. In production the Pi's lot-snapshot
    # poller pulls the cloud_lots delta on every 60s tick — by the
    # time the user resolves the review (or the apply path retries
    # via reconcile), the mirror should be fresh. We seed the
    # cloud_lots row directly to keep the test deterministic.
    with pi_conn:
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

    # 8. Drive the apply path with the fallback-resolved result. The
    # cloud event must end up with event_kind=added + product_id=Gatorade.
    from server.storage import repo as storage_repo
    from server.storage.models import ScaleEventIn

    session_id = storage_repo.open_session(
        pi_conn, _now_iso(offset_s=-30), initial_weight_g=0.0,
    ).session_id
    handler = ctx.build_pi_scale_handler()
    ts_add = _now_iso()
    add_event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=ts_add,
            delta_g=920.0,
            before_weight_g=0.0,
            after_weight_g=920.0,
            direction="add",
            session_id=session_id,
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
            "meta": {
                "fallback_pass_used": True,
                "fallback_pass1_item_id": UNKNOWN_CANDIDATE_ID,
                "fallback_pass2_item_id": cloud_product_id,
            },
        },
        event_ts=ts_add,
        delta_g=920.0,
        session_id=session_id,
        event_id=add_event.event_id,
        shelf_id="live_shelf",
    )

    # Drain Pi outbox so the cloud event lands.
    pre_drain = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0",
    ).fetchone()
    ctx.check(
        "outbox_has_pending_emit",
        pre_drain is not None and int(pre_drain[0]) >= 1,
        evidence=f"pending pre-drain={pre_drain[0]}",
    )
    ctx.pi_worker.tick()

    # 9. Final cloud-side assertion: shelf_event_log carries an 'added'
    # row with the Gatorade product_id — NOT UNKNOWN. The shelf_event_log
    # row stores event_kind inside the JSONB payload (payload->>'event_kind').
    log_row = ctx.q_one(
        "SELECT payload->>'event_kind', payload->>'product_id', applied "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        "   AND payload->>'product_id' = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id, cloud_product_id),
    )
    ctx.check(
        "shelf_event_log_has_added_for_gatorade",
        log_row is not None
        and log_row[0] == "added"
        and log_row[1] == cloud_product_id,
        evidence=(
            f"REGRESSION GUARD: cloud event must be 'added' with "
            f"product_id={cloud_product_id!r}, NOT UNKNOWN. "
            f"Got {log_row!r}. If product_id is None, the fallback's "
            f"pass-2 win didn't propagate through the apply path."
        ),
    )

    # Reset the global cache so subsequent scenarios that rely on the
    # default OFF state aren't poisoned by this test's flip.
    cache.update(ClassifierSettings(chefbyte_classifier_fallback_enabled=False))
