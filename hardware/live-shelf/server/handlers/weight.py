"""Weight-triggered session open/close for the catch-all shelf.

Companion to :class:`BrightnessHandler` — the door-gated path — but for
the second (countertop) scale that has NO enclosure, so there is no
brightness signal to gate sessions on. Instead, sessions open when the
scale's live weight rises above ``onscale_threshold_g`` and close once
the weight has returned below the threshold for ``stable_zero_samples``
consecutive heartbeats (hysteresis).

Subscribed to :func:`server.handlers.scale_events.ScaleHandler.handle_heartbeat`
via the middleware installed in :mod:`server.app`: whenever a heartbeat
arrives whose ``device_id`` matches the configured catch-all device id
(default ``'scale-02'``), :meth:`on_heartbeat` is invoked with the
weight reading + timestamp. The handler decides whether to open or
close the catch-all session and writes the corresponding DB rows via
:mod:`server.storage.repo`.

Design notes:

* **Never raises.** :meth:`on_heartbeat` is called from the Flask
  request thread that just processed a heartbeat POST; a raise here
  would 500 the heartbeat endpoint and make the ESP retry. Wrap the
  whole handler body in a try/except.

* **Hysteresis via consecutive-sample counter.** A single noisy sub-
  threshold sample (hand brushing the scale, scale pan oscillating on
  pickup) must NOT close the session. We require
  ``stable_zero_samples`` consecutive samples below threshold (default
  3 → ~1.5 s at the ESP's 500 ms heartbeat cadence). Any sample at or
  above the threshold resets the counter.

* **Session state is implicit from ``app_state.current_catch_all_session_id``.**
  We read the pointer every call rather than caching a session_id in
  handler state so a crash / restart between ticks re-syncs to the DB
  on the next heartbeat. The handler only caches the consecutive-zero
  counter (which is OK to lose on restart: a single zero tick is not
  a close).

* **Reconciler fire-on-close.** The catch-all does NOT go through the
  ScaleHandler.process_session_events pipeline (no classifier for
  catch-all events). The reconciler callback is invoked directly from
  the close path — mirrors the original pre-CATCH_ALL BrightnessHandler
  behavior, which is fine here because catch-all events are classified
  synchronously at ingress (CATCH_ALL_SCALE_PLAN.md §5.1 — the
  classifier agent wires this into /api/scale-event).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import datetime
from typing import Any, Callable, Optional

from ..storage import lifecycle, repo as storage_repo
from ..storage.lifecycle import ReasonCode

log = logging.getLogger(__name__)


ReconcilerFn = Callable[[str], None]


class WeightHandler:
    """Bridges catch-all scale-heartbeat readings to session lifecycle.

    Parameters
    ----------
    conn:
        Shared sqlite connection. All writes are guarded by ``db_lock``.
    db_lock:
        Re-entrant (or plain) lock protecting ``conn``.
    shelf_id:
        Target shelf id for the sessions this handler writes. Always
        ``'catch_all'`` in production; parameterised for symmetry.
    onscale_threshold_g:
        Weight threshold above which a session opens. Below-threshold
        readings count toward the close hysteresis.
    stable_zero_samples:
        Number of consecutive sub-threshold samples required to close
        an open session (default 3 → ~1.5 s at 500 ms heartbeats).
    reconciler_fn:
        Optional callable invoked with ``session_id`` after a successful
        close. The catch-all's reconciler runs inline (no classifier
        pipeline to wait for).
    """

    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        db_lock: "threading.Lock | threading.RLock",
        shelf_id: str = "catch_all",
        onscale_threshold_g: float,
        stable_zero_samples: int = 3,
        reconciler_fn: Optional[ReconcilerFn] = None,
    ) -> None:
        if shelf_id not in ("live_shelf", "catch_all"):
            raise ValueError(
                f"WeightHandler.shelf_id must be 'live_shelf' or 'catch_all', "
                f"got {shelf_id!r}"
            )
        if onscale_threshold_g <= 0:
            raise ValueError(
                f"WeightHandler.onscale_threshold_g must be > 0, "
                f"got {onscale_threshold_g!r}"
            )
        if stable_zero_samples < 1:
            raise ValueError(
                f"WeightHandler.stable_zero_samples must be >= 1, "
                f"got {stable_zero_samples!r}"
            )
        self._conn = conn
        self._db_lock = db_lock
        self._shelf_id = shelf_id
        self._onscale_threshold_g = float(onscale_threshold_g)
        self._stable_zero_samples = int(stable_zero_samples)
        self._reconciler_fn = reconciler_fn

        # State: consecutive-sub-threshold counter. Reset to 0 whenever
        # the weight crosses back above the threshold. Only relevant
        # when a session is open; we still update it while closed so
        # the invariant is always "counter == samples_below_threshold".
        self._below_threshold_samples: int = 0
        self._state_lock = threading.Lock()

    # ------------------------------------------------------------ public

    @property
    def onscale_threshold_g(self) -> float:
        return self._onscale_threshold_g

    @property
    def stable_zero_samples(self) -> int:
        return self._stable_zero_samples

    def below_threshold_samples(self) -> int:
        """Test / diagnostic hook — current consecutive sub-threshold counter."""
        with self._state_lock:
            return self._below_threshold_samples

    def on_heartbeat(
        self,
        weight_g: float,
        ts: str,
        device_id: str,
    ) -> None:
        """Ingest one heartbeat sample.

        Called from the middleware wrapper around
        :meth:`ScaleHandler.handle_heartbeat` in :mod:`server.app`. Runs on
        the Flask request thread. Never raises.
        """
        try:
            self._on_heartbeat_impl(weight_g, ts, device_id)
        except Exception:  # pragma: no cover - defensive
            log.exception(
                "weight_handler: on_heartbeat raised (weight=%.1fg device=%s)",
                weight_g,
                device_id,
            )

    # ------------------------------------------------------------ internals

    def _on_heartbeat_impl(
        self,
        weight_g: float,
        ts: str,
        device_id: str,
    ) -> None:
        # Coerce inputs before touching the DB so bad input (non-numeric
        # weight, missing ts) becomes a no-op rather than a mid-txn raise.
        try:
            w = float(weight_g)
        except (TypeError, ValueError):
            log.warning(
                "weight_handler: non-numeric weight %r; ignoring heartbeat",
                weight_g,
            )
            return
        if not ts:
            log.warning(
                "weight_handler: missing ts; ignoring heartbeat (device=%s)",
                device_id,
            )
            return

        open_session_id = self._current_catch_all_session_id()
        above = w >= self._onscale_threshold_g

        if above:
            # Weight is on the scale — reset the close-counter and open
            # a session if none is active yet.
            with self._state_lock:
                self._below_threshold_samples = 0
            if open_session_id is None:
                self._open_session(w, ts)
            return

        # Below threshold.
        with self._state_lock:
            self._below_threshold_samples += 1
            close_now = (
                open_session_id is not None
                and self._below_threshold_samples >= self._stable_zero_samples
            )
        if close_now:
            # Reset BEFORE closing so a re-open on the next above-threshold
            # heartbeat starts from a clean counter. Closing is the
            # slow-path op; the reset is cheap and idempotent.
            with self._state_lock:
                self._below_threshold_samples = 0
            # ``open_session_id`` was captured above the lock; it's
            # possible (in a multi-threaded race) that the session was
            # already closed out-of-band. _close_session treats that as
            # a no-op by re-checking under the DB lock.
            self._close_session(open_session_id, w, ts)

    # ------------------------------------------------------------ DB ops

    def _current_catch_all_session_id(self) -> Optional[str]:
        """Read the catch-all open-session pointer from app_state."""
        with self._db_lock:
            row = self._conn.execute(
                "SELECT current_catch_all_session_id FROM app_state WHERE id = 1"
            ).fetchone()
        if row is None:
            return None
        # sqlite3.Row supports both indexing styles.
        try:
            val = row["current_catch_all_session_id"]
        except (IndexError, KeyError, TypeError):
            val = row[0]
        return str(val) if val else None

    def _open_session(self, initial_weight_g: float, ts: str) -> None:
        """Open a fresh catch-all session and stamp the pointer."""
        with self._db_lock:
            # Double-check-under-lock: a concurrent heartbeat thread may
            # have just opened a session between our pre-check and here.
            row = self._conn.execute(
                "SELECT current_catch_all_session_id FROM app_state WHERE id = 1"
            ).fetchone()
            already_open = row and row[0]
            if already_open:
                log.debug(
                    "weight_handler: open raced — session %s already open; skipping",
                    row[0],
                )
                return
            sess = storage_repo.open_session(
                self._conn, ts, float(initial_weight_g or 0.0),
                shelf_id=self._shelf_id,
            )
        log.info(
            "catch-all session opened: %s @ %s (initial=%.1fg)",
            sess.session_id, ts, initial_weight_g or 0.0,
        )
        lifecycle.log_session(
            self._conn, self._db_lock,
            sess.session_id,
            actor="weight_handler",
            reason_code=ReasonCode.SESSION_OPENED,
            payload={
                "ts": ts,
                "initial_weight_g": float(initial_weight_g or 0.0),
                "shelf_id": self._shelf_id,
                "trigger": "weight",
            },
        )

    def _close_session(
        self,
        session_id: str,
        final_weight_g: float,
        ts: str,
    ) -> None:
        """Close an open catch-all session, clear the pointer, fire reconciler.

        Safe against concurrent close: if the session row was already
        closed out-of-band, ``close_session`` raises LookupError when
        the UPDATE matches zero rows — we swallow that so the close
        path is idempotent.
        """
        with self._db_lock:
            # Re-check the pointer under the lock — if a concurrent
            # close already landed, app_state won't match and
            # close_session's app_state update is a no-op. The session
            # row close will still succeed if ended_at is NULL.
            try:
                storage_repo.close_session(
                    self._conn, session_id, ts, float(final_weight_g or 0.0),
                )
            except LookupError:
                log.warning(
                    "weight_handler: close tried to close unknown session %s",
                    session_id,
                )
                return
            # close_session's UPDATE on app_state only clears
            # current_session_id (the live-shelf pointer). For catch-all
            # we must also clear current_catch_all_session_id here.
            self._conn.execute(
                """
                UPDATE app_state
                   SET current_catch_all_session_id = NULL,
                       updated_at = datetime('now')
                 WHERE id = 1 AND current_catch_all_session_id = ?
                """,
                (session_id,),
            )
            self._conn.commit()
        # Compute duration, best-effort.
        duration_s: Optional[float] = None
        try:
            with self._db_lock:
                row = self._conn.execute(
                    "SELECT started_at FROM sessions WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
            if row and row[0] and ts:
                started = datetime.fromisoformat(
                    str(row[0]).replace("Z", "+00:00")
                )
                ended = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                duration_s = (ended - started).total_seconds()
        except Exception:  # pragma: no cover - defensive
            duration_s = None

        lifecycle.log_session(
            self._conn, self._db_lock,
            session_id,
            actor="weight_handler",
            reason_code=ReasonCode.SESSION_CLOSED,
            payload={
                "ts": ts,
                "final_weight_g": float(final_weight_g or 0.0),
                "duration_s": duration_s,
                "shelf_id": self._shelf_id,
                "trigger": "weight",
            },
        )
        log.info(
            "catch-all session closed: %s @ %s (final=%.1fg, dur=%.1fs)",
            session_id, ts, final_weight_g or 0.0,
            duration_s if duration_s is not None else -1.0,
        )

        # Fire the reconciler last, outside the DB lock. The catch-all
        # has no pending-classifier wait — events are classified inline
        # at scale-event ingress — so we can reconcile immediately.
        if self._reconciler_fn is not None:
            try:
                self._reconciler_fn(session_id)
            except Exception:  # pragma: no cover - defensive
                log.exception(
                    "weight_handler: reconciler_fn raised for session %s",
                    session_id,
                )


__all__ = ["WeightHandler"]
