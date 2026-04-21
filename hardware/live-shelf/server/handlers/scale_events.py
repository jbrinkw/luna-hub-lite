"""Scale event + heartbeat ingestion (Bundle H).

`POST /api/scale-event` — full §5.3/§5.4 pipeline:
    1. Validate body against the §4.1 schema.
    2. Dedup by (device_id, event_seq).
    3. Classify direction from delta magnitude.
    4. For non-noise events: save before/after frames, record the row,
       invoke the classifier synchronously, update lot state per §5.3/§5.4,
       enqueue review for low-confidence / unknown results.

`POST /api/scale-heartbeat` — keeps app_state.last_scale_weight_g fresh
and records the ESP's uptime for diagnostics.
"""

from __future__ import annotations

import json
import logging
import math
import re
import shutil
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from dataclasses import asdict, is_dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from flask import Blueprint, jsonify, request

from .. import shelves as shelf_registry
from ..camera import session_capture
from ..camera.daemon import CameraDaemon, now_iso_utc_ms, parse_iso_utc
from ..classifier.classify import classify_event
from ..classifier.models import (
    CandidateSource,
    ClassifierContext,
    ScaleEvent as ClsScaleEvent,
    UNKNOWN_CANDIDATE_ID,
)
from ..cloud.integration import CloudEventEmitter, null_emitter
from ..storage import repo as storage_repo
from ..storage import lifecycle
from ..storage.lifecycle import ReasonCode
from ..storage.models import (
    AppStatePatch,
    LotIn,
    ReviewQueueIn,
    ScaleEventIn,
    SessionResolutionIn,
    UsageLogIn,
)

log = logging.getLogger(__name__)

# ISO-8601 regex — permissive enough to handle ms precision + Z or +00:00.
_ISO_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$"
)

# Minimum plausible year for an ESP-originated timestamp. The ESP's
# isoTimestampMs() falls back to 1970-based uptime before NTP syncs;
# accepting those would corrupt session correlation (no session window
# matches 1970). Rejecting with a 400 causes the ESP's FIFO to requeue
# the event, which will retry once NTP is synced. 2024 is a safe floor —
# the demo shipped in 2026 and the hardware obviously can't precede that.
_MIN_PLAUSIBLE_YEAR = 2024

# Confidence below which we enqueue a review even for identified events.
LOW_CONFIDENCE_THRESHOLD: float = 0.75

# Volatile per-device runtime state updated by heartbeats. Visual-only signals
# (stable flag, last seen) live here instead of sqlite to avoid write
# amplification at the heartbeat cadence (0.5s).
_SCALE_RUNTIME_STATE: dict[str, dict[str, Any]] = {}
_SCALE_RUNTIME_LOCK = threading.Lock()

# Rolling buffer of (esp_ts, pi_ts, weight, stable, uptime, kind) — one entry
# per heartbeat + one per scale-event. Exposed via /api/diag/dump-session so
# the frame trace can be overlaid with the weight trace when tuning anchors.
# At ~500ms heartbeat cadence, 600 samples = 5 minutes.
_WEIGHT_TRACE: dict[str, deque] = {}
_WEIGHT_TRACE_LOCK = threading.Lock()
_WEIGHT_TRACE_MAX = 600


def _append_weight_trace(entry: dict[str, Any]) -> None:
    """Append one sample to the per-device rolling weight trace."""
    device_id = entry.get("device_id") or "scale-01"
    with _WEIGHT_TRACE_LOCK:
        buf = _WEIGHT_TRACE.get(device_id)
        if buf is None:
            buf = deque(maxlen=_WEIGHT_TRACE_MAX)
            _WEIGHT_TRACE[device_id] = buf
        buf.append(entry)


def get_weight_trace(device_id: Optional[str] = None) -> list[dict[str, Any]]:
    """Return a snapshot of the rolling weight trace for a device.

    If device_id is None, returns the first registered device's trace. Returns
    an empty list if no samples have been buffered yet.
    """
    with _WEIGHT_TRACE_LOCK:
        if device_id is None:
            if not _WEIGHT_TRACE:
                return []
            buf = next(iter(_WEIGHT_TRACE.values()))
        else:
            buf = _WEIGHT_TRACE.get(device_id)
            if buf is None:
                return []
        return list(buf)

# After this many seconds without a fresh heartbeat, treat the stored entry as
# absent (suppress from reads) so a stale ``scale_stable`` value isn't served
# after an ESP reboot or network hiccup. The entry itself is preserved so a
# single missed tick doesn't wipe device metadata.
_RUNTIME_STATE_TTL_SECONDS: float = 10.0


def _runtime_entry_is_fresh(entry: dict[str, Any], now: float) -> bool:
    """True if the entry's heartbeat timestamp is within the TTL window."""
    ts = entry.get("ts")
    if not isinstance(ts, str):
        return False
    try:
        # Accept the common ``...Z`` shorthand for UTC.
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age = now - parsed.timestamp()
    return age <= _RUNTIME_STATE_TTL_SECONDS


def get_scale_runtime_state(device_id: Optional[str] = None) -> dict[str, Any]:
    """Return the latest runtime state for a device.

    If device_id is None, returns the first registered device's state (sufficient
    for single-scale demos). Returns an empty dict if nothing has heartbeated yet.

    Entries whose ``ts`` is older than ``_RUNTIME_STATE_TTL_SECONDS`` are
    suppressed from reads (empty dict returned) — this keeps ``/api/state``
    from serving a pre-reboot ``scale_stable`` value after the ESP restarts.
    The underlying entry is not deleted; a fresh heartbeat revives it.
    """
    now = time.time()
    with _SCALE_RUNTIME_LOCK:
        if device_id is None:
            if not _SCALE_RUNTIME_STATE:
                return {}
            entry = next(iter(_SCALE_RUNTIME_STATE.values()))
        else:
            entry = _SCALE_RUNTIME_STATE.get(device_id, {})
            if not entry:
                return {}
        if not _runtime_entry_is_fresh(entry, now):
            return {}
        return dict(entry)


# --- Weight-fit helpers --------------------------------------------------

# Maximum relative error between |delta_g| and the summed expected weights
# of the classifier's picked candidates. A match within this tolerance lets
# us override the confidence gate: the arithmetic alone is ~certain when the
# sum of catalog weights lands within 3% of the scale-observed delta. The
# prompt suggests a looser 5-10% tolerance to the model so it doesn't
# artificially suppress multi_match; the apply path then enforces the
# tighter 3%.
_WEIGHT_FIT_TOLERANCE: float = 0.03


def _compute_weight_fit(
    classification: dict[str, Any],
    direction: str,
    delta_g: Optional[float],
) -> tuple[bool, list[str], float]:
    """Return (weight_match_ok, picked_ids, summed_expected_g).

    picked_ids = ``item_id`` (if present and non-UNKNOWN) followed by any
    multi_match entries for REMOVE events. When item_id is UNKNOWN, the list
    contains only the multi_match entries — so this helper can be called
    BEFORE a promotion decision to determine whether multi_match alone
    weight-fits.

    Returns (False, picked_ids, summed) when pool info is incomplete or
    any expected_weight_g is missing — i.e. we cannot form a decisive
    arithmetic argument and must fall back to confidence gating.
    """

    try:
        pool_by_id: dict[str, dict[str, Any]] = {}
        for c in classification.get("candidate_pool_used") or []:
            if isinstance(c, dict) and c.get("candidate_id"):
                pool_by_id[str(c["candidate_id"])] = c

        picked_ids: list[str] = []
        item_id = classification.get("item_id")
        if item_id and item_id not in {UNKNOWN_CANDIDATE_ID, "unknown"}:
            picked_ids.append(str(item_id))
        if direction == "remove":
            for m in classification.get("multi_match") or []:
                if isinstance(m, dict) and m.get("candidate_id"):
                    mid = str(m["candidate_id"])
                    if mid not in picked_ids:
                        picked_ids.append(mid)
        if not picked_ids:
            return False, [], 0.0

        summed_expected = 0.0
        for pid in picked_ids:
            cand = pool_by_id.get(pid)
            if cand is None:
                return False, picked_ids, 0.0
            w = cand.get("expected_weight_g")
            if w is None:
                return False, picked_ids, 0.0
            summed_expected += float(w)
        if summed_expected <= 0 or delta_g is None:
            return False, picked_ids, summed_expected
        abs_delta = abs(float(delta_g))
        if abs_delta <= 0:
            return False, picked_ids, summed_expected
        fit_err = abs(abs_delta - summed_expected) / abs_delta
        return (fit_err <= _WEIGHT_FIT_TOLERANCE), picked_ids, summed_expected
    except Exception:
        log.exception("weight-fit computation raised; returning False")
        return False, [], 0.0


def _pick_promotion_item_id(
    classification: dict[str, Any],
    direction: str,
    delta_g: Optional[float],
) -> Optional[str]:
    """Return the candidate_id to promote item_id to, or None.

    Triggered when the classifier returned item_id=UNKNOWN but its
    multi_match weight-fits |delta_g| within _WEIGHT_FIT_TOLERANCE. The
    promoted id is the highest-expected-weight candidate among multi_match
    — a stable deterministic pick so this is idempotent. Applies to REMOVE
    events only (ADD never emits multi_match).
    """

    if direction != "remove":
        return None
    weight_match_ok, picked_ids, _ = _compute_weight_fit(
        classification, direction, delta_g
    )
    if not weight_match_ok or not picked_ids:
        return None

    pool_by_id: dict[str, dict[str, Any]] = {}
    for c in classification.get("candidate_pool_used") or []:
        if isinstance(c, dict) and c.get("candidate_id"):
            pool_by_id[str(c["candidate_id"])] = c
    best_id: Optional[str] = None
    best_weight = -1.0
    for pid in picked_ids:
        cand = pool_by_id.get(pid) or {}
        w = cand.get("expected_weight_g")
        if w is None:
            continue
        w_f = float(w)
        if w_f > best_weight:
            best_weight = w_f
            best_id = pid
    return best_id


