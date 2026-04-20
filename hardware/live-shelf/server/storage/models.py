"""Pydantic-validated dataclasses for every Live Shelf table row and input type.

Each `*In` type describes the shape of data the caller provides to a repo write
function. Each corresponding non-`In` type describes the shape the repo returns
after defaults (IDs, timestamps) have been materialized.

All timestamps are ISO-8601 UTC strings. The `coerce_ts` helper accepts either
`str` or `datetime` on input and emits a canonical `str`; repo functions call
it before INSERT/UPDATE.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import Field
from pydantic.dataclasses import dataclass

# Sentinel used in patch dataclasses to distinguish "don't touch this column"
# from "set this column to NULL". A plain None cannot serve both roles, so
# callers pass the sentinel literal ``"__CLEAR__"`` to request explicit NULL.
CLEAR_SENTINEL: str = "__CLEAR__"

# ---------------------------------------------------------------------------
# Enum-style literal aliases — mirror the CHECK constraints in schema.sql.
# ---------------------------------------------------------------------------

UnitType = Literal["liquid", "solid", "count", "mixed"]
LotStatus = Literal["on_shelf", "in_flight", "out", "depleted", "relocated", "lost"]
EventDirection = Literal["add", "remove", "noise"]
ClassifierStatus = Literal[
    "pending", "classifying", "classified", "review", "failed"
]
# Shelf discriminator enum (CATCH_ALL_SCALE_PLAN.md §4.1). Mirrors the
# CHECK constraint on lots.shelf_id / sessions.shelf_id /
# scale_events.shelf_id in schema.sql. Keep the literal set in sync with
# ``server.shelves.ShelfId`` — they must describe the same domain.
ShelfId = Literal["live_shelf", "catch_all", "single_item"]
ResolutionPattern = Literal[
    "use_return_no_consumption",
    "use_return_consumed",
    "topped_up",
    "consumed_or_removed",
    "new_arrival",
    "swap_out",
    "swap_in",
    "relocation",
    "unknown",
    "no_op",
    # In-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §3.2). Fast-path
    # resolutions written at event time, distinct from the reconciler's
    # post-session use_return_* variants.
    "in_flight_pickup",
    "in_flight_return",
    "in_flight_replaced_new_item",
    "in_flight_ttl_expired",
]
UsageKind = Literal[
    "in_flight_return",
    "in_flight_ttl_expired",
    "in_flight_replaced_new_item",
    "reconciler_use_return",
    # Single-item tracker (CATCH_ALL_SCALE_PLAN.md follow-up). A paired
    # scale measured a negative delta beyond noise — log the consumed
    # grams against the paired product's lot. Positive deltas are
    # refills; they update lot.current_weight_g only and don't produce
    # a usage_log row.
    "single_item_consumed",
]
ReviewKind = Literal[
    "unknown_item_add",
    "low_confidence",
    "weight_mismatch",
    "unpaired_remove",
    "multi_match",
    "failed_intake",
    "sensor_anomaly",
]
ReviewStatus = Literal["pending", "resolved", "dismissed"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def coerce_ts(value: str | datetime | None) -> Optional[str]:
    """Normalize a timestamp input to an ISO-8601 UTC string.

    Accepts:
      * None → None (unchanged)
      * str  → returned as-is (trusted to be ISO-8601; no strict validation
               here because SQLite stores it as TEXT and we need to round-trip
               datetime('now') defaults cleanly)
      * datetime → converted to UTC and emitted as isoformat with 'Z' suffix if
                   it came from a naive or UTC datetime
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.isoformat()
    raise TypeError(f"coerce_ts: unsupported type {type(value)!r}")


# ---------------------------------------------------------------------------
# products
# ---------------------------------------------------------------------------


@dataclass
class ProductIn:
    name: str
    barcode: Optional[str] = None
    brand: Optional[str] = None
    variant: Optional[str] = None
    net_weight_g: Optional[float] = None
    gross_weight_g: Optional[float] = None
    tare_weight_g: Optional[float] = None
    serving_weight_g: Optional[float] = None
    servings_per_container: Optional[float] = None
    unit_type: Optional[UnitType] = None
    density_g_per_ml: Optional[float] = None
    container_type: Optional[str] = None
    # Macro + description fields — passed straight through to the cloud
    # /intake POST body; stored locally if the Pi schema has the columns
    # (migration added via the cloud-sync write-through path). These are
    # *not* required for the local-only legacy flow — ``create_product``
    # on the Pi's legacy schema ignores any columns it doesn't know
    # about because :mod:`server.storage.repo.create_product` writes a
    # fixed subset.
    calories_per_serving: Optional[float] = None
    carbs_per_serving: Optional[float] = None
    protein_per_serving: Optional[float] = None
    fat_per_serving: Optional[float] = None
    description: Optional[str] = None
    certified: int = 0


