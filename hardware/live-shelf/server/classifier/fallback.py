"""Opt-in classifier fallback — two-pass orchestration.

When the user has flipped ``hub.profiles.chefbyte_classifier_fallback_enabled``
in the web UI (mirrored to the Pi via the lot-snapshot poller's
settings cache), the classifier runs a SECOND pass against ALL
certified LiveTrack-tracked products IF the first pass returned UNKNOWN
or low confidence on the inventory-only pool.

Use case: today's chocolate-milk / Gatorade scenario. The Pi's
inventory-only pool was empty for a product the user IS tracking with
LiveTrack (certified + tare-captured) — they'd just depleted the
previous container off the shelf, the cloud_lots qty was 0, and
placing a fresh container produced UNKNOWN. With fallback on, the
second pass sees the certified LiveTrack catalog and identifies the
product correctly.

Design constraints:

* **Default off.** No behaviour change for existing users. The
  toggle must be flipped explicitly in Settings.
* **Pass-1 unchanged.** When the toggle is off, pass-1 runs exactly
  as before — no extra DB queries, no extra prompt assembly. The
  fallback path is gated on the toggle BEFORE any extra work.
* **Two thresholds, both module-level.** ``FALLBACK_TRIGGER_THRESHOLD``
  decides whether pass-1's confidence is low enough to consider
  pass-2; ``FALLBACK_ACCEPT_THRESHOLD`` decides whether pass-2's
  result is good enough to override pass-1. Tuning lives here, not
  per-user.
* **Same Anthropic client.** Pass-2 reuses the client passed in via
  ``ClassifierContext`` so tests can inject one fake that scripts
  both responses in order.
* **Telemetry on the result.** Every pass-2 invocation stamps
  ``meta["fallback_pass_used"] = True`` plus ``fallback_*`` audit
  fields. Lifecycle sink + scale_events.py read these to record a
  ``classifier_fallback_attempt`` lifecycle event without growing a
  new SQL table.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

from .candidate_pool import _ensure_sentinel_last, _rank_candidates
from .classify import classify_event
from .models import (
    UNKNOWN_CANDIDATE_ID,
    Candidate,
    CandidateSource,
    ClassificationResult,
    ClassifierContext,
    ProductCandidate,
    ScaleEvent,
)

logger = logging.getLogger(__name__)


# Pass-1 confidence below this triggers pass-2 consideration. 0.85 is
# the same line scale_events.py uses to decide whether a result is
# "confident enough to apply directly" (LOW_CONFIDENCE_THRESHOLD), so
# anything that would land in the review queue today is eligible for
# the fallback pass.
FALLBACK_TRIGGER_THRESHOLD = 0.85

# Pass-2 confidence must meet this to override pass-1. Set higher than
# FALLBACK_TRIGGER_THRESHOLD to avoid rubber-stamping a borderline
# pass-2 over a borderline pass-1 — fallback should only "win" when
# the model is meaningfully more sure on the expanded pool.
FALLBACK_ACCEPT_THRESHOLD = 0.9


def _build_fallback_pool(
    delta_g: float,
    source: CandidateSource,
    *,
    pool_top_n: int,
) -> list[Candidate]:
    """Assemble the fallback ADD pool — certified LiveTrack-tracked products.

    The pool is keyed on the source's ``get_certified_livetrack_tracked``
    method (added on :class:`RepoCandidateSource` for prod and
    duck-typed via ``getattr`` here for back-compat with simple test
    stubs that don't implement it). Returns are projected as
    ``why_candidate='catalog_not_on_shelf'`` candidates because the
    fallback semantic is "certified catalog product, possibly never
    seen on this shelf before" — same shape the classifier already
    knows how to handle.

    The UNKNOWN sentinel is appended last so the model can still
    return UNKNOWN if even the expanded pool doesn't fit.
    """
    fetcher = getattr(source, "get_certified_livetrack_tracked", None)
    if not callable(fetcher):
        # Stubs that don't implement the fallback fetcher: no fallback
        # data available, return empty (caller handles by falling
        # through to pass-1's UNKNOWN result).
        return _ensure_sentinel_last([])

    try:
        rows = list(fetcher())
    except Exception:  # noqa: BLE001 - never crash the classifier path
        logger.warning(
            "fallback: get_certified_livetrack_tracked raised — using empty pool",
            exc_info=True,
        )
        return _ensure_sentinel_last([])

    candidates: list[Candidate] = []
    for product in rows:
        # ``product`` is a ProductCandidate (cloud) or storage-shaped
        # row (local). We accept either: detect by attribute presence
        # rather than isinstance to keep the test surface tiny.
        product_id = getattr(product, "product_id", None)
        if not product_id:
            continue
        name = getattr(product, "name", "") or ""
        brand = getattr(product, "brand", None)
        expected = (
            getattr(product, "expected_weight_g", None)
            or getattr(product, "gross_weight_g", None)
            or getattr(product, "net_weight_g", None)
        )
        container_type = getattr(product, "container_type", None)
        reference_image_paths = (
            getattr(product, "reference_image_paths", None) or ()
        )
        candidates.append(
            Candidate(
                candidate_id=str(product_id),
                name=str(name),
                brand=brand,
                expected_weight_g=expected,
                container_type=container_type,
                why_candidate="catalog_not_on_shelf",
                reference_image_paths=tuple(reference_image_paths),
                product_id=str(product_id),
                lot_id=None,
            )
        )

    ranked = _rank_candidates(candidates, abs(delta_g))
    truncated = ranked[: max(0, pool_top_n - 1)]
    return _ensure_sentinel_last(truncated)


def _is_low_or_unknown(result: ClassificationResult) -> bool:
    """True if pass-1's result should trigger pass-2 consideration.

    Mirrors scale_events.py's ``is_unknown`` + low-confidence checks
    so the trigger condition matches what the apply path would
    otherwise reject.
    """
    item_id = result.item_id
    if item_id in (None, "", UNKNOWN_CANDIDATE_ID, "unknown"):
        return True
    return float(result.confidence or 0.0) < FALLBACK_TRIGGER_THRESHOLD


def classify_event_with_fallback(
    event: ScaleEvent,
    ctx: ClassifierContext,
    *,
    fallback_enabled: bool,
    model: Optional[str] = None,
) -> ClassificationResult:
    """Run pass-1 + (optionally) pass-2.

    When ``fallback_enabled`` is False (default user state), behaves
    identically to :func:`classify_event` — same result, same
    Anthropic call count, same meta payload. The pass-2 branch is
    not entered.

    When ``fallback_enabled`` is True AND pass-1's result is UNKNOWN /
    low confidence, runs a second classify against the expanded
    fallback pool. If pass-2 returns a real product (not UNKNOWN)
    with confidence >= :data:`FALLBACK_ACCEPT_THRESHOLD`, that
    result wins; otherwise pass-1's result is returned unchanged.

    The returned :class:`ClassificationResult` always carries
    ``meta["fallback_pass_attempted"]`` (True iff pass-2 ran) and,
    when ``fallback_pass_attempted`` is True, an additional
    ``meta["fallback_pass_used"]`` flag (True iff pass-2's result
    overrode pass-1's). Plus the pass-2 confidence + reasoning under
    ``meta["fallback_pass2"]`` for audit.

    Pass-2 is gated on ``event.direction == 'add'``. Remove events
    don't have an inventory-only matching problem (the REMOVE pool
    is the on-shelf state, not the cloud catalog), so fallback there
    would be both semantically wrong and a wasted Anthropic call.
    """
    pass1 = classify_event(event, ctx, model=model)

    # Stamp pass-2 audit fields on every result so downstream telemetry
    # can distinguish "pass-2 not attempted" from "pass-2 attempted but
    # didn't override". Use a fresh dict to avoid mutating the existing
    # meta in place — ClassificationResult is frozen so we'd need a new
    # instance to update meta anyway.
    if not fallback_enabled:
        return _stamp_meta(pass1, fallback_pass_attempted=False)

    if event.direction != "add":
        return _stamp_meta(pass1, fallback_pass_attempted=False)

    if not _is_low_or_unknown(pass1):
        # Pass-1 was confident — no need to spend another API call.
        return _stamp_meta(pass1, fallback_pass_attempted=False)

    pool2 = _build_fallback_pool(
        event.delta_g, ctx.source, pool_top_n=ctx.pool_top_n,
    )
    # An empty pool (no certified+tracked products in the user's
    # catalog) means there's nothing to match against — return pass-1
    # unchanged. ``_ensure_sentinel_last`` always appends UNKNOWN, so
    # ``len <= 1`` is the empty case.
    if len(pool2) <= 1:
        logger.info(
            "fallback: empty fallback pool — keeping pass-1 result for event %s",
            event.event_id,
        )
        return _stamp_meta(
            pass1,
            fallback_pass_attempted=True,
            fallback_pass_used=False,
            fallback_pass2_reason="empty_pool",
        )

    # Run pass-2 with the expanded pool. We assemble the prompt + call
    # the model directly here (rather than reusing classify_event)
    # because classify_event would re-derive the pool from the source
    # — which on a real Pi would just hand back the inventory-only
    # pool again. The send/parse logic is the same; we replicate the
    # minimum needed to drive the model with our pool override.
    from .anthropic_client import AnthropicClassifierClient
    from .classify import (
        MalformedClassifierOutput,
        _normalise_unknown,
        parse_response,
    )
    from .prompt import build_messages_payload

    payload = build_messages_payload(event, list(pool2))
    # Prefix the user-content with a note that this is a fallback
    # pass against certified items so the model knows to lean on the
    # expanded pool (rather than insisting it doesn't recognise any
    # of the items as on-shelf inventory). We prepend a fresh text
    # block at the top of the user message, BEFORE the candidate JSON,
    # so it's the first thing the model reads. This sits before the
    # cache breakpoint, which is fine — pass-2 only fires on
    # individual events that already failed pass-1, so we don't gain
    # much from caching across pass-2 calls.
    fallback_note = {
        "type": "text",
        "text": (
            "FALLBACK PASS — the inventory-only pool did not yield a "
            "confident match. The candidate list below is the user's "
            "certified LiveTrack-tracked catalog. Match against it "
            "using the visible product image. Return UNKNOWN only if "
            "you genuinely cannot recognise any of the listed products "
            "in the after-frame."
        ),
    }
    try:
        payload["messages"][0]["content"].insert(0, fallback_note)
    except (KeyError, IndexError, TypeError, AttributeError):
        # Defensive: if the payload shape ever changes upstream,
        # silently skip the prefix rather than crash the classifier.
        # The pool itself is the primary signal anyway.
        logger.warning(
            "fallback: could not prepend pass-2 instruction note",
            exc_info=True,
        )

    client = ctx.anthropic_client
    if client is None:
        client = AnthropicClassifierClient()
    elif not hasattr(client, "send"):
        client = AnthropicClassifierClient(client=client)

    try:
        call_result = client.send(payload, model=model)
    except Exception as exc:  # noqa: BLE001 - same defensive shape as classify_event
        logger.warning(
            "fallback: pass-2 API call raised: %s — keeping pass-1 result",
            exc,
        )
        return _stamp_meta(
            pass1,
            fallback_pass_attempted=True,
            fallback_pass_used=False,
            fallback_pass2_reason=f"api_error:{type(exc).__name__}",
        )

    try:
        pass2 = parse_response(
            call_result.text,
            candidate_pool_used=list(pool2),
            meta={
                "model": call_result.model,
                "usage": call_result.usage,
                "fallback_pass2_raw_text": call_result.text,
            },
        )
    except MalformedClassifierOutput as exc:
        logger.warning(
            "fallback: pass-2 parse failed: %s — keeping pass-1 result", exc,
        )
        return _stamp_meta(
            pass1,
            fallback_pass_attempted=True,
            fallback_pass_used=False,
            fallback_pass2_reason=f"parse_error:{exc}",
        )

    pass2 = _normalise_unknown(pass2)
    pass2_unknown = pass2.item_id in (
        None, "", UNKNOWN_CANDIDATE_ID, "unknown",
    )
    pass2_conf = float(pass2.confidence or 0.0)

    if pass2_unknown or pass2_conf < FALLBACK_ACCEPT_THRESHOLD:
        logger.info(
            "fallback: pass-2 not confident enough (item=%s conf=%.3f) — "
            "keeping pass-1 for event %s",
            pass2.item_id, pass2_conf, event.event_id,
        )
        return _stamp_meta(
            pass1,
            fallback_pass_attempted=True,
            fallback_pass_used=False,
            fallback_pass2_item_id=pass2.item_id,
            fallback_pass2_confidence=pass2_conf,
            fallback_pass2_reason="low_confidence" if not pass2_unknown else "unknown",
        )

    # Pass-2 wins. Return a NEW ClassificationResult that carries
    # pass-2's identification but stamps the audit fields so
    # downstream code (scale_events.py + reconciler) can tell this
    # was a fallback-driven match.
    logger.info(
        "fallback: pass-2 wins for event %s (item=%s conf=%.3f, "
        "pass-1 was item=%s conf=%.3f)",
        event.event_id, pass2.item_id, pass2_conf,
        pass1.item_id, float(pass1.confidence or 0.0),
    )
    merged_meta: dict[str, Any] = {
        **(pass2.meta or {}),
        "fallback_pass_attempted": True,
        "fallback_pass_used": True,
        "fallback_pass1_item_id": pass1.item_id,
        "fallback_pass1_confidence": float(pass1.confidence or 0.0),
        "fallback_pass2_item_id": pass2.item_id,
        "fallback_pass2_confidence": pass2_conf,
    }
    # Use dataclasses.replace so any field added to ClassificationResult
    # later (e.g. estimated_tare_g — Task 7+8) threads through
    # automatically. Manual per-field reconstruction was the bug — it
    # silently dropped any new field whenever this site rebuilt the
    # result.
    return dataclasses.replace(pass2, meta=merged_meta)


def _stamp_meta(
    result: ClassificationResult,
    **fields: Any,
) -> ClassificationResult:
    """Return a copy of ``result`` with extra meta fields layered on.

    ``ClassificationResult`` is frozen, so we have to construct a new
    instance. Used by the early-out branches to ensure every result
    coming out of this orchestrator carries the audit fields the
    caller's logging path expects.

    Uses :func:`dataclasses.replace` rather than per-field enumeration
    so any field added to ``ClassificationResult`` later (e.g.
    ``estimated_tare_g`` — Task 7+8 catch-all auto-import) threads
    through automatically. The previous manual-reconstruction
    implementation silently stripped new fields, which was caught by
    the Task 7 reviewer as a regression risk.
    """
    merged = {**(result.meta or {}), **fields}
    return dataclasses.replace(result, meta=merged)


__all__ = [
    "FALLBACK_ACCEPT_THRESHOLD",
    "FALLBACK_TRIGGER_THRESHOLD",
    "classify_event_with_fallback",
]
