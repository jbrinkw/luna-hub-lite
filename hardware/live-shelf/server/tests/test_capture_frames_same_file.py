"""Regression tests for ``ScaleHandler._capture_frames`` same-file guard.

Bug history (2026-04-28):
    Commit 65722f3 wired the catch-all classifier dispatch into
    ``handle_scale_event`` so catch-all events get classified inline.
    The catch-all fast-path (``_capture_catch_all_frames``) writes
    ``before.jpg`` + ``after.jpg`` directly into the canonical event
    dir ``data/events/<event_id>/``, then persists those paths onto
    the ``scale_events`` row. ``_dispatch_classification`` →
    ``_classify_recorded_event`` then re-enters ``_capture_frames``
    with those persisted paths as ``src``. Because ``src == dst``,
    ``shutil.copyfile`` raised ``SameFileError`` (subclass of
    ``OSError``), the helper returned an error string, and the
    classifier never ran. The user's event 6baa809d-... hit this
    bug and ended up at ``classifier_status='failed'``.

    The fix (this file's pin) is a defensive same-file guard inside
    ``_capture_frames``: when ``Path(src).resolve() ==
    dst.resolve()``, treat as a no-op success rather than copying.
    The same guard also handles the sweeper-recovery path (which
    re-enters with paths read straight off the persisted row).

Mutation discipline:
    * Removing the same-file guard (i.e. unconditionally calling
      ``shutil.copyfile``) causes ``test_reentrant_copy_is_no_op``
      to fail with the SameFileError message. The error text is
      asserted explicitly so a partial revert that swallows the
      exception silently still flips the test.
    * Removing ``shutil.SameFileError`` from the except clause
      while keeping the guard would NOT flip these tests (the
      guard prevents the error from being raised). That's
      intentional — the guard is the load-bearing change.
"""

from __future__ import annotations

import shutil
import sqlite3
import sys
import threading
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn: sqlite3.Connection, events_root: Path) -> ScaleHandler:
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
    events_root.mkdir(parents=True, exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        catch_all_enabled=True,
        shelf_registry_override=registry,
    )


def _seed_event_dir_with_canonical_frames(
    handler: ScaleHandler, event_id: str
) -> tuple[Path, Path]:
    """Mirror the catch-all fast-path: write before.jpg + after.jpg
    directly into the canonical event dir under ``events_root``."""
    out_dir = handler._event_dir(event_id)
    before = out_dir / "before.jpg"
    after = out_dir / "after.jpg"
    before.write_bytes(b"\xff\xd8\xff\xd9-before")
    after.write_bytes(b"\xff\xd8\xff\xd9-after")
    return before, after