@dataclass
class Product:
    product_id: str
    name: str
    certified: int
    created_at: str
    updated_at: str
    barcode: Optional[str] = None
    brand: Optional[str] = None
    variant: Optional[str] = None
    net_weight_g: Optional[float] = None
    gross_weight_g: Optional[float] = None
    tare_weight_g: Optional[float] = None
    serving_weight_g: Optional[float] = None
    servings_per_container: Optional[float] = None
    unit_type: Optional[UnitType] = None
    density_g_per_ml: Optional[float] = None
    container_type: Optional[str] = None


# ---------------------------------------------------------------------------
# product_reference_images
# ---------------------------------------------------------------------------


@dataclass
class ProductReferenceImageIn:
    product_id: str
    file_path: str
    angle: Optional[str] = None


@dataclass
class ProductReferenceImage:
    image_id: str
    product_id: str
    file_path: str
    captured_at: str
    angle: Optional[str] = None


# ---------------------------------------------------------------------------
# lots
# ---------------------------------------------------------------------------


@dataclass
class LotIn:
    product_id: str
    status: LotStatus
    current_weight_g: Optional[float] = None
    initial_weight_g: Optional[float] = None
    total_consumed_g: float = 0.0
    placed_at: Optional[str] = None
    last_seen_at: Optional[str] = None
    last_out_at: Optional[str] = None
    notes: Optional[str] = None
    # In-flight tracker columns (§3.1). Non-NULL iff status='in_flight'.
    in_flight_since: Optional[str] = None
    pickup_weight_g: Optional[float] = None
    pickup_event_id: Optional[str] = None
    pickup_session_id: Optional[str] = None
    # Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). Defaults to the
    # legacy single-shelf value so existing callers (live-shelf mint path)
    # don't have to change shape. Catch-all callers thread through the
    # resolved shelf_id at the ingress.
    shelf_id: ShelfId = "live_shelf"


@dataclass
class Lot:
    lot_id: str
    product_id: str
    status: LotStatus
    total_consumed_g: float
    placed_at: str
    last_seen_at: str
    current_weight_g: Optional[float] = None
    initial_weight_g: Optional[float] = None
    last_out_at: Optional[str] = None
    notes: Optional[str] = None
    # In-flight tracker columns (§3.1). Non-NULL iff status='in_flight'.
    in_flight_since: Optional[str] = None
    pickup_weight_g: Optional[float] = None
    pickup_event_id: Optional[str] = None
    pickup_session_id: Optional[str] = None
    # Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). Defaulted so
    # legacy repo callsites that don't select the column still work; the
    # row-to-model helper in ``repo._row_to_lot`` populates it from the
    # DB when present.
    shelf_id: ShelfId = "live_shelf"


@dataclass
class LotWithProduct:
    """Join of lots + products — used by registry/recently-out views."""

    lot: Lot
    product: Product


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------


@dataclass
class Session:
    session_id: str
    started_at: str
    reconciled: int
    ended_at: Optional[str] = None
    initial_shelf_weight_g: Optional[float] = None
    final_shelf_weight_g: Optional[float] = None
    reconciled_at: Optional[str] = None


# ---------------------------------------------------------------------------
# scale_events
# ---------------------------------------------------------------------------


@dataclass
class ScaleEventIn:
    ts: str
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: EventDirection
    session_id: Optional[str] = None
    before_frame_path: Optional[str] = None
    after_frame_path: Optional[str] = None
    classification: Optional[str] = None  # JSON blob
    classifier_status: Optional[ClassifierStatus] = None
    # Pi's NTP-synced wall-clock at ingress. Optional because old migrated
    # rows and test paths that don't go through the HTTP handler may not
    # set it. When present, the frame picker uses this instead of ``ts``
    # to avoid the ESP's random sub-second artefact (millis() % 1000).
    pi_received_ts: Optional[str] = None
    # Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). Optional so test
    # paths + legacy callers that don't thread device routing still work;
    # ``record_scale_event`` omits the column when None so the SQL DEFAULT
    # ('live_shelf') kicks in for backward compat.
    shelf_id: Optional[ShelfId] = None


