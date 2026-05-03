"""Top-level classifier orchestration.

Implements the ``classify_event(event, ctx)`` contract in §4.5 of
hardware/live-shelf/docs/plan.md:

  1. Build the direction-scoped candidate pool (§6).
  2. Assemble the multimodal prompt (§7.1).
  3. Call Anthropic (§7.2) with caching (§7.3).
  4. Parse the JSON response strictly. On malformed output: log + retry
     once; on second failure return a safe "unknown" result.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from typing import Any, Optional

from .anthropic_client import AnthropicClassifierClient, ClassifierCallResult
from .candidate_pool import pool_for_add, pool_for_catch_all, pool_for_remove
from .models import (
    UNKNOWN_CANDIDATE_ID,
    Candidate,
    ClassificationResult,
    ClassifierAction,
    ClassifierContext,
    ScaleEvent,
    SecondaryCandidate,
)
from .prompt import build_catch_all_messages_payload, build_messages_payload

logger = logging.getLogger(__name__)


# Module-level rate-limit for the cold-start WARNING (finding #7). Once
# the first cold-start fires we switch to DEBUG so a Pi that stays
# offline for the first 100 classifier calls doesn't flood the log.
# Flipped back to False by ``reset_cold_start_warn_state`` — app.py may
# call this after a successful catalog fetch so the warning resumes if
# the source regresses to cold-start later (e.g. catalog invalidation).
_cold_start_warned: bool = False


def reset_cold_start_warn_state() -> None:
    """Re-arm the cold-start warning after a successful catalog fetch.

    Exposed so callers (e.g. the cloud sync code) can re-enable the
    one-shot warning if the source transitions back into cold-start
    territory. Test helper as well.
    """
    global _cold_start_warned
    _cold_start_warned = False


# Optional lifecycle sink set by app.py. Signature::
#
#     sink(event_id: str | None, *, actor: str, reason_code: str,
#          payload: dict | None = None) -> None
#
# Unset (= None) during bare tests so imports stay free of DB deps.
_LIFECYCLE_SINK: Optional[Any] = None


def set_lifecycle_sink(sink: Optional[Any]) -> None:
    global _LIFECYCLE_SINK
    _LIFECYCLE_SINK = sink


def _lc(event_id: Optional[str], *, actor: str, reason_code: str,
        payload: Optional[dict[str, Any]] = None) -> None:
    sink = _LIFECYCLE_SINK
    if sink is None or not event_id:
        return
    try:
        sink(event_id, actor=actor, reason_code=reason_code, payload=payload)
    except Exception:  # pragma: no cover - observability must not raise
        logger.warning("classifier lifecycle sink raised", exc_info=True)


def _prompt_hash(payload: dict[str, Any]) -> str:
    """Return an md5 of the prompt text blocks for timeline correlation."""
    try:
        blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    except Exception:
        blob = repr(payload).encode("utf-8", "replace")
    return hashlib.md5(blob).hexdigest()[:16]


_VALID_ACTIONS: set[ClassifierAction] = {
    "removed",
    "added",
    "added_to_existing",
    "unknown",
}


class MalformedClassifierOutput(Exception):
    """Raised when the model's response can't be parsed as the §4.5 schema."""


def _is_transient_api_error(exc: BaseException) -> bool:
    """Return True for transient Anthropic SDK errors.

    Rate limits (429), overloaded (529), and raw connection errors are
    expected-but-recoverable failure modes. The SDK retries them itself
    with exponential backoff (see ``max_retries`` in anthropic_client.py);
    if one bubbles up to us here it means those retries were exhausted.
    We still return UNKNOWN so the event goes to review, but the
    distinction makes log triage much faster.
    """

    try:
        import anthropic  # type: ignore[import-untyped]
    except ImportError:
        # If the SDK isn't installed we can't identify its exception types.
        # Any exception reaching here in that environment is "not transient"
        # — the test harness doesn't go through the real SDK anyway.
        return False

    transient_types: tuple[type[BaseException], ...] = tuple(
        t for t in (
            getattr(anthropic, "RateLimitError", None),
            getattr(anthropic, "InternalServerError", None),
            getattr(anthropic, "APIConnectionError", None),
            getattr(anthropic, "APITimeoutError", None),
        )
        if isinstance(t, type)
    )
    return bool(transient_types) and isinstance(exc, transient_types)


# --- JSON extraction / validation -----------------------------------------


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _find_balanced_json(text: str, start: int) -> int:
    """Return the index of the ``}`` that matches the ``{`` at ``start``.

    Walks the string tracking brace depth while respecting JSON string
    literals (``"..."`` with ``\\`` escapes) so braces inside strings are
    ignored. Returns -1 if no balanced closer is found.
    """

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _extract_json(text: str) -> str:
    """Best-effort: strip code fences and grab the first top-level JSON object.

    The model is instructed to emit only JSON, but models occasionally
    wrap output in ```json ... ``` fences or add a leading/trailing line.
    We unwrap fences and, failing that, walk the first ``{`` forward
    tracking brace depth (skipping braces inside string literals) to find
    the matching closer — more reliable than a naive ``rfind("}")`` when
    the payload is followed by prose that contains a ``}``.
    """

    text = (text or "").strip()
    if not text:
        raise MalformedClassifierOutput("Empty response")

    match = _FENCE_RE.search(text)
    if match:
        return match.group(1).strip()

    # Walk from the first `{` counting brace depth to find the matching
    # closer. Handles trailing prose that contains a `}` and objects with
    # nested `}` inside reasoning strings.
    start = text.find("{")
    if start == -1:
        raise MalformedClassifierOutput("No JSON object found in response")
    end = _find_balanced_json(text, start)
    if end == -1:
        # Fall back to the original string — downstream json.loads will
        # raise a descriptive MalformedClassifierOutput.
        return text
    return text[start : end + 1]


def _coerce_action(value: Any) -> ClassifierAction:
    if not isinstance(value, str) or value not in _VALID_ACTIONS:
        raise MalformedClassifierOutput(f"Invalid action: {value!r}")
    return value  # type: ignore[return-value]


def _coerce_confidence(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise MalformedClassifierOutput(f"confidence not a number: {value!r}") from exc
    if not 0.0 <= result <= 1.0:
        # Clamp rather than reject — the model occasionally emits 0..100.
        # Anything outside [0,1] is suspicious; clamp and log.
        logger.warning(
            "classifier: confidence %r out of range, clamping into [0,1]",
            value,
        )
        result = max(0.0, min(1.0, result))
    return result


def _coerce_secondary(block: Any) -> list[SecondaryCandidate]:
    if block is None:
        return []
    if not isinstance(block, list):
        raise MalformedClassifierOutput(
            f"secondary / multi_match must be a list, got {type(block).__name__}"
        )
    out: list[SecondaryCandidate] = []
    for entry in block:
        if not isinstance(entry, dict):
            raise MalformedClassifierOutput(
                f"secondary entry must be an object, got {type(entry).__name__}"
            )
        cid = entry.get("candidate_id")
        conf = entry.get("confidence")
        if not isinstance(cid, str):
            raise MalformedClassifierOutput(
                f"secondary entry missing candidate_id string: {entry!r}"
            )
        out.append(
            SecondaryCandidate(
                candidate_id=cid,
                confidence=_coerce_confidence(conf if conf is not None else 0.0),
            )
        )
    return out


def parse_response(
    text: str,
    candidate_pool_used: list[Candidate],
    *,
    meta: dict[str, Any] | None = None,
) -> ClassificationResult:
    """Parse the model's JSON text into a :class:`ClassificationResult`.

    Raises :class:`MalformedClassifierOutput` if the payload doesn't match
    the §4.5 schema closely enough to be trusted.
    """

    raw_json = _extract_json(text)
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise MalformedClassifierOutput(f"Invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise MalformedClassifierOutput(
            f"Top-level JSON must be an object, got {type(data).__name__}"
        )

    item_id = data.get("item_id")
    if not isinstance(item_id, str) or not item_id:
        raise MalformedClassifierOutput(f"item_id missing or not a string: {item_id!r}")

    action = _coerce_action(data.get("action"))
    confidence = _coerce_confidence(data.get("confidence", 0.0))

    reasoning = data.get("reasoning", "")
    if not isinstance(reasoning, str):
        raise MalformedClassifierOutput(
            f"reasoning must be a string, got {type(reasoning).__name__}"
        )

    # The §4.5 schema splits secondary results between "secondary_candidates"
    # (ADD events) and "multi_match" (REMOVE events). Accept both keys and
    # place them into the right field on the result.
    secondary = _coerce_secondary(data.get("secondary_candidates"))
    multi_match = _coerce_secondary(data.get("multi_match"))

    # Catch-all auto-import: optional estimated_tare_g. Validated:
    # must be > 0 and finite. Out-of-range / non-numeric → silently
    # dropped (None). The apply path is the source of truth for whether
    # to write — it cross-checks against measured weight to reject
    # impossible values (tare > scale_reading). We deliberately do NOT
    # raise MalformedClassifierOutput here: the rest of the
    # classification (item_id, action, confidence) is still useful even
    # when the model fumbled the optional tare field.
    estimated_tare_g: float | None = None
    raw_tare = data.get("estimated_tare_g")
    if raw_tare is not None:
        try:
            tare_val = float(raw_tare)
            if tare_val > 0.0 and math.isfinite(tare_val):
                estimated_tare_g = tare_val
        except (TypeError, ValueError):
            pass

    return ClassificationResult(
        item_id=item_id,
        action=action,
        confidence=confidence,
        reasoning=reasoning,
        secondary_candidates=tuple(secondary),
        multi_match=tuple(multi_match),
        candidate_pool_used=tuple(candidate_pool_used),
        meta=meta or {},
        estimated_tare_g=estimated_tare_g,
    )


# --- Entry point ----------------------------------------------------------


def _is_cold_start(source: Any) -> bool:
    """Return True if ``source`` is cloud-backed and has no catalog yet.

    The cold-start guard uses duck typing (``has_catalog``) rather than
    isinstance so tests + legacy sources don't need to import the cloud
    module. Any CandidateSource that exposes a ``has_catalog()`` method
    which returns False is treated as "not ready" — the method is absent
    on the legacy sqlite-backed source so legacy mode never trips this
    branch.

    If ``has_catalog()`` itself raises, treat the source as cold
    (return True). The previous behaviour was to return False and fall
    through to the downstream pool assembly — but that path crashes
    Anthropic with an empty/corrupt pool and costs a real API call
    every time. The safer default is "short-circuit to UNKNOWN and
    log" — finding #6 in the deep audit.
    """

    has_catalog = getattr(source, "has_catalog", None)
    if not callable(has_catalog):
        return False
    try:
        return not bool(has_catalog())
    except Exception:
        logger.warning(
            "classifier: has_catalog() raised — treating source as cold-start",
            exc_info=True,
        )
        return True


def _build_pool(event: ScaleEvent, ctx: ClassifierContext) -> list[Candidate]:
    """Choose between ADD / catch-all / REMOVE pools based on shelf + direction.

    **2026-04-27 catch-all delta-capture (CATCH_ALL_SCALE_PLAN.md):** an
    ADD event on the catch-all shelf uses a dedicated single-pool
    composition (in-flight catch-all lots + qty>0 user-inventory lots
    + UNKNOWN). Tier 2 was widened on 2026-05-02 from certified-only
    to all qty>0 inventory; see ``pool_for_catch_all`` for the
    rationale. REMOVE on the catch-all uses the default REMOVE pool —
    catch-all REMOVEs are rare (user picks the bottle off the measuring
    station) and are handled by the same on-shelf rank logic. Live_shelf
    events use the existing pool_for_add / pool_for_remove paths.
    """
    shelf_id = getattr(ctx, "shelf_id", None)

    if event.direction == "add":
        if shelf_id == "catch_all":
            return pool_for_catch_all(event.delta_g, ctx)
        return pool_for_add(event.delta_g, ctx)
    if event.direction == "remove":
        return pool_for_remove(event.delta_g, ctx)
    # Noise events aren't routed through the classifier in practice; but
    # if one slips through, treat it like an empty REMOVE so we don't crash.
    logger.info("classifier: event direction=%r — returning empty pool", event.direction)
    return []


def _unknown_result(
    reason: str,
    pool: list[Candidate],
    meta: dict[str, Any],
) -> ClassificationResult:
    logger.warning("classifier: falling back to UNKNOWN: %s", reason)
    return ClassificationResult.unknown(
        reasoning=reason,
        candidate_pool_used=pool,
        meta=meta,
    )


def classify_event(
    event: ScaleEvent,
    ctx: ClassifierContext,
    *,
    model: str | None = None,
) -> ClassificationResult:
    """Classify one scale event and return a typed result (§4.5).

    On malformed output: log, retry once, and — if still malformed —
    return a :class:`ClassificationResult` with ``action="unknown"``,
    ``confidence=0``, and a descriptive reasoning string.

    Args:
        event: The scale event carrying before/after frame paths and delta.
        ctx: Classifier context. Must carry a :class:`CandidateSource`. If
            ``ctx.anthropic_client`` is set, it is used directly (used by
            tests); otherwise a fresh :class:`AnthropicClassifierClient` is
            built on demand.
        model: Optional model override (``claude-haiku-4-5`` for the "cheap
            path" described in §7.2).
    """

    # Cold-start guard: when the classifier is running against a
    # cloud-backed candidate source that has never successfully fetched
    # the catalog, short-circuit to UNKNOWN. We deliberately don't crash
    # and don't call Anthropic — the correct behaviour when "we have
    # nothing to match against" is the same as "evidence doesn't
    # converge", per §4.5 of the plan.
    if _is_cold_start(ctx.source):
        # Finding #7: rate-limit the WARNING to one-per-process. A Pi
        # that boots without cloud connectivity will otherwise log
        # this on every scale event. The first fire is WARNING so it
        # reaches the nightly log review; subsequent fires drop to
        # DEBUG so they're silent in production. ``reset_cold_start_warn_state``
        # re-arms the warning if the source regresses to cold-start.
        global _cold_start_warned
        if not _cold_start_warned:
            logger.warning(
                "classifier: cold-start guard — cloud catalog not yet "
                "fetched for event %s (direction=%s, delta=%.1fg); "
                "returning UNKNOWN. Further cold-start events will log "
                "at DEBUG until the catalog is fetched.",
                event.event_id,
                event.direction,
                event.delta_g,
            )
            _cold_start_warned = True
        else:
            logger.debug(
                "classifier: cold-start (suppressed) event=%s direction=%s delta=%.1fg",
                event.event_id,
                event.direction,
                event.delta_g,
            )
        cold_meta: dict[str, Any] = {
            "event_id": event.event_id,
            "direction": event.direction,
            "delta_g": event.delta_g,
            "pool_size": 0,
            "cold_start": True,
        }
        return ClassificationResult.unknown(
            reasoning="catalog not yet fetched",
            candidate_pool_used=(),
            meta=cold_meta,
        )

    # Non-cold path: reset the one-shot warning so a later regression
    # back into cold-start (catalog invalidation, cloud outage after
    # refresh) fires a fresh WARNING rather than silently debug-logging.
    if _cold_start_warned:
        reset_cold_start_warn_state()

    pool = _build_pool(event, ctx)
    meta: dict[str, Any] = {
        "event_id": event.event_id,
        "direction": event.direction,
        "delta_g": event.delta_g,
        "pool_size": len(pool),
    }

    # Edge case: empty pool with a direction we don't have candidates for.
    if not pool and event.direction in ("add", "remove"):
        meta["empty_pool"] = True
        # For ADD we still include the UNKNOWN sentinel in pool_for_add, so
        # this branch only triggers for REMOVE with no on-shelf items, or
        # for unexpected directions.
        return _unknown_result(
            "No candidates available for this event direction", pool, meta
        )

    # Catch-all events use a single-frame, visual-primary prompt that
    # frames the task as "identify the item in this image" — NOT a
    # before/after delta comparison. ``ctx.shelf_id == "catch_all"``
    # is set by the apply path's ClassifierContext construction (see
    # handlers/scale_events.py:_classify_recorded_event). Live_shelf
    # events keep the original delta-comparison prompt unchanged.
    if getattr(ctx, "shelf_id", None) == "catch_all":
        payload = build_catch_all_messages_payload(event, pool)
        prompt_variant = "catch_all"
    else:
        payload = build_messages_payload(event, pool)
        prompt_variant = "shelf"
    _lc(
        event.event_id,
        actor="classifier",
        reason_code="classifier_prompt_prepared",
        payload={
            "prompt_hash": _prompt_hash(payload),
            "pool_size": len(pool),
            "prompt_variant": prompt_variant,
        },
    )

    client = ctx.anthropic_client
    if client is None:
        client = AnthropicClassifierClient()
    elif not hasattr(client, "send"):
        # Allow callers to inject a plain ``anthropic.Anthropic`` instance;
        # wrap it in our facade so the rest of the code is uniform.
        client = AnthropicClassifierClient(client=client)

    attempts: list[dict[str, Any]] = []

    for attempt in (1, 2):
        try:
            call_result: ClassifierCallResult = client.send(payload, model=model)
        except Exception as exc:  # network / API-level failure
            # Distinguish transient errors (rate limit, overloaded,
            # connection) from other errors. The SDK itself already retries
            # 429/529/connection errors with exponential backoff (we set
            # max_retries=3 in anthropic_client), so reaching here means
            # the retries were exhausted — log loudly and mark failed.
            # Classifying the exception type also makes the failure trail
            # in review_queue much easier to debug.
            exc_type = type(exc).__name__
            is_transient = _is_transient_api_error(exc)
            if is_transient:
                logger.warning(
                    "classifier: transient API error on attempt %d "
                    "(SDK retries exhausted): %s: %s",
                    attempt,
                    exc_type,
                    exc,
                )
            else:
                logger.exception(
                    "classifier: API call failed on attempt %d", attempt
                )
            attempts.append(
                {
                    "attempt": attempt,
                    "error": repr(exc),
                    "error_type": exc_type,
                    "transient": is_transient,
                }
            )
            # Don't retry transport-level errors silently — they usually
            # repeat. Fall straight through to the unknown result with the
            # original error captured in meta.
            meta["attempts"] = attempts
            return _unknown_result(
                f"Classifier API error: {exc_type}: {exc}",
                pool,
                meta,
            )

        attempt_meta: dict[str, Any] = {
            "attempt": attempt,
            "model": call_result.model,
            "usage": call_result.usage,
            "raw_text_len": len(call_result.text),
        }

        try:
            parsed = parse_response(
                call_result.text,
                candidate_pool_used=pool,
                meta={
                    **meta,
                    "model": call_result.model,
                    "usage": call_result.usage,
                    "attempts": attempts + [attempt_meta],
                    "raw_text": call_result.text,
                },
            )
        except MalformedClassifierOutput as exc:
            logger.warning(
                "classifier: malformed output on attempt %d: %s. Raw text: %r",
                attempt,
                exc,
                call_result.text[:500],
            )
            attempt_meta["parse_error"] = str(exc)
            attempt_meta["raw_text"] = call_result.text
            attempts.append(attempt_meta)
            _lc(
                event.event_id,
                actor="classifier",
                reason_code="classifier_parse_retry" if attempt == 1 else "classifier_malformed_output",
                payload={
                    "attempt": attempt,
                    "parse_error": str(exc),
                },
            )
            if attempt == 1:
                # Retry once, per §4.5.
                continue
            # Second failure: safe fallback.
            meta["attempts"] = attempts
            return ClassificationResult.unknown(
                reasoning="Malformed model output",
                candidate_pool_used=pool,
                meta=meta,
            )

        attempts.append(attempt_meta)

        # Normalise: if the model responded with an item_id matching the
        # UNKNOWN sentinel, snap the action to "unknown" (§4.5 says item_id
        # may be "unknown" or UNKNOWN — treat both as the sentinel).
        normalised = _normalise_unknown(parsed)
        return normalised

    # Unreachable — the for-loop returns on both branches.
    return _unknown_result("Classifier exhausted retries", pool, meta)


def _normalise_unknown(result: ClassificationResult) -> ClassificationResult:
    """If ``item_id`` is any variant of "unknown", force the canonical sentinel.

    The spec allows ``"unknown"`` lowercase (§4.5 example) as well as the
    UNKNOWN sentinel id we inject into the pool. Collapse both to the
    canonical form so downstream code can compare by string equality.
    """

    lowered = result.item_id.strip().lower()
    if lowered in ("unknown", UNKNOWN_CANDIDATE_ID.lower()):
        return ClassificationResult(
            item_id=UNKNOWN_CANDIDATE_ID,
            action="unknown" if result.action == "unknown" else result.action,
            confidence=result.confidence,
            reasoning=result.reasoning,
            secondary_candidates=result.secondary_candidates,
            multi_match=result.multi_match,
            candidate_pool_used=result.candidate_pool_used,
            meta=result.meta,
            estimated_tare_g=result.estimated_tare_g,
        )
    return result
