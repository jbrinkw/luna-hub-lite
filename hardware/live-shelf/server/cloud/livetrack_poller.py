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
        self._snapshot: Optional[dict[str, Any]] = None
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
        """
        with self._snapshot_lock:
            if self._snapshot is None:
                return None
            return dict(self._snapshot)

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
            session = self._client.get_active_livetrack_session()
        except Exception:  # pragma: no cover - defensive
            log.exception("livetrack poller: seed poll failed; snapshot left empty")
            return
        self._maybe_clear_baseline(session)
        with self._snapshot_lock:
            self._snapshot = session

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
        """Poll once, update snapshot, dispatch AI-tare if needed.

        Returns True iff the poll returned an active session (used by
        the loop to pick the next sleep interval).
        """
        session = self._client.get_active_livetrack_session()
        # Clear any stale baseline before swapping the snapshot — the
        # heartbeat handler's baseline cache is scoped to one waiting_scale
        # session, so transitions out of that state must reset it.
        self._maybe_clear_baseline(session)
        with self._snapshot_lock:
            self._snapshot = session
        if session is None:
            return False

        # Fire AI-tare asynchronously on the same thread — it's a blocking
        # Anthropic call (~5s), which is acceptable because the user has
        # nothing to do while it runs anyway. Single-flight per
        # (session_id, state) so repeated polls during the call don't
        # spawn duplicates.
        if session.get("state") == "awaiting_ai_tare":
            session_id = str(session.get("session_id", ""))
            flight_key = f"{session_id}:awaiting_ai_tare"
            with self._ai_tare_lock:
                if flight_key in self._ai_tare_inflight:
                    return True
                self._ai_tare_inflight.add(flight_key)
            try:
                self._handle_ai_tare(session)
            finally:
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

    def _post_update_safely(self, session_id: str, **fields: Any) -> None:
        """POST a session update; swallow + log any failure.

        The cloud is the source of truth for session state, so a failed
        update means the UI won't see the result. But we can't block the
        poll loop on it — the next poll will retry implicitly (state
        hasn't changed, so the UI's Realtime subscription will still
        wait until the user resets the session).
        """
        try:
            self._client.post_livetrack_session_update(session_id, **fields)
        except CloudError as err:
            log.warning(
                "livetrack poller: post update failed (%d): %s",
                err.status_code, str(err.body)[:200],
            )
        except Exception:  # pragma: no cover - defensive
            log.exception("livetrack poller: post update raised unexpectedly")


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
