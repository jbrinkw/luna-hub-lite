"""Event + session + system-health lifecycle logging.

Every state transition of an event or session — ingress, claim, frame
pick, classifier dispatch, apply/skip, review enqueue, reconciler start/
done — writes one row to the ``event_lifecycle`` / ``session_lifecycle``
tables. Periodic snapshots of scale / queue / lot aggregates go into
``system_health``.

Design rules (keep these tight):

* **Never raise.** Observability must never crash the main flow.
  Every public helper wraps its DB work in ``try/except`` that logs
  at WARNING and swallows. Callers don't need a guard.
* **Use the caller's db_lock** so we don't deadlock with writers that
  already hold it, and so we observe the same serialization order.
* **Small JSON payloads.** ``json.dumps(..., default=str)`` handles
  datetimes, UUIDs, paths etc without blowing up.
* **Reason codes are class-level constants** on :class:`ReasonCode`.
  Call sites reference the constant (``ReasonCode.EVENT_INGRESS``),
  never a bare string.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from typing import Any, Iterable, Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Reason codes — string enum. Keep these values stable; they land in the DB
# and external tools grep for them.
# ---------------------------------------------------------------------------


class ReasonCode:
    """Canonical set of lifecycle reason_code values.

    Grouped by pipeline stage. Adding a new transition? Add the constant
    here so call sites don't sprout magic strings.
    """

    # -- event ingress / dedup ---------------------------------------------
    EVENT_INGRESS = "event_ingress"
    EVENT_INGRESS_DEDUP_HIT = "event_ingress_dedup_hit"
    EVENT_INGRESS_NOISE = "event_ingress_noise"
    EVENT_INGRESS_REJECTED = "event_ingress_rejected"

    # -- claim ------------------------------------------------------------
    EVENT_CLAIMED = "event_claimed"
    EVENT_CLAIM_LOST = "event_claim_lost"
    EVENT_ROW_MISSING = "event_row_missing"

    # -- session id back-stamp --------------------------------------------
    SESSION_ID_BACKSTAMPED = "session_id_backstamped"

    # -- frames ----------------------------------------------------------
    FRAMES_PICKED = "frames_picked"
    FRAMES_COPIED = "frames_copied"
    FRAMES_COPY_ERROR = "frames_copy_error"

    # -- classifier ------------------------------------------------------
    CLASSIFIER_DISPATCHED = "classifier_dispatched"
    CLASSIFIER_PROMPT_PREPARED = "classifier_prompt_prepared"
    CLASSIFIER_RETURNED = "classifier_returned"
    CLASSIFIER_THREW = "classifier_threw"
    CLASSIFIER_PARSE_RETRY = "classifier_parse_retry"
    CLASSIFIER_MALFORMED_OUTPUT = "classifier_malformed_output"
    CLASSIFIER_PROMOTED_UNKNOWN_WEIGHT_FIT = "classifier_promoted_unknown_weight_fit"

    # -- apply decision --------------------------------------------------
    APPLY_ACCEPTED = "apply_accepted"
    APPLY_SKIPPED = "apply_skipped"
    LOT_MUTATED = "lot_mutated"
    REVIEW_ENQUEUED = "review_enqueued"

    # -- in-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §3.3) ---------------
    LOT_MARKED_IN_FLIGHT = "lot_marked_in_flight"
    LOT_RETURNED_FROM_FLIGHT = "lot_returned_from_flight"
    LOT_REPLACED_IN_FLIGHT = "lot_replaced_in_flight"
    LOT_EXPIRED_IN_FLIGHT = "lot_expired_in_flight"

    # -- usage_log (USAGE_LOG_PLAN.md) ------------------------------------
    # Emitted whenever a usage_log row is written (or the write is
    # attempted and fails). Lets timelines correlate consumption with
    # the lifecycle trail.
    USAGE_LOGGED = "usage_logged"
    USAGE_LOG_WRITE_FAILED = "usage_log_write_failed"

    # -- sweeper ---------------------------------------------------------
    SWEEPER_CONSIDERED = "sweeper_considered"
    SWEEPER_DEFERRED_TO_CLOSE_HOOK = "sweeper_deferred_to_close_hook"
    SWEEPER_MARKED_FAILED = "sweeper_marked_failed"
    SWEEPER_CLASSIFIED = "sweeper_classified"

    # -- gap-fill --------------------------------------------------------
    GAP_FILL_CONSIDERED = "gap_fill_considered"
    GAP_FILL_SYNTHESIZED = "gap_fill_synthesized"
    GAP_FILL_SKIPPED = "gap_fill_skipped"

    # -- heartbeats ------------------------------------------------------
    ESP_REBOOT_DETECTED = "esp_reboot_detected"
    HEARTBEAT_WEIGHT_REGRESSION_SUPPRESSED = "heartbeat_weight_regression_suppressed"

    # -- sessions --------------------------------------------------------
    SESSION_OPENED = "session_opened"
    SESSION_OPEN_SKIPPED = "session_open_skipped"
    SESSION_CLOSED = "session_closed"
    SESSION_CAPTURE_OPENED = "session_capture_opened"
    SESSION_CAPTURE_CLOSED = "session_capture_closed"
    SESSION_ORPHAN_DROPPED = "session_orphan_dropped"
    FRAMES_ARCHIVE_TICK = "frames_archive_tick"
    VIDEO_ENCODED = "video_encoded"
    VIDEO_ENCODE_FAILED = "video_encode_failed"

    # -- reconciler ------------------------------------------------------
    RECONCILER_STARTED = "reconciler_started"
    RECONCILER_COMPLETED = "reconciler_completed"
    RECONCILER_SKIPPED_IDEMPOTENT = "reconciler_skipped_idempotent"

    # -- review resolution ----------------------------------------------
    REVIEW_RESOLVED = "review_resolved"

    # -- admin -----------------------------------------------------------
    WIPE_STARTED = "wipe_started"
    WIPE_COMPLETED = "wipe_completed"


# ---------------------------------------------------------------------------
# Internal write helper
# ---------------------------------------------------------------------------


def _encode_payload(payload: Optional[dict[str, Any]]) -> Optional[str]:
    if payload is None:
        return None
    try:
        return json.dumps(payload, default=str)
    except (TypeError, ValueError):
        # Fallback: stringify everything. Never raise from this path.
        try:
            return json.dumps({k: str(v) for k, v in payload.items()}, default=str)
        except Exception:  # pragma: no cover - defensive
            return None


def _acquire(lock: Any) -> tuple[Any, bool]:
    """Best-effort lock acquire that never raises.

    Returns ``(ctx_or_none, acquired)``. When ``acquired`` is False the
    caller writes without the lock (a lifecycle log is not worth
    blocking on a broken lock).
    """
    if lock is None:
        return None, False
    try:
        lock.acquire()
        return lock, True
    except Exception:  # pragma: no cover - defensive
        return None, False


def _release(lock: Any, acquired: bool) -> None:
    if not acquired:
        return
    try:
        lock.release()
    except Exception:  # pragma: no cover - defensive
        pass


# ---------------------------------------------------------------------------
# Public: event lifecycle
# ---------------------------------------------------------------------------


def log_event(
    conn: sqlite3.Connection,
    lock: Any,
    event_id: Optional[str],
    *,
    actor: str,
    reason_code: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    """Append one row to ``event_lifecycle``.

    ``lock`` is the caller's db_lock. Pass ``None`` for tests that use a
    single-threaded in-memory connection.

    Never raises — any DB error is logged at WARNING and swallowed.
    """
    if not event_id:
        return
    encoded = _encode_payload(payload)
    acquired = False
    ctx_lock = None
    try:
        ctx_lock, acquired = _acquire(lock)
        with conn:
            conn.execute(
                """
                INSERT INTO event_lifecycle
                    (event_id, actor, reason_code, payload_json)
                VALUES (?, ?, ?, ?)
                """,
                (event_id, actor, reason_code, encoded),
            )
    except Exception:  # pragma: no cover - defensive
        log.warning(
            "lifecycle.log_event: insert failed (event_id=%s reason=%s)",
            event_id, reason_code, exc_info=True,
        )
    finally:
        _release(ctx_lock, acquired)


def log_session(
    conn: sqlite3.Connection,
    lock: Any,
    session_id: Optional[str],
    *,
    actor: str,
    reason_code: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    """Append one row to ``session_lifecycle``."""
    if not session_id:
        return
    encoded = _encode_payload(payload)
    acquired = False
    ctx_lock = None
    try:
        ctx_lock, acquired = _acquire(lock)
        with conn:
            conn.execute(
                """
                INSERT INTO session_lifecycle
                    (session_id, actor, reason_code, payload_json)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, actor, reason_code, encoded),
            )
    except Exception:  # pragma: no cover - defensive
        log.warning(
            "lifecycle.log_session: insert failed (session_id=%s reason=%s)",
            session_id, reason_code, exc_info=True,
        )
    finally:
        _release(ctx_lock, acquired)


