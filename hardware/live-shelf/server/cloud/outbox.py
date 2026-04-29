"""SQLite-backed event queue for cloud delivery.

Events produced by the reconciler / single-item tracker / intake path
are written into ``cloud_outbox`` before any network I/O happens. The
background :class:`~server.cloud.worker.CloudWorker` drains the queue
asynchronously so Pi event handling stays local-first and resilient to
Wi-Fi blips.

Schema design rationale (PROD_MIGRATION_PLAN.md §6 disk-cap risk):
  * ``client_event_id`` is a UUID4 generated client-side and stamped
    into ``payload_json`` before serialization. The cloud's
    ``POST /event`` endpoint dedupes on this id so a retry after an
    ambiguous timeout can't double-write stock/macros.
  * ``UNIQUE`` on ``client_event_id`` means a second ``enqueue_event``
    with the same id (e.g. caller reconstructed the payload and reused
    it) raises ``sqlite3.IntegrityError``. Callers generate fresh ids.
  * Partial index ``(sent_at) WHERE sent_at IS NULL`` keeps the pending
    scan cheap even after the outbox has drained thousands of rows that
    we keep for a while as audit trail.
  * ``trim_oldest_over`` caps the table at 10 000 rows — at typical
    event rates (a few per hour) that's weeks of offline buffer.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class OutboxRow:
    """One pending-or-sent outbox row.

    ``payload_json`` is the raw string as stored; callers decide whether
    to ``json.loads`` it or forward it verbatim as the ``POST /event``
    body. ``client_event_id`` is always present inside the decoded
    payload too, per :func:`enqueue_event` behavior.

    ``failed_permanently`` flags rows that hit a non-retryable 4xx
    (400/404/409 — see worker.py; 422 is treated as retryable per
    pass-2 audit finding #8 because the edge fn uses it for "occurred_at
    out of range" which a clock correction or back-fill window shift
    resolves). The drainer filters these out of the pending scan;
    operators can inspect them via :func:`count_permanent_failures`.
    """

    outbox_id: int
    client_event_id: str
    payload_json: str
    enqueued_at: str
    sent_at: str | None
    attempts: int
    last_error: str | None
    failed_permanently: bool = False

    @property
    def payload(self) -> dict[str, Any]:
        """Decode ``payload_json`` on demand."""
        return json.loads(self.payload_json)


def enqueue_event(conn: sqlite3.Connection, payload: dict) -> str:
    """Persist ``payload`` to the outbox and return its ``client_event_id``.

    Generates a fresh UUID4, composes a shallow copy of ``payload`` with
    ``client_event_id`` injected, then inserts the serialized payload as
    a pending row. The ``enqueued_at`` / ``sent_at`` / ``attempts``
    columns are populated by SQLite defaults.

    The caller's dict is **not** mutated — the returned id is the sole
    public contract. A previous implementation stamped the id into the
    caller's dict in place, which was a subtle foot-gun for producers
    that built a payload once and enqueued it under several emit paths
    (e.g. retry helpers); they would end up with the first attempt's id
    baked into their "fresh" dict on subsequent calls.

    Raises :class:`sqlite3.IntegrityError` if the generated id collides
    with an existing row — practically impossible with UUID4 entropy,
    but the UNIQUE constraint is still the correctness guarantee.
    """
    client_event_id = str(uuid.uuid4())
    stamped = {**payload, "client_event_id": client_event_id}
    payload_json = json.dumps(stamped, separators=(",", ":"), default=str)
    with conn:
        conn.execute(
            "INSERT INTO cloud_outbox (client_event_id, payload_json) "
            "VALUES (?, ?)",
            (client_event_id, payload_json),
        )
    return client_event_id


def list_pending(
    conn: sqlite3.Connection, limit: int = 50
) -> list[OutboxRow]:
    """Return up to ``limit`` oldest deliverable outbox rows.

    Deliverable = ``sent_at IS NULL AND failed_permanently = 0``. Rows
    the worker has flagged ``failed_permanently`` (non-retryable 4xx)
    stay in the table as an audit trail but are skipped here so the
    drainer doesn't keep beating on them.

    Ordering by ``outbox_id`` (autoincrement) preserves insertion order
    which is what the cloud expects — events must apply in the order
    they happened on the Pi so stock deltas reconcile correctly.
    """
    rows = conn.execute(
        "SELECT outbox_id, client_event_id, payload_json, enqueued_at, "
        "       sent_at, attempts, last_error, failed_permanently "
        "  FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0 "
        " ORDER BY outbox_id ASC "
        " LIMIT ?",
        (limit,),
    ).fetchall()
    return [
        OutboxRow(
            outbox_id=r["outbox_id"],
            client_event_id=r["client_event_id"],
            payload_json=r["payload_json"],
            enqueued_at=r["enqueued_at"],
            sent_at=r["sent_at"],
            attempts=r["attempts"],
            last_error=r["last_error"],
            failed_permanently=bool(r["failed_permanently"]),
        )
        for r in rows
    ]


def mark_sent(conn: sqlite3.Connection, outbox_id: int) -> None:
    """Stamp ``sent_at`` to mark an outbox row delivered.

    Idempotent: re-marking an already-sent row just overwrites the
    timestamp with the current moment, which is harmless because the
    worker never re-sends a row whose ``sent_at`` is non-NULL.
    """
    with conn:
        conn.execute(
            "UPDATE cloud_outbox "
            "   SET sent_at = datetime('now'), last_error = NULL "
            " WHERE outbox_id = ?",
            (outbox_id,),
        )


def mark_failed(
    conn: sqlite3.Connection, outbox_id: int, error: str
) -> None:
    """Record a failed delivery attempt.

    Increments ``attempts`` and stores the latest error message so
    operators can inspect recent failures via the ``cloud_outbox`` row.
    ``sent_at`` is left NULL so the row stays in the pending pool for
    the worker's next tick.
    """
    with conn:
        conn.execute(
            "UPDATE cloud_outbox "
            "   SET attempts = attempts + 1, last_error = ? "
            " WHERE outbox_id = ?",
            (error, outbox_id),
        )


def mark_permanent_failure(
    conn: sqlite3.Connection, outbox_id: int, reason: str
) -> None:
    """Flag a row as permanently failed so the drainer stops retrying.

    Called for non-retryable 4xx responses (400/404/409) — the
    payload has a shape or dedupe problem that won't resolve by
    retrying. Row stays in the table as an audit trail and is excluded
    from :func:`list_pending`. ``last_error`` is updated so operators
    can see the terminal reason.
    """
    with conn:
        conn.execute(
            "UPDATE cloud_outbox "
            "   SET failed_permanently = 1, "
            "       last_error = ?, "
            "       attempts = attempts + 1 "
            " WHERE outbox_id = ?",
            (reason, outbox_id),
        )


def mark_dead_letter(
    conn: sqlite3.Connection, outbox_id: int, reason: str
) -> None:
    """Flag a row as dead-lettered after exhausting retry budget.

    Called by the worker after :data:`DEAD_LETTER_ATTEMPT_THRESHOLD`
    consecutive *transient* failures (5xx, auth, network) on the same
    row. Distinct semantics from :func:`mark_permanent_failure` — that
    one fires when the cloud explicitly says "this payload is bad"
    (400/404/409); this one fires when the cloud keeps timing-out /
    erroring without a clear root cause and we'd rather skip the row
    than FIFO-block every event behind it indefinitely.

    On disk both end up in the same ``failed_permanently=1`` slot — the
    audit trail's ``last_error`` is the human-readable distinguisher
    ("DEAD_LETTER: " prefix vs the bare cloud response). One column +
    the prefix keeps the schema simple while preserving operator-facing
    differentiation in the /admin/dead-letter UI.

    The drainer's :func:`list_pending` filter (``failed_permanently=0``)
    excludes both bucket types, so dead-letter writes are
    immediately effective: the worker's NEXT tick skips this row and
    proceeds to drain the rest of the queue.

    Operators can manually clear a dead-lettered row by setting
    ``failed_permanently = 0`` (and optionally ``attempts = 0``) via
    direct SQL or the /admin/dead-letter UI's "retry" affordance — the
    drainer will pick it up again on the next tick.
    """
    with conn:
        conn.execute(
            "UPDATE cloud_outbox "
            "   SET failed_permanently = 1, "
            "       last_error = ?, "
            "       attempts = attempts + 1 "
            " WHERE outbox_id = ?",
            (f"DEAD_LETTER: {reason}", outbox_id),
        )


def list_dead_letter(
    conn: sqlite3.Connection, *, limit: int = 100
) -> list[OutboxRow]:
    """Return up to ``limit`` dead-lettered + permanently-failed rows.

    Used by the /admin/dead-letter UI to surface what's stuck. Includes
    BOTH ``mark_dead_letter`` (transient retry exhaustion) and
    ``mark_permanent_failure`` (cloud-said-bad-payload) rows. The
    ``last_error`` ``DEAD_LETTER:`` prefix lets the UI render them
    distinctly without a separate column.

    Sorted by ``outbox_id DESC`` so the most recent failures appear
    first — operators usually want to triage the latest breakage.
    """
    rows = conn.execute(
        "SELECT outbox_id, client_event_id, payload_json, enqueued_at, "
        "       sent_at, attempts, last_error, failed_permanently "
        "  FROM cloud_outbox "
        " WHERE failed_permanently = 1 "
        " ORDER BY outbox_id DESC "
        " LIMIT ?",
        (limit,),
    ).fetchall()
    return [
        OutboxRow(
            outbox_id=r["outbox_id"],
            client_event_id=r["client_event_id"],
            payload_json=r["payload_json"],
            enqueued_at=r["enqueued_at"],
            sent_at=r["sent_at"],
            attempts=r["attempts"],
            last_error=r["last_error"],
            failed_permanently=bool(r["failed_permanently"]),
        )
        for r in rows
    ]


def reset_dead_letter(
    conn: sqlite3.Connection, outbox_id: int
) -> bool:
    """Clear ``failed_permanently`` so the worker will retry the row.

    Returns True if a row was actually updated. Operator-facing affordance
    for the /admin/dead-letter UI when a dead-lettered row should be
    re-tried (e.g. after a cloud-side fix lands). Resets ``attempts``
    to 0 so the dead-letter threshold counts from scratch — otherwise
    the row would re-dead-letter after a single failure.
    """
    with conn:
        cur = conn.execute(
            "UPDATE cloud_outbox "
            "   SET failed_permanently = 0, "
            "       attempts = 0, "
            "       last_error = NULL "
            " WHERE outbox_id = ? AND failed_permanently = 1",
            (outbox_id,),
        )
    return (cur.rowcount or 0) > 0


def count_pending(conn: sqlite3.Connection) -> int:
    """Return the number of outbox rows still awaiting delivery.

    Mirrors :func:`list_pending`'s filter — a row flagged
    ``failed_permanently`` is excluded from this count because the
    drainer will never touch it again; reporting it as "pending" would
    confuse the /healthz backlog signal.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM cloud_outbox "
        "WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()
    return int(row["c"] if row is not None else 0)


