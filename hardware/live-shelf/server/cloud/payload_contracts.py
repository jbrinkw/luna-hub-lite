"""Runtime payload contracts for CloudEventEmitter emit_* helpers.

Each emitted payload is validated by ``event_kind`` before enqueueing into
``cloud_outbox``. Contracts are intentionally strict on required/non-null
fields so data-shape regressions fail immediately on the Pi instead of
silently drifting into cloud state.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Literal, Mapping, NotRequired, TypedDict


class PayloadContractError(ValueError):
    """Raised when an emitter payload violates its event-kind contract."""


# ---------------------------------------------------------------------------
# Typed payload shapes (static contract surface)
# ---------------------------------------------------------------------------


class ConsumedPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["consumed"]
    delta_g: float
    occurred_at: str
    product_id: NotRequired[str]
    usage_kind: NotRequired[str]
    pi_event_id: NotRequired[str]
    _pi_resolution_id: NotRequired[str]


class AddedPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["added"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: NotRequired[str]
    _pi_resolution_id: NotRequired[str]


class RefilledPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["refilled"]
    delta_g: float
    occurred_at: str
    product_id: NotRequired[str]
    pi_event_id: NotRequired[str]
    _pi_resolution_id: NotRequired[str]


class DepletedPayload(TypedDict):
    scale_id: str
    kind: Literal["live_scale"]
    event_kind: Literal["depleted"]
    delta_g: float
    occurred_at: str
    product_id: NotRequired[str]
    usage_kind: NotRequired[str]
    pi_event_id: NotRequired[str]


class InFlightPickupPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["in_flight_pickup"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: NotRequired[str]
    _pi_resolution_id: NotRequired[str]


class InFlightReturnPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["in_flight_return"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: NotRequired[str]
    _pi_resolution_id: NotRequired[str]


class DiscardedPayload(TypedDict):
    scale_id: str
    kind: str
    event_kind: Literal["discarded"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: NotRequired[str]
    pi_lot_id: NotRequired[str]


class CatchAllFirstPayload(TypedDict):
    scale_id: str
    kind: Literal["catch_all"]
    event_kind: Literal["catch_all_first_measurement"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: str


class CatchAllSecondPayload(TypedDict):
    scale_id: str
    kind: Literal["catch_all"]
    event_kind: Literal["catch_all_second_measurement"]
    product_id: str
    delta_g: float
    occurred_at: str
    pi_event_id: str


class LiveWeightSyncPayload(TypedDict):
    scale_id: str
    kind: Literal["live_shelf", "live_scale"]
    event_kind: Literal["live_weight_sync"]
    observed_weight_g: float
    delta_g: float
    pi_lot_id: str
    occurred_at: str
    pi_event_id: NotRequired[str]


class ReviewQueueCreatePayload(TypedDict):
    event_kind: Literal["review_queue_create"]
    pi_review_id: str
    kind: str
    pi_session_id: NotRequired[str]
    pi_event_id: NotRequired[str]
    proposed: NotRequired[dict[str, Any]]
    images: NotRequired[list[str]]
    created_at: NotRequired[str]


class ReviewQueueResolvePayload(TypedDict):
    event_kind: Literal["review_queue_resolve"]
    pi_review_id: str
    status: Literal["resolved", "dismissed"]
    user_response: NotRequired[dict[str, Any]]
    resolved_at: NotRequired[str]


# ---------------------------------------------------------------------------
# Runtime validators
# ---------------------------------------------------------------------------


EventValidator = Callable[[Mapping[str, Any]], None]


def _fail(event_kind: str, msg: str) -> None:
    raise PayloadContractError(f"{event_kind}: {msg}")


def _require_str(payload: Mapping[str, Any], event_kind: str, key: str) -> str:
    if key not in payload:
        _fail(event_kind, f"missing required field {key!r}")
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        _fail(event_kind, f"field {key!r} must be a non-empty string")
    return value


def _require_number(payload: Mapping[str, Any], event_kind: str, key: str) -> float:
    if key not in payload:
        _fail(event_kind, f"missing required field {key!r}")
    value = payload.get(key)
    if not isinstance(value, (int, float)):
        _fail(event_kind, f"field {key!r} must be numeric")
    value_f = float(value)
    if not math.isfinite(value_f):
        _fail(event_kind, f"field {key!r} must be finite")
    return value_f


def _optional_str(payload: Mapping[str, Any], event_kind: str, key: str) -> None:
    if key not in payload:
        return
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        _fail(event_kind, f"optional field {key!r} must be a non-empty string")


def _optional_dict(payload: Mapping[str, Any], event_kind: str, key: str) -> None:
    if key not in payload:
        return
    value = payload.get(key)
    if not isinstance(value, dict):
        _fail(event_kind, f"optional field {key!r} must be an object")


def _validate_kind(payload: Mapping[str, Any], event_kind: str, allowed: set[str]) -> str:
    kind = _require_str(payload, event_kind, "kind")
    if kind not in allowed:
        _fail(event_kind, f"field 'kind' must be one of {sorted(allowed)!r}, got {kind!r}")
    return kind


def _validate_common_event_fields(payload: Mapping[str, Any], event_kind: str) -> None:
    _require_str(payload, event_kind, "scale_id")
    _require_str(payload, event_kind, "occurred_at")
    _require_number(payload, event_kind, "delta_g")
    _optional_str(payload, event_kind, "pi_event_id")
    _optional_str(payload, event_kind, "_pi_resolution_id")


def _validate_consumed(payload: Mapping[str, Any]) -> None:
    event_kind = "consumed"
    _validate_common_event_fields(payload, event_kind)
    kind = _validate_kind(payload, event_kind, {"live_shelf", "live_scale"})
    delta = _require_number(payload, event_kind, "delta_g")
    if delta >= 0:
        _fail(event_kind, "delta_g must be negative")
    # live_shelf consumed events must carry product_id; live_scale can
    # omit it so cloud resolves via scale_pairings.
    if kind == "live_shelf":
        _require_str(payload, event_kind, "product_id")
    elif "product_id" in payload:
        _optional_str(payload, event_kind, "product_id")
    _optional_str(payload, event_kind, "usage_kind")


def _validate_added(payload: Mapping[str, Any]) -> None:
    event_kind = "added"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_shelf", "live_scale"})
    _require_str(payload, event_kind, "product_id")
    if _require_number(payload, event_kind, "delta_g") <= 0:
        _fail(event_kind, "delta_g must be > 0")


def _validate_refilled(payload: Mapping[str, Any]) -> None:
    event_kind = "refilled"
    _validate_common_event_fields(payload, event_kind)
    kind = _validate_kind(payload, event_kind, {"live_shelf", "live_scale"})
    if _require_number(payload, event_kind, "delta_g") <= 0:
        _fail(event_kind, "delta_g must be > 0")
    if kind == "live_shelf":
        _require_str(payload, event_kind, "product_id")
    elif "product_id" in payload:
        _optional_str(payload, event_kind, "product_id")


def _validate_depleted(payload: Mapping[str, Any]) -> None:
    event_kind = "depleted"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_scale"})
    if _require_number(payload, event_kind, "delta_g") >= 0:
        _fail(event_kind, "delta_g must be negative")
    if "product_id" in payload:
        _optional_str(payload, event_kind, "product_id")
    _optional_str(payload, event_kind, "usage_kind")


def _validate_in_flight_pickup(payload: Mapping[str, Any]) -> None:
    event_kind = "in_flight_pickup"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_shelf"})
    _require_str(payload, event_kind, "product_id")
    # in_flight_pickup is a REMOVE event. The Pi emits delta_g as the
    # signed weight change off the shelf — typically negative (e.g.
    # −472.3g for a bottle picked up). Cloud apply_shelf_event takes
    # abs(delta_g) for the pickup_weight_g field so any sign works at
    # apply time. Don't constrain sign here.
    _require_number(payload, event_kind, "delta_g")


def _validate_in_flight_return(payload: Mapping[str, Any]) -> None:
    event_kind = "in_flight_return"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_shelf", "live_scale"})
    _require_str(payload, event_kind, "product_id")


def _validate_discarded(payload: Mapping[str, Any]) -> None:
    event_kind = "discarded"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_shelf", "catch_all"})
    _require_str(payload, event_kind, "product_id")
    if _require_number(payload, event_kind, "delta_g") != 0.0:
        _fail(event_kind, "delta_g must be 0.0")
    _optional_str(payload, event_kind, "pi_lot_id")


def _validate_catch_all_first(payload: Mapping[str, Any]) -> None:
    event_kind = "catch_all_first_measurement"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"catch_all"})
    _require_str(payload, event_kind, "product_id")
    if _require_number(payload, event_kind, "delta_g") <= 0:
        _fail(event_kind, "delta_g must be > 0")
    _require_str(payload, event_kind, "pi_event_id")


def _validate_catch_all_second(payload: Mapping[str, Any]) -> None:
    event_kind = "catch_all_second_measurement"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"catch_all"})
    _require_str(payload, event_kind, "product_id")
    if _require_number(payload, event_kind, "delta_g") < 0:
        _fail(event_kind, "delta_g must be >= 0")
    _require_str(payload, event_kind, "pi_event_id")


def _validate_live_weight_sync(payload: Mapping[str, Any]) -> None:
    event_kind = "live_weight_sync"
    _validate_common_event_fields(payload, event_kind)
    _validate_kind(payload, event_kind, {"live_shelf", "live_scale"})
    _require_str(payload, event_kind, "pi_lot_id")
    observed = _require_number(payload, event_kind, "observed_weight_g")
    if observed < 0:
        _fail(event_kind, "observed_weight_g must be >= 0")
    delta = _require_number(payload, event_kind, "delta_g")
    if delta < 0:
        _fail(event_kind, "delta_g must be >= 0")
    if abs(delta - observed) > 1e-6:
        _fail(event_kind, "delta_g must equal observed_weight_g")


def _validate_review_queue_create(payload: Mapping[str, Any]) -> None:
    event_kind = "review_queue_create"
    _require_str(payload, event_kind, "pi_review_id")
    _require_str(payload, event_kind, "kind")
    _optional_str(payload, event_kind, "pi_session_id")
    _optional_str(payload, event_kind, "pi_event_id")
    _optional_str(payload, event_kind, "created_at")
    _optional_dict(payload, event_kind, "proposed")
    if "images" in payload:
        images = payload.get("images")
        if not isinstance(images, list) or any(
            (not isinstance(item, str) or not item) for item in images
        ):
            _fail(event_kind, "optional field 'images' must be a list[str]")


def _validate_review_queue_resolve(payload: Mapping[str, Any]) -> None:
    event_kind = "review_queue_resolve"
    _require_str(payload, event_kind, "pi_review_id")
    status = _require_str(payload, event_kind, "status")
    if status not in {"resolved", "dismissed"}:
        _fail(event_kind, "field 'status' must be 'resolved' or 'dismissed'")
    _optional_str(payload, event_kind, "resolved_at")
    _optional_dict(payload, event_kind, "user_response")


EVENT_KIND_VALIDATORS: dict[str, EventValidator] = {
    "consumed": _validate_consumed,
    "added": _validate_added,
    "refilled": _validate_refilled,
    "depleted": _validate_depleted,
    "in_flight_pickup": _validate_in_flight_pickup,
    "in_flight_return": _validate_in_flight_return,
    "discarded": _validate_discarded,
    "catch_all_first_measurement": _validate_catch_all_first,
    "catch_all_second_measurement": _validate_catch_all_second,
    "live_weight_sync": _validate_live_weight_sync,
    "review_queue_create": _validate_review_queue_create,
    "review_queue_resolve": _validate_review_queue_resolve,
}

SUPPORTED_EVENT_KINDS = frozenset(EVENT_KIND_VALIDATORS.keys())


def validate_payload_contract(payload: Mapping[str, Any]) -> None:
    """Validate one emitter payload against its event-kind contract.

    Raises
    ------
    PayloadContractError
        If required fields are missing/NULL/invalid for the given
        ``event_kind``.
    """
    if not isinstance(payload, Mapping):
        raise PayloadContractError("payload must be a mapping")
    event_kind = payload.get("event_kind")
    if not isinstance(event_kind, str) or not event_kind:
        raise PayloadContractError("payload missing non-empty string event_kind")
    validator = EVENT_KIND_VALIDATORS.get(event_kind)
    if validator is None:
        raise PayloadContractError(
            f"unknown event_kind {event_kind!r}; supported={sorted(SUPPORTED_EVENT_KINDS)!r}"
        )
    validator(payload)