def log_system_health_snapshot(
    conn: sqlite3.Connection,
    lock: Any,
    snapshot: dict[str, Any],
) -> None:
    """Write one row to ``system_health``.

    ``snapshot`` keys are mapped to the table columns. Unknown keys are
    ignored. Missing keys store NULL.
    """
    cols = (
        "scale_weight_g",
        "pending_events",
        "classifying_events",
        "failed_events",
        "pending_reviews",
        "on_shelf_lot_count",
        "on_shelf_weight_sum_g",
        "closed_deque_size",
        "anthropic_calls_total",
        "anthropic_errors_total",
    )
    values = tuple(snapshot.get(c) for c in cols)
    acquired = False
    ctx_lock = None
    try:
        ctx_lock, acquired = _acquire(lock)
        with conn:
            conn.execute(
                f"""
                INSERT INTO system_health
                    ({', '.join(cols)})
                VALUES ({', '.join(['?'] * len(cols))})
                """,
                values,
            )
    except Exception:  # pragma: no cover - defensive
        log.warning(
            "lifecycle.log_system_health_snapshot: insert failed",
            exc_info=True,
        )
    finally:
        _release(ctx_lock, acquired)


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


def get_event_timeline(
    conn: sqlite3.Connection,
    event_id: str,
    *,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return rows for one event, chronological. Never raises."""
    try:
        rows = conn.execute(
            """
            SELECT id, event_id, ts, actor, reason_code, payload_json
              FROM event_lifecycle
             WHERE event_id = ?
             ORDER BY id ASC
             LIMIT ?
            """,
            (event_id, int(limit)),
        ).fetchall()
    except Exception:  # pragma: no cover - defensive
        log.warning("lifecycle.get_event_timeline failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows]


def get_session_timeline(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return rows for one session, chronological. Never raises."""
    try:
        rows = conn.execute(
            """
            SELECT id, session_id, ts, actor, reason_code, payload_json
              FROM session_lifecycle
             WHERE session_id = ?
             ORDER BY id ASC
             LIMIT ?
            """,
            (session_id, int(limit)),
        ).fetchall()
    except Exception:  # pragma: no cover - defensive
        log.warning("lifecycle.get_session_timeline failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows]


def get_recent_health(
    conn: sqlite3.Connection,
    *,
    since_seconds: int = 3600,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """Return the last N system_health snapshots in the given window."""
    try:
        rows = conn.execute(
            """
            SELECT id, ts, scale_weight_g, pending_events, classifying_events,
                   failed_events, pending_reviews, on_shelf_lot_count,
                   on_shelf_weight_sum_g, closed_deque_size,
                   anthropic_calls_total, anthropic_errors_total
              FROM system_health
             WHERE datetime(ts) >= datetime('now', ? )
             ORDER BY id DESC
             LIMIT ?
            """,
            (f"-{int(since_seconds)} seconds", int(limit)),
        ).fetchall()
    except Exception:  # pragma: no cover - defensive
        log.warning("lifecycle.get_recent_health failed", exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        if hasattr(r, "keys"):
            out.append({k: r[k] for k in r.keys()})
        else:
            out.append(dict(r))
    return out


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def purge_older_than(
    conn: sqlite3.Connection,
    lock: Any,
    *,
    days: int = 30,
) -> dict[str, int]:
    """Delete lifecycle + system_health rows older than ``days``.

    Returns a dict of per-table row counts deleted. Never raises.
    """
    deleted = {"event_lifecycle": 0, "session_lifecycle": 0, "system_health": 0}
    cutoff = f"-{int(days)} days"
    acquired = False
    ctx_lock = None
    try:
        ctx_lock, acquired = _acquire(lock)
        with conn:
            for tbl in deleted:
                cur = conn.execute(
                    f"DELETE FROM {tbl} WHERE datetime(ts) < datetime('now', ?)",
                    (cutoff,),
                )
                deleted[tbl] = int(cur.rowcount or 0)
    except Exception:  # pragma: no cover - defensive
        log.warning("lifecycle.purge_older_than failed", exc_info=True)
    finally:
        _release(ctx_lock, acquired)
    return deleted


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _row_to_dict(row: Any) -> dict[str, Any]:
    if hasattr(row, "keys"):
        d = {k: row[k] for k in row.keys()}
    else:
        d = dict(row)
    # Decode payload_json for convenience — but leave as-is if it's
    # already None or malformed.
    raw = d.get("payload_json")
    if isinstance(raw, str) and raw:
        try:
            d["payload"] = json.loads(raw)
        except (TypeError, ValueError):
            d["payload"] = None
    else:
        d["payload"] = None
    return d


__all__ = [
    "ReasonCode",
    "log_event",
    "log_session",
    "log_system_health_snapshot",
    "get_event_timeline",
    "get_session_timeline",
    "get_recent_health",
    "purge_older_than",
]
