"""Brightness transition → session lifecycle.

The camera daemon invokes our callback on every open/close transition
from its capture thread. Per Bundle C's docs, callbacks must be quick
and must never raise — so session-close does the minimum required DB
work (close the sessions row, clear app_state.current_session_id) and
nothing else. The reconciler is NOT spawned from here: the close
notification fans out to two subscribers — this one, and
``session_capture._handle_close`` which calls the classifier inline —
and the camera daemon runs both in subscription order. If we spawned
the reconciler here it would race ahead of the classifier and write
"unknown" resolutions before any pending event had been classified.
The reconciler is now spawned from ``ScaleHandler.process_session_events``
once all pending events for the session have been classified.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from typing import Callable

from ..camera.daemon import BrightnessTransition
from ..reconciler.reconcile import ReconcilerRepo
from ..storage import lifecycle, repo as storage_repo
from ..storage.lifecycle import ReasonCode

log = logging.getLogger(__name__)


class BrightnessHandler:
    """Bridges door open/close transitions to session state.

    All writes go through a shared ``sqlite3.Connection``. Callers must
    guard DB mutations with the supplied lock. See :class:`server.app`
    for the shared-lock wiring.

    ``reconciler_repo`` is accepted for backward-compat with the wiring
    in :mod:`server.app`, but is no longer used by this handler —
    reconcile spawning moved to
    :meth:`ScaleHandler.process_session_events` so it runs AFTER
    classification completes.
    """

    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        db_lock: threading.Lock,
        reconciler_repo: ReconcilerRepo,
        last_weight_provider: Callable[[], float],
    ) -> None:
        self._conn = conn
        self._db_lock = db_lock
        # Kept for backward-compat with the app wiring; no longer used
        # here. The reconciler is spawned from ScaleHandler after
        # classification.
        self._reconciler_repo = reconciler_repo
        self._last_weight_provider = last_weight_provider

    # ------------------------------------------------------------ entrypoint

    def __call__(self, evt: BrightnessTransition) -> None:
        """Daemon-facing callback. Runs on the capture thread."""
        try:
            if evt.kind == "open":
                self._on_open(evt)
            elif evt.kind == "close":
                self._on_close(evt)
            else:
                log.warning("brightness: unknown kind %r", evt.kind)
        except Exception:  # pragma: no cover — daemon catches but double-guard
            log.exception("brightness handler raised")

    # ------------------------------------------------------------ session open

    def _on_open(self, evt: BrightnessTransition) -> None:
        initial_weight = self._last_weight_provider()
        with self._db_lock:
            state = storage_repo.get_app_state(self._conn)
            if state.door_open and state.current_session_id:
                log.warning(
                    "brightness: open event but session %s is already active; ignoring",
                    state.current_session_id,
                )
                lifecycle.log_session(
                    self._conn, self._db_lock,
                    state.current_session_id,
                    actor="brightness",
                    reason_code=ReasonCode.SESSION_OPEN_SKIPPED,
                    payload={
                        "ts": evt.ts_iso,
                        "reason": "already_active",
                    },
                )
                return
            sess = storage_repo.open_session(
                self._conn,
                evt.ts_iso,
                float(initial_weight or 0.0),
            )
        log.info(
            "session opened: %s @ %s (initial=%.1fg)",
            sess.session_id,
            evt.ts_iso,
            initial_weight or 0.0,
        )
        lifecycle.log_session(
            self._conn, self._db_lock,
            sess.session_id,
            actor="brightness",
            reason_code=ReasonCode.SESSION_OPENED,
            payload={
                "ts": evt.ts_iso,
                "initial_weight_g": float(initial_weight or 0.0),
                "brightness": getattr(evt, "brightness", None),
            },
        )

    # ------------------------------------------------------------ session close

    def _on_close(self, evt: BrightnessTransition) -> None:
        final_weight = self._last_weight_provider()
        with self._db_lock:
            state = storage_repo.get_app_state(self._conn)
            session_id = state.current_session_id
            if not session_id:
                log.warning(
                    "brightness: close event but no active session; ignoring"
                )
                return
            try:
                storage_repo.close_session(
                    self._conn,
                    session_id,
                    evt.ts_iso,
                    float(final_weight or 0.0),
                )
            except LookupError:
                log.warning(
                    "brightness: close tried to close unknown session %s", session_id
                )
                return
        # Compute duration for the payload — read the session row back. Best
        # effort; if anything fails we still log the close without duration.
        duration_s: Optional[float] = None
        try:
            with self._db_lock:
                row = self._conn.execute(
                    "SELECT started_at FROM sessions WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
            if row and row[0] and evt.ts_iso:
                from datetime import datetime
                started = datetime.fromisoformat(str(row[0]).replace("Z", "+00:00"))
                ended = datetime.fromisoformat(evt.ts_iso.replace("Z", "+00:00"))
                duration_s = (ended - started).total_seconds()
        except Exception:  # pragma: no cover - defensive
            duration_s = None
        lifecycle.log_session(
            self._conn, self._db_lock,
            session_id,
            actor="brightness",
            reason_code=ReasonCode.SESSION_CLOSED,
            payload={
                "ts": evt.ts_iso,
                "final_weight_g": float(final_weight or 0.0),
                "duration_s": duration_s,
            },
        )
        log.info(
            "session closed: %s @ %s (final=%.1fg); reconciler will run "
            "after classifier completes",
            session_id,
            evt.ts_iso,
            final_weight or 0.0,
        )
        # NOTE: the reconciler USED to be spawned here, but that raced
        # ahead of the classifier (which runs in the next close
        # subscriber, session_capture._handle_close → on_close_callback
        # → ScaleHandler.process_session_events) and wrote "unknown"
        # resolutions before any event had been classified. The
        # reconciler is now spawned at the tail of
        # ScaleHandler.process_session_events so it sees classified rows.


__all__ = ["BrightnessHandler"]
