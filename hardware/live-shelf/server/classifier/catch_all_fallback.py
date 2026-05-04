"""Two-pass catch-all classifier orchestrator.

The catch-all scale classifies in TWO passes when the standard
single-pool match doesn't converge:

  1. **Pass 1 — certified inventory.** Build the catch-all pool from
     ONLY in-flight catch-all lots + qty>0 inventory whose product is
     ``certified=true``. Run the classifier. If it returns a real
     ``item_id`` (in-pool) with confidence >= ``LOW_CONFIDENCE_THRESHOLD``
     we accept it — meta stamps ``catch_all_pass=1`` and
     ``needs_certify=False`` (already certified, no auto-import write).

  2. **Pass 2 — uncertified inventory.** When pass-1 returned UNKNOWN /
     low confidence, re-run against ONLY qty>0 inventory whose product
     is uncertified. If that pass returns a real ``item_id`` (in-pool)
     with confidence >= ``LOW_CONFIDENCE_THRESHOLD`` we accept it —
     meta stamps ``catch_all_pass=2`` and ``needs_certify=True`` so
     the dispatch path pushes ``certified=true`` to cloud
     (``/shelf-ingest/product-tare`` set-once, like ``tare_weight_g``
     and ``measured_full_at``).

  3. **Both fail.** Fall back to pass-1's UNKNOWN result — no auto-
     certify, no fabricated match. ``catch_all_pass`` is stamped to 2
     so operators can tell pass-2 was attempted but did not converge.

This module is the catch-all-only sibling to
:mod:`server.classifier.fallback` (which handles the live-shelf
opt-in fallback). The two paths intentionally do NOT share an
implementation: the live-shelf orchestrator gates on a per-user
toggle and runs against a different pool source (certified
LiveTrack-tracked products), whereas the catch-all orchestrator
ALWAYS runs both passes and uses the lot-keyed catch-all pool
sources.

Live-shelf classification path is OUT OF SCOPE — this module never
fires for ``shelf_id != 'catch_all'``.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

from .candidate_pool import (
    pool_for_catch_all_pass1,
    pool_for_catch_all_pass2,
)
from .classify import (
    MalformedClassifierOutput,
    _normalise_unknown,
    parse_response,
)
from .models import (
    UNKNOWN_CANDIDATE_ID,
    Candidate,  # used in _is_in_pool typing
    ClassificationResult,
    ClassifierContext,
    ScaleEvent,
)
from .prompt import build_catch_all_messages_payload

logger = logging.getLogger(__name__)


# Mirror the existing scale_events.py LOW_CONFIDENCE_THRESHOLD (0.75) —
# anything at or above this is "confident enough to apply directly"; below
# it we either fall through to pass-2 (after pass-1) or to the legacy
# review path (after pass-2). Keeping the constant local rather than
# importing scale_events avoids a circular dependency at module-load time
# and lets tests tune it independently.
LOW_CONFIDENCE_THRESHOLD = 0.75


def _is_unknown_or_low(result: ClassificationResult) -> bool:
    """True if the pass should be considered insufficient.

    Mirrors the scale_events.py ``is_unknown`` guard: UNKNOWN id, low
    confidence, or empty/missing item_id all signal "no confident match".
    """
    item_id = result.item_id
    if item_id in (None, "", UNKNOWN_CANDIDATE_ID, "unknown"):
        return True
    return float(result.confidence or 0.0) < LOW_CONFIDENCE_THRESHOLD


def _run_pass(
    event: ScaleEvent,
    ctx: ClassifierContext,
    pool: list[Candidate],
    *,
    instruction_note: str,
    model: Optional[str],
    pass_label: str,
) -> Optional[ClassificationResult]:
    """Build payload, send to Anthropic, parse response — for one pass.

    Returns ``None`` if the pool is effectively empty (only the UNKNOWN
    sentinel) so the caller can short-circuit without spending an API
    call. Returns a parsed :class:`ClassificationResult` otherwise (with
    the standard ``_normalise_unknown`` post-processing applied, mirroring
    :func:`server.classifier.classify.classify_event`).

    Errors are logged and converted to ``None`` so the caller can fall
    through gracefully — the dispatch path treats a missing pass result
    the same as UNKNOWN.
    """
    if len(pool) <= 1:
        # Only the UNKNOWN sentinel — no real candidates to classify
        # against. Skip the API call.
        return None

    payload = build_catch_all_messages_payload(event, list(pool))
    note = {
        "type": "text",
        "text": instruction_note,
    }
    try:
        # Prepend the note before the JSON candidate list so the model
        # reads the pass intent first. Mirrors the live-shelf fallback
        # injection at server/classifier/fallback.py:262.
        payload["messages"][0]["content"].insert(0, note)
    except (KeyError, IndexError, TypeError, AttributeError):
        logger.warning(
            "catch_all_fallback: could not prepend %s instruction note",
            pass_label,
            exc_info=True,
        )

    # Resolve client lazily — same shape as classify_event uses, so
    # tests can inject a fake via ctx.anthropic_client. We import here
    # to avoid a top-level cycle (anthropic_client → models →
    # classifier surface).
    from .anthropic_client import AnthropicClassifierClient

    client = ctx.anthropic_client
    if client is None:
        client = AnthropicClassifierClient()
    elif not hasattr(client, "send"):
        client = AnthropicClassifierClient(client=client)

    try:
        call_result = client.send(payload, model=model)
    except Exception:  # noqa: BLE001 — never crash the dispatch path
        logger.exception(
            "catch_all_fallback: %s API call raised", pass_label,
        )
        return None

    try:
        parsed = parse_response(
            call_result.text,
            candidate_pool_used=list(pool),
            meta={
                "model": call_result.model,
                "usage": call_result.usage,
                f"catch_all_{pass_label}_raw_text": call_result.text,
            },
        )
    except MalformedClassifierOutput:
        logger.warning(
            "catch_all_fallback: %s parse failed", pass_label,
            exc_info=True,
        )
        return None
    return _normalise_unknown(parsed)


def _stamp_meta(
    result: ClassificationResult,
    **fields: Any,
) -> ClassificationResult:
    """Return a copy of ``result`` with extra meta fields layered on.

    :class:`ClassificationResult` is frozen so we have to construct a
    new instance via :func:`dataclasses.replace`.
    """
    merged = {**(result.meta or {}), **fields}
    return dataclasses.replace(result, meta=merged)


def _is_in_pool(
    result: ClassificationResult, pool: list[Candidate]
) -> bool:
    """True if ``result.item_id`` is one of the candidate ids in ``pool``.

    Defends against model hallucination: an out-of-pool id MUST be
    treated as UNKNOWN even if the confidence is high. Mirrors the
    dispatch path's hallucination guard at
    :file:`handlers/scale_events.py:2334`.
    """
    item_id = result.item_id
    if not item_id:
        return False
    cid = str(item_id)
    if cid == UNKNOWN_CANDIDATE_ID:
        # Sentinel always "matches" — caller checks UNKNOWN separately.
        return True
    for c in pool:
        if c.candidate_id and str(c.candidate_id) == cid:
            return True
        if c.lot_id and str(c.lot_id) == cid:
            return True
    return False


def classify_catch_all_with_fallback(
    event: ScaleEvent,
    ctx: ClassifierContext,
    *,
    model: Optional[str] = None,
) -> ClassificationResult:
    """Run pass-1 (certified-only); fall back to pass-2 (uncertified-only).

    See module docstring for the full state machine. The returned
    :class:`ClassificationResult` always carries the following meta
    fields so the dispatch path can audit and route correctly:

      * ``catch_all_pass``         — 1 or 2; which pass produced the
                                     accepted result (or last-attempted).
      * ``needs_certify``          — True iff pass-2 won; signals the
                                     dispatch auto-import block to push
                                     ``certified=true`` to cloud.
      * ``catch_all_pass1_item_id`` / ``..._confidence`` — pass-1 raw
                                     output for telemetry. Always present
                                     when pass-1 ran.
      * ``catch_all_pass2_item_id`` / ``..._confidence`` — pass-2 raw
                                     output (only present when pass-2
                                     ran).

    Pass-1 runs UNCONDITIONALLY (the "match against trusted inventory"
    pass). Pass-2 runs only when pass-1 was UNKNOWN / low confidence
    AND pass-2's pool has at least one real candidate.
    """
    # ----- Pass 1 ------------------------------------------------------
    pool1 = pool_for_catch_all_pass1(event.delta_g, ctx)
    pass1_note = (
        "CATCH-ALL PASS 1 of 2 — match against the user's CERTIFIED "
        "LiveTrack-tracked inventory (already-calibrated products plus "
        "any lots currently mid-measurement on the catch-all). The "
        "candidate JSON below carries every certified inventory lot. "
        "Return UNKNOWN if you can't confidently identify the placed "
        "item among them — a separate uncertified pass will follow."
    )
    pass1: Optional[ClassificationResult] = None
    if len(pool1) > 1:
        pass1 = _run_pass(
            event, ctx, pool1,
            instruction_note=pass1_note,
            model=model,
            pass_label="pass1",
        )

    # If pass-1 produced a confident, in-pool match — accept and stop.
    if pass1 is not None and not _is_unknown_or_low(pass1):
        if _is_in_pool(pass1, pool1):
            return _stamp_meta(
                pass1,
                catch_all_pass=1,
                needs_certify=False,
                catch_all_pass1_item_id=pass1.item_id,
                catch_all_pass1_confidence=float(pass1.confidence or 0.0),
            )
        # Hallucinated id — treat as low-confidence so we still try pass-2.
        logger.warning(
            "catch_all_fallback: pass-1 returned out-of-pool id %r; "
            "treating as low-confidence and continuing to pass-2",
            pass1.item_id,
        )

    # ----- Pass 2 ------------------------------------------------------
    pool2 = pool_for_catch_all_pass2(event.delta_g, ctx)
    if len(pool2) <= 1:
        # No uncertified inventory to match against. Return pass-1's
        # result as-is (or fabricate an UNKNOWN if pass-1 never ran
        # because its pool was also empty). ``catch_all_pass`` is
        # stamped to 2 so operators can see the second pass was at
        # least *considered* — even though we never spent an API call.
        if pass1 is not None:
            return _stamp_meta(
                pass1,
                catch_all_pass=2,
                needs_certify=False,
                catch_all_pass1_item_id=pass1.item_id,
                catch_all_pass1_confidence=float(pass1.confidence or 0.0),
                catch_all_pass2_item_id=None,
                catch_all_pass2_confidence=0.0,
            )
        # Both pools empty — no signal at all. Synthesise UNKNOWN.
        return _stamp_meta(
            ClassificationResult.unknown(
                reasoning=(
                    "catch-all two-pass: no candidates available "
                    "(both certified and uncertified pools empty)"
                ),
                candidate_pool_used=tuple(pool1 or pool2 or []),
                meta={},
            ),
            catch_all_pass=2,
            needs_certify=False,
            catch_all_pass1_item_id=None,
            catch_all_pass1_confidence=0.0,
            catch_all_pass2_item_id=None,
            catch_all_pass2_confidence=0.0,
        )

    pass2_note = (
        "CATCH-ALL PASS 2 of 2 — the certified-inventory pass did not "
        "yield a confident match. The candidate JSON below is the user's "
        "UNCERTIFIED inventory (products owned but not yet promoted via "
        "LiveTrack). Match against it using the visible product. A "
        "confident match here will graduate the product to "
        "LiveTrack-tracked. Return UNKNOWN only if you genuinely cannot "
        "recognise the placed item among the listed products."
    )
    pass2 = _run_pass(
        event, ctx, pool2,
        instruction_note=pass2_note,
        model=model,
        pass_label="pass2",
    )
    pass1_item_id = pass1.item_id if pass1 is not None else None
    pass1_conf = float(pass1.confidence or 0.0) if pass1 is not None else 0.0

    if pass2 is not None and not _is_unknown_or_low(pass2):
        if _is_in_pool(pass2, pool2):
            return _stamp_meta(
                pass2,
                catch_all_pass=2,
                needs_certify=True,
                catch_all_pass1_item_id=pass1_item_id,
                catch_all_pass1_confidence=pass1_conf,
                catch_all_pass2_item_id=pass2.item_id,
                catch_all_pass2_confidence=float(pass2.confidence or 0.0),
            )
        logger.warning(
            "catch_all_fallback: pass-2 returned out-of-pool id %r; "
            "falling back to UNKNOWN",
            pass2.item_id,
        )

    # Both passes failed — return pass-1's UNKNOWN-shaped result with
    # pass-2 telemetry stamped. Falls back to a fresh UNKNOWN if pass-1
    # never ran (empty pool-1).
    base = pass1 if pass1 is not None else ClassificationResult.unknown(
        reasoning="catch-all two-pass: both passes returned UNKNOWN",
        candidate_pool_used=tuple(pool1 or []),
        meta={},
    )
    pass2_item_id = pass2.item_id if pass2 is not None else None
    pass2_conf = float(pass2.confidence or 0.0) if pass2 is not None else 0.0
    return _stamp_meta(
        base,
        catch_all_pass=2,
        needs_certify=False,
        catch_all_pass1_item_id=pass1_item_id,
        catch_all_pass1_confidence=pass1_conf,
        catch_all_pass2_item_id=pass2_item_id,
        catch_all_pass2_confidence=pass2_conf,
    )


__all__ = [
    "LOW_CONFIDENCE_THRESHOLD",
    "classify_catch_all_with_fallback",
]
