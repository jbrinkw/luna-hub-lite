"""Unit tests for :class:`WeightHandler` (CATCH_ALL_SCALE_PLAN.md §5.1).

The handler ingests catch-all scale heartbeats and decides session
open/close. Tests exercise:

* rising above threshold opens a catch_all session + stamps app_state
* sustained sub-threshold readings close it + fire reconciler_fn
* single-sample dip is absorbed by hysteresis (stable_zero_samples>=2)
* both shelves' session pointers are independent (current_session_id
  vs current_catch_all_session_id)
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.weight import WeightHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402


@pytest.fixture()
def conn() -> sqlite3.Connection:
    return init_db(":memory:")


@pytest.fixture()
def db_lock() -> threading.RLock:
    return threading.RLock()


def _catch_all_session_id(c: sqlite3.Connection) -> str | None:
    row = c.execute(
        "SELECT current_catch_all_session_id FROM app_state WHERE id = 1"
    ).fetchone()
    return row[0] if row else None


def _handler(
    conn: sqlite3.Connection,
    db_lock: threading.RLock,
    *,
    threshold: float = 5.0,
    stable_zero_samples: int = 3,
    reconciler_fn=None,
) -> WeightHandler:
    return WeightHandler(
        conn=conn,
        db_lock=db_lock,
        shelf_id="catch_all",
        onscale_threshold_g=threshold,
        stable_zero_samples=stable_zero_samples,
        reconciler_fn=reconciler_fn,
    )


# ------------------------------------------------------------- open path


def test_weight_handler_opens_session_above_threshold(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """Weight 0 → 10 g with threshold=5 g must open a catch_all session
    and stamp app_state.current_catch_all_session_id.
    """
    h = _handler(conn, db_lock, threshold=5.0)

    # Sub-threshold tick first — must not open.
    h.on_heartbeat(0.5, "2026-04-18T12:00:00.000Z", "scale-02")
    assert _catch_all_session_id(conn) is None

    # Rising above threshold must open.
    h.on_heartbeat(10.0, "2026-04-18T12:00:01.000Z", "scale-02")
    sid = _catch_all_session_id(conn)
    assert sid is not None

    # The session row must be stamped with shelf_id='catch_all'.
    sess_row = conn.execute(
        "SELECT session_id, shelf_id, started_at, initial_shelf_weight_g, "
        "ended_at FROM sessions WHERE session_id = ?",
        (sid,),
    ).fetchone()
    assert sess_row is not None
    assert sess_row[1] == "catch_all"
    assert sess_row[2] == "2026-04-18T12:00:01.000Z"
    assert float(sess_row[3]) == pytest.approx(10.0)
    assert sess_row[4] is None  # still open

    # Live-shelf pointer + door_open must NOT be touched.
    st = storage_repo.get_app_state(conn)
    assert st.current_session_id is None
    assert st.door_open == 0


def test_weight_handler_open_is_idempotent_under_repeated_above_samples(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """Multiple above-threshold ticks must keep the SAME session open
    (not open a new one each tick)."""
    h = _handler(conn, db_lock, threshold=5.0)
    h.on_heartbeat(10.0, "2026-04-18T12:00:00.000Z", "scale-02")
    sid1 = _catch_all_session_id(conn)
    h.on_heartbeat(12.0, "2026-04-18T12:00:00.500Z", "scale-02")
    h.on_heartbeat(15.0, "2026-04-18T12:00:01.000Z", "scale-02")
    sid2 = _catch_all_session_id(conn)
    assert sid1 is not None and sid2 == sid1


# ------------------------------------------------------------- close path


def test_weight_handler_closes_session_when_weight_returns_to_zero(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """10 g → 0 g for 3 consecutive ticks must close the session and
    invoke reconciler_fn with the session_id.
    """
    recon_calls: list[str] = []

    def _recon(session_id: str) -> None:
        recon_calls.append(session_id)

    h = _handler(
        conn, db_lock,
        threshold=5.0, stable_zero_samples=3,
        reconciler_fn=_recon,
    )

    h.on_heartbeat(12.0, "2026-04-18T12:00:00.000Z", "scale-02")
    sid = _catch_all_session_id(conn)
    assert sid is not None

    # Two sub-threshold ticks — not yet enough.
    h.on_heartbeat(0.0, "2026-04-18T12:00:00.500Z", "scale-02")
    h.on_heartbeat(0.1, "2026-04-18T12:00:01.000Z", "scale-02")
    assert _catch_all_session_id(conn) == sid
    assert recon_calls == []

    # Third consecutive sub-threshold — session closes.
    h.on_heartbeat(0.0, "2026-04-18T12:00:01.500Z", "scale-02")
    assert _catch_all_session_id(conn) is None
    assert recon_calls == [sid]

    # Session row must have ended_at + final_shelf_weight_g stamped.
    ended_at, final_w = conn.execute(
        "SELECT ended_at, final_shelf_weight_g FROM sessions "
        "WHERE session_id = ?", (sid,),
    ).fetchone()
    assert ended_at == "2026-04-18T12:00:01.500Z"
    assert float(final_w) == pytest.approx(0.0)


def test_weight_handler_hysteresis_survives_single_sample_drop(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """10 g → brief 3 g dip → 10 g must keep the session OPEN.

    Single sub-threshold sample must not close; counter resets on the
    next above-threshold sample.
    """
    h = _handler(conn, db_lock, threshold=5.0, stable_zero_samples=3)

    h.on_heartbeat(10.0, "2026-04-18T12:00:00.000Z", "scale-02")
    sid = _catch_all_session_id(conn)
    assert sid is not None

    # Single sub-threshold blip — counter becomes 1.
    h.on_heartbeat(3.0, "2026-04-18T12:00:00.500Z", "scale-02")
    assert _catch_all_session_id(conn) == sid
    assert h.below_threshold_samples() == 1

    # Back above threshold — counter resets.
    h.on_heartbeat(10.0, "2026-04-18T12:00:01.000Z", "scale-02")
    assert _catch_all_session_id(conn) == sid
    assert h.below_threshold_samples() == 0

    # Two more blips — still not three in a row → session stays open.
    h.on_heartbeat(0.0, "2026-04-18T12:00:01.500Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:02.000Z", "scale-02")
    assert _catch_all_session_id(conn) == sid


# ------------------------------------------------------------- reconciler


def test_weight_handler_close_without_reconciler_fn_does_not_crash(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """``reconciler_fn=None`` must be a no-op on close, not a NoneType
    call error."""
    h = _handler(conn, db_lock, threshold=5.0, stable_zero_samples=2,
                 reconciler_fn=None)
    h.on_heartbeat(10.0, "2026-04-18T12:00:00.000Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:00.500Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:01.000Z", "scale-02")
    assert _catch_all_session_id(conn) is None


def test_weight_handler_reconciler_exception_does_not_leak(
    conn: sqlite3.Connection, db_lock: threading.RLock, caplog,
):
    """A raising reconciler_fn must be caught — close must still land."""
    def _boom(session_id: str) -> None:
        raise RuntimeError("reconciler on fire")

    h = _handler(conn, db_lock, threshold=5.0, stable_zero_samples=2,
                 reconciler_fn=_boom)
    h.on_heartbeat(10.0, "2026-04-18T12:00:00.000Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:00.500Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:01.000Z", "scale-02")
    assert _catch_all_session_id(conn) is None


# ------------------------------------------------------------- validation


def test_weight_handler_rejects_invalid_shelf_id():
    with pytest.raises(ValueError):
        WeightHandler(
            conn=init_db(":memory:"),
            db_lock=threading.RLock(),
            shelf_id="unknown_shelf",  # type: ignore[arg-type]
            onscale_threshold_g=5.0,
        )


def test_weight_handler_rejects_non_positive_threshold():
    with pytest.raises(ValueError):
        WeightHandler(
            conn=init_db(":memory:"),
            db_lock=threading.RLock(),
            onscale_threshold_g=0.0,
        )


def test_weight_handler_rejects_below_one_stable_samples():
    with pytest.raises(ValueError):
        WeightHandler(
            conn=init_db(":memory:"),
            db_lock=threading.RLock(),
            onscale_threshold_g=5.0,
            stable_zero_samples=0,
        )


def test_weight_handler_ignores_non_numeric_weight(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    h = _handler(conn, db_lock, threshold=5.0)
    h.on_heartbeat("not-a-number", "2026-04-18T12:00:00.000Z", "scale-02")  # type: ignore[arg-type]
    assert _catch_all_session_id(conn) is None


def test_weight_handler_ignores_empty_ts(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    h = _handler(conn, db_lock, threshold=5.0)
    h.on_heartbeat(10.0, "", "scale-02")
    assert _catch_all_session_id(conn) is None


# ------------------------------------------------------------- independence


def test_weight_handler_does_not_disturb_live_shelf_session_pointer(
    conn: sqlite3.Connection, db_lock: threading.RLock,
):
    """Pre-seed a live_shelf session, then open+close a catch_all one.
    The live_shelf pointer must survive unchanged.
    """
    # Seed a live_shelf session.
    live = storage_repo.open_session(
        conn, "2026-04-18T11:00:00.000Z", 500.0, shelf_id="live_shelf",
    )
    assert storage_repo.get_app_state(conn).current_session_id == live.session_id
    assert storage_repo.get_app_state(conn).door_open == 1

    h = _handler(conn, db_lock, threshold=5.0, stable_zero_samples=2)
    h.on_heartbeat(10.0, "2026-04-18T12:00:00.000Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:00.500Z", "scale-02")
    h.on_heartbeat(0.0, "2026-04-18T12:00:01.000Z", "scale-02")

    st = storage_repo.get_app_state(conn)
    assert st.current_session_id == live.session_id  # untouched
    assert st.door_open == 1                         # untouched
    # AppState dataclass doesn't yet expose current_catch_all_session_id —
    # read the raw column (the classifier agent will add the field).
    assert _catch_all_session_id(conn) is None       # catch-all closed
