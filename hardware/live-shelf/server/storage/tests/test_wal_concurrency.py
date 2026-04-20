"""WAL-mode + concurrent-writer regression tests.

Deep-audit finding #1: without WAL + a busy-timeout, concurrent writes
from Flask request threads + the cloud worker thread can race and
raise ``OperationalError: database is locked``. The cloud emitter's
``except Exception`` swallows that and silently drops the outbox row.

We verify:
  1. ``init_db`` turns on WAL mode on an on-disk connection + sets the
     busy timeout.
  2. Multiple threads can hammer the same connection with short writes
     without raising ``database is locked``.

The test uses an on-disk DB (tmp_path) because SQLite rejects WAL on
``:memory:`` — the whole point of the fix is the on-disk production
behaviour.
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

from server.storage import init_db  # noqa: E402


def test_init_db_enables_wal_mode_on_disk(tmp_path: Path) -> None:
    """On an on-disk DB, ``init_db`` must leave the connection in WAL
    journal mode + a non-zero busy_timeout — the two pragmas that
    close the race surfaced by finding #1."""
    db_path = tmp_path / "shelf.db"
    conn = init_db(str(db_path))
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    finally:
        conn.close()
    assert str(mode).lower() == "wal"
    # busy_timeout is in milliseconds — we set 5000.
    assert int(timeout) == 5000


def test_init_db_survives_concurrent_connection_writes(
    tmp_path: Path,
) -> None:
    """Multiple ``sqlite3.Connection`` instances pointed at the same
    WAL-enabled DB must be able to write concurrently without raising
    ``OperationalError: database is locked``.

    Context: the Pi uses a single shared connection guarded by a
    process-wide :class:`threading.RLock`, so in the steady state
    Python-layer serialisation handles contention. But any subsystem
    that opens its own secondary connection (the background cloud
    worker's ``conn_factory`` in particular can hand out a distinct
    connection, and future code may do the same) will contend at the
    SQLite engine level. Without WAL + a busy_timeout, the default
    ``journal_mode=delete`` serialises writers at the *file* level and
    a zero ``busy_timeout`` makes the second writer raise
    ``database is locked`` immediately — which the cloud emitter's
    ``except Exception`` swallows and drops the row.

    This test pre-creates the schema with ``init_db`` (which enables
    WAL), then spins up N threads each holding their OWN connection,
    and asserts they can all INSERT in parallel without a single
    ``database is locked`` exception.
    """
    db_path = tmp_path / "shelf.db"
    # First init_db call on the path bootstraps schema + enables WAL.
    conn0 = init_db(str(db_path))
    conn0.close()

    n_threads = 6
    writes_per_thread = 30
    errors: list[Exception] = []
    start_barrier = threading.Barrier(n_threads)

    def worker(worker_id: int) -> None:
        # Each thread gets its OWN connection into the same DB file —
        # this is where WAL's magic lives. Without WAL this is exactly
        # the scenario that triggers ``database is locked``.
        local_conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            # Inherit WAL + busy_timeout from the db-level pragmas
            # (WAL is DB-level; busy_timeout is connection-level, so we
            # set it explicitly — mirrors what a future subsystem that
            # opens its own connection would need to do).
            local_conn.execute("PRAGMA busy_timeout=5000")
            start_barrier.wait()
            for i in range(writes_per_thread):
                with local_conn:
                    local_conn.execute(
                        "INSERT INTO cloud_outbox "
                        "(client_event_id, payload_json) VALUES (?, ?)",
                        (
                            f"evt-{worker_id}-{i}",
                            '{"w":%d,"i":%d}' % (worker_id, i),
                        ),
                    )
        except Exception as exc:  # noqa: BLE001 - capture for the assert
            errors.append(exc)
        finally:
            local_conn.close()

    threads = [
        threading.Thread(target=worker, args=(wid,), name=f"writer-{wid}")
        for wid in range(n_threads)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30.0)
    assert all(not t.is_alive() for t in threads), (
        "writers hung — likely database-lock deadlock"
    )
    assert not errors, (
        f"concurrent writes raised {len(errors)} error(s); "
        f"first: {errors[0]!r}"
    )

    # Every row landed (correctness check, not just "no exception").
    verify_conn = sqlite3.connect(str(db_path))
    try:
        row = verify_conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()
    finally:
        verify_conn.close()
    assert int(row[0]) == n_threads * writes_per_thread


def test_init_db_memory_dbs_still_work(tmp_path: Path) -> None:
    """``:memory:`` DBs can't use WAL (SQLite limitation) — they fall
    back to ``memory`` journal mode. ``init_db`` must still return a
    usable connection rather than raise."""
    conn = init_db(":memory:")
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        conn.close()
    # :memory: ignores our WAL request and falls back.
    assert str(mode).lower() in {"memory", "wal"}