@dataclass
class ScaleEvent:
    event_id: str
    ts: str
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: EventDirection
    created_at: str
    session_id: Optional[str] = None
    before_frame_path: Optional[str] = None
    after_frame_path: Optional[str] = None
    classification: Optional[str] = None
    classifier_status: Optional[ClassifierStatus] = None


# ---------------------------------------------------------------------------
# session_resolutions
# ---------------------------------------------------------------------------


@dataclass
class SessionResolutionIn:
    session_id: str
    pattern: ResolutionPattern
    lot_id: Optional[str] = None
    consumed_g: Optional[float] = None
    confidence: Optional[float] = None
    add_event_id: Optional[str] = None
    remove_event_id: Optional[str] = None


@dataclass
class SessionResolution:
    resolution_id: str
    session_id: str
    pattern: ResolutionPattern
    created_at: str
    lot_id: Optional[str] = None
    consumed_g: Optional[float] = None
    confidence: Optional[float] = None
    add_event_id: Optional[str] = None
    remove_event_id: Optional[str] = None


# ---------------------------------------------------------------------------
# usage_log (USAGE_LOG_PLAN.md §5.2)
# ---------------------------------------------------------------------------


@dataclass
class UsageLogIn:
    product_id: str
    product_name: str
    consumed_g: float
    kind: UsageKind
    occurred_at: str
    lot_id: Optional[str] = None
    product_brand: Optional[str] = None
    container_type: Optional[str] = None
    pickup_weight_g: Optional[float] = None
    return_weight_g: Optional[float] = None
    session_id: Optional[str] = None
    pickup_event_id: Optional[str] = None
    return_event_id: Optional[str] = None


@dataclass
class UsageLog:
    usage_id: str
    product_id: str
    product_name: str
    consumed_g: float
    kind: UsageKind
    occurred_at: str
    created_at: str
    lot_id: Optional[str] = None
    product_brand: Optional[str] = None
    container_type: Optional[str] = None
    pickup_weight_g: Optional[float] = None
    return_weight_g: Optional[float] = None
    session_id: Optional[str] = None
    pickup_event_id: Optional[str] = None
    return_event_id: Optional[str] = None


# ---------------------------------------------------------------------------
# review_queue
# ---------------------------------------------------------------------------


@dataclass
class ReviewQueueIn:
    kind: ReviewKind
    status: ReviewStatus = "pending"
    session_id: Optional[str] = None
    event_id: Optional[str] = None
    resolution_id: Optional[str] = None
    proposed: Optional[str] = None  # JSON string
    images: Optional[str] = None  # JSON array string


@dataclass
class ReviewQueueItem:
    review_id: str
    kind: ReviewKind
    status: ReviewStatus
    created_at: str
    session_id: Optional[str] = None
    event_id: Optional[str] = None
    resolution_id: Optional[str] = None
    proposed: Optional[str] = None
    images: Optional[str] = None
    resolved_at: Optional[str] = None
    user_response: Optional[str] = None


# ---------------------------------------------------------------------------
# app_state (singleton)
# ---------------------------------------------------------------------------


@dataclass
class AppState:
    id: int = Field(default=1)
    current_session_id: Optional[str] = None
    last_scale_weight_g: Optional[float] = None
    last_scale_event_ts: Optional[str] = None
    door_open: int = 0
    shelf_name: str = "demo shelf"
    camera_locked_json: Optional[str] = None
    updated_at: Optional[str] = None
    # Per-shelf open-session pointer for the catch-all scale
    # (CATCH_ALL_SCALE_PLAN.md §4.2). Mirrors
    # ``app_state.current_catch_all_session_id`` — a separate pointer
    # from ``current_session_id`` so a live-shelf session and a
    # catch-all session can be open concurrently without clobbering
    # each other. Defaulted to None so legacy test fixtures that don't
    # include the column still hydrate cleanly.
    current_catch_all_session_id: Optional[str] = None


@dataclass
class AppStatePatch:
    """Partial patch. Only fields set (non-None) are written. Note that
    door_open/shelf_name do accept their type's zero value — use keyword
    arguments explicitly to opt in.

    To explicitly clear ``current_session_id`` (or
    ``current_catch_all_session_id``) back to NULL, pass the
    module-level :data:`CLEAR_SENTINEL` string (``"__CLEAR__"``). The
    plain default ``None`` means "leave this column alone."
    """

    current_session_id: Optional[str] = None
    last_scale_weight_g: Optional[float] = None
    last_scale_event_ts: Optional[str] = None
    door_open: Optional[int] = None
    shelf_name: Optional[str] = None
    camera_locked_json: Optional[str] = None
    current_catch_all_session_id: Optional[str] = None
