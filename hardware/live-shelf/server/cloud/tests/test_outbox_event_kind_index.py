"""Sync-audit finding #14: cloud_outbox event_kind expression index.

The migration in ``server.storage.migrations`` adds an expression index
on ``json_extract(payload_json, '$.event_kind')`` so triage queries that
filter by event_kind hit the index instead of full-scanning every
payload. This test asserts:

  1. The index exists on a freshly-migrated DB.
  2. ``EXPLAIN QUERY PLAN`` for a SELECT filtering by
     ``json_extract(...) = ?`` actually USES the new index (not a
     full-table SCAN).
  3. Idempotent re-application of migrations is a no-op.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.storage.migrations import (  # noqa: E402
    _apply_column_additions,
    apply_migrations,
)


def _fresh_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


def test_event_kind_index_exists_on_fresh_db():
    """Freshly-migrated DB carries the expression index."""
    conn = _fresh_db()
    row = conn.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type = 'index' AND name = 'idx_cloud_outbox_event_kind'"
    ).fetchone()
    assert row is not None, "idx_cloud_outbox_event_kind missing on fresh DB"
    sql = row["sql"] or ""
    assert "json_extract" in sql
    assert "$.event_kind" in sql


def test_explain_query_plan_uses_event_kind_index():
    """EXPLAIN QUERY PLAN for a json_extract filter must reference the
    new index — confirms the planner can actually use the expression
    index, not just that it exists."""
    conn = _fresh_db()
    # Seed a few outbox rows with different event_kinds so the planner
    # has something to consider; ANALYZE so stats reflect the data.
    payloads = [
        '{"event_kind":"consumed","client_event_id":"a"}',
        '{"event_kind":"refilled","client_event_id":"b"}',
        '{"event_kind":"discarded","client_event_id":"c"}',
        '{"event_kind":"consumed","client_event_id":"d"}',
    ]
    for i, p in enumerate(payloads):
        conn.execute(
            "INSERT INTO cloud_outbox (client_event_id, payload_json) "
            "VALUES (?, ?)",
            (str(i), p),
        )
    conn.execute("ANALYZE")

    plan_rows = conn.execute(
        "EXPLAIN QUERY PLAN SELECT outbox_id FROM cloud_outbox "
        "WHERE json_extract(payload_json, '$.event_kind') = ?",
        ("consumed",),
    ).fetchall()
    plan_text = " | ".join(str(r["detail"]) for r in plan_rows)
    # The planner's detail string for an indexed lookup contains the
    # index name. A SCAN-only plan would not.
    assert "idx_cloud_outbox_event_kind" in plan_text, (
        f"expected planner to use idx_cloud_outbox_event_kind; got: {plan_text!r}"
    )


def test_index_creation_idempotent():
    """Re-running the migration must not raise even though the index
    already exists (CREATE INDEX IF NOT EXISTS)."""
    conn = _fresh_db()
    # Second application should be a no-op.
    _apply_column_additions(conn)
    rows = conn.execute(
        "SELECT COUNT(*) AS c FROM sqlite_master "
        "WHERE type = 'index' AND name = 'idx_cloud_outbox_event_kind'"
    ).fetchone()
    assert rows["c"] == 1
