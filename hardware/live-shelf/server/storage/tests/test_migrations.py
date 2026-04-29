"""Tests for ``_apply_column_additions`` CHECK-constraint rebuild.

A long-lived on-disk DB may have been created before ``'classifying'``
was added to ``classifier_status``'s CHECK. The migration probes the
DDL, detects the missing value, rebuilds the table in place, and
preserves all rows + dependent-table FKs.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage.migrations import _apply_column_additions  # noqa: E402

# Finding 8-A (MOCK_AUDIT_PI_WEB_CLASSIFIER.md): load the "old" starting
# schema from a committed fixture file instead of an inline hand-built
# CREATE TABLE string.  This ensures migration tests always upgrade from the
# real historical schema shape — any drift between the fixture and the
# inline string would be caught at review time when the fixture is updated.
_FIXTURES_DIR = Path(__file__).parent / "fixtures"
_SCHEMA_V1_SQL = (_FIXTURES_DIR / "schema_v1.sql").read_text()


def _make_old_schema_conn() -> sqlite3.Connection:
    """Create a fresh in-memory DB from the committed v1 fixture schema.

    The v1 schema predates the '_apply_column_additions' migrations:
    no 'classifying' in scale_events.classifier_status CHECK, no
    in-flight columns on lots, no shelf_id columns, no device_id.
    Also seeds the FK-dependent tables so the rebuild path has to
    temporarily disable FKs.

    Finding 8-A fix: uses fixtures/schema_v1.sql instead of an inline
    hand-rolled schema string that can drift silently from production history.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(_SCHEMA_V1_SQL)
    return conn


def test_apply_column_additions_upgrades_old_check_constraint_preserving_rows():
    """End-to-end: seed the OLD schema with rows (some with FK-dependent
    rows in session_resolutions + review_queue), run
    _apply_column_additions, and assert:

      1. scale_events DDL now contains 'classifying'
      2. All original rows are preserved
      3. Indexes exist
      4. Inserting a new row with classifier_status='classifying' succeeds
      5. PRAGMA foreign_keys is back ON after the migration
    """
    conn = _make_old_schema_conn()

    # Seed data — including FK-referencing rows on dependents.
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at) "
        "VALUES (?, ?, ?)",
        ("S1", "2026-04-15T12:00:00Z", "2026-04-15T12:05:00Z"),
    )
    conn.execute(
        "INSERT INTO products (product_id, name) VALUES (?, ?)",
        ("P1", "ketchup"),
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, ?)",
        ("L1", "P1", "on_shelf"),
    )
    for i in range(3):
        conn.execute(
            """
            INSERT INTO scale_events
                (event_id, session_id, ts, delta_g,
                 before_weight_g, after_weight_g, direction, classifier_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (f"E{i}", "S1", f"2026-04-15T12:00:{i:02d}Z",
             -100.0, 1000.0 - i * 100, 900.0 - i * 100, "remove", "classified"),
        )
    conn.execute(
        "INSERT INTO session_resolutions "
        "(resolution_id, session_id, pattern, remove_event_id) "
        "VALUES (?, ?, ?, ?)",
        ("R1", "S1", "consumed_or_removed", "E0"),
    )
    conn.execute(
        "INSERT INTO review_queue (review_id, kind, event_id) "
        "VALUES (?, ?, ?)",
        ("RV1", "low_confidence", "E0"),
    )
    conn.commit()

    # Run the migration.
    _apply_column_additions(conn)

    # 1. DDL contains 'classifying'.
    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name='scale_events'"
    ).fetchone()[0]
    assert "'classifying'" in ddl, (
        f"expected 'classifying' in rebuilt DDL; got {ddl!r}"
    )

    # 2. All original rows preserved.
    rows = conn.execute(
        "SELECT event_id, classifier_status FROM scale_events ORDER BY event_id"
    ).fetchall()
    assert [r[0] for r in rows] == ["E0", "E1", "E2"]
    assert all(r[1] == "classified" for r in rows)

    # 3. Indexes recreated.
    idx_names = {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND tbl_name='scale_events'"
        )
    }
    assert "idx_scale_events_session" in idx_names
    assert "idx_scale_events_ts" in idx_names

    # 4. Inserting 'classifying' now works.
    conn.execute(
        """
        INSERT INTO scale_events
            (event_id, session_id, ts, delta_g,
             before_weight_g, after_weight_g, direction, classifier_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("E-new", "S1", "2026-04-15T12:00:10Z", -50.0, 500.0, 450.0,
         "remove", "classifying"),
    )
    conn.commit()
    new_row = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = 'E-new'"
    ).fetchone()
    assert new_row[0] == "classifying"

    # 5. Foreign keys back ON.
    fk_on = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    assert fk_on == 1

    # Dependent rows in session_resolutions / review_queue still resolve.
    r_ref = conn.execute(
        "SELECT remove_event_id FROM session_resolutions WHERE resolution_id = 'R1'"
    ).fetchone()[0]
    assert r_ref == "E0"
    rq_ref = conn.execute(
        "SELECT event_id FROM review_queue WHERE review_id = 'RV1'"
    ).fetchone()[0]
    assert rq_ref == "E0"


# ---------------------------------------------------------------------------
# Finding 8-A drift guard — fixture vs production schema contract
# ---------------------------------------------------------------------------


def test_schema_v1_fixture_tables_are_a_strict_subset_of_current_schema():
    """Drift guard: verify that every table in schema_v1.sql also exists in
    the current production schema (schema.sql).  If a table is renamed or
    dropped in production but the fixture is not updated, this test fails.

    The inverse direction (new tables in production that aren't in v1) is
    expected — migrations add columns/tables.  The guard only fires when
    the fixture references something that no longer exists in production.

    Finding 8-A (MOCK_AUDIT_PI_WEB_CLASSIFIER.md): ensures the committed
    fixture stays in sync with production history at review time.
    """
    from server.storage import init_db  # noqa: E402 — heavy import, isolated here

    # Build a fresh full-schema DB to collect the canonical table set.
    full_conn = init_db(":memory:")
    full_tables = {
        r[0] for r in full_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    full_conn.close()

    # Build the v1 fixture DB and collect its table set.
    v1_conn = _make_old_schema_conn()
    v1_tables = {
        r[0] for r in v1_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    v1_conn.close()

    # Every v1 table must still exist in the full schema.
    missing = v1_tables - full_tables
    assert not missing, (
        f"schema_v1.sql fixture references table(s) that no longer exist "
        f"in the current production schema: {missing!r}.  "
        f"Update fixtures/schema_v1.sql to match the real historical shape."
    )
