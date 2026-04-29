"""Intake dead-letter queue (DLQ).

AUDIT_FINDINGS_PHASE1 L8/HIGH — when the cloud's
``POST /shelf-ingest/intake`` returns 5xx or the request never makes
it (DNS / TCP reset / timeout), the user-typed product spec is parked
in ``intake_pending`` so the operator can retry it later from the
admin UI. Without this queue, the user has to re-type every field
after each transient cloud outage.

Scope distinction vs ``cloud_outbox``:

  * cloud_outbox carries shelf events (consumed/added/in_flight) —
    the cloud dedupes on ``client_event_id`` so a retry after an
    ambiguous timeout is idempotent. Drained by a background worker.
  * intake_pending carries product creates. The cloud /intake
    handler does NOT dedupe on ``client_intake_id`` today — intake
    creates a row in ``chefbyte.products``, not a ledger entry, and
    a duplicate POST would mint a second product. So retries are
    OPERATOR-driven (manual click in /api/admin/intake-dlq) rather
    than fire-and-forget.

Status enum (matches schema CHECK):
  * 0 = pending  — operator can retry.
  * 1 = resolved — retry succeeded; ``product_id`` stamped.
  * 2 = abandoned — operator gave up (e.g. cloud refuses with 4xx
    after the operator manually fixed something cloud-side).

The 4xx (validation) failure path does NOT enqueue — those errors
are intrinsic to the user's input and require user-visible
correction. Only 5xx + network failures land here.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Optional


log = logging.getLogger(__name__)


STATUS_PENDING = 0
STATUS_RESOLVED = 1
STATUS_ABANDONED = 2


@dataclass
class IntakePendingRow:
    """One DLQ row.

    ``payload_json`` is the request body that would have been POSTed
    to ``/shelf-ingest/intake``. Callers JSON-decode lazily via
    :pyattr:`payload`.
    """

    intake_id: int
    client_intake_id: str
    payload_json: str
    enqueued_at: str
    resolved_at: Optional[str]
    attempts: int
    last_error: Optional[str]
    status: int
    product_id: Optional[str]

    @property
    def payload(self) -> dict[str, Any]:
        return json.loads(self.payload_json)


def enqueue(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    error: str,
    db_lock: Optional[threading.Lock] = None,
) -> str:
    """Park a failed intake POST in the DLQ.

    Generates a fresh ``client_intake_id`` UUID4, serializes
    ``payload`` (the body the wizard would have posted), records the
    transient error message, and returns the intake id so the caller
    can surface it in the user-facing failure response (so ops can
    grep for it later).

    Caller is responsible for confirming the failure was transient
    (5xx / network) before calling this — 4xx validation errors must
    NOT be enqueued.
    """
    client_id = str(uuid.uuid4())
    payload_json = json.dumps(payload, separators=(",", ":"), default=str)
    lock = db_lock if db_lock is not None else _NULL_LOCK
    with lock:
        with conn:
            conn.execute(
                """
                INSERT INTO intake_pending (
                    client_intake_id, payload_json, last_error, attempts
                ) VALUES (?, ?, ?, 1)
                """,
                (client_id, payload_json, error),
            )
    return client_id


def list_pending(
    conn: sqlite3.Connection, *, limit: int = 200
) -> list[IntakePendingRow]:
    """Return pending DLQ rows, oldest first.

    Defaults to ``limit=200`` so the admin UI can paginate without
    blowing up on a stuck queue. Status=0 only — resolved/abandoned
    rows are visible via :func:`list_all`.
    """
    rows = conn.execute(
        """
        SELECT intake_id, client_intake_id, payload_json, enqueued_at,
               resolved_at, attempts, last_error, status, product_id
          FROM intake_pending
         WHERE status = 0
         ORDER BY intake_id ASC
         LIMIT ?
        """,
        (int(limit),),
    ).fetchall()
    return [_row_to_obj(r) for r in rows]


def list_all(
    conn: sqlite3.Connection, *, limit: int = 200
) -> list[IntakePendingRow]:
    """Return DLQ rows across all statuses, newest first.

    Surfaces the audit trail (resolved + abandoned) too so operators
    can trace what was queued + what eventually succeeded. Sorted
    DESC on ``intake_id`` because the admin UI usually wants the most
    recent failures at the top.
    """
    rows = conn.execute(
        """
        SELECT intake_id, client_intake_id, payload_json, enqueued_at,
               resolved_at, attempts, last_error, status, product_id
          FROM intake_pending
         ORDER BY intake_id DESC
         LIMIT ?
        """,
        (int(limit),),
    ).fetchall()
    return [_row_to_obj(r) for r in rows]


def get(
    conn: sqlite3.Connection, intake_id: int
) -> Optional[IntakePendingRow]:
    """Look up one DLQ row by id; ``None`` if missing."""
    row = conn.execute(
        """
        SELECT intake_id, client_intake_id, payload_json, enqueued_at,
               resolved_at, attempts, last_error, status, product_id
          FROM intake_pending
         WHERE intake_id = ?
        """,
        (int(intake_id),),
    ).fetchone()
    return _row_to_obj(row) if row else None


def mark_resolved(
    conn: sqlite3.Connection,
    intake_id: int,
    *,
    product_id: str,
    db_lock: Optional[threading.Lock] = None,
) -> bool:
    """Stamp the row as resolved with the cloud-minted ``product_id``.

    Returns True if a row was actually updated (intake_id existed AND
    was still status=0). Idempotent: a second call on a resolved row
    is a no-op (returns False).
    """
    lock = db_lock if db_lock is not None else _NULL_LOCK
    with lock:
        with conn:
            cur = conn.execute(
                """
                UPDATE intake_pending
                   SET status = 1,
                       resolved_at = datetime('now'),
                       product_id = ?,
                       last_error = NULL
                 WHERE intake_id = ? AND status = 0
                """,
                (product_id, int(intake_id)),
            )
    return (cur.rowcount or 0) > 0


def mark_abandoned(
    conn: sqlite3.Connection,
    intake_id: int,
    *,
    reason: str,
    db_lock: Optional[threading.Lock] = None,
) -> bool:
    """Stamp the row as abandoned (operator gave up).

    Used by the admin UI's "abandon" action when a queued intake
    won't ever succeed (e.g. cloud rejected with 4xx after the
    operator manually fixed something). Returns True iff updated.
    """
    lock = db_lock if db_lock is not None else _NULL_LOCK
    with lock:
        with conn:
            cur = conn.execute(
                """
                UPDATE intake_pending
                   SET status = 2,
                       resolved_at = datetime('now'),
                       last_error = ?
                 WHERE intake_id = ? AND status = 0
                """,
                (reason, int(intake_id)),
            )
    return (cur.rowcount or 0) > 0


def record_retry_failure(
    conn: sqlite3.Connection,
    intake_id: int,
    *,
    error: str,
    db_lock: Optional[threading.Lock] = None,
) -> None:
    """Bump ``attempts`` and store the latest failure message.

    Called from the retry endpoint when a retry attempt failed but
    the row should stay pending (transient error). The row stays in
    status=0 so future retries can keep trying.
    """
    lock = db_lock if db_lock is not None else _NULL_LOCK
    with lock:
        with conn:
            conn.execute(
                """
                UPDATE intake_pending
                   SET attempts = attempts + 1,
                       last_error = ?
                 WHERE intake_id = ? AND status = 0
                """,
                (error, int(intake_id)),
            )


def count_pending(conn: sqlite3.Connection) -> int:
    """Return the count of pending DLQ rows.

    Surfaced via /healthz so operators see when intakes are stuck
    without digging through the admin UI.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM intake_pending WHERE status = 0"
    ).fetchone()
    return int(row["c"] if row is not None else 0)


def _row_to_obj(row: sqlite3.Row) -> IntakePendingRow:
    return IntakePendingRow(
        intake_id=row["intake_id"],
        client_intake_id=row["client_intake_id"],
        payload_json=row["payload_json"],
        enqueued_at=row["enqueued_at"],
        resolved_at=row["resolved_at"],
        attempts=row["attempts"],
        last_error=row["last_error"],
        status=row["status"],
        product_id=row["product_id"],
    )


class _NullLock:
    """No-op context manager used when the caller doesn't pass a real lock."""

    def __enter__(self) -> "_NullLock":
        return self

    def __exit__(self, *args: Any) -> None:
        return None


_NULL_LOCK = _NullLock()
