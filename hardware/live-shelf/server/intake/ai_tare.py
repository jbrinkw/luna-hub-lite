"""AI tare estimation (§5.1 — partially-used container handling).

When a user brings in a container that was opened before being weighed, the
deterministic ``tare = gross - net`` derivation produces garbage.
This module wraps Claude Opus 4.6 with *extended thinking* to visually
estimate the empty-container weight from the user-captured reference
images plus the label metadata the wizard has collected.

The module exposes a single :func:`estimate` entry point. It mirrors the
SDK usage style of :mod:`server.classifier.anthropic_client`:

  * API key comes from ``ANTHROPIC_API_KEY``.
  * Model id comes from ``LIVE_SHELF_TARE_MODEL`` with a sensible default.
  * Callers can inject a fake ``anthropic.Anthropic`` client for tests.

Unlike the classifier wrapper, this module owns its own retry + JSON-parse
logic because its caller is a Flask endpoint (not a long-lived pipeline)
and the spec mandates a single retry on malformed output before surfacing
a 502.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .models import AiTareProductForm, TareEstimate

logger = logging.getLogger(__name__)

# -- Configuration ---------------------------------------------------------

# Default to Sonnet 4.6 with NO extended thinking. Tare estimation is
# straightforward pattern recognition (identify container material/size, apply
# typical weight priors, cross-check against gross-net math). Sonnet produces
# answers indistinguishable from Opus+thinking at ~1/20 the cost (~$0.015 vs
# $0.30 per call). Override via LIVE_SHELF_TARE_MODEL and the `thinking_budget_tokens`
# kwarg on estimate() for edge cases where you want Opus+thinking.
DEFAULT_MODEL = "claude-sonnet-4-6"

# 0 disables extended thinking. Set to a positive value to enable (e.g. 3000).
# Only enable for cases where the model is genuinely struggling — tare
# estimation typically doesn't need it.
DEFAULT_THINKING_BUDGET_TOKENS = 0

# Max response tokens. JSON reply is ~120 tokens; keep headroom.
# When extended thinking is enabled this also needs to exceed the thinking
# budget, which :func:`estimate` enforces.
DEFAULT_MAX_TOKENS = 512


# Environment variable name — mirror :mod:`anthropic_client` naming.
_TARE_MODEL_ENV = "LIVE_SHELF_TARE_MODEL"


# -- Errors ----------------------------------------------------------------


class AiTareError(Exception):
    """Base class for AI-tare failures the endpoint turns into HTTP errors."""


class AiTareUnavailable(AiTareError):
    """Raised when the API key / SDK isn't configured — surfaces as 503."""


class AiTareMalformedOutput(AiTareError):
    """Raised after retry when the model's JSON still can't be parsed."""


class AiTareApiError(AiTareError):
    """Raised when the SDK/API call itself fails — surfaces as 502."""


# -- Prompt ----------------------------------------------------------------


SYSTEM_PROMPT = """\
You are estimating the empty container (tare) weight of a food product for an
automatic fridge inventory tracker. You will receive a photograph of the product
and label metadata. Reason step-by-step about:

  1. What kind of container it is (material, approximate capacity)
  2. Typical empty-weight ranges for that container class
  3. Whether the item appears sealed/unopened in the photo
  4. If a measured gross weight is provided: does (gross - net) fall within the
     range you'd expect from the image? If yes, trust that value. If no, prefer
     your visual estimate and note the discrepancy.

Output STRICT JSON — no prose outside the JSON block. Schema:

{
  "tare_weight_g": <number>,            // your best single estimate, integer grams
  "confidence": "low" | "medium" | "high",
  "appears_sealed": <boolean>,
  "reasoning": "<one short paragraph, 2-4 sentences>"
}

Confidence "high" means you are within +/- 15%. "medium" = +/- 25%. "low" = wider."""


# -- Image loading ---------------------------------------------------------