class ScaleHandler:
    """Encapsulates the ingest pipeline + required dependencies.

    The heavy lifting lives here (not in the blueprint factory) so the
    same object can be reused across tests with a minimal Flask app.
    """

    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        db_lock: threading.RLock,
        camera: CameraDaemon,
        candidate_source: CandidateSource,
        events_root: Path,
        delta_threshold_g: float,
        lookback_seconds: float,
        recently_out_window_seconds: int,
        dedup_cache_size: int = 2048,
        classifier_client: Any | None = None,
        reconciler_fn: Optional[Callable[[str], None]] = None,
        lifecycle_verbose: bool = False,
        # In-flight tracker knobs (IN_FLIGHT_TRACKER_PLAN.md §9). Defaults
        # match config.py; app.py wires the current AppConfig values.
        in_flight_ttl_seconds: int = 14_400,
        new_item_weight_ratio: float = 1.15,
        consumption_noise_floor_g: float = 2.0,
        # Catch-all scale wiring (CATCH_ALL_SCALE_PLAN.md §4.3, §6).
        # Optional so existing (pre-catch-all) callers that don't pass
        # these keep working — the handler then treats every event as
        # belonging to the live_shelf, matching the legacy behavior.
        catch_all_enabled: bool = False,
        shelf_registry_override: Optional[dict[str, Any]] = None,
        # Cloud event emitter (PROD_MIGRATION_PLAN.md Phase 4). Defaults
        # to a no-op sentinel so legacy tests + pre-cloud callers work
        # unchanged; ``app.py`` injects a real emitter when
        # CLOUD_ENABLED=true.
        cloud_emitter: Optional[CloudEventEmitter] = None,
        # Optional CloudClient — used ONLY for fire-and-forget tare-
        # capture push-back (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.2 cloud
        # resolution). When None, tare captures still land locally; the
        # cloud never hears about them. Duck-typed so tests can pass a
        # stub with a single ``post_product_tare`` method.
        cloud_client: Any | None = None,
    ) -> None:
        self._conn = conn
        self._db_lock = db_lock
        self._camera = camera
        self._candidate_source = candidate_source
        self._events_root = Path(events_root)
        self._delta_threshold_g = float(delta_threshold_g)
        self._lookback = float(lookback_seconds)
        self._recently_out_window_seconds = int(recently_out_window_seconds)
        self._classifier_client = classifier_client
        # Callable that runs reconcile_session(session_id) under the
        # appropriate deps (see server.app for wiring). Invoked at the
        # end of process_session_events so the reconciler sees events
        # that have already been classified, not still-pending ones
        # that would otherwise be stamped "unknown".
        self._reconciler_fn = reconciler_fn
        # Dedup cache: ordered dict used as an LRU of
        # (device_id, event_seq) → event_id.
        self._dedup: "OrderedDict[tuple[str, int], str]" = OrderedDict()
        self._dedup_limit = int(dedup_cache_size)
        self._dedup_lock = threading.Lock()
        # Bounded concurrency for fire-and-forget classification threads
        # so a burst of post-close events can't spawn N concurrent
        # Anthropic calls (each holding ~5 seconds + multiple DB
        # transactions). The semaphore blocks new dispatches until a
        # running classifier finishes. The sweeper shares this bound
        # because it uses the same underlying method.
        self._classify_semaphore = threading.BoundedSemaphore(value=3)
        # Monotonic counter bumped by the admin wipe path. Classifier
        # threads read it at start and compare before each DB write; if
        # it has changed, they abort to avoid inserting review_queue
        # rows / minting lots that reference wiped data. Callers bump
        # via ``bump_wipe_epoch()``.
        self._wipe_epoch = 0
        self._wipe_epoch_lock = threading.Lock()
        # Fix 6: track the last-seen ESP uptime per device so we can
        # detect reboots via a decreasing uptime and purge stale LRU
        # entries (``event_seq`` restarts at 0 after a reboot, which
        # would otherwise silently dedup the first post-reboot event).
        # Guarded by its own lock so two heartbeat threads reading +
        # writing concurrently can't miss a reboot or double-purge.
        self._last_uptime_s: dict[str, int] = {}
        self._uptime_lock = threading.Lock()
        self._lifecycle_verbose = bool(lifecycle_verbose)
        # In-flight tracker configuration.
        self._in_flight_ttl_seconds = int(in_flight_ttl_seconds)
        self._new_item_weight_ratio = float(new_item_weight_ratio)
        self._consumption_noise_floor_g = float(consumption_noise_floor_g)
        # Catch-all scale wiring. When disabled, unknown device_ids fall
        # back to live_shelf (pre-feature behavior). When enabled,
        # unknown device_ids are rejected so a misconfigured scale can't
        # silently pollute the live-shelf timeline.
        self._catch_all_enabled = bool(catch_all_enabled)
        self._shelf_registry = shelf_registry_override
        # Cloud emitter — no-op by default.
        self._cloud_emitter: CloudEventEmitter = (
            cloud_emitter if cloud_emitter is not None else null_emitter()
        )
        # Cloud client — used only by the tare-capture push-back. No-op
        # when None; the tare capture still lands locally.
        self._cloud_client = cloud_client
        # LiveTrack import poller — when attached, its snapshot drives the
        # import-arm interception branch in handle_scale_event. Duck-typed
        # so tests can pass a stub with a single ``snapshot()`` method.
        self._livetrack_poller = None

    def set_livetrack_poller(self, poller: Any) -> None:
        """Attach a LiveTrack session poller.

        Wired post-construction so ``app.py`` can build the poller with
        the handler's already-constructed ``_cloud_client``. The handler
        only reads ``poller.snapshot()``; everything else (poll cadence,
        AI-tare, reconnect) is the poller's concern.
        """
        self._livetrack_poller = poller

    def _push_tare_to_cloud(self, product_id: str, tare_g: float) -> None:
        """Fire-and-forget cloud push of a captured tare value.

        Per the CATCH_ALL_TARE_CAPTURE_PLAN cloud resolution: local write
        is authoritative and synchronous; cloud push is best-effort and
        must never raise / block the HTTP response. Any exception is
        swallowed + logged at WARNING. When ``cloud_client`` is None (or
        the client lacks ``post_product_tare``), the call is a silent
        no-op — useful for the legacy / tests / cloud-disabled paths.
        """
        client = self._cloud_client
        if client is None:
            return
        push = getattr(client, "post_product_tare", None)
        if not callable(push):
            return
        try:
            push(product_id=product_id, tare_g=float(tare_g))
        except Exception:  # noqa: BLE001 — must never raise
            log.warning(
                "cloud: post_product_tare failed for product_id=%s (non-fatal)",
                product_id,
                exc_info=True,
            )

    def _scale_id_for_shelf(self, shelf_id: Optional[str]) -> str:
        """Map a shelf_id to the physical device_id cloud expects.

        Looks up the shelf in the local registry (if one was injected);
        falls back to the defaults ``scale-01`` / ``scale-02`` / custom
        single-item device_id. Used by the cloud-mirror helpers that
        need to stamp the ``scale_id`` field on outbox payloads.
        """
        reg = self._shelf_registry
        if reg and shelf_id in reg:
            cfg = reg[shelf_id]  # type: ignore[index]
            return str(getattr(cfg, "device_id", "scale-01"))
        # Static fallbacks mirror shelves.DEFAULT_REGISTRY.
        if shelf_id == "catch_all":
            return "scale-02"
        if shelf_id == "single_item":
            return "scale-single"
        return "scale-01"

    def emit_single_item_event(
        self,
        *,
        scale_id: str,
        product_id: str,
        delta_g: float,
        occurred_at: Optional[str] = None,
        depleted: bool = False,
        refill_threshold_g: Optional[float] = None,
    ) -> Optional[str]:
        """Public hook for single-item (``live_scale``) scale commits.

        Single-item hardware isn't implemented on the Pi yet (PROD_MIGRATION_PLAN.md
        phase 1 single-shelf demo); this method exists so the eventual
        handler + the cloud-integration test can drive the classifier
        without waiting on the hardware wiring. Delegates to
        :meth:`CloudEventEmitter.emit_single_item_event` which handles
        the consumed/refilled/depleted/noise branching.
        """
        return self._cloud_emitter.emit_single_item_event(
            scale_id=scale_id,
            product_id=product_id,
            delta_g=float(delta_g),
            # Reuse the noise floor that governs in-flight return
            # consumption clamping — same physical reality.
            noise_floor_g=self._consumption_noise_floor_g,
            refill_threshold_g=(
                float(refill_threshold_g)
                if refill_threshold_g is not None
                else self._delta_threshold_g
            ),
            depleted=depleted,
            occurred_at=occurred_at,
        )

    def _lc_event(
        self,
        event_id: Optional[str],
        *,
        actor: str,
        reason_code: str,
        payload: Optional[dict[str, Any]] = None,
        verbose: bool = False,
    ) -> None:
        """Thin wrapper — log one event_lifecycle row.

        ``verbose=True`` rows are suppressed unless
        ``self._lifecycle_verbose`` is set (keeps the high-volume
        sweeper_considered / frames_archive_tick traffic off-by-default).
        The underlying helper never raises.
        """
        if verbose and not self._lifecycle_verbose:
            return
        lifecycle.log_event(
            self._conn, self._db_lock, event_id,
            actor=actor, reason_code=reason_code, payload=payload,
        )

    def _lc_session(
        self,
        session_id: Optional[str],
        *,
        actor: str,
        reason_code: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> None:
        lifecycle.log_session(
            self._conn, self._db_lock, session_id,
            actor=actor, reason_code=reason_code, payload=payload,
        )

    # ------------------------------------------------------------ helpers

    def _dedup_get(self, key: tuple[str, int]) -> Optional[str]:
        with self._dedup_lock:
            hit = self._dedup.get(key)
            if hit is not None:
                # Promote to most-recently-used.
                self._dedup.move_to_end(key)
            return hit

    def _dedup_set(self, key: tuple[str, int], event_id: str) -> None:
        with self._dedup_lock:
            self._dedup[key] = event_id
            self._dedup.move_to_end(key)
            while len(self._dedup) > self._dedup_limit:
                self._dedup.popitem(last=False)

    def _dedup_purge_device(self, device_id: str) -> None:
        """Remove all LRU entries for ``device_id``.

        Called on detected ESP reboot so a freshly-reset ``event_seq``
        starting at 0 doesn't collide with the pre-reboot entry for
        ``(device_id, 0)``.
        """
        with self._dedup_lock:
            stale = [k for k in self._dedup if k[0] == device_id]
            for k in stale:
                self._dedup.pop(k, None)

    def apply_user_reviewed_candidate(
        self,
        *,
        event_id: str,
        candidate_id: str,
    ) -> dict[str, Any]:
        """Apply a user-confirmed candidate_id to an event's lot state.

        Called when a user resolves a ``low_confidence`` review by
        picking one of the candidates the classifier offered. This
        bypasses the confidence threshold (the user has overridden it)
        but still runs the full pool-validation + lot-vs-product-id
        resolution that the classifier path uses — we don't want a UI
        bug to let arbitrary ids be applied.

        Returns a small status dict:
            {"applied": bool, "reason": str, "lot_id": str | None}
        """
        with self._db_lock:
            row = self._conn.execute(
                """
                SELECT event_id, ts, direction, delta_g, classification,
                       classifier_status, shelf_id
                  FROM scale_events
                 WHERE event_id = ?
                """,
                (event_id,),
            ).fetchone()
        if row is None:
            return {"applied": False, "reason": "event not found", "lot_id": None}
        event_ts = row[1]
        direction = row[2]
        delta_g = float(row[3])
        try:
            classification = json.loads(row[4] or "null") or {}
        except (TypeError, ValueError):
            classification = {}
        # Shelf discriminator — thread through to the apply helper so a
        # user-review resolution of a catch-all event still mints on
        # the right shelf. NULL fallback keeps legacy rows on
        # live_shelf (matches SQL DEFAULT).
        event_shelf_id = row[6] if row[6] else "live_shelf"

        # Validate the user's pick against the candidate pool the
        # classifier saw — prevents a malformed UI payload from applying
        # a lot id that wasn't actually offered for this event.
        pool = classification.get("candidate_pool_used") or []
        valid_ids = {
            str(c.get("candidate_id"))
            for c in pool
            if isinstance(c, dict) and c.get("candidate_id")
        }
        if valid_ids and str(candidate_id) not in valid_ids:
            return {
                "applied": False,
                "reason": f"candidate {candidate_id} not in event pool",
                "lot_id": None,
            }
        # Synthesize a classification dict the existing apply path can
        # consume. We set confidence > threshold so the guard passes; we
        # already vetted the user's pick above.
        forced = {
            "item_id": candidate_id,
            "action": "added" if direction == "add" else "removed",
            "confidence": 1.0,
            "candidate_pool_used": pool,
            "multi_match": [],
        }
        # Snapshot on_shelf lots before so we can report which new lot
        # (if any) got minted by the apply call.
        #
        # M5: wrap the whole read→apply→stamp block in a single
        # transactional context (``self._db_lock`` + ``self._conn``).
        # ``_apply_lot_update_from_classification`` issues several writes
        # internally (``mark_lot_in_flight``, ``write_resolution``,
        # ``update_event_classification``); without the outer
        # ``self._conn`` context, a mid-path exception leaves partially
        # applied state. Matching the pattern used by
        # ``_classify_recorded_event`` ensures every sub-write either all
        # commits together or all rolls back.
        with self._db_lock, self._conn:
            before_lot_ids = {
                r[0] for r in self._conn.execute(
                    "SELECT lot_id FROM lots WHERE product_id = ? "
                    "AND status = 'on_shelf'",
                    (candidate_id,),
                )
            }
            # Resolve session_id for dedup guard (B3a). The event row
            # may not carry it directly in this helper so fetch it
            # alongside everything else we already read.
            ur_session_id: Optional[str] = None
            try:
                ur_sid_row = self._conn.execute(
                    "SELECT session_id FROM scale_events WHERE event_id = ?",
                    (event_id,),
                ).fetchone()
                if ur_sid_row is not None:
                    ur_session_id = ur_sid_row[0]
            except Exception:  # pragma: no cover - defensive
                ur_session_id = None
            self._apply_lot_update_from_classification(
                direction=direction,
                classification=forced,
                event_ts=event_ts,
                delta_g=delta_g,
                session_id=ur_session_id,
                event_id=event_id,
                shelf_id=event_shelf_id,
            )
            # If the apply path minted a new lot, return its id.
            after_lot_ids = {
                r[0] for r in self._conn.execute(
                    "SELECT lot_id FROM lots WHERE product_id = ? "
                    "AND status = 'on_shelf'",
                    (candidate_id,),
                )
            }
            new_lot_ids = list(after_lot_ids - before_lot_ids)
            # Also mark the event row as 'classified' with the forced
            # classification so re-viewing the event doesn't still show
            # the original low-confidence result.
            classification["item_id"] = candidate_id
            classification["confidence"] = 1.0
            classification["user_confirmed"] = True
            self._conn.execute(
                "UPDATE scale_events SET classifier_status = 'classified', "
                "classification = ? WHERE event_id = ?",
                (json.dumps(classification), event_id),
            )
        return {
            "applied": True,
            "reason": "ok",
            "lot_id": new_lot_ids[0] if new_lot_ids else None,
        }

    def _direction(self, delta_g: float) -> str:
        if delta_g > self._delta_threshold_g:
            return "add"
        if delta_g < -self._delta_threshold_g:
            return "remove"
        return "noise"

    def _event_dir(self, event_id: str) -> Path:
        p = self._events_root / event_id
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _capture_frames(
        self,
        event_id: str,
        before_src: Optional[str],
        after_src: Optional[str],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """Copy the session-capture before/after JPEGs into the event dir.

        Events reference their own copies of the frames (rather than the
        session paths directly) so that session-dir cleanup or wipe
        operations don't orphan the event record. The copy is a cheap
        filesystem op — the JPEGs are already encoded.

        Returns ``(before_final, after_final, err)``. On any missing source
        or copy failure the slot is None and ``err`` describes which side
        failed. Missing before is non-fatal; missing after is fatal (the
        classifier needs an after image).
        """
        out_dir = self._event_dir(event_id)

        after_final: Optional[str] = None
        if after_src is None:
            return None, None, "no after frame available (session still open?)"
        try:
            dst = out_dir / "after.jpg"
            shutil.copyfile(after_src, dst)
            after_final = str(dst.resolve())
        except OSError as exc:
            return None, None, f"after copy failed: {exc}"

        before_final: Optional[str] = None
        if before_src is None:
            return None, after_final, "no before frame available (no session opened yet)"
        try:
            dst = out_dir / "before.jpg"
            shutil.copyfile(before_src, dst)
            before_final = str(dst.resolve())
        except OSError as exc:
            return None, after_final, f"before copy failed: {exc}"

        return before_final, after_final, None

    def _emit_usage_log(
        self,
        *,
        lot_id: str,
        product_id: Optional[str],
        product_name: Optional[str],
        product_brand: Optional[str],
        container_type: Optional[str],
        consumed_g: float,
        pickup_weight_g: Optional[float],
        return_weight_g: Optional[float],
        kind: str,
        session_id: Optional[str],
        pickup_event_id: Optional[str],
        return_event_id: Optional[str],
        occurred_at: str,
    ) -> None:
        """Best-effort usage_log insert. USAGE_LOG_PLAN.md §4.

        Called from apply / reaper sites. Swallows all exceptions so
        observability can't break the caller — emission failures are
        logged at WARNING so operators notice, but the event flow
        continues. Fills missing product fields by looking up the
        product row if the caller didn't pre-resolve it.
        """
        # Resolve product_id from the lot if caller didn't supply one.
        resolved_product_id = product_id
        name = product_name
        brand = product_brand
        container = container_type
        try:
            if not resolved_product_id and lot_id:
                with self._db_lock:
                    lot_row = storage_repo.get_lot(self._conn, lot_id)
                    if lot_row is not None:
                        resolved_product_id = lot_row.product_id
            if resolved_product_id and (not name or brand is None):
                with self._db_lock:
                    product = storage_repo.get_product(
                        self._conn, resolved_product_id
                    )
                    if product is not None:
                        name = name or product.name
                        brand = brand if brand is not None else product.brand
                        container = (
                            container if container is not None
                            else product.container_type
                        )
        except Exception:  # pragma: no cover - defensive
            log.warning(
                "usage_log: failed to resolve product for lot %s (kind=%s)",
                lot_id, kind, exc_info=True,
            )

        if not resolved_product_id or not name:
            log.warning(
                "usage_log: skipping %s for lot %s — missing product info",
                kind, lot_id,
            )
            return

        # Lifecycle observability: tie the successful write (or the
        # failure) back to the event that triggered it. Prefer the return
        # event_id (the side that just caused the write) over the pickup
        # id so the lifecycle trail shows ``usage_logged`` at the moment
        # the row landed. Fall back to the pickup id when return is
        # absent (e.g. TTL-expired reaper path).
        lc_event_id = return_event_id or pickup_event_id

        written_row: Any = None
        try:
            with self._db_lock:
                written_row = storage_repo.write_usage_log(
                    self._conn,
                    UsageLogIn(
                        lot_id=lot_id,
                        product_id=resolved_product_id,
                        product_name=name,
                        product_brand=brand,
                        container_type=container,
                        consumed_g=float(consumed_g),
                        pickup_weight_g=pickup_weight_g,
                        return_weight_g=return_weight_g,
                        kind=kind,  # type: ignore[arg-type]
                        session_id=session_id,
                        pickup_event_id=pickup_event_id,
                        return_event_id=return_event_id,
                        occurred_at=occurred_at,
                    ),
                )
        except Exception as exc:
            log.warning(
                "usage_log: write failed for lot %s (kind=%s)",
                lot_id, kind, exc_info=True,
            )
            # Fire USAGE_LOG_WRITE_FAILED on exception so operators can
            # trace why a user-visible usage row didn't materialize.
            self._lc_event(
                lc_event_id,
                actor="usage",
                reason_code=ReasonCode.USAGE_LOG_WRITE_FAILED,
                payload={
                    "error": str(exc),
                    "kind": kind,
                    "lot_id": lot_id,
                },
            )
            return

        # Success (row was inserted) — emit USAGE_LOGGED. write_usage_log
        # returns None when the unique-index dedup rejected the row; in
        # that case we stay quiet because the prior emitter already
        # logged the successful write.
        if written_row is not None:
            usage_id = getattr(written_row, "usage_id", None)
            self._lc_event(
                lc_event_id,
                actor="usage",
                reason_code=ReasonCode.USAGE_LOGGED,
                payload={
                    "usage_id": usage_id,
                    "consumed_g": float(consumed_g),
                    "kind": kind,
                    "product_id": resolved_product_id,
                },
            )

    def _apply_add_against_in_flight_lot(
        self,
        *,
        lot: Any,
        delta_g: float,
        event_ts: str,
        event_id: Optional[str],
        session_id: Optional[str],
        action: Optional[str] = None,
    ) -> bool:
        """Handle an ADD event that resolved to an in_flight lot.

        IN_FLIGHT_TRACKER_PLAN.md §4.2–§4.3. Branches on the ratio of
        return_delta / pickup_weight_g:
          * ≤ new_item_weight_ratio → return branch. Compute consumption
            (pickup − delta, clamped at noise floor and at 0 for the
            total_consumed_g accumulator). Lot flips back to on_shelf.
          * >  new_item_weight_ratio → replacement branch. Close the
            in-flight lot as ``out`` and let the caller mint a new lot
            for the heavier returned mass.

        ``action`` is the classifier's ``action`` field. Per §4.9, when
        the classifier explicitly says ``action="added_to_existing"``,
        the return branch writes ``pattern="topped_up"`` in the
        session_resolutions row instead of ``in_flight_return`` — the
        user added contents to the same container rather than merely
        returning it. usage_log ``kind`` stays ``in_flight_return``
        (that enum is separate).

        Returns True if this helper fully handled the event (return or
        in-session close), False if the caller should fall through to the
        default ADD lot-resolve path (e.g. pickup_weight_g was NULL on
        the in-flight row, which shouldn't happen but we want to degrade
        gracefully rather than crash).
        """
        pickup_weight_g = lot.pickup_weight_g
        if pickup_weight_g is None or pickup_weight_g <= 0:
            # Corrupt state — treat as a plain return (flip to on_shelf)
            # so the lot doesn't get stuck in_flight forever. Log loudly.
            log.warning(
                "in_flight lot %s has pickup_weight_g=%r; cannot compute "
                "consumption. Falling through to default ADD update.",
                lot.lot_id, pickup_weight_g,
            )
            return False

        abs_delta = abs(float(delta_g))
        ratio = abs_delta / float(pickup_weight_g)

        if ratio > self._new_item_weight_ratio:
            # Replacement: user put something heavier in the same slot.
            # Close the old lot as ``out`` and record the pickup weight
            # as consumption — the old item is gone, we just don't know
            # what happened to it (presumed eaten / discarded off-shelf).
            # The added weight is left unattributed at this layer — the
            # reconciler will pick it up at session close, or human
            # review resolves it. We do NOT mint a new lot inline
            # because the classifier picked an in-flight lot (not a
            # catalog product), so we have no authoritative product_id
            # to mint against.
            log.info(
                "in_flight replacement: lot %s pickup=%.1fg return=%.1fg "
                "(ratio=%.2f > %.2f) — closing old lot as out",
                lot.lot_id, pickup_weight_g, abs_delta, ratio,
                self._new_item_weight_ratio,
            )
            storage_repo.close_in_flight_as_replaced(
                self._conn, lot.lot_id,
                consumed_g=float(pickup_weight_g),
                last_out_at=event_ts,
            )
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.LOT_REPLACED_IN_FLIGHT,
                payload={
                    "lot_id": lot.lot_id,
                    "pickup_weight_g": pickup_weight_g,
                    "return_delta_g": abs_delta,
                    "ratio": ratio,
                },
            )
            if session_id is not None:
                try:
                    storage_repo.write_resolution(
                        self._conn,
                        SessionResolutionIn(
                            session_id=session_id,
                            pattern="in_flight_replaced_new_item",
                            lot_id=lot.lot_id,
                            consumed_g=float(pickup_weight_g),
                            add_event_id=event_id,
                        ),
                    )
                except Exception:  # pragma: no cover - defensive
                    log.exception(
                        "failed to write in_flight_replaced_new_item "
                        "resolution for event %s", event_id,
                    )
            # Cloud mirror — replacement means the old lot's mass is
            # presumed consumed off-shelf. Fire a ``consumed`` event for
            # that product. The new lot gets minted inline by the
            # classifier path and produces its own ``added`` event via
            # the reconciler on session close. Gated: emitter is a
            # no-op when CLOUD_ENABLED=false.
            try:
                self._cloud_emitter.emit_in_flight_reap(
                    scale_id=self._scale_id_for_shelf(
                        getattr(lot, "shelf_id", "live_shelf")
                    ),
                    product_id=getattr(lot, "product_id", "") or "",
                    consumed_g=float(pickup_weight_g),
                    occurred_at=event_ts,
                )
            except Exception:  # pragma: no cover - defensive
                log.warning(
                    "cloud emit failed for in-flight replacement of %s",
                    lot.lot_id, exc_info=True,
                )
            # Usage log emission — best-effort.
            self._emit_usage_log(
                lot_id=lot.lot_id,
                product_id=getattr(lot, "product_id", None),
                product_name=None,
                product_brand=None,
                container_type=None,
                consumed_g=float(pickup_weight_g),
                pickup_weight_g=float(pickup_weight_g),
                return_weight_g=None,
                kind="in_flight_replaced_new_item",
                session_id=session_id,
                pickup_event_id=getattr(lot, "pickup_event_id", None),
                return_event_id=event_id,
                occurred_at=event_ts,
            )
            # Return True — this matched_id is fully handled. The loop
            # moves to the next id (if any); extra ids with catalog
            # products can still mint new lots via the default path.
            return True

        # Return branch: same item coming back, possibly lighter.
        raw_consumption = float(pickup_weight_g) - abs_delta
        if abs(raw_consumption) < self._consumption_noise_floor_g:
            consumption_g = 0.0
        else:
            consumption_g = raw_consumption

        log.info(
            "in_flight return: lot %s pickup=%.1fg return=%.1fg "
            "consumption=%.2fg (ratio=%.2f <= %.2f)",
            lot.lot_id, pickup_weight_g, abs_delta, consumption_g,
            ratio, self._new_item_weight_ratio,
        )
        storage_repo.return_lot_from_flight(
            self._conn, lot.lot_id,
            return_weight_g=abs_delta,
            consumption_g=consumption_g,
            return_ts=event_ts,
        )
        self._lc_event(
            event_id,
            actor="classifier",
            reason_code=ReasonCode.LOT_RETURNED_FROM_FLIGHT,
            payload={
                "lot_id": lot.lot_id,
                "pickup_weight_g": pickup_weight_g,
                "return_delta_g": abs_delta,
                "consumption_g": consumption_g,
            },
        )
        # §4.9: when the classifier explicitly signals the user added
        # contents to the existing container (rather than merely putting
        # the same item back), route the resolution row to the existing
        # ``topped_up`` pattern the reconciler already knows how to apply.
        # The usage_log ``kind`` is a separate enum and stays
        # ``in_flight_return`` below.
        resolution_pattern = (
            "topped_up" if action == "added_to_existing" else "in_flight_return"
        )
        if session_id is not None:
            try:
                storage_repo.write_resolution(
                    self._conn,
                    SessionResolutionIn(
                        session_id=session_id,
                        pattern=resolution_pattern,
                        lot_id=lot.lot_id,
                        consumed_g=consumption_g,
                        add_event_id=event_id,
                    ),
                )
            except Exception:  # pragma: no cover - defensive
                log.exception(
                    "failed to write %s resolution for event %s",
                    resolution_pattern, event_id,
                )
        # Cloud mirror for the return branch. Map the fast-path
        # resolution_pattern onto the cloud event_kind:
        #   * in_flight_return  → consumed (stock dropped by consumption_g)
        #   * topped_up         → refilled (stock rose by -consumption_g,
        #                         which is positive because consumption_g
        #                         was clamped negative for a top-up)
        try:
            product_id = getattr(lot, "product_id", None) or ""
            if product_id and resolution_pattern == "topped_up":
                # For a top-up, ``consumption_g`` is negative (user added
                # content). The added mass is the absolute value.
                refill_g = abs(float(consumption_g))
                if refill_g > 0:
                    self._cloud_emitter.emit_reconciler_resolution(
                        pattern="topped_up",
                        product_id=product_id,
                        scale_id=self._scale_id_for_shelf(
                            getattr(lot, "shelf_id", "live_shelf")
                        ),
                        kind="live_shelf",
                        delta_g=refill_g,
                        occurred_at=event_ts,
                    )
            elif product_id and consumption_g > 0:
                self._cloud_emitter.emit_reconciler_resolution(
                    pattern="in_flight_return",
                    product_id=product_id,
                    scale_id=self._scale_id_for_shelf(
                        getattr(lot, "shelf_id", "live_shelf")
                    ),
                    kind="live_shelf",
                    delta_g=-float(consumption_g),
                    occurred_at=event_ts,
                )
        except Exception:  # pragma: no cover - defensive
            log.warning(
                "cloud emit failed for in-flight return of %s",
                lot.lot_id, exc_info=True,
            )
        # Usage log emission — best-effort, swallows errors.
        self._emit_usage_log(
            lot_id=lot.lot_id,
            product_id=getattr(lot, "product_id", None),
            product_name=None,   # resolved via the lot
            product_brand=None,
            container_type=None,
            consumed_g=consumption_g,
            pickup_weight_g=float(pickup_weight_g),
            return_weight_g=abs_delta,
            kind="in_flight_return",
            session_id=session_id,
            pickup_event_id=getattr(lot, "pickup_event_id", None),
            return_event_id=event_id,
            occurred_at=event_ts,
        )
        return True

    def _apply_lot_update_from_classification(
        self,
        *,
        direction: str,
        classification: Any,
        event_ts: str,
        delta_g: float,
        session_id: Optional[str] = None,
        event_id: Optional[str] = None,
        shelf_id: str = "live_shelf",
    ) -> None:
        """§5.3 / §5.4 lot updates at event time (not consumption math).

        For ADD events: matched lot (if `on_shelf` or `out`) goes back to
        `on_shelf` with the new weight. For REMOVE events: matched lots
        flip to `out` with last_out_at. We DO NOT update total_consumed_g
        here — that's the reconciler's job.

        ``delta_g`` is the weight change attributable to THIS event (not
        the whole-scale reading). For ADD events it equals the new
        item's mass; for REMOVE events it's negative. Using the delta
        instead of the absolute scale reading is what lets multi-item
        shelves track each lot's weight independently.
        """
        if not isinstance(classification, dict):
            return
        confidence = float(classification.get("confidence", 0.0) or 0.0)
        item_id = classification.get("item_id")
        if not item_id or item_id in {UNKNOWN_CANDIDATE_ID, "unknown"}:
            # UNKNOWN escape hatch: if direction=remove and multi_match
            # weight-fits, promote item_id to the highest-expected-weight
            # multi_match entry and proceed. Caller may have already
            # promoted at the outer level (_classify_recorded_event does
            # this before calling us); this branch is defensive for callers
            # that pass an unmodified classification dict (e.g. sweeper
            # retries, review resolution).
            promoted = _pick_promotion_item_id(classification, direction, delta_g)
            if promoted is None:
                return
            log.info(
                "apply: promoted UNKNOWN -> %s via weight-fit "
                "(inside _apply_lot_update_from_classification)",
                promoted[:8],
            )
            # Shadow the incoming dict with a copy so we don't mutate caller
            # state. Downstream reads (candidate_pool_used, multi_match)
            # still see the original values.
            classification = {**classification, "item_id": promoted}
            item_id = promoted

        # Weight-fit override: bypass the confidence threshold when the
        # picked candidate(s)' expected weights sum to within 3% of the
        # event's |delta_g|. Rationale: multi_match REMOVEs of bundled
        # items are visually ambiguous (shelf looks "mostly empty" and
        # individual items blur together in one motion) so the AI
        # correctly expresses lower confidence — but a ≤3% weight match
        # on a picked candidate set is ~certain identification by
        # arithmetic alone. Single-item picks within 3% also benefit
        # when the after-frame is dim / occluded.
        weight_match_ok, picked_ids, summed_expected = _compute_weight_fit(
            classification, direction, delta_g
        )
        if weight_match_ok and delta_g is not None:
            abs_delta = abs(float(delta_g))
            fit_err = abs(abs_delta - summed_expected) / abs_delta if abs_delta else 0.0
            log.info(
                "weight-fit override: bypassing conf=%.2f < %.2f "
                "threshold — |delta|=%.1fg vs Σexpected=%.1fg "
                "(fit_err=%.1f%%, ids=%s)",
                confidence, LOW_CONFIDENCE_THRESHOLD,
                abs_delta, summed_expected, fit_err * 100.0,
                [p[:8] for p in picked_ids],
            )

        if confidence < LOW_CONFIDENCE_THRESHOLD and not weight_match_ok:
            return

        # Fix 2: build a validation set of ids that were ACTUALLY in the
        # candidate pool we fed the classifier. The classifier is not
        # trusted to invent ids — if an item_id / multi_match entry
        # isn't in the pool, the model hallucinated it and we skip
        # rather than mutating a random lot.
        valid_ids: set[str] = {
            str(c.get("candidate_id"))
            for c in (classification.get("candidate_pool_used") or [])
            if isinstance(c, dict) and c.get("candidate_id")
        }

        # Fix 3: also collect any product_ids referenced by the pool so
        # we can cross-check after lot resolution. ``catalog_not_on_shelf``
        # picks carry the product_id directly as candidate_id (per
        # candidate_pool.py); other sources may attach an explicit
        # ``product_id`` field on the candidate payload. Collect both.
        valid_product_ids: set[str] = set()
        for c in classification.get("candidate_pool_used") or []:
            if not isinstance(c, dict):
                continue
            pid = c.get("product_id")
            if pid:
                valid_product_ids.add(str(pid))
            if c.get("why_candidate") == "catalog_not_on_shelf" and c.get(
                "candidate_id"
            ):
                valid_product_ids.add(str(c["candidate_id"]))

        # Fix 2 (primary item_id): classifier returned an id not in the
        # pool we sent — treat as hallucination and bail before touching
        # any lots.
        if valid_ids and str(item_id) not in valid_ids:
            log.warning(
                "classifier returned item_id %r not in candidate pool; "
                "skipping lot update",
                item_id,
            )
            return

        matched_ids: list[str] = [str(item_id)]
        if direction == "remove":
            for m in classification.get("multi_match") or []:
                if not (isinstance(m, dict) and m.get("candidate_id")):
                    continue
                mid = str(m["candidate_id"])
                # Fix 2: validate each multi_match id against the pool.
                if valid_ids and mid not in valid_ids:
                    log.warning(
                        "multi_match: classifier returned id %r not in "
                        "candidate pool; skipping",
                        mid,
                    )
                    continue
                matched_ids.append(mid)

        # Weight to assign to the lot on an ADD event. For a multi-item
        # shelf, the item's own mass is ``+delta_g``, not the absolute
        # after-scale reading.
        lot_weight_g = abs(float(delta_g)) if delta_g is not None else 0.0

        # Resolve each id. The classifier may return either a lot_id (when a
        # `recently_out` / `top_up_target` / `currently_on_shelf` candidate was
        # picked) or a product_id (when a `catalog_not_on_shelf` candidate was
        # picked — the lot doesn't exist yet and we must mint it here).
        for cid in matched_ids:
            lot = storage_repo.get_lot(self._conn, cid)
            if lot is not None:
                # Fix 3: guard against the lot_id-vs-product_id ambiguity.
                # If get_lot(cid) succeeded but that lot's product_id was
                # NOT in the pool we sent, the classifier likely picked a
                # product_id (catalog_not_on_shelf) that coincidentally
                # collides with an unrelated lot_id. Log which path was
                # taken, and when we have pool product_ids to validate
                # against, skip the mismatched resolution entirely.
                if valid_product_ids and lot.product_id not in valid_product_ids:
                    log.warning(
                        "classifier id %r resolved to lot %s (product %s) "
                        "but that product is not in the candidate pool; "
                        "skipping lot update to avoid ambiguity",
                        cid, lot.lot_id, lot.product_id,
                    )
                    continue
                # Bug B3a: in-session dedup. If another event in this
                # session already wrote a session_resolutions row against
                # this lot, a second apply would double-book the same
                # lot (observed: two ADDs in one session both minting
                # ``new_arrival`` against the same parmesan lot). Skip
                # the duplicate apply and log — the classifier likely
                # picked the same id twice because the before/after
                # frames were too similar to distinguish siblings.
                #
                # NOTE: caller (_classify_recorded_event) already holds
                # ``self._db_lock`` when calling into this function —
                # ``threading.Lock`` is non-reentrant, so attempting to
                # re-acquire here deadlocks the thread against itself.
                # The SELECT runs under the already-held lock.
                if session_id is not None:
                    try:
                        existing = self._conn.execute(
                            "SELECT resolution_id, pattern, add_event_id, "
                            "remove_event_id FROM session_resolutions "
                            "WHERE session_id = ? AND lot_id = ?",
                            (session_id, lot.lot_id),
                        ).fetchall()
                    except Exception:  # pragma: no cover - defensive
                        existing = []
                    sibling = None
                    for row in existing:
                        row_add = row[2]
                        row_remove = row[3]
                        if event_id is not None and (
                            row_add == event_id or row_remove == event_id
                        ):
                            # Same event — legitimate (e.g. reconciler
                            # already wrote a row for THIS event). Not a
                            # duplicate.
                            continue
                        # in_flight_pickup is the EXPECTED predecessor for
                        # an in_flight_return / in_flight_replaced_new_item
                        # on the ADD side of the same session — NOT a
                        # duplicate. Whitelist it so ADD events against
                        # in-flight lots aren't erroneously skipped.
                        if row[1] == "in_flight_pickup" and direction == "add":
                            continue
                        sibling = row
                        break
                    if sibling is not None:
                        log.warning(
                            "lot %s already resolved in session %s by another "
                            "event (pattern=%s); skipping duplicate apply for "
                            "event %s (direction=%s)",
                            lot.lot_id, session_id, sibling[1],
                            event_id, direction,
                        )
                        continue
                log.info(
                    "lot update: resolved id %r as lot_id (lot=%s product=%s)",
                    cid, lot.lot_id, lot.product_id,
                )
                if direction == "add":
                    # In-flight return/replacement branch — when the
                    # classifier picked a lot that's currently in_flight,
                    # decide whether this is a return (consumption math)
                    # or a replacement (new item in the same slot) based
                    # on the pickup-vs-delta weight ratio.
                    if lot.status == "in_flight":
                        # Extract the classifier's ``action`` field so the
                        # helper can route topped_up vs in_flight_return
                        # per §4.9. Defensive: ``classification`` may have
                        # been rebuilt via ``{**classification, ...}`` above,
                        # which preserves all original keys including
                        # ``action``.
                        cls_action = None
                        if isinstance(classification, dict):
                            cls_action = classification.get("action")
                        handled = self._apply_add_against_in_flight_lot(
                            lot=lot,
                            delta_g=lot_weight_g,
                            event_ts=event_ts,
                            event_id=event_id,
                            session_id=session_id,
                            action=cls_action,
                        )
                        # handled=True → return or replacement ran; skip
                        # the default ADD update.
                        # handled=False → fall through (e.g. missing
                        # pickup_weight_g for an in_flight lot means data
                        # is corrupt — treat as a plain return).
                        if handled:
                            continue
                    storage_repo.update_lot(
                        self._conn,
                        cid,
                        status="on_shelf",
                        current_weight_g=lot_weight_g,
                        last_seen_at=event_ts,
                    )
                elif direction == "remove":
                    # Bug B3b: don't double-flip an already-out lot. If
                    # status=='out' we'd just re-stamp last_out_at with
                    # a later ts, which the reconciler would read as a
                    # "recently removed" signal even though this REMOVE
                    # event is spurious (e.g. classifier picked the same
                    # parmesan lot twice). Log + skip.
                    if lot.status == "out":
                        log.warning(
                            "remove: lot %s (product %s) is already status='out' "
                            "(last_out_at=%s); skipping redundant flip for event %s",
                            lot.lot_id, lot.product_id, lot.last_out_at, event_id,
                        )
                        continue
                    # If the lot is ALREADY in_flight (e.g. a duplicate
                    # remove event classified to the same lot), don't
                    # clobber the in_flight_since or pickup_weight_g —
                    # the first pickup is authoritative.
                    if lot.status == "in_flight":
                        log.warning(
                            "remove: lot %s (product %s) is already in_flight "
                            "(since=%s); skipping redundant pickup for event %s",
                            lot.lot_id, lot.product_id,
                            lot.in_flight_since, event_id,
                        )
                        # L3: still write an in_flight_pickup resolution
                        # for THIS redundant REMOVE event so the reconciler's
                        # claimed_event_ids skip logic covers it. Without
                        # this row, the reconciler would later resolve
                        # the same event as ``consumed_or_removed`` on
                        # top of the original pickup — double-booking.
                        # The original REMOVE's in_flight_pickup row is
                        # preserved; we now have two rows pointing at
                        # the same lot — that's fine because the C3
                        # skip logic requires a terminal in_flight row
                        # for either to be claimed anyway.
                        if session_id is not None and event_id is not None:
                            try:
                                storage_repo.write_resolution(
                                    self._conn,
                                    SessionResolutionIn(
                                        session_id=session_id,
                                        pattern="in_flight_pickup",
                                        lot_id=lot.lot_id,
                                        confidence=confidence,
                                        remove_event_id=event_id,
                                    ),
                                )
                            except Exception:  # pragma: no cover - defensive
                                log.exception(
                                    "failed to write redundant in_flight_pickup "
                                    "resolution for event %s", event_id,
                                )
                        continue
                    # In-flight REMOVE branch (IN_FLIGHT_TRACKER_PLAN.md §4.1):
                    # transition on_shelf -> in_flight, preserving the
                    # pickup weight so the return event can compute
                    # consumption. pickup_weight_g is the lot's current
                    # weight reading BEFORE this remove (which equals
                    # the delta magnitude for single-item removals and
                    # is the recorded current_weight_g otherwise).
                    pickup_weight = (
                        lot.current_weight_g
                        if lot.current_weight_g is not None
                        else abs(float(delta_g)) if delta_g is not None else 0.0
                    )
                    # H5: pass ``event_id`` straight through — the
                    # storage layer now accepts Optional[str] and the
                    # ``usage_log`` dedup index on ``pickup_event_id``
                    # is partial (``WHERE pickup_event_id IS NOT NULL``).
                    # Coercing to "" previously collapsed every
                    # null-pickup row into a single dedup entry, which
                    # silently dropped distinct in-flight rows.
                    storage_repo.mark_lot_in_flight(
                        self._conn,
                        cid,
                        pickup_weight_g=float(pickup_weight or 0.0),
                        pickup_event_id=event_id,
                        pickup_session_id=session_id,
                        in_flight_since=event_ts,
                    )
                    self._lc_event(
                        event_id,
                        actor="classifier",
                        reason_code=ReasonCode.LOT_MARKED_IN_FLIGHT,
                        payload={
                            "lot_id": cid,
                            "pickup_weight_g": pickup_weight,
                        },
                    )
                    # Record in_flight_pickup resolution so the dashboard +
                    # reconciler can see this event is accounted for.
                    if session_id is not None:
                        try:
                            storage_repo.write_resolution(
                                self._conn,
                                SessionResolutionIn(
                                    session_id=session_id,
                                    pattern="in_flight_pickup",
                                    lot_id=cid,
                                    confidence=confidence,
                                    remove_event_id=event_id,
                                ),
                            )
                        except Exception:  # pragma: no cover - defensive
                            log.exception(
                                "failed to write in_flight_pickup resolution "
                                "for event %s", event_id,
                            )
                continue

            # No lot with this id. Only ADD events can mint a new lot from a
            # catalog product — REMOVE events with an unresolved id can't
            # possibly refer to anything real (nothing to remove).
            if direction != "add":
                continue
            product = storage_repo.get_product(self._conn, cid)
            if product is None:
                # Neither lot nor product — skip (defensive).
                continue
            # Bug B3a: in-session dedup for new-lot minting. If another
            # event in this session already minted a lot for this
            # product (picked by product_id from catalog_not_on_shelf),
            # a second mint is almost always a duplicate picking — the
            # classifier couldn't distinguish two ADDs of different
            # items and picked the same product id twice. Check for an
            # existing resolution against ANY on-shelf lot of this
            # product in the same session.
            #
            # Caller (_classify_recorded_event) already holds
            # ``self._db_lock``; re-acquiring here deadlocks (non-
            # reentrant). Read under the already-held lock.
            if session_id is not None:
                try:
                    dup_rows = self._conn.execute(
                        """
                        SELECT sr.resolution_id, sr.pattern, sr.lot_id,
                               sr.add_event_id
                          FROM session_resolutions sr
                          JOIN lots l ON l.lot_id = sr.lot_id
                         WHERE sr.session_id = ?
                           AND l.product_id = ?
                        """,
                        (session_id, product.product_id),
                    ).fetchall()
                except Exception:  # pragma: no cover - defensive
                    dup_rows = []
                dup = None
                for row in dup_rows:
                    if event_id is not None and row[3] == event_id:
                        continue
                    dup = row
                    break
                if dup is not None:
                    log.warning(
                        "product %s already received a session_resolution in "
                        "session %s (lot=%s, pattern=%s); skipping duplicate "
                        "new-lot mint for event %s",
                        product.product_id, session_id, dup[2], dup[1],
                        event_id,
                    )
                    continue
            # Fix 3: informational log — id resolved as product_id path.
            log.info(
                "lot update: resolved id %r as product_id (minting new lot)",
                cid,
            )
            try:
                new_lot = storage_repo.create_lot(
                    self._conn,
                    LotIn(
                        product_id=product.product_id,
                        status="on_shelf",
                        current_weight_g=lot_weight_g,
                        initial_weight_g=lot_weight_g,
                        total_consumed_g=0.0,
                        placed_at=event_ts,
                        last_seen_at=event_ts,
                        # CATCH_ALL_SCALE_PLAN.md §7: new lots inherit
                        # the event's shelf_id so a catch-all ADD on a
                        # catalog_not_on_shelf pick mints the lot on
                        # the correct shelf. Defaults to 'live_shelf'
                        # from the helper's kwarg when the caller
                        # doesn't thread it (e.g. user-review apply).
                        shelf_id=shelf_id,  # type: ignore[arg-type]
                    ),
                )
            except Exception:  # pragma: no cover - defensive
                log.exception(
                    "failed to create lot for product %s from event",
                    product.product_id,
                )
                continue
            log.info(
                "created new lot %s for product %s (%.1fg delta) from ADD event",
                new_lot.lot_id,
                product.product_id,
                lot_weight_g,
            )

    # ------------------------------------------------------------ main entrypoints

    def handle_scale_event(self, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        """Process one POST /api/scale-event body. Returns (resp, status)."""
        validation = _validate_event_payload(payload)
        if isinstance(validation, str):
            return {"error": validation}, 400

        # Capture Pi's wall-clock at receipt time. The ESP's clock (``ts`` in
        # the payload) can be +/- several hundred ms off the Pi's NTP-synced
        # clock; using the ESP ts for ring-buffer lookups pulls frames from
        # the wrong moment (notably after the ESP's blue-LED flash because
        # the ``future-skewed`` requested ts falls back to the newest frame
        # in the buffer). Using the Pi's receive ts means lookups are in the
        # ring buffer's native timeline, within ~100ms of the real stabilize
        # moment — orders of magnitude better than ~900ms clock skew.
        pi_received_ts = now_iso_utc_ms()

        ts = payload["ts"]
        device_id = str(payload["device_id"])
        event_seq = int(payload["event_seq"])
        delta_g = float(payload["delta_g"])
        before_weight_g = float(payload["before_weight_g"])
        after_weight_g = float(payload["after_weight_g"])

        # Device → shelf resolution (CATCH_ALL_SCALE_PLAN.md §6). The
        # registry is the authoritative mapping from ESP device_id to
        # physical shelf. On a miss we branch on the feature flag:
        #   * catch_all_enabled=False → fall back to 'live_shelf'
        #     (preserves pre-feature behavior for any legacy device_id,
        #     typically 'scale-01').
        #   * catch_all_enabled=True  → 400 the event. Silently accepting
        #     from an unknown device would let a mis-provisioned ESP
        #     pollute the live-shelf timeline with catch-all data or
        #     vice-versa.
        shelf = shelf_registry.get_shelf_for_device(
            device_id, self._shelf_registry
        )
        if shelf is not None:
            shelf_id = shelf.shelf_id
        elif self._catch_all_enabled:
            log.warning(
                "scale-event: unknown device_id %r with catch-all enabled; "
                "rejecting", device_id,
            )
            return {"error": f"unknown device_id {device_id!r}"}, 400
        else:
            shelf_id = "live_shelf"

        # Type-literal drift: the shelf registry (shelves.py) + ESP firmware
        # + cloud `chefbyte.scale_pairings.kind` CHECK all use "live_scale"
        # for the single-item kind. The Pi's storage-side Literal (models.py)
        # + SQLite CHECK constraints still use "single_item". Translate at
        # the ingress boundary so everything downstream (ScaleEventIn, DB
        # writes, reconciler) sees the storage-native name. Changing the
        # storage literal would require a migration on every deployed Pi
        # DB — translation is the less-invasive fix.
        if shelf_id == "live_scale":
            shelf_id = "single_item"

        # Classify direction ahead of the tare-arm branch so we can gate
        # on direction != 'noise' — noise events are sub-threshold and
        # meaningless as tare values. The dedup + session pipeline below
        # re-uses this same value (previously computed after dedup; the
        # classification is deterministic on ``delta_g`` so hoisting is
        # side-effect-free).
        direction = self._direction(delta_g)

        # LiveTrack Import interception (2026-04-21-livetrack-import-wizard.md §8).
        # Runs BEFORE the tare-arm branch because ``waiting_scale`` is the
        # more specific state — only one of the two branches fires per event,
        # since the LiveTrack session ownership and the local tare_arm row are
        # independent pieces of state that the owner could theoretically hold
        # simultaneously. Guards:
        #   * catch-all scale only (same invariant as tare-arm).
        #   * non-noise event (sub-threshold readings aren't credible).
        #   * poller attached AND its snapshot is state=='waiting_scale'.
        # On match: POSTs after_weight_g back via the cloud client and short-
        # circuits the event — no scale_events row, no classifier, no session
        # correlation. A cloud-POST failure is logged and the event still
        # short-circuits (the session ownership already moved to the cloud
        # side, so falling through to delta detection would double-apply).
        if shelf_id == "catch_all" and direction != "noise":
            arm = self._livetrack_poller.snapshot() if self._livetrack_poller is not None else None
            if arm is not None and arm.get("state") == "waiting_scale":
                session_id = str(arm.get("session_id", ""))
                client = self._cloud_client
                posted = False
                if session_id and client is not None:
                    fn = getattr(client, "post_livetrack_session_update", None)
                    if callable(fn):
                        try:
                            fn(
                                session_id,
                                scale_reading_g=float(after_weight_g),
                                scale_reading_ts=pi_received_ts,
                                state="scale_reading_received",
                            )
                            posted = True
                        except Exception:  # noqa: BLE001 — must never raise
                            log.warning(
                                "livetrack: post_livetrack_session_update failed "
                                "(session_id=%s); dropping event",
                                session_id, exc_info=True,
                            )
                log.info(
                    "livetrack: import arm intercepted event — "
                    "session_id=%s, reading=%.1fg, posted=%s",
                    session_id, after_weight_g, posted,
                )
                return {
                    "ok": True,
                    "intercepted": "livetrack_import",
                    "session_id": session_id,
                    "scale_reading_g": float(after_weight_g),
                    "posted": posted,
                }, 200

        # Tare-arm interception (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.3).
        # Must run BEFORE dedup so a duplicate retry doesn't fire the
        # tare twice, and BEFORE the normal session/classifier pipeline
        # so an armed-active event doesn't also leak into reconciliation.
        #
        # Gating:
        #   * only the catch-all scale is armable (shelf_id == 'catch_all'
        #     is load-bearing — live-shelf events never trigger tare).
        #   * direction != 'noise' — sub-threshold readings are not
        #     credible tare values.
        #   * arm row must be present AND not expired (read helper filters).
        #
        # Direction handling:
        #   * 'add' events: the container was just placed on the scale,
        #     so ``after_weight_g`` is the new settled reading — use it.
        #   * 'remove' events: the container was just lifted OFF, so the
        #     ``before_weight_g`` is the settled reading from when it
        #     was sitting there — use that. This lets the operator pick
        #     up the already-on-scale container after clicking Tare
        #     without an "arm then place" dance.
        #   * 'noise' never intercepts (skipped above).
        #
        # Bounds: ``tare_g`` must be within [min_weight_g, max_weight_g]
        # (defaults 5..5000). Out-of-bounds stamps ``last_error`` on the
        # arm row and returns without consuming — operator re-places or
        # cancels. A successful capture writes the tare to the products
        # row, deletes the arm, and short-circuits the event (no
        # scale_events row, no classifier, no session correlation).
        if shelf_id == "catch_all" and direction != "noise":
            tare_captured = False
            tare_product_id: Optional[str] = None
            tare_g: Optional[float] = None
            tare_reason: Optional[str] = None
            with self._db_lock:
                arm = storage_repo.get_active_tare_arm(
                    self._conn, device_id=device_id,
                )
                if arm is not None:
                    # 'add' → settled weight is after; 'remove' → before.
                    reading = (
                        after_weight_g if direction == "add"
                        else before_weight_g
                    )
                    reading_g = float(reading)
                    if (
                        reading_g < arm.min_weight_g
                        or reading_g > arm.max_weight_g
                    ):
                        storage_repo.set_tare_arm_error(
                            self._conn,
                            f"implausible reading {reading_g:.1f}g "
                            f"(bounds {arm.min_weight_g:.0f}..{arm.max_weight_g:.0f}g)",
                        )
                        tare_product_id = arm.product_id
                        tare_g = reading_g
                        tare_reason = "implausible_weight"
                    else:
                        storage_repo.consume_tare_arm(
                            self._conn,
                            product_id=arm.product_id,
                            tare_g=reading_g,
                        )
                        tare_captured = True
                        tare_product_id = arm.product_id
                        tare_g = reading_g
            # Short-circuit outside the lock so we can log lifecycle +
            # kick the cloud push without holding the db_lock longer
            # than needed.
            if tare_captured and tare_product_id is not None and tare_g is not None:
                self._lc_event(
                    None,
                    actor="tare_capture",
                    reason_code="TARE_CAPTURE",
                    payload={
                        "product_id": tare_product_id,
                        "device_id": device_id,
                        "weight_g": tare_g,
                        "direction": direction,
                        "esp_ts": ts, "pi_ts": pi_received_ts,
                    },
                )
                # Fire-and-forget cloud push. Must NOT throw / block — a
                # local tare is authoritative even if the cloud is down.
                self._push_tare_to_cloud(tare_product_id, tare_g)
                return {
                    "ok": True,
                    "tare_captured": True,
                    "product_id": tare_product_id,
                    "tare_g": tare_g,
                    "direction": direction,
                }, 200
            if tare_reason is not None:
                # Arm stays active; operator sees last_error via
                # /api/tare/status and can re-place or cancel.
                return {
                    "ok": True,
                    "tare_captured": False,
                    "reason": tare_reason,
                    "weight_g": tare_g,
                    "product_id": tare_product_id,
                }, 200
            # No arm active → fall through to the normal pipeline.

        # Append an "event" marker to the weight trace so diag dumps show
        # events inline with the heartbeat trace. Kept here (before dedup)
        # so even duplicate retries show up for visibility.
        _append_weight_trace({
            "kind": "event",
            "device_id": device_id,
            "esp_ts": ts,
            "pi_ts": pi_received_ts,
            "event_seq": event_seq,
            "delta_g": delta_g,
            "before_weight_g": before_weight_g,
            "after_weight_g": after_weight_g,
            "motion_start_ms_before": payload.get("motion_start_ms_before"),
            "stability_window_ms": payload.get("stability_window_ms"),
        })

        # Dedup — both in the in-memory LRU and the DB
        # (scale_events has no unique constraint on (device_id, event_seq),
        # but notes column can keep an audit trail if we ever need it).
        dedup_key = (device_id, event_seq)
        existing = self._dedup_get(dedup_key)
        if existing is not None:
            self._lc_event(
                existing,
                actor="fast_path",
                reason_code=ReasonCode.EVENT_INGRESS_DEDUP_HIT,
                payload={
                    "device_id": device_id, "event_seq": event_seq,
                    "esp_ts": ts, "pi_ts": pi_received_ts,
                },
            )
            return {"ok": True, "event_id": existing, "duplicate": True}, 200

        # ``direction`` hoisted above the tare-arm branch. Fix 3: fetch
        # current_session_id and insert the scale_events
        # row in ONE lock-held critical section. Previously this was
        # split across two ``with self._db_lock:`` blocks, letting a
        # brightness close slip in between and stamp the event with a
        # stale session_id (or a concurrent open stamp it too early).
        if direction == "noise":
            with self._db_lock:
                app_state = storage_repo.get_app_state(self._conn)
                session_id = app_state.current_session_id
                ev = storage_repo.record_scale_event(
                    self._conn,
                    ScaleEventIn(
                        ts=ts,
                        delta_g=delta_g,
                        before_weight_g=before_weight_g,
                        after_weight_g=after_weight_g,
                        direction="noise",
                        session_id=session_id,
                        classifier_status=None,
                        # Anchor to Pi clock so downstream consumers
                        # (reviews, diagnostics) can correlate noise
                        # events across the same timeline as real ones.
                        pi_received_ts=pi_received_ts,
                        shelf_id=shelf_id,
                    ),
                )
                storage_repo.update_app_state(
                    self._conn,
                    AppStatePatch(
                        last_scale_weight_g=after_weight_g,
                        last_scale_event_ts=ts,
                    ),
                )
                # Dedup LRU is updated INSIDE the lock so a retry arriving
                # between the DB commit and the lock release can't slip
                # through and create a duplicate row.
                self._dedup_set(dedup_key, ev.event_id)
            self._lc_event(
                ev.event_id,
                actor="fast_path",
                reason_code=ReasonCode.EVENT_INGRESS_NOISE,
                payload={
                    "device_id": device_id, "event_seq": event_seq,
                    "esp_ts": ts, "pi_ts": pi_received_ts,
                    "delta_g": delta_g,
                    "before_weight_g": before_weight_g,
                    "after_weight_g": after_weight_g,
                    "session_id_at_ingress": session_id,
                },
            )
            return {"ok": True, "event_id": ev.event_id, "direction": "noise"}, 200

        # Non-noise events: record the DB row and return immediately.
        # Classification is done asynchronously by the session-close hook
        # (for events that match an open session) or by the sweeper (for
        # post-close events + orphans). The HTTP handler returns within
        # ~100ms — no session waits, no classifier API calls, no thread
        # pile-up during long door-open sessions.
        with self._db_lock:
            app_state = storage_repo.get_app_state(self._conn)
            session_id = app_state.current_session_id
            ev = storage_repo.record_scale_event(
                self._conn,
                ScaleEventIn(
                    ts=ts,
                    delta_g=delta_g,
                    before_weight_g=before_weight_g,
                    after_weight_g=after_weight_g,
                    direction=direction,
                    session_id=session_id,
                    classifier_status="pending",
                    # Store the Pi's NTP-synced receive time. The frame
                    # picker uses this (not ``ts``) because ESP sub-second
                    # precision is not NTP-synced; see ingress comment on
                    # pi_received_ts capture at handler entry.
                    pi_received_ts=pi_received_ts,
                    shelf_id=shelf_id,
                ),
            )
            storage_repo.update_app_state(
                self._conn,
                AppStatePatch(
                    last_scale_weight_g=after_weight_g,
                    last_scale_event_ts=ts,
                ),
            )
            event_id = ev.event_id
            self._dedup_set(dedup_key, event_id)

        self._lc_event(
            event_id,
            actor="fast_path",
            reason_code=ReasonCode.EVENT_INGRESS,
            payload={
                "device_id": device_id, "event_seq": event_seq,
                "esp_ts": ts, "pi_ts": pi_received_ts,
                "direction": direction, "delta_g": delta_g,
                "before_weight_g": before_weight_g,
                "after_weight_g": after_weight_g,
                "session_id_at_ingress": session_id,
            },
        )

        # If a matching closed session is ALREADY available at record
        # time (post-close event: scale stabilized after the door already
        # shut), classify inline on a best-effort basis without blocking.
        # Use a 0s wait so we don't delay the response. If the session
        # isn't ready yet, the sweeper picks it up within a few seconds.
        try:
            session, matched = session_capture.get_frames_for_event(
                pi_received_ts,
                wait_for_close_s=0.0,
                wait_for_video_s=0.0,
            )
        except Exception:
            log.exception("event %s: session lookup threw", event_id)
            session, matched = None, False
        if matched and session is not None:
            # Run the classification pipeline in a background thread so
            # the HTTP handler stays fast. The classifier may take 2-5s
            # on the Anthropic API; we don't want the ESP's 2s timeout
            # to fire for events that would otherwise succeed.
            self._lc_event(
                event_id,
                actor="fast_path",
                reason_code=ReasonCode.CLASSIFIER_DISPATCHED,
                payload={
                    "dispatch_path": "fast_path",
                    "session_open_ts": session.get("open_ts"),
                    "session_close_ts": session.get("close_ts"),
                },
            )
            self._dispatch_classification(event_id, session)
        # Events without a matching session stay "pending" — the sweeper
        # will try again periodically and eventually mark them failed if
        # no session ever arrives.

        return {
            "ok": True,
            "event_id": event_id,
            "direction": direction,
            "classifier_status": "pending",
        }, 200

    # ================================================================
    # Classification pipeline — invoked asynchronously via:
    #   * session_capture close hook (on_close_callback → process_session_events)
    #   * sweeper thread (for late/orphan events)
    #   * handle_scale_event fast-path (post-close events with a ready session)
    # ================================================================

    def process_session_events(self, session: dict[str, Any]) -> int:
        """Classify every ``pending`` event whose ``ts`` falls inside the
        given session's window. Called by session_capture on close.

        Returns the count of events processed. Runs inline on the caller's
        thread — for the session-close callback that's the daemon's
        brightness-watcher thread, which is fine because the classifier
        calls are bounded and the watcher only needs to resume in time
        for the next transition (seconds-to-minutes scale, not ms).
        """
        open_ts = session.get("open_ts")
        close_ts = session.get("close_ts")
        if not open_ts or not close_ts:
            return 0
        # Grace period: events fire up to several seconds after close
        # (scale settling). Reference session_capture.POST_CLOSE_GRACE_S
        # directly so this stays aligned with the event-side lookup
        # window (previously hardcoded 15s while the source-of-truth
        # constant had already drifted to 30s).
        grace_end = None
        try:
            close_dt = datetime.fromisoformat(close_ts.replace("Z", "+00:00"))
            grace_end = close_dt + timedelta(
                seconds=session_capture.POST_CLOSE_GRACE_S,
            )
        except ValueError:
            grace_end = None
        grace_end_iso = (
            grace_end.strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{grace_end.microsecond // 1000:03d}Z"
            if grace_end
            else close_ts
        )
        # Fix: correlate by Pi clock, not ESP clock. Session open_ts/close_ts
        # are Pi wall-clock; scale_events.ts is ESP clock (see handoff §7.5).
        # The schema has no pi_received_ts column — use created_at, which the
        # DB stamps at INSERT time via datetime('now') (Pi clock). Because
        # created_at uses sqlite's space-separated format while the session
        # bounds are ISO-8601 'T...Z', both sides are normalized through
        # datetime() for a reliable comparison.
        with self._db_lock:
            rows = self._conn.execute(
                """
                SELECT event_id FROM scale_events
                 WHERE classifier_status = 'pending'
                   AND direction != 'noise'
                   AND datetime(created_at) >= datetime(?)
                   AND datetime(created_at) <= datetime(?)
                 ORDER BY created_at ASC
                """,
                (open_ts, grace_end_iso),
            ).fetchall()
        event_ids = [r[0] for r in rows]
        log.info("session %s: processing %d pending event(s)",
                 open_ts, len(event_ids))
        processed = 0
        for event_id in event_ids:
            try:
                self._classify_recorded_event(event_id, session)
                processed += 1
            except Exception:
                log.exception("event %s: classification threw", event_id)

        # ----------------------------------------------------------------
        # Session-level bulk-remove gap fill. The ESP only emits an event
        # when the scale declares stability, which requires the user to
        # pause between physical actions. For REMOVEs that's a lousy UX —
        # you should be able to grab several items out in one motion and
        # have the system figure out what left based on the before/after
        # image + the cumulative scale delta. We reconcile the session's
        # whole-scale reading vs. the sum of ESP events, and if there's
        # unaccounted NEGATIVE weight (items left without individual
        # stability events), synthesize ONE virtual REMOVE event for the
        # gap. That event uses session-boundary frames (before = empty /
        # pre-interaction, after = final state) and gets classified with
        # multi_match, letting the classifier enumerate which on-shelf
        # lots sum to the missing weight.
        # ----------------------------------------------------------------
        gap_event_id = self._maybe_synthesize_remove_gap(session, open_ts, close_ts)
        if gap_event_id is not None:
            try:
                self._classify_recorded_event(gap_event_id, session)
                processed += 1
            except Exception:
                log.exception(
                    "gap-remove event %s: classification threw", gap_event_id,
                )

        # ----------------------------------------------------------------
        # Spawn the reconciler AFTER classification has run, not before.
        # Previously BrightnessHandler._on_close spawned it inline, which
        # raced ahead of this method (the second close subscriber) and
        # caused the reconciler to see pending/unclassified events and
        # write "unknown" resolutions. By spawning it here, once the
        # loop above has flipped every pending event to classified /
        # review / failed, the reconciler sees real classifications.
        # ----------------------------------------------------------------
        if self._reconciler_fn is not None:
            session_id = self._find_session_id_by_open_ts(open_ts)
            if session_id:
                reconciler = self._reconciler_fn
                # Capture handler ref for the nested function to reach _lc_session.
                handler = self
                def _run_reconciler(sid: str = session_id) -> None:
                    handler._lc_session(
                        sid,
                        actor="reconciler",
                        reason_code=ReasonCode.RECONCILER_STARTED,
                        payload={"trigger": "process_session_events"},
                    )
                    try:
                        reconciler(sid)
                        handler._lc_session(
                            sid,
                            actor="reconciler",
                            reason_code=ReasonCode.RECONCILER_COMPLETED,
                            payload={"ok": True},
                        )
                    except Exception as exc:  # pragma: no cover - defensive
                        log.exception(
                            "reconciler failed for session %s", sid,
                        )
                        handler._lc_session(
                            sid,
                            actor="reconciler",
                            reason_code=ReasonCode.RECONCILER_COMPLETED,
                            payload={"ok": False, "error": repr(exc)},
                        )
                t = threading.Thread(
                    target=_run_reconciler,
                    name=f"reconciler-{session_id[:8]}",
                    daemon=True,
                )
                t.start()
            else:
                log.warning(
                    "process_session_events: no DB session row matched "
                    "open_ts=%s — skipping reconciler spawn", open_ts,
                )
        return processed

    def _find_session_id_by_open_ts(self, open_ts: str) -> Optional[str]:
        """Resolve a camera-session record's ``open_ts`` to the DB
        ``sessions.session_id`` used by the reconciler. Returns None if
        no row matches (session was wiped or never persisted)."""
        try:
            with self._db_lock:
                row = self._conn.execute(
                    "SELECT session_id FROM sessions WHERE started_at = ? "
                    "ORDER BY started_at DESC LIMIT 1",
                    (open_ts,),
                ).fetchone()
        except Exception:  # pragma: no cover - defensive
            log.exception("session lookup by open_ts threw")
            return None
        if not row:
            return None
        return str(row[0])

    # Minimum magnitude of unaccounted session-scale delta (g) that
    # triggers a synthetic REMOVE event. Below this we assume the gap is
    # drift / per-event rounding and not a real physical removal.
    _GAP_REMOVE_MIN_G: float = 20.0

    def _maybe_synthesize_remove_gap(
        self,
        session: dict[str, Any],
        open_ts: str,
        close_ts: str,
    ) -> Optional[str]:
        """Create a virtual REMOVE event for items that left the shelf in
        one fast motion (no ESP stability declaration). Returns the new
        event_id or None if the gap is too small / in the wrong direction.

        Compares:
            scale_delta        = final_shelf_weight_g - initial_shelf_weight_g
            accounted_delta    = sum(event.delta_g for event in session)
            unaccounted_delta  = scale_delta - accounted_delta

        When ``unaccounted_delta <= -_GAP_REMOVE_MIN_G`` we know the
        scale saw items leave that no individual event explains. We
        synthesize one REMOVE event for the full gap, stamp it into the
        session, and let the classifier use ``multi_match`` to enumerate
        which on-shelf lots sum to the missing mass.
        """
        session_id = self._find_session_id_by_open_ts(open_ts)
        if session_id is None:
            return None

        with self._db_lock:
            sess_row = self._conn.execute(
                "SELECT initial_shelf_weight_g, final_shelf_weight_g, shelf_id "
                "FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if sess_row is None:
                return None
            initial_w = sess_row[0]
            final_w = sess_row[1]
            if initial_w is None or final_w is None:
                return None
            session_shelf_id = sess_row[2] if sess_row[2] else "live_shelf"
            scale_delta = float(final_w) - float(initial_w)

            # Only count events that fired DURING the session, not
            # post-close grace events. final_shelf_weight_g is captured at
            # session close, so a post-close grace event's delta_g isn't
            # reflected in it — including that delta in `accounted` breaks
            # the invariant (accounted ≈ scale_delta when all items
            # stabilized) and triggers spurious gap-fill. Filter by
            # ts <= close_ts so only in-session stability events count.
            ev_rows = self._conn.execute(
                """
                SELECT delta_g FROM scale_events
                 WHERE session_id = ? AND direction != 'noise'
                   AND ts <= ?
                """,
                (session_id, close_ts),
            ).fetchall()

        accounted = sum(float(r[0] or 0.0) for r in ev_rows)
        unaccounted = scale_delta - accounted

        # Surface the decision even when we DON'T synthesize — lets a
        # future debugger tell "gap threshold wasn't exceeded" from
        # "gap-fill logic never ran."
        self._lc_session(
            session_id,
            actor="sweeper",
            reason_code=ReasonCode.GAP_FILL_CONSIDERED,
            payload={
                "scale_delta": scale_delta,
                "accounted": accounted,
                "unaccounted": unaccounted,
                "threshold": self._GAP_REMOVE_MIN_G,
            },
        )

        # Only synthesize for meaningful NEGATIVE gaps (items removed
        # without stability). A positive unaccounted delta would imply
        # items added without stability — that's physically implausible
        # (putting something down generates a settle) so we skip.
        if unaccounted > -self._GAP_REMOVE_MIN_G:
            self._lc_session(
                session_id,
                actor="sweeper",
                reason_code=ReasonCode.GAP_FILL_SKIPPED,
                payload={
                    "reason": "below_threshold",
                    "unaccounted": unaccounted,
                    "threshold": self._GAP_REMOVE_MIN_G,
                },
            )
            return None

        # Before weight for the synthetic event = the cumulative state
        # right after all ESP events fired. After weight = actual final.
        synth_before_w = float(initial_w) + accounted
        synth_after_w = float(final_w)
        synth_delta = synth_after_w - synth_before_w
        # Timestamp = session close (Pi clock). We set ESP ts = close_ts
        # so it falls inside the session window for per-event framing /
        # adapter filters.
        ts_iso = close_ts

        log.info(
            "session %s: synthesizing bulk-REMOVE gap event (scale_delta="
            "%.1fg, accounted=%.1fg, gap=%.1fg)",
            session_id, scale_delta, accounted, unaccounted,
        )

        with self._db_lock, self._conn:
            ev = storage_repo.record_scale_event(
                self._conn,
                ScaleEventIn(
                    ts=ts_iso,
                    delta_g=synth_delta,
                    before_weight_g=synth_before_w,
                    after_weight_g=synth_after_w,
                    direction="remove",
                    session_id=session_id,
                    classifier_status="pending",
                    # Synthetic event inherits the session's shelf_id so
                    # downstream classification + apply runs against the
                    # correct scoped candidate pool.
                    shelf_id=session_shelf_id,
                ),
            )
        self._lc_event(
            ev.event_id,
            actor="sweeper",
            reason_code=ReasonCode.GAP_FILL_SYNTHESIZED,
            payload={
                "session_id": session_id,
                "scale_delta": scale_delta,
                "accounted": accounted,
                "unaccounted": unaccounted,
                "delta_g": synth_delta,
                "before_weight_g": synth_before_w,
                "after_weight_g": synth_after_w,
            },
        )
        return ev.event_id

    def sweep_orphans(
        self,
        *,
        max_age_seconds: int = 60,
        min_age_seconds: int = 5,
    ) -> int:
        """Find events still in ``pending`` and either classify them
        (matching session now available) or mark them failed if they've
        waited too long without a session.

        Runs periodically in a background thread. ``min_age_seconds``
        avoids racing with the fast-path in ``handle_scale_event``;
        ``max_age_seconds`` is the point of no return — events older
        than that without a session get marked as sensor anomalies.

        Returns the total events touched.
        """
        # Fix: session windows are Pi wall-clock (daemon stamps them
        # with now_iso_utc_ms()), but scale_events.ts is ESP clock —
        # which can be off by ~900ms. Use the Pi-clock ``created_at``
        # (auto-stamped by SQLite's ``datetime('now')`` default) and
        # emit it via strftime in the exact ISO-8601 T...Z shape that
        # session_capture._parse_iso accepts — SQLite's raw format is
        # space-separated which fromisoformat used to reject on older
        # Pythons. Mirrors the same Pi-clock fix now in
        # process_session_events's event-selection query.
        with self._db_lock:
            rows = self._conn.execute(
                """
                SELECT event_id,
                       ts,
                       strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_iso,
                       direction,
                       delta_g,
                       classifier_status
                  FROM scale_events
                 WHERE classifier_status = 'pending'
                   AND direction != 'noise'
                 ORDER BY created_at ASC
                 LIMIT 100
                """
            ).fetchall()
        if not rows:
            return 0
        now = datetime.now(timezone.utc)
        # Fix 4: peek the currently-open session's open_ts (Pi clock, ISO-8601
        # UTC) under session_capture._LOCK so we don't age-fail events that
        # are still validly inside an ongoing long session (door open > 60s).
        # The lock is session_capture's own — holding it briefly is safe and
        # matches the access pattern used everywhere else in that module.
        current_open_iso: Optional[str] = None
        try:
            with session_capture._LOCK:
                if session_capture._CURRENT is not None:
                    current_open_iso = session_capture._CURRENT.get("open_ts")
        except Exception:  # pragma: no cover - defensive
            current_open_iso = None
        touched = 0
        for row in rows:
            # Wipe check (handoff §7.7): snapshot the wipe epoch at the
            # top of the per-row work so later write sites in this loop
            # can bail if an admin wipe runs mid-iteration. Mirrors the
            # pattern used in _classify_recorded_event.
            start_epoch = self._current_wipe_epoch()
            event_id = row[0]
            # row[1] is the ESP-clock ts — kept only for logging, NOT
            # passed to session_capture (session windows are Pi clock).
            created_at_iso = row[2]  # Pi clock, strftime'd to T...Z
            direction = row[3]
            delta_g = row[4]
            # Age by created_at (Pi receipt time), not ESP ts.
            try:
                created_dt = datetime.fromisoformat(
                    str(created_at_iso).replace("Z", "+00:00")
                )
            except ValueError:
                continue
            age_s = (now - created_dt).total_seconds()
            if age_s < min_age_seconds:
                continue  # too fresh; let fast-path handle it

            # Try to find a matching session now. Pass the Pi-clock
            # created_at, not the ESP ts (see bug note above).
            try:
                session, matched = session_capture.get_frames_for_event(
                    created_at_iso,
                    wait_for_close_s=0.0,
                    wait_for_video_s=0.0,
                )
            except Exception:
                log.exception("sweeper: session lookup threw for %s", event_id)
                continue

            if matched and session is not None:
                self._lc_event(
                    event_id,
                    actor="sweeper",
                    reason_code=ReasonCode.CLASSIFIER_DISPATCHED,
                    payload={
                        "dispatch_path": "sweeper",
                        "age_s": age_s,
                        "session_open_ts": session.get("open_ts"),
                    },
                )
                try:
                    self._classify_recorded_event(event_id, session)
                    touched += 1
                    self._lc_event(
                        event_id,
                        actor="sweeper",
                        reason_code=ReasonCode.SWEEPER_CLASSIFIED,
                        payload={"age_s": age_s},
                    )
                except Exception:
                    log.exception("sweeper: classify threw for %s", event_id)
                continue

            # No session matched. Only mark failed after the full wait.
            if age_s >= max_age_seconds:
                # Fix 4: don't age-fail events that are still inside the
                # currently-open session — a long door-open session (>60s)
                # would otherwise lose its early events to the sweeper
                # before the close callback ever gets to classify them.
                # Compare on ISO-8601 UTC strings (lexicographic equals
                # chronological for that shape).
                if (
                    current_open_iso is not None
                    and created_at_iso is not None
                    and str(created_at_iso) >= str(current_open_iso)
                ):
                    log.debug(
                        "sweeper: event %s (age=%.1fs) still inside "
                        "currently-open session (open_ts=%s); waiting",
                        event_id, age_s, current_open_iso,
                    )
                    self._lc_event(
                        event_id,
                        actor="sweeper",
                        reason_code=ReasonCode.SWEEPER_DEFERRED_TO_CLOSE_HOOK,
                        payload={
                            "age_s": age_s,
                            "reason": "inside_open_session",
                            "open_ts": current_open_iso,
                        },
                        verbose=True,
                    )
                    continue
                # Fix: also skip age-failing if the event falls inside a
                # recently-closed DB session whose camera close-hook may
                # not have fired yet. Brightness _on_close writes the
                # sessions row synchronously, but session_capture's
                # _handle_close (which populates the in-memory _CLOSED
                # deque used by get_frames_for_event) runs afterward on
                # the same thread — there's a several-second window
                # where the DB says "closed" but the frame lookup still
                # returns no match. Without this check, the sweeper
                # marks events failed that the close-hook would have
                # classified seconds later.
                try:
                    with self._db_lock:
                        db_sess = self._conn.execute(
                            """
                            SELECT session_id, ended_at
                              FROM sessions
                             WHERE started_at <= ?
                               AND (ended_at IS NULL OR
                                    datetime(ended_at, '+30 seconds') >= datetime(?))
                             ORDER BY started_at DESC
                             LIMIT 1
                            """,
                            (created_at_iso, created_at_iso),
                        ).fetchone()
                except Exception:  # pragma: no cover - defensive
                    db_sess = None
                if db_sess is not None:
                    log.info(
                        "sweeper: event %s (age=%.1fs) falls inside recently "
                        "closed session %s — waiting for close-hook to "
                        "populate frames rather than marking failed",
                        event_id, age_s, db_sess[0][:8] if db_sess[0] else "?",
                    )
                    self._lc_event(
                        event_id,
                        actor="sweeper",
                        reason_code=ReasonCode.SWEEPER_DEFERRED_TO_CLOSE_HOOK,
                        payload={
                            "age_s": age_s,
                            "reason": "recently_closed_session",
                            "session_id": db_sess[0],
                        },
                    )
                    continue
                # Wipe check: if an admin wipe fired since we started this
                # row, skip the write so we don't re-insert review_queue
                # rows referencing a now-deleted event.
                if self._current_wipe_epoch() != start_epoch:
                    log.info(
                        "sweeper: wipe happened during row %s; skipping "
                        "failed-status writeback", event_id,
                    )
                    continue
                log.warning(
                    "sweeper: event %s (dir=%s, delta=%+.1fg) has no "
                    "matching camera session after %.1fs — marking failed",
                    event_id, direction, delta_g, age_s,
                )
                err_json = json.dumps(
                    {"error": "no camera session (door was closed "
                              "with no lit frames at event time)",
                     "item_id": UNKNOWN_CANDIDATE_ID}
                )
                with self._db_lock:
                    storage_repo.update_event_classification(
                        self._conn,
                        event_id,
                        classification=err_json,
                        classifier_status="failed",
                    )
                    storage_repo.enqueue_review(
                        self._conn,
                        ReviewQueueIn(
                            kind="sensor_anomaly",
                            event_id=event_id,
                            session_id=None,
                            proposed=err_json,
                        ),
                    )
                self._lc_event(
                    event_id,
                    actor="sweeper",
                    reason_code=ReasonCode.SWEEPER_MARKED_FAILED,
                    payload={
                        "age_s": age_s,
                        "direction": direction,
                        "delta_g": delta_g,
                        "reason": "no_camera_session",
                    },
                )
                self._lc_event(
                    event_id,
                    actor="sweeper",
                    reason_code=ReasonCode.REVIEW_ENQUEUED,
                    payload={"kind": "sensor_anomaly"},
                )
                touched += 1
        return touched

    def bump_wipe_epoch(self) -> int:
        """Record that an admin wipe just ran. Classification threads in
        flight will see a new epoch on their next check and abort rather
        than writing rows that reference now-deleted data."""
        with self._wipe_epoch_lock:
            self._wipe_epoch += 1
            return self._wipe_epoch

    def _current_wipe_epoch(self) -> int:
        with self._wipe_epoch_lock:
            return self._wipe_epoch

    def _find_prior_event_pi_ts_in_session(
        self,
        session_id: Optional[str],
        current_event_ts: str,
    ) -> Optional[str]:
        """Return the Pi-clock ts of the most recent prior event in the
        same session whose ESP ts < ``current_event_ts``. Used by
        per-event framing so event N's "before" is event N-1's settled
        state. Returns None if no prior event exists in the session.

        Prior to 2026-04-16 this function returned the row's ``ts``
        (ESP ts), despite the "pi_ts" in its name. That was a real bug
        — the caller feeds this into ``pick_event_frames``, which
        indexes Pi-clock-timestamped camera frames. Cross-clock lookup
        fuzzed anchors by up to ±500ms (the ESP firmware fills
        sub-seconds from ``millis() % 1000``, un-synced to NTP).
        Ordering by ``ts`` is still correct — the ESP fires events in
        order and both rows are written in that order — but the
        RETURNED value is now ``pi_received_ts`` (with ``ts`` fallback
        for legacy rows that predate the migration).
        """
        if not session_id:
            return None
        with self._db_lock:
            row = self._conn.execute(
                """
                SELECT COALESCE(pi_received_ts, ts) AS pi_ts
                  FROM scale_events
                 WHERE session_id = ?
                   AND ts < ?
                   AND direction != 'noise'
                 ORDER BY ts DESC
                 LIMIT 1
                """,
                (session_id, current_event_ts),
            ).fetchone()
        return row[0] if row else None

    def _reap_expired_in_flight(self, *, limit: int = 50) -> int:
        """Flip in-flight lots older than ``in_flight_ttl_seconds`` to ``out``.

        IN_FLIGHT_TRACKER_PLAN.md §8. Called from the sweeper tick.
        Bounded by ``limit`` so a very long queue can't monopolize the DB
        lock. Returns the number of lots reaped this tick.
        """
        ttl = self._in_flight_ttl_seconds
        if ttl <= 0:
            return 0
        try:
            with self._db_lock:
                expired = storage_repo.list_expired_in_flight_lots(
                    self._conn, ttl_seconds=ttl, limit=limit,
                )
        except Exception:  # pragma: no cover - defensive
            log.exception("in_flight reaper: query raised")
            return 0
        if not expired:
            return 0
        reaped = 0
        now_ts = now_iso_utc_ms()
        for lot in expired:
            try:
                with self._db_lock:
                    # The whole pickup mass is presumed consumed / lost —
                    # we haven't seen the item in TTL seconds. The reaper
                    # increments total_consumed_g so the lot's lifetime
                    # total reflects reality.
                    presumed_consumed = float(lot.pickup_weight_g or 0.0)
                    # C2: The UPDATE in reap_in_flight_lot_as_consumed is
                    # race-guarded by ``AND status='in_flight'`` — if a
                    # concurrent ADD already returned the lot between the
                    # list query above and this call, the UPDATE hits 0
                    # rows. The helper still returns a Lot (via get_lot),
                    # so check the post-update status to detect the race.
                    returned_lot = storage_repo.reap_in_flight_lot_as_consumed(
                        self._conn, lot.lot_id,
                        consumed_g=presumed_consumed,
                        last_out_at=now_ts,
                    )
                    if returned_lot is None or returned_lot.status != "out":
                        # Race fired — lot was already resolved concurrently.
                        # Skip the rest of the per-lot loop: no resolution
                        # row, no lifecycle log, no usage_log emission,
                        # don't bump the reaped counter.
                        log.info(
                            "in_flight reaper: lot %s already resolved by "
                            "concurrent ADD; skipping",
                            lot.lot_id,
                        )
                        continue
                    if lot.pickup_session_id is not None:
                        storage_repo.write_resolution(
                            self._conn,
                            SessionResolutionIn(
                                session_id=lot.pickup_session_id,
                                pattern="in_flight_ttl_expired",
                                lot_id=lot.lot_id,
                                consumed_g=presumed_consumed,
                            ),
                        )
                    # Cloud mirror — TTL expiry on the Pi corresponds
                    # to a ``consumed`` event on the cloud for the full
                    # pickup mass (item never returned). Still holding
                    # db_lock so the enqueue is serialized against any
                    # concurrent session-close reconcile.
                    try:
                        self._cloud_emitter.emit_in_flight_reap(
                            scale_id=self._scale_id_for_shelf(lot.shelf_id),
                            product_id=lot.product_id,
                            consumed_g=presumed_consumed,
                            occurred_at=now_ts,
                        )
                    except Exception:  # pragma: no cover - defensive
                        log.warning(
                            "cloud emit failed for in-flight TTL reap "
                            "of lot %s", lot.lot_id, exc_info=True,
                        )
                self._lc_event(
                    lot.pickup_event_id,
                    actor="sweeper",
                    reason_code=ReasonCode.LOT_EXPIRED_IN_FLIGHT,
                    payload={
                        "lot_id": lot.lot_id,
                        "in_flight_since": lot.in_flight_since,
                        "ttl_seconds": ttl,
                    },
                )
                # Usage log — item never returned within TTL, whole
                # pickup mass counts as consumption.
                self._emit_usage_log(
                    lot_id=lot.lot_id,
                    product_id=lot.product_id,
                    product_name=None,
                    product_brand=None,
                    container_type=None,
                    consumed_g=presumed_consumed,
                    pickup_weight_g=lot.pickup_weight_g,
                    return_weight_g=None,
                    kind="in_flight_ttl_expired",
                    session_id=lot.pickup_session_id,
                    pickup_event_id=lot.pickup_event_id,
                    return_event_id=None,
                    occurred_at=now_ts,
                )
                reaped += 1
                log.info(
                    "in_flight reaper: lot %s expired (since=%s, ttl=%ds)",
                    lot.lot_id[:8], lot.in_flight_since, ttl,
                )
            except Exception:  # pragma: no cover - defensive
                log.exception(
                    "in_flight reaper: failed to reap lot %s", lot.lot_id
                )
        return reaped

    def start_sweeper(self, interval_s: float = 5.0) -> None:
        """Launch a daemon thread that runs ``sweep_orphans`` on a fixed
        interval. Call once at app startup."""
        def _loop() -> None:
            while True:
                try:
                    self.sweep_orphans()
                except Exception:
                    log.exception("scale_events sweeper: iteration threw")
                try:
                    self._reap_expired_in_flight()
                except Exception:
                    log.exception("in_flight reaper: iteration threw")
                time.sleep(interval_s)
        t = threading.Thread(
            target=_loop, name="scale-events-sweeper", daemon=True,
        )
        t.start()
        log.info("scale_events sweeper started (interval=%.1fs)", interval_s)

    def _dispatch_classification(
        self, event_id: str, session: dict[str, Any],
    ) -> None:
        """Fire-and-forget a background thread to classify one event.

        Used by ``handle_scale_event`` when a matching session is already
        closed at event time (post-close fast path). Keeps the HTTP
        handler under 100ms while still classifying quickly.

        Concurrency is bounded by ``_classify_semaphore`` so a burst of
        post-close events can't spawn dozens of concurrent Anthropic
        calls + DB transactions. Threads that can't acquire the
        semaphore immediately block inside ``_run`` before doing any
        work, so the caller still returns fast.
        """
        def _run() -> None:
            acquired = False
            try:
                # Block until a slot opens. 30s is more than enough for
                # any realistic classifier call; if it times out we bail
                # and let the sweeper retry later.
                acquired = self._classify_semaphore.acquire(timeout=30.0)
                if not acquired:
                    log.warning(
                        "event %s: classify semaphore timeout, deferring "
                        "to sweeper", event_id,
                    )
                    return
                self._classify_recorded_event(event_id, session)
            except Exception:
                log.exception("event %s: dispatched classification threw",
                              event_id)
            finally:
                if acquired:
                    self._classify_semaphore.release()
        t = threading.Thread(
            target=_run,
            name=f"classify-{event_id[:8]}",
            daemon=True,
        )
        t.start()

    def _classify_recorded_event(
        self,
        event_id: str,
        session: dict[str, Any],
    ) -> None:
        """Run the full frame-copy + classifier + lot-update pipeline
        for an already-recorded event, using the given session's frames.

        If an admin wipe runs while this method is executing, the wipe
        epoch is bumped and this method returns early rather than
        writing rows that reference now-deleted data.
        """
        # Snapshot the wipe epoch at start. If it changes mid-run we
        # abort before writing to avoid leaking orphan rows that
        # reference wiped events/sessions/lots.
        start_epoch = self._current_wipe_epoch()

        def _wipe_happened() -> bool:
            return self._current_wipe_epoch() != start_epoch

        # Atomically claim the event: flip pending -> classifying under the
        # lock. This is the ONLY dedup gate — a read-then-check is racy
        # because frame-copy + Anthropic call take several seconds, during
        # which a concurrent sweeper tick can see status='pending' and
        # double-dispatch (observed: two lots minted for one physical ADD).
        # Using UPDATE ... WHERE status='pending' + rowcount is the
        # conditional CAS: only one thread wins.
        with self._db_lock, self._conn:
            claim = self._conn.execute(
                """
                UPDATE scale_events
                   SET classifier_status = 'classifying'
                 WHERE event_id = ? AND classifier_status = 'pending'
                """,
                (event_id,),
            )
            if claim.rowcount == 0:
                # Either the event no longer exists or another worker
                # already claimed it. Nothing to do.
                self._lc_event(
                    event_id,
                    actor="classifier",
                    reason_code=ReasonCode.EVENT_CLAIM_LOST,
                )
                return
            row = self._conn.execute(
                """
                SELECT event_id, ts, direction, delta_g, before_weight_g,
                       after_weight_g, session_id, pi_received_ts, shelf_id
                  FROM scale_events
                 WHERE event_id = ?
                """,
                (event_id,),
            ).fetchone()
        if row is None:
            # Race with wipe: event was deleted between our UPDATE and
            # SELECT. Nothing we can do — just log and move on.
            log.warning("_classify_recorded_event: claimed %s but row is gone", event_id)
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.EVENT_ROW_MISSING,
            )
            return
        # Claim succeeded — announce the flip to classifying.
        self._lc_event(
            event_id,
            actor="classifier",
            reason_code=ReasonCode.EVENT_CLAIMED,
            payload={
                "session_open_ts": session.get("open_ts") if session else None,
            },
        )
        event_ts = row[1]
        direction = row[2]
        delta_g = float(row[3])
        before_weight_g = float(row[4])
        after_weight_g = float(row[5])
        session_id = row[6]
        # pi_received_ts is NULL for rows written before the migration
        # landed. Fall back to ESP ts in that case — behavior matches
        # pre-fix code for legacy data.
        pi_received_ts = row[7] if row[7] else event_ts
        # Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). Migrated
        # legacy rows that pre-date catch-all have shelf_id='live_shelf'
        # (SQL DEFAULT), so this is safe to trust. When defensively NULL
        # (should not happen post-migration) fall back to live_shelf.
        event_shelf_id = row[8] if row[8] else "live_shelf"

        # Back-stamp session_id from the session dict we're about to use.
        # Events that fire in the post-close grace window arrive AFTER
        # app_state.current_session_id has been cleared, so their ingress
        # session_id is NULL — but the frame-lookup matches them to the
        # closed session via the grace window. Without this backfill, the
        # reconciler / per-event prior-lookup can't tie them back to the
        # session they visually belong to.
        if session_id is None:
            session_open_ts = session.get("open_ts") if session else None
            if session_open_ts:
                matched_sid = self._find_session_id_by_open_ts(session_open_ts)
                if matched_sid:
                    with self._db_lock, self._conn:
                        self._conn.execute(
                            "UPDATE scale_events SET session_id = ? WHERE event_id = ?",
                            (matched_sid, event_id),
                        )
                    self._lc_event(
                        event_id,
                        actor="back_stamp",
                        reason_code=ReasonCode.SESSION_ID_BACKSTAMPED,
                        payload={"old": None, "new": matched_sid},
                    )
                    session_id = matched_sid

        # Per-event framing: if the session retained its lit-frame
        # timeline, pick a before/after pair anchored to THIS event's
        # Pi-clock ts. The "before" is the prior event-in-session's
        # settled state (same-scene classifier reference); the "after"
        # is the frame just after this event's stability declaration.
        # Without this, every event in a multi-item session gets the
        # same session-wide boundary pair — which makes the classifier
        # attribute weight deltas to items that were added in a
        # different sub-event.
        #
        # Critical: pass ``pi_received_ts`` (not ``event_ts`` aka the
        # ESP ts) to the picker. Camera frames are stamped with the
        # Pi's NTP-synced clock, but the ESP's ``ts`` has a RANDOM
        # sub-second component (firmware writes ``millis() % 1000``,
        # which is not NTP-synced). Using ESP ts for frame lookup
        # introduced ±500ms of noise — enough for tightly-spaced
        # events to land in neighbour-event frame territory. See
        # 2026-04-16 root-cause investigation.
        prior_event_pi_ts = self._find_prior_event_pi_ts_in_session(
            session_id, event_ts,
        )
        pe_before_ts, pe_before_path, pe_after_ts, pe_after_path = (
            session_capture.pick_event_frames(
                session, pi_received_ts, prior_event_pi_ts,
            )
        )
        before_src = pe_before_path or session.get("before_path")
        after_src = pe_after_path or session.get("after_path")
        video_src = session.get("video_path")
        # Method: per_event = anchored to this event's ts, session_wide = fell
        # back to the session boundary frames, fallback = neither available.
        if pe_before_path or pe_after_path:
            pick_method = "per_event"
        elif session.get("before_path") or session.get("after_path"):
            pick_method = "session_wide"
        else:
            pick_method = "fallback"
        self._lc_event(
            event_id,
            actor="classifier",
            reason_code=ReasonCode.FRAMES_PICKED,
            payload={
                "before_ts": pe_before_ts,
                "after_ts": pe_after_ts,
                "prior_event_pi_ts": prior_event_pi_ts,
                "method": pick_method,
                "lookback_s": self._lookback,
            },
        )
        before_path, after_path, frame_err = self._capture_frames(
            event_id, before_src, after_src,
        )
        self._lc_event(
            event_id,
            actor="classifier",
            reason_code=(
                ReasonCode.FRAMES_COPY_ERROR if frame_err else ReasonCode.FRAMES_COPIED
            ),
            payload={
                "before_path": before_path,
                "after_path": after_path,
                "error": frame_err,
            },
        )
        if video_src and Path(video_src).exists():
            try:
                video_dst = self._event_dir(event_id) / "session.mp4"
                shutil.copyfile(video_src, str(video_dst))
            except OSError:
                log.exception("event %s: failed to copy session video",
                              event_id)
        log.info(
            "event %s frame_capture: session_open_ts=%s session_close_ts=%s "
            "before=%s after=%s err=%s",
            event_id, session.get("open_ts"), session.get("close_ts"),
            Path(before_path).name if before_path else None,
            Path(after_path).name if after_path else None,
            frame_err,
        )

        if frame_err is not None:
            # Wipe check (handoff §7.7): if an admin wipe ran while we were
            # capturing frames, bail before writing the failed-status row
            # or enqueuing a sensor_anomaly that references a now-deleted
            # event/session. Mirrors the checks at the other two write
            # sites in this method.
            if _wipe_happened():
                log.info(
                    "event %s: wipe happened during frame capture; "
                    "aborting frame-error writeback", event_id,
                )
                return
            # Fix 5: if ONLY the before-frame extraction failed, we
            # still have a valid after.jpg on disk. Persist
            # ``after_frame_path`` on the event row so the UI can show
            # the image in the event-detail view instead of orphaning
            # it. We mark the classifier status 'failed' and enqueue a
            # review as before — the classifier can't run without both
            # frames in the MVP flow.
            # Fix: unify both writes under a single transaction so a crash
            # between them can't leave after_frame_path persisted while
            # classifier_status remains 'pending' (which the sweeper would
            # then clobber back to None). update_event_classification and
            # enqueue_review each use their own `with conn:` internally —
            # nesting is fine (sqlite3 treats the outer block as the
            # transaction and inner `with conn:` becomes a no-op savepoint-
            # like commit on exit), and the explicit .commit() is removed.
            with self._db_lock, self._conn:
                if after_path is not None:
                    self._conn.execute(
                        """
                        UPDATE scale_events
                           SET after_frame_path = ?
                         WHERE event_id = ?
                        """,
                        (after_path, event_id),
                    )
                storage_repo.update_event_classification(
                    self._conn,
                    event_id,
                    classification=json.dumps(
                        {"error": frame_err, "item_id": UNKNOWN_CANDIDATE_ID}
                    ),
                    classifier_status="failed",
                )
                storage_repo.enqueue_review(
                    self._conn,
                    ReviewQueueIn(
                        kind="sensor_anomaly",
                        event_id=event_id,
                        session_id=session_id,
                        proposed=json.dumps({"error": frame_err}),
                    ),
                )
            return

        # Persist frame paths on the event.
        if _wipe_happened():
            log.info(
                "event %s: wipe happened during frame capture; aborting",
                event_id,
            )
            return
        # Fix: replace explicit .commit() with `with self._conn:` so the
        # write is a proper transaction (auto-rollback on exception).
        with self._db_lock, self._conn:
            self._conn.execute(
                """
                UPDATE scale_events
                   SET before_frame_path = ?, after_frame_path = ?
                 WHERE event_id = ?
                """,
                (before_path, after_path, event_id),
            )

        # Classify. The classifier makes an outbound Anthropic API call
        # which can hang (network issues, provider outage) or throw
        # (bad response, auth error). Wrap it so a classifier failure
        # doesn't leave the event stuck in "pending" forever. The event
        # row is marked failed and enqueued for review on any exception.
        cls_event = ClsScaleEvent(
            event_id=event_id,
            session_id=session_id,
            ts=event_ts,
            delta_g=delta_g,
            before_weight_g=before_weight_g,
            after_weight_g=after_weight_g,
            direction=direction,  # type: ignore[arg-type]
            before_frame_path=before_path,
            after_frame_path=after_path,
        )
        ctx = ClassifierContext(
            source=self._candidate_source,
            anthropic_client=self._classifier_client,
            recently_out_window_seconds=self._recently_out_window_seconds,
            # CATCH_ALL_SCALE_PLAN.md §5.2: scope candidate pool to this
            # event's shelf so catch-all events never consider live-shelf
            # lots and vice versa. None would preserve pre-feature
            # behavior, but we always have a definite shelf_id on the row
            # after the migration runs.
            shelf_id=event_shelf_id,
        )
        try:
            result = classify_event(cls_event, ctx)
        except Exception as exc:
            log.exception("event %s: classifier threw", event_id)
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.CLASSIFIER_THREW,
                payload={"error": repr(exc)},
            )
            if _wipe_happened():
                log.info(
                    "event %s: wipe happened during classifier call; "
                    "aborting error writeback", event_id,
                )
                return
            err_json = json.dumps(
                {"error": f"classifier failed: {exc}",
                 "item_id": UNKNOWN_CANDIDATE_ID}
            )
            with self._db_lock:
                storage_repo.update_event_classification(
                    self._conn,
                    event_id,
                    classification=err_json,
                    classifier_status="failed",
                )
                storage_repo.enqueue_review(
                    self._conn,
                    ReviewQueueIn(
                        kind="sensor_anomaly",
                        event_id=event_id,
                        session_id=session_id,
                        proposed=err_json,
                    ),
                )
            return

        # Pack classification JSON.
        classification_dict = _classification_to_dict(result)
        confidence = float(classification_dict.get("confidence", 0.0) or 0.0)
        item_id = classification_dict.get("item_id")
        is_unknown = item_id in {None, "", UNKNOWN_CANDIDATE_ID, "unknown"}

        # Pull attempt + usage info for timeline. meta.attempts is a list of
        # per-attempt dicts — count them; sum usage tokens where available.
        cls_meta = classification_dict.get("meta") or {}
        attempts_info = cls_meta.get("attempts") or []
        tokens_used: Optional[int] = None
        try:
            usage = cls_meta.get("usage") or {}
            if isinstance(usage, dict):
                tokens_used = int(
                    (usage.get("input_tokens") or 0)
                    + (usage.get("output_tokens") or 0)
                )
        except (TypeError, ValueError):
            tokens_used = None
        multi_match_ids = [
            str(m.get("candidate_id"))
            for m in (classification_dict.get("multi_match") or [])
            if isinstance(m, dict) and m.get("candidate_id")
        ]
        self._lc_event(
            event_id,
            actor="classifier",
            reason_code=ReasonCode.CLASSIFIER_RETURNED,
            payload={
                "confidence": confidence,
                "item_id": item_id,
                "multi_match_ids": multi_match_ids,
                "tokens_used": tokens_used,
                "attempts": len(attempts_info) if isinstance(attempts_info, list) else None,
                "action": classification_dict.get("action"),
            },
        )

        # Promotion: when the classifier returned UNKNOWN but its
        # multi_match list weight-fits |delta_g| within tolerance, treat
        # this as a successful identification. The sum of catalog weights
        # matching the scale reading is ~certain arithmetic identification;
        # the model's UNKNOWN usually reflects visual self-doubt (occlusion,
        # items clustered together) that does not change the physical
        # reality that we can precisely enumerate. We promote item_id to
        # the highest-weight multi_match entry so the downstream apply
        # path treats this as a normal weight-fit identification.
        weight_fit_promoted_from: Optional[str] = None
        if is_unknown and direction == "remove":
            promoted = _pick_promotion_item_id(
                classification_dict, direction, delta_g
            )
            if promoted is not None:
                weight_fit_promoted_from = str(
                    classification_dict.get("item_id") or UNKNOWN_CANDIDATE_ID
                )
                cls_meta_for_audit = classification_dict.setdefault("meta", {})
                if isinstance(cls_meta_for_audit, dict):
                    cls_meta_for_audit["weight_fit_promoted_from"] = (
                        weight_fit_promoted_from
                    )
                classification_dict["item_id"] = promoted
                item_id = promoted
                is_unknown = False
                self._lc_event(
                    event_id,
                    actor="classifier",
                    reason_code=ReasonCode.CLASSIFIER_PROMOTED_UNKNOWN_WEIGHT_FIT,
                    payload={
                        "promoted_item_id": promoted,
                        "original_item_id": weight_fit_promoted_from,
                        "original_confidence": confidence,
                        "multi_match_ids": multi_match_ids,
                    },
                )
                log.info(
                    "event %s: promoted UNKNOWN -> %s via weight-fit "
                    "(multi_match len=%d)",
                    event_id, promoted[:8], len(multi_match_ids),
                )

        # Compute outer weight-fit once for the status decision + apply
        # gate. After promotion this still passes (promotion only fires
        # when weight-fit was already true); when is_unknown is True it
        # never fires the bypass because we still want UNKNOWN to go to
        # review without a successful promotion.
        outer_weight_fit_ok, _, _ = _compute_weight_fit(
            classification_dict, direction, delta_g
        )

        if is_unknown:
            new_status = "review"
            review_kind = "unknown_item_add" if direction == "add" else "unpaired_remove"
        elif confidence < LOW_CONFIDENCE_THRESHOLD and not outer_weight_fit_ok:
            new_status = "review"
            review_kind = "low_confidence"
        else:
            # Either high confidence or weight-fit override — apply cleanly.
            new_status = "classified"
            review_kind = None

        # Persist the classification JSON + status. Last-moment wipe
        # check — if an admin wipe ran while we were waiting on the
        # classifier API, bail rather than reinstating dead data (lot
        # updates and review_queue inserts that reference wiped rows).
        if _wipe_happened():
            log.info(
                "event %s: wipe happened during classifier call; "
                "aborting success writeback", event_id,
            )
            return
        # Wrap all three writes (event classification stamp + lot update
        # + review enqueue) in a single outer `with self._conn:` so
        # they commit as one transaction. Without this wrap, each repo
        # helper's inner `with conn:` commits independently: if
        # `_apply_lot_update_from_classification` raises after
        # `update_event_classification` already committed, the event is
        # stamped "classified" but no lot was minted/updated — a stuck
        # inconsistent state. SQLite handles nested `with conn:` fine
        # (inner contexts become no-op savepoint-like commits; the
        # outermost controls the real transaction boundary).
        with self._db_lock, self._conn:
            storage_repo.update_event_classification(
                self._conn,
                event_id,
                classification=json.dumps(classification_dict, default=str),
                classifier_status=new_status,
            )

            # Apply immediate lot updates per §5.3/§5.4 (only for confident
            # identifications; the reconciler handles consumption).
            # Gate accepts EITHER high confidence OR a weight-fit override
            # — the inner _apply_lot_update_from_classification recomputes
            # weight-fit defensively for callers that bypass this gate.
            if not is_unknown and (
                confidence >= LOW_CONFIDENCE_THRESHOLD or outer_weight_fit_ok
            ):
                self._apply_lot_update_from_classification(
                    direction=direction,
                    classification=classification_dict,
                    event_ts=event_ts,
                    delta_g=delta_g,
                    session_id=session_id,
                    event_id=event_id,
                    shelf_id=event_shelf_id,
                )

            # Enqueue review row if needed.
            if review_kind is not None:
                storage_repo.enqueue_review(
                    self._conn,
                    ReviewQueueIn(
                        kind=review_kind,
                        event_id=event_id,
                        session_id=session_id,
                        proposed=json.dumps(classification_dict, default=str),
                    ),
                )

        # Log apply / review decisions OUTSIDE the write block so
        # observability still records the verdict even if the upstream
        # write raised. Reason codes distinguish the reject path (unknown
        # id / low conf) from the accept path.
        if not is_unknown and (
            confidence >= LOW_CONFIDENCE_THRESHOLD or outer_weight_fit_ok
        ):
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.APPLY_ACCEPTED,
                payload={
                    "direction": direction,
                    "item_id": item_id,
                    "confidence": confidence,
                    "delta_g": delta_g,
                    "weight_fit_override": bool(
                        outer_weight_fit_ok
                        and confidence < LOW_CONFIDENCE_THRESHOLD
                    ),
                    "weight_fit_promoted_from": weight_fit_promoted_from,
                },
            )
        else:
            skip_reason = (
                "unknown_item" if is_unknown
                else "low_confidence_no_weight_fit"
            )
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.APPLY_SKIPPED,
                payload={
                    "skip_reason": skip_reason,
                    "item_id": item_id,
                    "confidence": confidence,
                    "threshold": LOW_CONFIDENCE_THRESHOLD,
                },
            )
        if review_kind is not None:
            self._lc_event(
                event_id,
                actor="classifier",
                reason_code=ReasonCode.REVIEW_ENQUEUED,
                payload={"kind": review_kind, "confidence": confidence},
            )

        log.info("event %s classified: status=%s item=%s conf=%s",
                 event_id, new_status,
                 str(classification_dict.get("item_id", "?"))[:8],
                 classification_dict.get("confidence"))

    def handle_heartbeat(self, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        """Process /api/scale-heartbeat. Updates the volatile per-device
        runtime state (stable flag, uptime) and refreshes the cached
        latest weight reading. Heartbeats do NOT update
        ``last_scale_event_ts`` — that field is reserved for actual
        stability-triggered events so the UI can distinguish the two.
        """
        err = _validate_heartbeat_payload(payload)
        if err is not None:
            return {"error": err}, 400
        ts = payload["ts"]
        try:
            weight_g = float(payload["weight_g"])
        except (TypeError, ValueError):
            return {"error": "weight_g must be a number"}, 400
        device_id = str(payload.get("device_id", "scale-01"))
        try:
            stable = bool(payload.get("stable", False))
        except Exception:
            return {"error": "stable must be a boolean"}, 400
        try:
            uptime_s = int(payload.get("uptime_s", 0))
        except (TypeError, ValueError):
            return {"error": "uptime_s must be an integer"}, 400

        # Fix 6: detect ESP reboot via a decreasing uptime counter. When
        # the ESP reboots, ``event_seq`` resets to 0 — without purging
        # the LRU, the first post-reboot event collides with the stale
        # (device_id, 0) entry and is silently deduped. Track + compare
        # under a lock so two heartbeats racing from different threads
        # can't both read the same "prev" and each think the other
        # already purged.
        with self._uptime_lock:
            prev_uptime = self._last_uptime_s.get(device_id)
            reboot_detected = (
                prev_uptime is not None and uptime_s < prev_uptime
            )
            self._last_uptime_s[device_id] = uptime_s
        if reboot_detected:
            log.info(
                "scale reboot detected for %s (uptime %ds → %ds); purging dedup LRU",
                device_id, prev_uptime, uptime_s,
            )
            # No event_id — fake one from device_id so operators can still
            # grep for esp_reboot_detected. Log at session_lifecycle? The
            # reboot isn't tied to a session either; use a device-scoped
            # session_id surrogate.
            try:
                lifecycle.log_session(
                    self._conn, self._db_lock,
                    f"device:{device_id}",
                    actor="heartbeat",
                    reason_code=ReasonCode.ESP_REBOOT_DETECTED,
                    payload={
                        "device_id": device_id,
                        "prev_uptime_s": prev_uptime,
                        "uptime_s": uptime_s,
                    },
                )
            except Exception:  # pragma: no cover - defensive
                pass
            self._dedup_purge_device(device_id)

        # Update the cached "latest" weight. We do NOT touch
        # last_scale_event_ts from heartbeats — that belongs to real
        # scale events. The runtime state below carries the heartbeat ts.
        #
        # Fix 5: avoid last-write-wins regressing last_scale_weight_g.
        # Scenario: a scale event at ts=X just committed
        # last_scale_weight_g=after_weight_g, and a heartbeat whose
        # ESP-side sample was taken slightly before the event (ts<X)
        # now arrives and would overwrite with the pre-settle value.
        # Compare the heartbeat ts with app_state.last_scale_event_ts;
        # if strictly older, skip the weight update (but still touch
        # the other heartbeat state downstream — runtime dict + trace).
        # ISO-8601 UTC string ordering equals chronological ordering.
        with self._db_lock:
            app_state = storage_repo.get_app_state(self._conn)
            last_event_ts = getattr(app_state, "last_scale_event_ts", None)
            if (
                isinstance(last_event_ts, str)
                and isinstance(ts, str)
                and ts < last_event_ts
            ):
                log.debug(
                    "heartbeat: ts=%s older than last_scale_event_ts=%s; "
                    "skipping last_scale_weight_g update to avoid regression",
                    ts, last_event_ts,
                )
                try:
                    lifecycle.log_session(
                        self._conn, self._db_lock,
                        f"device:{device_id}",
                        actor="heartbeat",
                        reason_code=ReasonCode.HEARTBEAT_WEIGHT_REGRESSION_SUPPRESSED,
                        payload={
                            "device_id": device_id,
                            "heartbeat_ts": ts,
                            "last_scale_event_ts": last_event_ts,
                        },
                    )
                except Exception:  # pragma: no cover - defensive
                    pass
            else:
                storage_repo.update_app_state(
                    self._conn,
                    AppStatePatch(last_scale_weight_g=weight_g),
                )
        with _SCALE_RUNTIME_LOCK:
            _SCALE_RUNTIME_STATE[device_id] = {
                "stable": stable,
                "weight_g": weight_g,
                "ts": ts,
                "uptime_s": uptime_s,
                "device_id": device_id,
            }
        _append_weight_trace({
            "kind": "heartbeat",
            "device_id": device_id,
            "esp_ts": ts,
            "pi_ts": now_iso_utc_ms(),
            "weight_g": weight_g,
            "stable": stable,
            "uptime_s": uptime_s,
        })
        # LiveTrack Import: when the container is already sitting stable on
        # the catch-all scale (no delta event will fire), use the heartbeat
        # to post the current reading so the wizard unblocks. Guards:
        #   * scale is catch_all
        #   * reading is stable AND in a plausible range
        #   * current reading differs from the arm-time baseline by at least
        #     LIVETRACK_MIN_DELTA_FROM_BASELINE_G. This stops empty-scale
        #     drift (catch_all sits at ~90g idle) from being posted as if
        #     the user placed a container. The poller captures the baseline
        #     when it first sees state=waiting_scale (see LiveTrackPoller).
        LIVETRACK_MIN_DELTA_FROM_BASELINE_G = 30.0
        if (
            stable
            and self._catch_all_enabled
            and self._livetrack_poller is not None
            and 5.0 < weight_g < 5000.0
        ):
            shelf = shelf_registry.get_shelf_for_device(
                device_id, self._shelf_registry
            )
            shelf_id = shelf.shelf_id if shelf is not None else None
            if shelf_id == "catch_all":
                arm = self._livetrack_poller.snapshot()
                if arm is not None and arm.get("state") == "waiting_scale":
                    # Record the baseline on the FIRST heartbeat seen while
                    # armed. _livetrack_baseline_g is per-poller state set
                    # via maybe_set_baseline. The poller clears it when the
                    # session transitions away from waiting_scale.
                    baseline_g = self._livetrack_poller.maybe_set_baseline(weight_g)
                    delta_from_baseline = abs(weight_g - baseline_g)
                    if delta_from_baseline < LIVETRACK_MIN_DELTA_FROM_BASELINE_G:
                        # Empty scale or no meaningful change yet. Skip.
                        log.debug(
                            "livetrack: heartbeat weight=%.2f within baseline=%.2f "
                            "(Δ=%.2f < %.2f); not posting",
                            weight_g, baseline_g, delta_from_baseline,
                            LIVETRACK_MIN_DELTA_FROM_BASELINE_G,
                        )
                    else:
                        session_id = str(arm.get("session_id", ""))
                        client = self._cloud_client
                        fn = getattr(client, "post_livetrack_session_update", None)
                        if session_id and callable(fn):
                            try:
                                fn(
                                    session_id,
                                    scale_reading_g=weight_g,
                                    scale_reading_ts=now_iso_utc_ms(),
                                    state="scale_reading_received",
                                )
                                log.info(
                                    "livetrack: heartbeat-driven scale reading "
                                    "posted for session=%s "
                                    "(weight=%.2fg, baseline=%.2fg, Δ=%.2fg)",
                                    session_id, weight_g, baseline_g,
                                    delta_from_baseline,
                                )
                            except Exception:  # pragma: no cover - defensive
                                log.exception(
                                    "livetrack: failed to post heartbeat-driven "
                                    "scale reading for session=%s",
                                    session_id,
                                )
        return {"ok": True}, 200


# ------------------------------------------------------------ validators


def _ts_is_pre_ntp(ts: str) -> bool:
    """True if ``ts`` looks like an ESP pre-NTP fallback timestamp.

    The ESP firmware falls back to a 1970-based ``millis()/1000`` when NTP
    hasn't synced yet. Accepting those corrupts session correlation.
    Returns True when the year is before ``_MIN_PLAUSIBLE_YEAR``.
    """
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        # Regex already validated shape, so this shouldn't happen — but if
        # it does, let the caller decide (returns False = don't flag).
        return False
    return parsed.year < _MIN_PLAUSIBLE_YEAR


def _validate_event_payload(payload: Any) -> Optional[str]:
    """Return an error string or None on success.

    Schema from §4.1:
        ts, device_id, delta_g, before_weight_g, after_weight_g,
        stable_samples, event_seq
    """
    if not isinstance(payload, dict):
        return "body must be a JSON object"
    required = [
        "ts",
        "device_id",
        "delta_g",
        "before_weight_g",
        "after_weight_g",
        "event_seq",
    ]
    for key in required:
        if key not in payload:
            return f"missing required field: {key}"
    ts = payload.get("ts")
    if not isinstance(ts, str) or not _ISO_RE.match(ts):
        return "ts must be an ISO-8601 UTC timestamp"
    if _ts_is_pre_ntp(ts):
        # ESP hasn't NTP-synced yet. Reject with 400 so the firmware's
        # FIFO retries after the next sync. Silent accept would create
        # orphan events with 1970 timestamps no session can claim.
        return (
            f"ts {ts} predates NTP sync (year < {_MIN_PLAUSIBLE_YEAR}); "
            "ESP should retry after NTP sync"
        )
    if not isinstance(payload["device_id"], str) or not payload["device_id"]:
        return "device_id must be a non-empty string"
    weights: dict[str, float] = {}
    for num_key in ("delta_g", "before_weight_g", "after_weight_g"):
        try:
            v = float(payload[num_key])
        except (TypeError, ValueError):
            return f"{num_key} must be a number"
        # float("NaN") and float("inf") both succeed; reject so classifier
        # math (abs(delta_g), comparisons) never sees a non-finite value.
        if not math.isfinite(v):
            return f"{num_key} must be finite"
        weights[num_key] = v
    # Sign-consistency: delta_g should equal after - before within a
    # 1g tolerance for floating-point rounding. A mismatch implies either
    # an ESP hardware glitch, a truncated payload, or a replay — any of
    # which would produce nonsense downstream (direction would be wrong
    # relative to the visual evidence).
    recomputed = weights["after_weight_g"] - weights["before_weight_g"]
    if abs(weights["delta_g"] - recomputed) > 1.0:
        return (
            f"delta_g ({weights['delta_g']:.3f}) inconsistent with "
            f"after_weight_g - before_weight_g ({recomputed:.3f}); "
            "payload rejected"
        )
    try:
        if int(payload["event_seq"]) < 0:
            return "event_seq must be >= 0"
    except (TypeError, ValueError):
        return "event_seq must be an integer"
    return None


def _validate_heartbeat_payload(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return "body must be a JSON object"
    for key in ("ts", "device_id", "weight_g"):
        if key not in payload:
            return f"missing required field: {key}"
    ts = payload.get("ts")
    if not isinstance(ts, str) or not _ISO_RE.match(ts):
        return "ts must be an ISO-8601 UTC timestamp"
    if _ts_is_pre_ntp(ts):
        # Same 1970-timestamp rejection as events. Heartbeats at 1970
        # pollute the weight trace and would set ``last_scale_weight_g``
        # alongside a meaningless ts. Reject so the ESP retries post-NTP.
        return (
            f"ts {ts} predates NTP sync (year < {_MIN_PLAUSIBLE_YEAR}); "
            "ESP should retry after NTP sync"
        )
    if not isinstance(payload["device_id"], str) or not payload["device_id"]:
        return "device_id must be a non-empty string"
    try:
        weight_v = float(payload["weight_g"])
    except (TypeError, ValueError):
        return "weight_g must be a number"
    if not math.isfinite(weight_v):
        return "weight_g must be finite"
    return None


def _classification_to_dict(result: Any) -> dict[str, Any]:
    """Serialize a :class:`ClassificationResult` to a JSON-safe dict.

    Drops any non-serializable fields (raw SDK response). Preserves the
    candidate pool used so the review UI can show the list.
    """
    if result is None:
        return {}
    if is_dataclass(result):
        data = asdict(result)
    elif isinstance(result, dict):
        data = dict(result)
    else:
        return {}
    # ``meta`` carries the raw Anthropic response in tests; scrub it.
    meta = data.get("meta")
    if isinstance(meta, dict):
        scrubbed = {k: v for k, v in meta.items() if k != "raw_response"}
        data["meta"] = scrubbed
    return data


# ------------------------------------------------------------ blueprint factory


def make_scale_bp(handler: ScaleHandler) -> Blueprint:
    """Flask blueprint for ``/api/scale-event`` + ``/api/scale-heartbeat``."""
    bp = Blueprint("scale_events", __name__)

    @bp.post("/api/scale-event")
    def post_scale_event():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "expected application/json object"}), 400
        response, status = handler.handle_scale_event(body)
        return jsonify(response), status

    @bp.post("/api/scale-heartbeat")
    def post_heartbeat():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "expected application/json object"}), 400
        response, status = handler.handle_heartbeat(body)
        return jsonify(response), status

    return bp


__all__ = ["ScaleHandler", "make_scale_bp", "LOW_CONFIDENCE_THRESHOLD"]
