"""Background polling thread for LiveTrack Import sessions.

The cloud UI drives the import wizard; the Pi is the "result producer". This
thread periodically asks the cloud "is there an active session for me?",
maintains a thread-safe snapshot for the scale-event handler to read, and
handles any ``awaiting_ai_tare`` requests by running
:func:`server.intake.ai_tare.estimate` against the current camera frame and
POSTing the result back.

Wire protocol: both directions ride the existing x-api-key auth. Cloud→Pi
is polling (:meth:`CloudClient.get_active_livetrack_session`); Pi→cloud is
per-result POST (:meth:`CloudClient.post_livetrack_session_update`).

Poll cadence (from plan §5):
  * ``ACTIVE_POLL_S`` (500ms) when a session is known active.
  * ``IDLE_POLL_S`` (2s)     when the last poll returned None.
  * Exponential backoff on HTTP errors (1s → ``MAX_BACKOFF_S`` cap).

Thread safety: the snapshot is a plain dict behind a :class:`threading.Lock`.
Readers (the scale-event handler) call :meth:`snapshot` which returns a
shallow copy — no cross-thread dict mutation risk.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from ..intake.ai_tare import AiTareError, estimate as ai_tare_estimate
from ..intake.models import AiTareProductForm
from .client import CloudClient, CloudError

# UnitType is a Literal in storage.models, so we can't call it as a
# constructor — enumerate the valid strings for manual filtering.
_VALID_UNIT_TYPES = {"liquid", "solid", "count", "mixed"}

log = logging.getLogger(__name__)

# Poll cadences.
ACTIVE_POLL_S = 0.5
IDLE_POLL_S = 2.0

# HTTP-error exponential backoff (between failed polls only).
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0


class LiveTrackPoller:
    """Poll cloud for active LiveTrack sessions on a background thread.

    Parameters
    ----------
    cloud_client:
        Authenticated :class:`CloudClient`.
    camera:
        Optional object exposing ``current_frame_jpeg()`` (the
        :class:`CameraDaemon`). Used only for the AI-tare branch. When
        ``None`` the poller skips AI-tare handling and logs a warning.
    tmp_dir:
        Directory for ephemeral AI-tare image captures. Defaults to the
        OS temp dir. The poller cleans up its own files.
    ai_tare_fn:
        Override for the AI-tare call — tests inject a stub. Defaults to
        :func:`server.intake.ai_tare.estimate`.
    """

    def __init__(
        self,
        cloud_client: CloudClient,
        *,
        camera: Any | None = None,
        tmp_dir: Optional[Path] = None,
        ai_tare_fn: Optional[Callable[..., Any]] = None,
    ) -> None:
        self._client = cloud_client
        self._camera = camera
        self._tmp_dir = Path(tmp_dir) if tmp_dir is not None else Path(tempfile.gettempdir())
        self._ai_tare_fn = ai_tare_fn or ai_tare_estimate

        self._snapshot_lock = threading.Lock()
        # Legacy single-session snapshot — kept for callers that haven't
        # been migrated to the per-(device, scale) lookup. Mirrors the
        # newest active session across every scale on the device, same
        # value as before the 2026-04-27 scoping refactor.
        self._snapshot: Optional[dict[str, Any]] = None
        # New: per-(device_id, scale_id) tuple → session-row map. The
        # scale-event handler queries this via :meth:`is_active_for` so
        # only the targeted scale's events are suppressed; unrelated
        # scales on the same device keep flowing events.
        self._snapshots_by_tuple: dict[tuple[str, str], dict[str, Any]] = {}
        # First cloud-side device_id we've observed in a snapshot row —
        # used by :meth:`is_active_for` for defense-in-depth (Audit #13)
        # so a leaked row from a different cloud device can't cross-
        # suppress this Pi's events for an overlapping scale_id. None
        # until the first non-empty device_id is seen; sticky thereafter.
        self._observed_cloud_device_id: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # AI-tare de-dup: only run estimate() once per (session_id, state)
        # combo. Without this, the 500ms poll would fire N concurrent
        # Anthropic calls while the response is in flight.
        self._ai_tare_inflight: set[str] = set()
        self._ai_tare_lock = threading.Lock()

        # Baseline for heartbeat-driven LiveTrack scale posting. Captured
        # the first time a heartbeat arrives while a session is in
        # waiting_scale. Cleared when the session transitions out of
        # waiting_scale (or disappears). The scale-event handler reads
        # this via :meth:`maybe_set_baseline` and skips the post when
        # the current heartbeat weight hasn't moved enough from baseline —
        # stops empty-scale drift from being treated as a container placement.
        self._baseline_lock = threading.Lock()
        self._livetrack_baseline_g: Optional[float] = None
        self._livetrack_baseline_session: Optional[str] = None

    # ------------------------------------------------------------------
    # Public API (called by scale_events handler + app.py startup)
    # ------------------------------------------------------------------

    def snapshot(self) -> Optional[dict[str, Any]]:
        """Return the last-seen session row as a shallow copy, or None.

        Thread-safe. Returns ``None`` when the last poll returned no
        active session OR when the poller hasn't started yet. Callers
        treat a missing / None snapshot as "not import-armed".

        Legacy single-session view — returns the newest active session
        across every scale on the device. New callers that need per-scale
        scoping should use :meth:`is_active_for` or
        :meth:`active_tuples` instead. Kept stable for the scale-event
        handler's catch-all interception branch (which only ever cares
        about the ``waiting_scale`` row, of which there's at most one
        at a time per device).
        """
        with self._snapshot_lock:
            if self._snapshot is None:
                return None
            return dict(self._snapshot)

    def is_active_for(
        self, device_id: Optional[str], scale_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        """Return the active session row for this (device, scale) tuple, or None.

        The Pi's wizard-suppression gate (in
        :meth:`ScaleHandler._is_wizard_active_for`) calls this with the
        ESP-provided device_id ("scale-01", "scale-02", "scale-03") and
        scale_id from the incoming event.

        Important: the cloud's ``livetrack_import_sessions.device_id``
        column is the UUID of the live_shelf_devices row — NOT the ESP
        device id. The cloud's /active edge function already scopes
        responses to this Pi's cloud device (Pi authenticates with its
        own import_key). So in normal operation every snapshot row
        belongs to this Pi.

        Defense-in-depth (Audit #13): the lookup additionally enforces
        that all snapshot rows agree on a single cloud-side device_id.
        If a row leaks in from a different cloud device (e.g. an RLS
        regression on the /active endpoint), we reject the match —
        scale_id collisions across devices must NOT cross-suppress.
        We discover the Pi's own cloud-device UUID lazily: the first
        time a snapshot lands, we record its device_id; subsequent
        rows whose device_id differs are treated as invalid and
        skipped here. The caller-side ``device_id`` argument continues
        to be matched against scale_id only (callers pass ESP-style
        ids that never equal cloud UUIDs); its only enforced role is
        non-empty validation.

        Mismatched scale_id → return None → event flows through.
        Matching scale_id (with a row whose device_id agrees with the
        first observed) → return the row → event suppressed.

        Both args must be non-None and non-empty — defensive: an empty
        scale_id from a corrupt event must NOT match arbitrarily,
        otherwise we'd recreate the global-suppression bug. Callers fall
        back to :meth:`snapshot` when keys are missing.

        Returns a shallow copy so caller mutation doesn't bleed back.
        """
        if not device_id or not scale_id:
            return None
        scale_str = str(scale_id)
        with self._snapshot_lock:
            expected_device = self._observed_cloud_device_id
            # Linear scan — at most a handful of active sessions per Pi
            # (one per scale; 3 today). Faster than a defensive UUID-vs-
            # ESP-id mapping table.
            for (row_device, sid), row in self._snapshots_by_tuple.items():
                if sid != scale_str:
                    continue
                # Defensive: drop matches from a different cloud device.
                # In normal operation expected_device == row_device for
                # every row (the cloud /active endpoint scopes to this
                # Pi). A leak from another device's row would otherwise
                # trip cross-device suppression for the same scale_id.
                if expected_device is not None and row_device != expected_device:
                    log.warning(
                        "livetrack poller: dropping cross-device match "
                        "(scale_id=%s, row_device=%s, expected=%s)",
                        scale_str, row_device, expected_device,
                    )
                    continue
                return dict(row)
            return None

    def active_tuples(self) -> set[tuple[str, str]]:
        """Return the set of (device_id, scale_id) tuples with active sessions.

        ``device_id`` here is the cloud UUID (from
        ``livetrack_import_sessions.device_id``), NOT the ESP device id.
        Useful for diagnostic / observability surfaces (e.g. ``/api/state``)
        — the gate predicate uses :meth:`is_active_for` directly.
        """
        with self._snapshot_lock:
            return set(self._snapshots_by_tuple.keys())

    def active_scale_ids(self) -> set[str]:
        """Return the set of scale_ids currently being calibrated on this Pi.

        Convenience wrapper for the gate predicate's lookup; also used
        by ``/api/state`` to render the active-wizard summary line.
        """
        with self._snapshot_lock:
            return {sid for (_d, sid) in self._snapshots_by_tuple.keys()}

    def maybe_set_baseline(self, weight_g: float) -> float:
        """Return the baseline weight for the current waiting_scale session.

        First call after a session transitions to ``waiting_scale`` records
        ``weight_g`` as the baseline. Subsequent calls return the already-
        recorded baseline. Used by ``handle_heartbeat`` to determine
        whether the current reading represents a real container-placement
        vs. baseline drift.

        Thread-safe. Scoped per session — ``_maybe_clear_baseline`` wipes
        the recorded value whenever the session's state leaves
        ``waiting_scale`` or the session disappears entirely (so a fresh
        arm starts a fresh baseline).
        """
        with self._baseline_lock:
            if self._livetrack_baseline_g is None:
                self._livetrack_baseline_g = float(weight_g)
                # Capture the session_id for scoping (paired with the
                # snapshot below — reads under _snapshot_lock are fine
                # because this lock is independent).
                with self._snapshot_lock:
                    snap = self._snapshot
                self._livetrack_baseline_session = (
                    str(snap.get("session_id", "")) if snap else None
                )
                log.info(
                    "livetrack: captured baseline=%.2fg for session=%s",
                    weight_g, self._livetrack_baseline_session,
                )
            return self._livetrack_baseline_g

    def _maybe_clear_baseline(self, session: Optional[dict[str, Any]]) -> None:
        """Clear the waiting_scale baseline when the session has moved on.

        Called from the poll loop before updating _snapshot. If the
        new session is None, or its state is not waiting_scale, or its
        session_id differs from the one we baselined for, drop the
        cached baseline so the next waiting_scale arm captures fresh.
        """
        with self._baseline_lock:
            if self._livetrack_baseline_g is None:
                return
            should_clear = (
                session is None
                or session.get("state") != "waiting_scale"
                or str(session.get("session_id", "")) != self._livetrack_baseline_session
            )
            if should_clear:
                log.debug(
                    "livetrack: clearing baseline=%.2fg (session transitioned)",
                    self._livetrack_baseline_g,
                )
                self._livetrack_baseline_g = None
                self._livetrack_baseline_session = None

    def start(self) -> None:
        """Start the polling thread. Idempotent."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="livetrack-poller", daemon=True,
        )
        self._thread.start()
        log.info("livetrack poller thread started")

    def stop(self, timeout: float = 5.0) -> None:
        """Signal the loop to exit and join. Safe to call when not started."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def tick_once(self) -> None:
        """Run exactly one poll iteration synchronously.

        Exposed for tests so they can step through the state machine
        deterministically without sleeping on the real cadence.
        """
        self._poll_once()

    def seed_snapshot(self) -> None:
        """One-shot synchronous poll to populate the snapshot at startup.

        Called from ``app.py`` before the thread is started so the
        scale-event handler sees any in-progress session immediately
        after a reboot mid-wizard (doesn't wait for the first 500ms
        tick).
        """
        try:
            sessions = self._fetch_sessions()
        except Exception:  # pragma: no cover - defensive
            log.exception("livetrack poller: seed poll failed; snapshot left empty")
            return
        newest = sessions[0] if sessions else None
        self._maybe_clear_baseline(newest)
        self._update_snapshots(sessions)

    def _fetch_sessions(self) -> list[dict[str, Any]]:
        """Fetch the active-session list, with a legacy single-session fallback.

        Newer cloud edge function returns a list via
        :meth:`CloudClient.get_active_livetrack_sessions`. If the client
        method is missing (test stubs constructed pre-refactor) we fall
        back to the single-session shape and wrap it in a list — same
        behavior as a server returning the legacy body shape.
        """
        getter = getattr(self._client, "get_active_livetrack_sessions", None)
        if callable(getter):
            sessions = getter()
            return list(sessions) if isinstance(sessions, list) else []
        # Test-stub fallback: client only implements the single-session API.
        single = self._client.get_active_livetrack_session()
        return [single] if isinstance(single, dict) else []

    def _update_snapshots(self, sessions: list[dict[str, Any]]) -> None:
        """Atomically replace both legacy + per-tuple snapshots.

        Sessions list order: server returns newest-first (ORDER BY
        created_at DESC). The legacy snapshot mirrors the newest row
        (or None) — equivalent to the pre-refactor "what is the newest
        active session for this device?". The per-tuple map keys on
        (device_id, scale_id) and points to the row.

        Rows missing either key are dropped from the per-tuple map but
        still considered for the legacy snapshot (matches the cloud
        edge function's response shape — every row carries device_id,
        scale_id is nullable for legacy backfill).

        Side-effect (Audit #8): garbage-collect any
        ``_ai_tare_inflight`` keys whose session_id no longer appears
        in the active set. Without this, sessions that disappear mid-
        flight (operator closes the wizard, /create eviction, server-
        side expiry) leave their flight key in the set forever — a
        long-running Pi would accumulate orphaned entries unbounded.
        """
        legacy = sessions[0] if sessions else None
        by_tuple: dict[tuple[str, str], dict[str, Any]] = {}
        for row in sessions:
            d = row.get("device_id")
            s = row.get("scale_id")
            if not d or not s:
                continue
            key = (str(d), str(s))
            # Newest-first means the first row we see for a given tuple
            # wins; ignore older overlaps. (The edge function expires
            # priors on /create, so collisions should be rare.)
            by_tuple.setdefault(key, row)
        # Snapshot of session_ids currently active across all rows
        # (use the raw sessions list — anything the cloud returned
        # counts as live, including rows missing scale_id).
        active_session_ids = {
            str(row.get("session_id", ""))
            for row in sessions
            if row.get("session_id")
        }
        # Capture the first non-empty cloud-side device_id we ever see.
        # Used by is_active_for to reject any later row whose device_id
        # disagrees (defense-in-depth against RLS leaks; Audit #13).
        # Sticky once set — if the cloud truly switched the device's UUID
        # we'd want a fresh process anyway.
        first_observed_device: Optional[str] = None
        for row in sessions:
            d = row.get("device_id")
            if d:
                first_observed_device = str(d)
                break
        with self._snapshot_lock:
            self._snapshot = legacy
            self._snapshots_by_tuple = by_tuple
            if self._observed_cloud_device_id is None and first_observed_device:
                self._observed_cloud_device_id = first_observed_device
        # Acquire the inflight lock separately — keeps the snapshot
        # lock's critical section tight, and the two locks are
        # independent (no caller holds both at once elsewhere).
        # Each flight key is "{session_id}:awaiting_ai_tare"; split off
        # the session_id prefix for the membership test.
        with self._ai_tare_lock:
            stale = {
                key for key in self._ai_tare_inflight
                if key.split(":", 1)[0] not in active_session_ids
            }
            if stale:
                self._ai_tare_inflight.difference_update(stale)
                log.debug(
                    "livetrack poller: gc'd %d stale ai_tare inflight key(s): %s",
                    len(stale), sorted(stale),
                )

    # ------------------------------------------------------------------
    # Internal loop
    # ------------------------------------------------------------------

    def _run(self) -> None:
        backoff_s = INITIAL_BACKOFF_S
        while not self._stop.is_set():
            try:
                had_session = self._poll_once()
            except CloudError as err:
                log.warning(
                    "livetrack poller: HTTP %d %s — backing off %.1fs",
                    err.status_code, str(err.body)[:200], backoff_s,
                )
                self._stop.wait(backoff_s)
                backoff_s = min(backoff_s * 2, MAX_BACKOFF_S)
                continue
            except Exception:  # pragma: no cover - defensive
                log.exception("livetrack poller: unexpected failure")
                self._stop.wait(backoff_s)
                backoff_s = min(backoff_s * 2, MAX_BACKOFF_S)
                continue

            # Success — reset backoff and sleep per cadence.
            backoff_s = INITIAL_BACKOFF_S
            sleep_s = ACTIVE_POLL_S if had_session else IDLE_POLL_S
            self._stop.wait(sleep_s)

    def _poll_once(self) -> bool:
        """Poll once, update snapshots, dispatch AI-tare if needed.

        Returns True iff the poll returned at least one active session
        (used by the loop to pick the next sleep interval).
        """
        sessions = self._fetch_sessions()
        # Clear any stale baseline before swapping the snapshot — the
        # heartbeat handler's baseline cache is scoped to one waiting_scale
        # session, so transitions out of that state must reset it. We use
        # the newest row (legacy semantics) for the baseline check.
        legacy = sessions[0] if sessions else None
        self._maybe_clear_baseline(legacy)
        self._update_snapshots(sessions)
        if not sessions:
            return False

        # Fire AI-tare asynchronously on the same thread — it's a blocking
        # Anthropic call (~5s), which is acceptable because the user has
        # nothing to do while it runs anyway. Single-flight per
        # (session_id, state) so repeated polls during the call don't
        # spawn duplicates. Iterate every active session — multi-scale
        # users can have AI-tare requests on more than one scale
        # simultaneously (rare but plausible).
        for session in sessions:
            if session.get("state") != "awaiting_ai_tare":
                continue
            session_id = str(session.get("session_id", ""))
            flight_key = f"{session_id}:awaiting_ai_tare"
            with self._ai_tare_lock:
                if flight_key in self._ai_tare_inflight:
                    continue
                self._ai_tare_inflight.add(flight_key)
            try:
                self._handle_ai_tare(session)
            finally:
                # Audit #15 — retry semantics on POST failure.
                # The flight key is cleared unconditionally here so that
                # if the cloud-side update POST failed inside
                # ``_handle_ai_tare``, the cloud session is still in
                # ``awaiting_ai_tare`` and the NEXT poll re-runs the AI
                # call. Tradeoff: a transient cloud blip during the
                # POST costs one extra ~5s Anthropic call instead of
                # forcing the operator to manually re-arm the wizard.
                # The Anthropic call is the expensive part, but losing
                # the result silently is worse UX. (We chose option (b)
                # over routing the POST through cloud_outbox: the outbox
                # is shaped for event delivery, not arbitrary session
                # updates, and the natural state-machine retry here is
                # self-healing without extra schema.)
                with self._ai_tare_lock:
                    self._ai_tare_inflight.discard(flight_key)
        return True

    # ------------------------------------------------------------------
    # AI-tare handling
    # ------------------------------------------------------------------

    def _handle_ai_tare(self, session: dict[str, Any]) -> None:
        """Run ai_tare.estimate on the current frame + POST the result."""
        session_id = str(session.get("session_id", ""))
        if not session_id:
            log.warning("livetrack poller: awaiting_ai_tare with no session_id")
            return
        if self._camera is None:
            log.warning(
                "livetrack poller: awaiting_ai_tare but no camera available; "
                "marking session ai_tare_ready with null result"
            )
            self._post_update_safely(
                session_id,
                ai_tare_g=None,
                ai_tare_confidence="low",
                ai_tare_reasoning="Pi has no camera attached",
                state="ai_tare_ready",
                last_error="no_camera",
            )
            return

        # Grab a fresh frame. current_frame_jpeg returns None when the ring
        # buffer is empty (camera startup race, brightness threshold not
        # crossed yet, etc.). Don't ship a zero-byte image — surface the
        # problem back to the UI.
        jpeg = self._camera.current_frame_jpeg() if hasattr(self._camera, "current_frame_jpeg") else None
        if not jpeg:
            log.warning("livetrack poller: camera returned no frame; aborting AI-tare")
            self._post_update_safely(
                session_id,
                state="ai_tare_ready",
                last_error="no_frame_available",
                ai_tare_confidence="low",
            )
            return

        tmp_path = self._tmp_dir / f"livetrack-{session_id}.jpg"
        try:
            tmp_path.write_bytes(jpeg)
        except OSError:
            log.exception("livetrack poller: failed to write temp frame")
            self._post_update_safely(
                session_id,
                state="ai_tare_ready",
                last_error="temp_write_failed",
                ai_tare_confidence="low",
            )
            return

        try:
            product_form = _build_product_form(session.get("ai_tare_product_form"))
            measured_gross_g = session.get("scale_reading_g")
            if measured_gross_g is not None:
                measured_gross_g = float(measured_gross_g)
            estimate_result = self._ai_tare_fn(
                ref_image_paths=[str(tmp_path)],
                product_form=product_form,
                measured_gross_g=measured_gross_g,
                is_partial=True,
            )
            # estimate() returns (TareEstimate, model_used, thinking_budget).
            if isinstance(estimate_result, tuple) and len(estimate_result) >= 1:
                tare_estimate = estimate_result[0]
                model_used = estimate_result[1] if len(estimate_result) >= 2 else None
            else:
                tare_estimate = estimate_result
                model_used = None
            tare_g_value = getattr(tare_estimate, "tare_weight_g", None)
            confidence = getattr(tare_estimate, "confidence", None)
            reasoning = getattr(tare_estimate, "reasoning", None)
            self._post_update_safely(
                session_id,
                ai_tare_g=float(tare_g_value) if tare_g_value is not None else None,
                ai_tare_confidence=str(confidence) if confidence else None,
                ai_tare_reasoning=str(reasoning) if reasoning else None,
                state="ai_tare_ready",
            )
            log.info(
                "livetrack poller: ai-tare for session %s → %.1fg (conf=%s, model=%s)",
                session_id,
                float(tare_g_value) if tare_g_value is not None else float("nan"),
                confidence, model_used,
            )
        except AiTareError as err:
            log.warning("livetrack poller: ai_tare error: %s", err)
            self._post_update_safely(
                session_id,
                state="ai_tare_ready",
                last_error=f"ai_tare_error: {err}",
                ai_tare_confidence="low",
            )
        except Exception as err:  # pragma: no cover - defensive
            log.exception("livetrack poller: unexpected ai_tare failure")
            self._post_update_safely(
                session_id,
                state="ai_tare_ready",
                last_error=f"unexpected: {err}",
                ai_tare_confidence="low",
            )
        finally:
            # Clean up the temp image either way — AI-tare images are one-
            # shot and the owner doesn't want them lingering in /tmp.
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _post_update_safely(self, session_id: str, **fields: Any) -> bool:
        """POST a session update; swallow + log any failure.

        Returns True on success, False on any failure (CloudError or
        unexpected). The caller uses this signal to decide whether to
        leave the AI-tare inflight key cleared (so the next poll retries
        the whole flow) — see Audit #15 / option (b).

        The cloud is the source of truth for session state, so a failed
        update means the UI won't see the result. We can't block the
        poll loop, but on failure we explicitly drop the inflight key
        in :meth:`_poll_once` so the next 500ms tick re-runs the
        Anthropic call. Tradeoff: a transient cloud blip costs one
        extra ~5s Anthropic call instead of forcing the operator to
        manually re-arm. The Anthropic call is the expensive part, but
        the alternative — silent state-machine stall — is worse UX.
        """
        try:
            self._client.post_livetrack_session_update(session_id, **fields)
            return True
        except CloudError as err:
            log.warning(
                "livetrack poller: post update failed (%d): %s",
                err.status_code, str(err.body)[:200],
            )
            return False
        except Exception:  # pragma: no cover - defensive
            log.exception("livetrack poller: post update raised unexpectedly")
            return False


def _build_product_form(raw: Any) -> AiTareProductForm:
    """Construct an :class:`AiTareProductForm` from the session JSONB.

    The JSONB payload was written by the browser and mirrors
    :class:`AiTareProductForm` field names. Missing / malformed fields fall
    through to None defaults — ai_tare.estimate handles partial forms.
    """
    if not isinstance(raw, dict):
        return AiTareProductForm()

    def _as_float(key: str) -> Optional[float]:
        value = raw.get(key)
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _as_str(key: str) -> Optional[str]:
        value = raw.get(key)
        if value is None:
            return None
        value = str(value).strip()
        return value or None

    unit_type_raw = raw.get("unit_type")
    unit_type: Optional[str]
    if unit_type_raw is None:
        unit_type = None
    else:
        s = str(unit_type_raw).strip().lower() or None
        unit_type = s if s in _VALID_UNIT_TYPES else None

    return AiTareProductForm(
        name=_as_str("name"),
        brand=_as_str("brand"),
        variant=_as_str("variant"),
        net_weight_g=_as_float("net_weight_g"),
        serving_weight_g=_as_float("serving_weight_g"),
        servings_per_container=_as_float("servings_per_container"),
        unit_type=unit_type,
        container_type=_as_str("container_type"),
    )
