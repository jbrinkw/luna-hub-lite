"""Regression: frame picker must anchor to Pi-clock ts, not ESP ts.

Root-cause investigation on 2026-04-16 showed that the ESP firmware fills
the sub-second portion of every event timestamp with ``millis() % 1000``
— only the integer seconds come from NTP. Camera frames are all stamped
from the Pi's NTP-synced clock, so cross-referencing events into frame
timestamps using ``scale_events.ts`` fuzzes anchors by up to ±500ms.

The fix captures ``pi_received_ts`` at HTTP handler entry and stores it
on the row. Classification reads the new column (falling back to ``ts``
for rows pre-migration) and passes it to ``pick_event_frames`` + the
prior-event lookup.

These tests cover:
    * migration adds ``pi_received_ts`` column idempotently
    * ``record_scale_event`` persists the new field when set
    * ``record_scale_event`` leaves it NULL when not set (legacy path)
    * ``_find_prior_event_pi_ts_in_session`` returns ``pi_received_ts``
      when available, falls back to ``ts`` for NULL rows
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Storage layer
# ---------------------------------------------------------------------------


def test_migration_adds_pi_received_ts_column_idempotently(tmp_path: Path):
    """Fresh DB must expose ``pi_received_ts`` on ``scale_events``, and
    re-running migrations must be a no-op (the ADD COLUMN probe skips
    when the column already exists)."""
    db_path = tmp_path / "shelf.sqlite3"
    conn = init_db(str(db_path))
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scale_events)")}
    assert "pi_received_ts" in cols, (
        "pi_received_ts column missing from fresh DB — migration regression"
    )
    conn.close()

    # Re-open: apply_column_additions runs again. Must be idempotent (no
    # ALTER TABLE fires a second time).
    conn = init_db(str(db_path))
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scale_events)")}
    assert "pi_received_ts" in cols  # still there, still singular


def test_record_scale_event_persists_pi_received_ts_when_provided():
    conn = init_db(":memory:")
    storage_repo.open_session(conn, ts="2026-04-16T12:00:00.000Z",
                              initial_weight_g=500.0)
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:05.123Z",              # ESP ts
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            classifier_status="pending",
            pi_received_ts="2026-04-16T12:00:05.456Z",  # Pi wall-clock
        ),
    )
    row = conn.execute(
        "SELECT ts, pi_received_ts FROM scale_events WHERE event_id=?",
        (ev.event_id,),
    ).fetchone()
    assert row[0] == "2026-04-16T12:00:05.123Z"     # ESP ts preserved
    assert row[1] == "2026-04-16T12:00:05.456Z"     # Pi ts stored


def test_record_scale_event_leaves_pi_received_ts_null_when_omitted():
    """Legacy test paths + internal helpers that don't come through the
    HTTP ingress don't need to supply the new field. Row must still
    insert cleanly with NULL so the picker's COALESCE fallback to
    ``ts`` keeps working."""
    conn = init_db(":memory:")
    storage_repo.open_session(conn, ts="2026-04-16T12:00:00.000Z",
                              initial_weight_g=500.0)
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:05.123Z",
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            classifier_status="pending",
            # pi_received_ts intentionally omitted
        ),
    )
    row = conn.execute(
        "SELECT pi_received_ts FROM scale_events WHERE event_id=?",
        (ev.event_id,),
    ).fetchone()
    assert row[0] is None


# ---------------------------------------------------------------------------
# Handler layer — _find_prior_event_pi_ts_in_session
# ---------------------------------------------------------------------------


def _make_minimal_handler(
    conn: sqlite3.Connection, tmp_path: Path
) -> ScaleHandler:
    """Bare ScaleHandler for testing storage-layer queries. No classifier,
    no camera — just enough wiring for ``_find_prior_event_pi_ts_in_session``.
    """
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)

    class _NullCandidateSource:
        def get_on_shelf_lots(self): return []
        def get_recently_out_lots(self, window_seconds): return []
        def get_certified_not_on_shelf(self): return []

    class _NullClient:
        def send(self, *args: Any, **kwargs: Any): raise AssertionError(
            "classifier must not be called in this test"
        )

    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=_NullClient(),
    )


def test_find_prior_event_returns_pi_received_ts_not_esp_ts(tmp_path: Path):
    """The most important invariant: when a row has ``pi_received_ts``
    set, the function must return THAT, not the ESP ``ts``. Before the
    fix, this function returned ``row[0]`` from ``SELECT ts`` — which
    is the ESP ts with random sub-seconds. The picker then used it as
    an anchor into the Pi-timestamped frame list, introducing a clock-
    domain mismatch that could land anchors ±500ms off.
    """
    conn = init_db(":memory:")
    sess = storage_repo.open_session(
        conn, ts="2026-04-16T12:00:00.000Z", initial_weight_g=500.0,
    )
    storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:05.123Z",              # ESP ts (.123)
            pi_received_ts="2026-04-16T12:00:05.456Z",  # Pi ts (.456)
            delta_g=-100.0,
            before_weight_g=500.0, after_weight_g=400.0,
            direction="remove", classifier_status="pending",
            session_id=sess.session_id,
        ),
    )
    handler = _make_minimal_handler(conn, tmp_path)

    # Query for the event's prior — seed a later event to anchor the
    # search window.
    result = handler._find_prior_event_pi_ts_in_session(
        sess.session_id, current_event_ts="2026-04-16T12:00:10.000Z",
    )
    assert result == "2026-04-16T12:00:05.456Z", (
        f"Expected Pi ts (.456), got {result!r}. If this is the ESP ts "
        "(.123), the lookup regressed to the pre-fix behavior — the "
        "picker will again fuzz frame anchors by up to ±500ms."
    )


def test_find_prior_event_falls_back_to_ts_for_legacy_null_rows(tmp_path: Path):
    """Rows written before the migration (or via test paths that don't
    provide pi_received_ts) have NULL in the new column. The COALESCE
    in the SELECT must degrade gracefully back to the ESP ``ts``.
    """
    conn = init_db(":memory:")
    sess = storage_repo.open_session(
        conn, ts="2026-04-16T12:00:00.000Z", initial_weight_g=500.0,
    )
    storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:05.123Z",
            # pi_received_ts omitted — simulates a legacy row
            delta_g=-100.0,
            before_weight_g=500.0, after_weight_g=400.0,
            direction="remove", classifier_status="pending",
            session_id=sess.session_id,
        ),
    )
    handler = _make_minimal_handler(conn, tmp_path)

    result = handler._find_prior_event_pi_ts_in_session(
        sess.session_id, current_event_ts="2026-04-16T12:00:10.000Z",
    )
    assert result == "2026-04-16T12:00:05.123Z", (
        f"Legacy fallback failed: expected ESP ts for NULL pi_received_ts, "
        f"got {result!r}. COALESCE(pi_received_ts, ts) must return ts when "
        "the new column is NULL."
    )


def test_find_prior_event_ignores_noise_events(tmp_path: Path):
    """Existing invariant — not about the fix specifically, but guards
    against a regression where switching the SELECT expression breaks
    the direction != 'noise' filter."""
    conn = init_db(":memory:")
    sess = storage_repo.open_session(
        conn, ts="2026-04-16T12:00:00.000Z", initial_weight_g=500.0,
    )
    # Newer noise event should be IGNORED
    storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:08.000Z",
            pi_received_ts="2026-04-16T12:00:08.100Z",
            delta_g=2.0, before_weight_g=400.0, after_weight_g=402.0,
            direction="noise", classifier_status=None,
            session_id=sess.session_id,
        ),
    )
    # Older real event should be RETURNED
    storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T12:00:05.000Z",
            pi_received_ts="2026-04-16T12:00:05.300Z",
            delta_g=-100.0, before_weight_g=500.0, after_weight_g=400.0,
            direction="remove", classifier_status="pending",
            session_id=sess.session_id,
        ),
    )
    handler = _make_minimal_handler(conn, tmp_path)
    result = handler._find_prior_event_pi_ts_in_session(
        sess.session_id, current_event_ts="2026-04-16T12:00:10.000Z",
    )
    assert result == "2026-04-16T12:00:05.300Z"  # real event's pi_ts