def count_permanent_failures(conn: sqlite3.Connection) -> int:
    """Return the number of outbox rows flagged ``failed_permanently``.

    Surfaced via /healthz so operators can see when the cloud has
    started rejecting a subset of events (shape mismatch after a
    schema rev, dedupe key collision, etc.) without digging through
    logs.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM cloud_outbox WHERE failed_permanently = 1"
    ).fetchone()
    return int(row["c"] if row is not None else 0)


def prune_sent_older_than(
    conn: sqlite3.Connection, *, days: int = 7
) -> int:
    """Delete rows whose delivery succeeded more than ``days`` days ago.

    Retention policy (bug fix 2026-04-22): sent rows accumulate
    indefinitely on the Pi's SD card. Observed in production: 4+ rows
    from 2+ days ago with ``sent_at`` populated, growing unbounded.
    This function drops anything with ``sent_at < now-days``.

    Scope guarantees — any row is preserved when:
      * ``sent_at IS NULL`` — still pending delivery, mustn't be lost.
      * ``failed_permanently = 1`` — forensic record of a 4xx rejection
        that operators may want to inspect (the dedupe key collided, a
        product reference was stale, etc.). Those rows stay as an audit
        trail until manually cleared.
      * ``sent_at >= now-days`` — recent successful sends stay around
        long enough to correlate a cloud-side bug report with the Pi's
        original payload.

    The ``datetime('now', '-N days')`` expression is computed by SQLite
    in a single statement alongside the DELETE so no race can interleave
    between the bound read and the prune. Returns the number of rows
    removed; useful for the janitor log line.

    Pairs with :func:`trim_oldest_over` (cap-based) as belt-and-
    suspenders: age-based pruning is the primary mechanism; the cap is
    a last-resort bound if an operator sets ``days`` too high.
    """
    days_int = int(days)
    if days_int <= 0:
        # Guard: a zero/negative cutoff would delete every sent row in
        # one call, which is a valid admin action but must be explicit —
        # expose it only via an explicit caller path, not this helper.
        raise ValueError("days must be > 0")
    cutoff = f"-{days_int} days"
    with conn:
        cur = conn.execute(
            "DELETE FROM cloud_outbox "
            " WHERE sent_at IS NOT NULL "
            "   AND failed_permanently = 0 "
            "   AND datetime(sent_at) < datetime('now', ?)",
            (cutoff,),
        )
    return cur.rowcount or 0


def trim_oldest_over(
    conn: sqlite3.Connection, cap: int = 10_000
) -> int:
    """Delete the oldest ``already-sent`` rows above the cap.

    We only trim *sent* rows so an extended outage can't drop undelivered
    events silently. If the total (sent + pending) exceeds the cap we
    still only reap sent rows; a cap breach made entirely of pending
    rows is a symptom of a prolonged outage and should surface via the
    heartbeat's pending count, not via silent data loss here.

    Atomicity: the row-count read and the DELETE are expressed as a
    single SQL statement executed under one ``with conn:`` context so
    another writer can't interleave between counting and deleting.
    The earlier two-phase form (read total, then DELETE) let a
    concurrent ``enqueue_event`` slip in between the two and stale the
    ``over`` count — harmless in practice (we just under-trim by one)
    but a silent invariant violation.

    Returns the number of rows deleted.
    """
    with conn:
        cur = conn.execute(
            "DELETE FROM cloud_outbox "
            " WHERE outbox_id IN ("
            "   SELECT outbox_id FROM cloud_outbox "
            "    WHERE sent_at IS NOT NULL "
            "    ORDER BY outbox_id ASC "
            "    LIMIT MAX(0, (SELECT COUNT(*) FROM cloud_outbox) - ?)"
            " )",
            (cap,),
        )
    return cur.rowcount or 0