def test_reentrant_copy_is_no_op(tmp_path: Path):
    """Catch-all fast-path: src paths already point at the canonical
    destinations under the event dir. ``_capture_frames`` must succeed
    (not raise) and return the destination paths with err=None.

    Mutation guard: revert the same-file guard inside
    ``_capture_frames`` (e.g. unconditionally call
    ``shutil.copyfile``) — this assert flips because copyfile raises
    ``SameFileError`` and the helper returns an error tuple. The
    explicit message check below catches a partial revert that
    swallows the error type but still leaves the operation broken.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-same-file-001"
    before, after = _seed_event_dir_with_canonical_frames(handler, event_id)

    # Pass the canonical paths back in as src — exactly what
    # _classify_recorded_event does when re-entering this helper for
    # a catch-all event whose frames were inline-captured at ingress.
    before_final, after_final, err = handler._capture_frames(
        event_id, str(before), str(after),
    )

    assert err is None, (
        f"_capture_frames returned an error for the re-entrant "
        f"(src == dst) case: {err!r}. The same-file guard at "
        "scale_events.py:_capture_frames was reverted — "
        "shutil.copyfile is now raising SameFileError on the "
        "catch-all fast-path's canonical paths."
    )
    assert before_final is not None
    assert after_final is not None
    assert Path(before_final).resolve() == before.resolve()
    assert Path(after_final).resolve() == after.resolve()
    # Files are still on disk with their original contents (no truncation).
    assert before.read_bytes() == b"\xff\xd8\xff\xd9-before"
    assert after.read_bytes() == b"\xff\xd8\xff\xd9-after"


def test_reentrant_copy_with_resolved_path_via_symlink(tmp_path: Path):
    """Defense in depth: paths that ``resolve()`` to the same file but
    differ syntactically (e.g. via symlink or trailing-slash
    normalization) must also be treated as a no-op.

    The persisted ``before_frame_path`` / ``after_frame_path`` columns
    on ``scale_events`` are written via ``str(dst.resolve())`` — but
    if a future caller passed a symlink-equivalent path, the guard
    should still match.
    """
    if not hasattr(Path, "symlink_to"):
        pytest.skip("symlinks unsupported")
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-same-file-002"
    before, after = _seed_event_dir_with_canonical_frames(handler, event_id)

    # Build a parallel symlinked tree so src goes through a different
    # path string but resolves to the same inode.
    link_root = tmp_path / "events_link"
    try:
        link_root.symlink_to(handler._events_root)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this platform")

    sym_before = link_root / event_id / "before.jpg"
    sym_after = link_root / event_id / "after.jpg"

    before_final, after_final, err = handler._capture_frames(
        event_id, str(sym_before), str(sym_after),
    )

    assert err is None, (
        f"resolve-equality guard missed the symlink case: {err!r}"
    )
    assert before.read_bytes() == b"\xff\xd8\xff\xd9-before"
    assert after.read_bytes() == b"\xff\xd8\xff\xd9-after"


def test_distinct_src_paths_are_copied(tmp_path: Path):
    """Legacy live_shelf path: src lives in the session_capture
    staging dir (or the camera ring tmp dir), dst is the event dir.
    The copy MUST happen — this is what the function exists for.

    Mutation guard: replacing the body with an unconditional
    ``return None, None, None`` (skipping the copy entirely) flips
    this assert because the destination files would not exist.
    Replacing with an unconditional same-file return (i.e.
    accidentally treating every call as same-file) also flips
    this — the dst would be empty / nonexistent.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-distinct-001"

    # Source frames live OUTSIDE the event dir (mirrors the live_shelf
    # session_capture path: per-session staging files that are then
    # cloned into the event dir for archival).
    src_dir = tmp_path / "session_staging"
    src_dir.mkdir()
    before_src = src_dir / "session-before.jpg"
    after_src = src_dir / "session-after.jpg"
    before_src.write_bytes(b"\xff\xd8\xff\xd9-staging-before")
    after_src.write_bytes(b"\xff\xd8\xff\xd9-staging-after")

    before_final, after_final, err = handler._capture_frames(
        event_id, str(before_src), str(after_src),
    )

    assert err is None, f"unexpected copy error: {err!r}"
    assert before_final is not None and after_final is not None
    bf = Path(before_final)
    af = Path(after_final)
    # Destination files exist under the event dir, with the
    # source bytes copied over.
    assert bf.parent == handler._event_dir(event_id)
    assert af.parent == handler._event_dir(event_id)
    assert bf.read_bytes() == b"\xff\xd8\xff\xd9-staging-before"
    assert af.read_bytes() == b"\xff\xd8\xff\xd9-staging-after"


def test_missing_after_src_is_fatal(tmp_path: Path):
    """Existing contract: a ``None`` after_src returns an error tuple
    (no after frame = classifier can't run). This test pins the
    pre-fix behavior so the same-file guard refactor doesn't change
    the missing-frame contract.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-missing-after"

    before_final, after_final, err = handler._capture_frames(
        event_id, "/some/before.jpg", None,
    )
    assert before_final is None
    assert after_final is None
    assert err is not None and "no after frame" in err


def test_missing_before_src_is_non_fatal(tmp_path: Path):
    """Existing contract: a ``None`` before_src returns the after
    path with an explanatory err string but does NOT block the
    classifier from running (after_final is populated).
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-missing-before"

    src_dir = tmp_path / "staging"
    src_dir.mkdir()
    after_src = src_dir / "after.jpg"
    after_src.write_bytes(b"\xff\xd8\xff\xd9-after")

    before_final, after_final, err = handler._capture_frames(
        event_id, None, str(after_src),
    )
    assert before_final is None
    assert after_final is not None
    assert err is not None and "no before frame" in err
    assert Path(after_final).read_bytes() == b"\xff\xd8\xff\xd9-after"


def test_genuine_copy_error_still_returns_error(tmp_path: Path):
    """If the source path doesn't exist, ``shutil.copyfile`` raises
    ``FileNotFoundError`` (subclass of ``OSError``) — the helper
    must return an error tuple, not silently succeed. The
    same-file guard must NOT short-circuit this case.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path / "events")
    event_id = "evt-genuine-error"

    before_final, after_final, err = handler._capture_frames(
        event_id,
        "/nonexistent/before.jpg",
        "/nonexistent/after.jpg",
    )
    assert err is not None
    assert "after copy failed" in err
    assert before_final is None
    assert after_final is None