def _guess_media_type(path: str) -> str:
    """Best-effort media-type detection. Falls back to image/jpeg."""

    guess, _ = mimetypes.guess_type(path)
    if guess and guess.startswith("image/"):
        return guess
    return "image/jpeg"


def _encode_image_block(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Read ``path`` and return an Anthropic image content block (base64)."""

    p = Path(path)
    data = p.read_bytes()
    encoded = base64.standard_b64encode(data).decode("ascii")
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": _guess_media_type(str(p)),
            "data": encoded,
        },
    }


# -- Metadata rendering ----------------------------------------------------


def _render_product_text(
    form: AiTareProductForm,
    measured_gross_g: Optional[float],
    is_partial: Optional[bool],
) -> str:
    """Human-readable product block appended to the user turn.

    Fields the user left blank are still shown (as ``null``) so the model
    sees the exact same schema every call — keeps caching behavior stable
    and makes the prompt easier for the model to pattern-match on.
    """

    lines = [
        "Product:",
        f"  name: {form.name if form.name else 'null'}",
        f"  brand: {form.brand if form.brand else 'null'}",
        f"  variant: {form.variant if form.variant else 'null'}",
        f"  net_weight_g: {_num(form.net_weight_g)}",
        f"  serving_weight_g: {_num(form.serving_weight_g)}",
        f"  servings_per_container: {_num(form.servings_per_container)}",
        f"  unit_type: {form.unit_type if form.unit_type else 'null'}",
        f"  container_type: {form.container_type if form.container_type else 'null'}",
    ]
    if measured_gross_g is not None:
        lines.append("")
        lines.append(f"Measured gross on scale: {measured_gross_g:.1f} g")
    if is_partial is not None:
        lines.append(f"User says partially used: {'true' if is_partial else 'false'}")
    lines.append("")
    lines.append("Estimate the empty container weight.")
    return "\n".join(lines)


def _num(value: Optional[float]) -> str:
    if value is None:
        return "null"
    # Integer-looking floats render as integers for label-style values.
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}"


# -- JSON extraction -------------------------------------------------------


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
    """Strip code fences + pull the outermost JSON object.

    Tolerant enough to handle the occasional ``json\\n...\\n`` fence the
    model tacks on even when told not to. Uses a brace-depth walker
    (respecting string literals) so trailing prose containing a ``}`` or
    nested ``}`` inside reasoning strings don't misplace the closer.
    Raises :class:`AiTareMalformedOutput` if nothing object-shaped is
    present.
    """

    text = (text or "").strip()
    if not text:
        raise AiTareMalformedOutput("Empty response")

    match = _FENCE_RE.search(text)
    if match:
        return match.group(1).strip()

    start = text.find("{")
    if start == -1:
        raise AiTareMalformedOutput("No JSON object found in response")
    end = _find_balanced_json(text, start)
    if end == -1:
        # Fall back to the original string — downstream json.loads will
        # raise a descriptive AiTareMalformedOutput.
        return text
    return text[start : end + 1]


_VALID_CONFIDENCE = {"low", "medium", "high"}


def _parse_estimate(text: str) -> TareEstimate:
    """Parse the model's JSON text into a :class:`TareEstimate`.

    Coerces / validates each field; raises
    :class:`AiTareMalformedOutput` on the first field that doesn't fit the
    schema.
    """

    raw = _extract_json(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AiTareMalformedOutput(f"Invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise AiTareMalformedOutput(
            f"Top-level JSON must be an object, got {type(data).__name__}"
        )

    tare_raw = data.get("tare_weight_g")
    try:
        tare = float(tare_raw)
    except (TypeError, ValueError) as exc:
        raise AiTareMalformedOutput(
            f"tare_weight_g not a number: {tare_raw!r}"
        ) from exc
    if tare < 0:
        raise AiTareMalformedOutput(f"tare_weight_g must be >= 0, got {tare}")

    confidence = data.get("confidence")
    if not isinstance(confidence, str) or confidence.lower() not in _VALID_CONFIDENCE:
        raise AiTareMalformedOutput(f"Invalid confidence: {confidence!r}")
    confidence = confidence.lower()

    appears_sealed = data.get("appears_sealed")
    if not isinstance(appears_sealed, bool):
        raise AiTareMalformedOutput(
            f"appears_sealed must be a boolean, got {type(appears_sealed).__name__}"
        )

    reasoning = data.get("reasoning", "")
    if not isinstance(reasoning, str):
        raise AiTareMalformedOutput(
            f"reasoning must be a string, got {type(reasoning).__name__}"
        )

    return TareEstimate(
        tare_weight_g=tare,
        confidence=confidence,
        appears_sealed=appears_sealed,
        reasoning=reasoning.strip(),
    )


# -- Model resolution ------------------------------------------------------


def resolve_model(override: Optional[str] = None) -> str:
    """Resolve which model to use.

    Order: explicit ``override`` > ``LIVE_SHELF_TARE_MODEL`` env >
    :data:`DEFAULT_MODEL`.
    """

    return override or os.environ.get(_TARE_MODEL_ENV) or DEFAULT_MODEL


# -- Extended-thinking call -----------------------------------------------


@dataclass
class _CallPayload:
    """Bundle of ready-to-send arguments — factored out so tests can inspect."""

    system: str
    messages: list[dict[str, Any]]
    model: str
    max_tokens: int
    thinking_budget_tokens: int


def _build_payload(
    *,
    ref_image_paths: list[str],
    product_form: AiTareProductForm,
    measured_gross_g: Optional[float],
    is_partial: Optional[bool],
    model: str,
    max_tokens: int,
    thinking_budget_tokens: int,
) -> _CallPayload:
    """Assemble the SDK payload. Separated for testability.

    Images come first (all of them), then the structured product block as a
    single text block. Mirrors the classifier's pattern so the model sees a
    predictable shape.
    """

    user_content: list[dict[str, Any]] = []
    for path in ref_image_paths:
        user_content.append(_encode_image_block(path))

    user_content.append(
        {
            "type": "text",
            "text": _render_product_text(product_form, measured_gross_g, is_partial),
        }
    )

    return _CallPayload(
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        model=model,
        max_tokens=max_tokens,
        thinking_budget_tokens=thinking_budget_tokens,
    )


def _extract_text_from_response(response: Any) -> str:
    """Collect text from an SDK response, skipping thinking blocks.

    Extended-thinking responses ship one or more ``thinking`` blocks before
    the final ``text`` block — concatenate only the ``text`` blocks so the
    JSON parser sees exactly the answer.
    """

    text_parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            text = getattr(block, "text", "")
            if text:
                text_parts.append(text)
    return "".join(text_parts).strip()


def _build_client(api_key: Optional[str]) -> Any:
    """Construct a fresh :class:`anthropic.Anthropic` client.

    Split out so tests can assert the "no API key" error path without
    needing the SDK installed.
    """

    if not api_key:
        raise AiTareUnavailable(
            "ANTHROPIC_API_KEY is not set — cannot run AI tare estimation."
        )
    import anthropic  # type: ignore[import-untyped]  # pragma: no cover

    return anthropic.Anthropic(api_key=api_key)  # pragma: no cover


def estimate(
    *,
    ref_image_paths: list[str],
    product_form: AiTareProductForm,
    measured_gross_g: Optional[float] = None,
    is_partial: Optional[bool] = None,
    client: Any | None = None,
    model: Optional[str] = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    thinking_budget_tokens: int = DEFAULT_THINKING_BUDGET_TOKENS,
) -> tuple[TareEstimate, str, int]:
    """Run one AI tare estimation call.

    Returns ``(estimate, model_used, thinking_budget_used)``.

    Parameters
    ----------
    ref_image_paths:
        Absolute paths to the captured reference images. At least one is
        required; more is better (the model sees all of them).
    product_form:
        Label metadata the wizard collected (may be partially filled).
    measured_gross_g:
        Optional scale reading at intake time. When provided, the model can
        cross-check ``(gross - net)`` against its visual estimate.
    is_partial:
        Optional explicit "this container is not sealed" flag. When true,
        the model is nudged to trust its visual estimate over any derived
        gross-minus-net value.
    client:
        Optional pre-constructed ``anthropic.Anthropic`` instance. Tests
        inject a fake here; production lazily builds one from
        ``ANTHROPIC_API_KEY``.
    model, max_tokens, thinking_budget_tokens:
        Override knobs. Sensible defaults per spec §5.1.

    Raises
    ------
    AiTareUnavailable:
        When ``client`` is not supplied and ``ANTHROPIC_API_KEY`` is unset.
    AiTareApiError:
        When the SDK call itself fails (network, auth, quota, etc.).
    AiTareMalformedOutput:
        When the model returns JSON that can't be parsed on either attempt.
    """

    if not ref_image_paths:
        raise ValueError("at least one reference image path is required")

    resolved_model = resolve_model(model)
    # Anthropic requires max_tokens > thinking.budget_tokens when thinking is
    # enabled. Bump automatically so callers opting into thinking don't have
    # to tweak max_tokens too.
    if thinking_budget_tokens > 0 and max_tokens <= thinking_budget_tokens:
        max_tokens = thinking_budget_tokens + 512
    payload = _build_payload(
        ref_image_paths=list(ref_image_paths),
        product_form=product_form,
        measured_gross_g=measured_gross_g,
        is_partial=is_partial,
        model=resolved_model,
        max_tokens=max_tokens,
        thinking_budget_tokens=thinking_budget_tokens,
    )

    if client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        client = _build_client(api_key)

    last_error: Optional[Exception] = None
    last_api_error: Optional[Exception] = None
    for attempt in (1, 2):
        try:
            create_kwargs: dict[str, Any] = {
                "model": payload.model,
                "max_tokens": payload.max_tokens,
                "system": payload.system,
                "messages": payload.messages,
            }
            # Extended thinking is opt-in via a positive budget. Skip the
            # thinking param entirely when budget<=0 — sending {"enabled": ...,
            # "budget_tokens": 0} is invalid per the SDK schema. Anthropic
            # also rejects temperature!=1 when thinking is enabled, so we
            # only set temperature on the non-thinking path (SDK default of
            # 1 is required for thinking calls).
            if payload.thinking_budget_tokens > 0:
                create_kwargs["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": payload.thinking_budget_tokens,
                }
            else:
                create_kwargs["temperature"] = 0
            response = client.messages.create(**create_kwargs)
        except AiTareError:
            raise
        except Exception as exc:  # transport / auth / quota errors
            # Fix 4: retry on API errors just like we retry on malformed
            # output. The classifier already behaves this way — asymmetric
            # treatment means a transient network blip kills tare requests
            # unnecessarily. On the first attempt, log + continue so the
            # loop tries again; on the final attempt, raise with context.
            logger.warning(
                "ai_tare: API call failed on attempt %d: %s", attempt, exc,
            )
            last_api_error = exc
            if attempt == 1:
                continue
            raise AiTareApiError(
                f"Anthropic API error: {type(exc).__name__}: {exc}"
            ) from exc

        text = _extract_text_from_response(response)
        try:
            parsed = _parse_estimate(text)
        except AiTareMalformedOutput as exc:
            logger.warning(
                "ai_tare: malformed output on attempt %d: %s. Raw text: %r",
                attempt,
                exc,
                text[:500],
            )
            last_error = exc
            if attempt == 1:
                continue
            raise

        return parsed, resolved_model, thinking_budget_tokens

    # Unreachable — the loop either returns or raises.
    if last_api_error is not None:  # pragma: no cover
        raise AiTareApiError(
            f"Exhausted retries: {last_api_error}"
        ) from last_api_error
    raise AiTareMalformedOutput(  # pragma: no cover
        f"Exhausted retries: {last_error}"
    )
