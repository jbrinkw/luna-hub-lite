"""``BrightnessHandler`` no longer spawns the reconciler on close.

The reconciler spawn moved to ``ScaleHandler.process_session_events``
(which runs as a second close subscriber AFTER classification). Leaving
a spawn here would race ahead of classification and write "unknown"
resolutions. Guarded by a direct test so a regression can't sneak back.
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

from server.camera.daemon import BrightnessTransition  # noqa: E402
from server.handlers.brightness import BrightnessHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import AppStatePatch  # noqa: E402


class _SpyReconcilerRepo:
    """Captures every call so we can assert on what BrightnessHandler
    does (or doesn't) invoke."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name: str):
        def _record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return None
        return _record


def _spy_last_weight() -> float:
    return 0.0


def test_brightness_handler_on_close_does_not_spawn_reconciler():
    """Fire a close transition after opening a session; the
    BrightnessHandler must NOT invoke any reconciler callable.
    """
    conn = init_db(":memory:")
    repo_spy = _SpyReconcilerRepo()
    handler = BrightnessHandler(
        conn=conn,
        db_lock=threading.RLock(),
        reconciler_repo=repo_spy,  # type: ignore[arg-type]
        last_weight_provider=_spy_last_weight,
    )

    # Open a session first so the close path has something to close.
    handler(BrightnessTransition("open", "2026-04-15T12:00:00.000Z", 120.0))

    # Sanity: door_open=1 now.
    assert storage_repo.get_app_state(conn).door_open == 1

    handler(BrightnessTransition("close", "2026-04-15T12:00:05.000Z", 5.0))

    # No reconciler-like method should have been touched.
    reconcile_calls = [c for c in repo_spy.calls if "reconcile" in c[0].lower()]
    assert reconcile_calls == [], (
        f"BrightnessHandler must not call any reconciler method on close; "
        f"got {reconcile_calls}"
    )


def test_brightness_handler_on_open_creates_sessions_row():
    """The open path invokes storage_repo.open_session, setting
    current_session_id + door_open=1."""
    conn = init_db(":memory:")
    handler = BrightnessHandler(
        conn=conn,
        db_lock=threading.RLock(),
        reconciler_repo=_SpyReconcilerRepo(),  # type: ignore[arg-type]
        last_weight_provider=lambda: 300.0,
    )

    ts_open = "2026-04-15T12:00:00.000Z"
    handler(BrightnessTransition("open", ts_open, 120.0))

    state = storage_repo.get_app_state(conn)
    assert state.door_open == 1
    assert state.current_session_id is not None
    sess = storage_repo.get_session(conn, state.current_session_id)
    assert sess is not None
    assert sess.started_at == ts_open
    assert sess.initial_shelf_weight_g == pytest.approx(300.0)
