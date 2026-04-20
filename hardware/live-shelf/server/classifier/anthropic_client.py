"""Anthropic SDK wrapper with prompt caching (§7.2-7.3).

Thin facade over ``anthropic.Anthropic().messages.create(...)`` that:

  * Reads the API key from ``ANTHROPIC_API_KEY`` (plan §12 #6).
  * Reads the model id from ``LIVE_SHELF_MODEL`` with a sane default
    (``claude-sonnet-4-6`` per §7.2; callers may also pass
    ``claude-haiku-4-5`` via the ``model`` parameter).
  * Wires up the payload produced by :mod:`classifier.prompt` — which
    already embeds the correct ``cache_control`` breakpoints.

The wrapper deliberately does *not* own the retry / JSON-parse logic;
:mod:`classifier.classify` handles that (spec §4.5 requires a one-retry
policy on malformed output with a specific fallback shape, which doesn't
belong down here).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# §7.2 default. Callers can override per-call for the "cheap path".
DEFAULT_MODEL = "claude-sonnet-4-6"
ALLOWED_MODELS = {"claude-sonnet-4-6", "claude-haiku-4-5"}

# Default max_tokens — the JSON response is normally tiny, but multi-item
# REMOVE events with long combination reasoning can push past 512 tokens
# (observed: 512-token truncation mid-JSON on a legitimate multi_match
# response). Doubled to 1024 with enough headroom for the reasoning
# string + 3-item multi_match arrays. Prompts also now strongly tell the
# model to respond with JSON only, so the extra ceiling only matters
# on the fallback path.
DEFAULT_MAX_TOKENS = 1024

# SDK-level retry count for transient 429 (rate limit) / 529 (overloaded) /
# connection errors. The SDK handles exponential backoff internally. We
# keep 3 retries as a balance between absorbing provider blips and not
# stacking multi-second delays onto the classifier's already-slow path.
DEFAULT_MAX_RETRIES = 3


# Process-level counters for the Anthropic API, surfaced via the
# ``system_health`` snapshot so operators can see provider churn at a
# glance. Bumped from :meth:`AnthropicClassifierClient.send`. Not reset
# except by process restart — the snapshot thread takes deltas.
_CALL_COUNTER_LOCK = __import__("threading").Lock()
ANTHROPIC_CALLS_TOTAL = 0
ANTHROPIC_ERRORS_TOTAL = 0


def get_anthropic_counters() -> tuple[int, int]:
    """Return ``(calls_total, errors_total)`` for the system_health snapshot."""
    with _CALL_COUNTER_LOCK:
        return ANTHROPIC_CALLS_TOTAL, ANTHROPIC_ERRORS_TOTAL


def _bump_calls() -> None:
    global ANTHROPIC_CALLS_TOTAL
    with _CALL_COUNTER_LOCK:
        ANTHROPIC_CALLS_TOTAL += 1


def _bump_errors() -> None:
    global ANTHROPIC_ERRORS_TOTAL
    with _CALL_COUNTER_LOCK:
        ANTHROPIC_ERRORS_TOTAL += 1


def resolve_model(override: str | None = None) -> str:
    """Resolve which model to use.

    Order of precedence: explicit ``override`` > ``LIVE_SHELF_MODEL`` env
    > :data:`DEFAULT_MODEL`. Unknown model ids are passed through with a
    warning so callers can experiment without the wrapper blocking them,
    but we log loudly so the test harness / logs flag it.
    """

    model = override or os.environ.get("LIVE_SHELF_MODEL") or DEFAULT_MODEL
    if model not in ALLOWED_MODELS:
        logger.warning(
            "anthropic_client: model %r is not in the known set %r — "
            "passing through unchanged.",
            model,
            ALLOWED_MODELS,
        )
    return model


@dataclass
class ClassifierCallResult:
    """Raw result returned from the Anthropic API.

    Not to be confused with :class:`classifier.models.ClassificationResult`
    — that is the *parsed* result that :mod:`classifier.classify` produces.
    This object just carries the text + usage so the caller can parse and
    introspect.
    """

    text: str
    model: str
    usage: dict[str, Any]
    raw: Any  # The SDK's response object, kept for debugging.


class AnthropicClassifierClient:
    """SDK wrapper that sends a pre-built payload and returns the text.

    Accepts an optional pre-constructed ``anthropic.Anthropic`` client so
    tests can inject a fake. If none is provided, one is lazily built the
    first time :meth:`send` is called.
    """

    def __init__(
        self,
        *,
        client: Any | None = None,
        api_key: str | None = None,
        default_model: str | None = None,
    ) -> None:
        self._client = client
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._default_model = default_model

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        # Lazy import so tests that stub the client never require the SDK.
        import anthropic  # type: ignore[import-untyped]

        if not self._api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Either export it or pass "
                "api_key= to AnthropicClassifierClient()."
            )
        # max_retries tells the SDK to automatically retry 429 (rate limit),
        # 529 (overloaded), and connection errors with exponential backoff.
        # Without this, a transient provider hiccup marks the event failed
        # and enqueues it for manual review.
        self._client = anthropic.Anthropic(
            api_key=self._api_key,
            max_retries=DEFAULT_MAX_RETRIES,
        )
        return self._client

    def send(
        self,
        payload: dict[str, Any],
        *,
        model: str | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> ClassifierCallResult:
        """Send ``payload`` (system + messages) and return the text reply.

        ``payload`` must already carry ``cache_control`` breakpoints where
        desired — :mod:`classifier.prompt.build_messages_payload` does this
        by default per §7.3.
        """

        client = self._ensure_client()
        resolved_model = resolve_model(model or self._default_model)

        _bump_calls()
        try:
            response = client.messages.create(
                model=resolved_model,
                max_tokens=max_tokens,
                system=payload.get("system"),
                messages=payload["messages"],
            )
        except Exception:
            _bump_errors()
            raise

        # Concatenate every text-block from the response. The classifier's
        # system prompt instructs a JSON-only response, so in practice there
        # is exactly one text block — but be defensive.
        text_parts: list[str] = []
        for block in getattr(response, "content", []) or []:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text = getattr(block, "text", "")
                if text:
                    text_parts.append(text)

        usage_obj = getattr(response, "usage", None)
        usage_dict: dict[str, Any] = {}
        if usage_obj is not None:
            # The SDK usage object has dict-like semantics via model_dump on
            # newer versions; fall back to attribute access otherwise.
            if hasattr(usage_obj, "model_dump"):
                try:
                    usage_dict = usage_obj.model_dump()
                except Exception:  # pragma: no cover - defensive
                    usage_dict = {}
            if not usage_dict:
                for name in (
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                ):
                    value = getattr(usage_obj, name, None)
                    if value is not None:
                        usage_dict[name] = value

        return ClassifierCallResult(
            text="".join(text_parts).strip(),
            model=resolved_model,
            usage=usage_dict,
            raw=response,
        )
