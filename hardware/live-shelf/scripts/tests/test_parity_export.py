"""Pytest for parity_export.py.

Tests run against in-memory SQLite (Pi DB) + a stub cloud connection.
No network calls, no real Supabase.

Per Change D spec:
  - run_export() reads Pi SQLite, diffs against cloud, returns report dict
  - report contains pi_db_sha256, generated_at, deltas_total, deltas_by_table
  - stub Storage POST verifies _storage_put() is callable (smoke only)
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]
_HARNESS_PATH = _REPO_ROOT / "scripts" / "harness"
if str(_HARNESS_PATH) not in sys.path:
    sys.path.insert(0, str(_HARNESS_PATH))

_SCRIPTS_PATH = _REPO_ROOT / "hardware" / "live-shelf" / "scripts"
if str(_SCRIPTS_PATH) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_PATH))

from parity_core import TABLE_PAIRS  # noqa: E402
from parity_export import _storage_put, run_export  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_pi_db(tmp_path: Path, *, add_product: bool = False) -> Path:
    import sqlite3
    db_path = tmp_path / "shelf.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE products (
            product_id TEXT PRIMARY KEY,
            name TEXT, brand TEXT,
            net_weight_g REAL,
            servings_per_container REAL,
            calories_per_serving REAL,
            certified INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE lots (
            lot_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            current_weight_g REAL,
            status TEXT
        );
        CREATE TABLE scale_pairings (
            device_id TEXT PRIMARY KEY, shelf_id TEXT, product_id TEXT, lot_id TEXT
        );
        CREATE TABLE usage_log (
            usage_id TEXT PRIMARY KEY, product_id TEXT, consumed_g REAL, kind TEXT
        );
        CREATE TABLE review_queue (
            review_id TEXT PRIMARY KEY, kind TEXT, status TEXT
        );
        CREATE TABLE cloud_lots (
            lot_id TEXT PRIMARY KEY, product_id TEXT NOT NULL
        );
    """)
    if add_product:
        conn.execute(
            "INSERT INTO products(product_id, name, net_weight_g, certified) "
            "VALUES ('pid-1', 'Test Product', 500.0, 1)"
        )
        conn.execute(
            "INSERT INTO lots(lot_id, product_id, current_weight_g, status) "
            "VALUES ('lot-pi-1', 'pid-1', 250.0, 'on_shelf')"
        )
    conn.commit()
    conn.close()
    return db_path


class _StubCloudConn:
    """Stub cloud connection returning empty tables (no cloud drift)."""

    def __init__(self, rows: dict[str, list[dict]] | None = None) -> None:
        self._rows = rows or {}

    def cursor(self):
        return _StubCursor(self)

    def fetch_table(self, table: str) -> list[dict]:
        return self._rows.get(table, [])


class _StubCursor:
    def __init__(self, conn: _StubCloudConn) -> None:
        self._conn = conn
        self._rows: list[dict] = []
        self.description: list = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql: str) -> None:
        parts = sql.strip().split()
        table = parts[-1] if parts else ""
        rows = self._conn.fetch_table(table)
        self._rows = rows
        self.description = [type("Col", (), {"name": k})() for k in rows[0]] if rows else []

    def fetchall(self) -> list[tuple]:
        keys = [d.name for d in self.description]
        return [tuple(r.get(k) for k in keys) for r in self._rows]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_report_has_required_keys(tmp_path):
    db_path = _make_pi_db(tmp_path)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    for key in ("pi_db_sha256", "generated_at", "deltas_total", "deltas_by_table", "findings"):
        assert key in report, f"missing key: {key}"


def test_pi_db_sha256_is_64_char_hex(tmp_path):
    db_path = _make_pi_db(tmp_path)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    sha = report["pi_db_sha256"]
    assert len(sha) == 64
    int(sha, 16)  # raises if not valid hex


def test_zero_deltas_when_empty_on_both_sides(tmp_path):
    db_path = _make_pi_db(tmp_path)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    assert report["deltas_total"] == 0
    assert report["findings"] == []


def test_pi_only_lot_detected_as_drift(tmp_path):
    """Pi has a lot that cloud doesn't -> delta reported."""
    db_path = _make_pi_db(tmp_path, add_product=True)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    assert report["deltas_total"] > 0
    assert report["deltas_by_table"]["stock_lots"] > 0


def test_deltas_by_table_covers_all_pairs(tmp_path):
    db_path = _make_pi_db(tmp_path)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    for pair in TABLE_PAIRS:
        assert pair.name in report["deltas_by_table"]
    assert "catch_all_namespace" in report["deltas_by_table"]


def test_generated_at_is_timezone_aware_iso8601(tmp_path):
    db_path = _make_pi_db(tmp_path)
    report = run_export(
        supabase_url="https://stub.supabase.co",
        service_role_key="stub-key",
        user_id="user-1",
        db_path=db_path,
        cloud_conn=_StubCloudConn(),
    )
    dt = datetime.fromisoformat(report["generated_at"])
    assert dt.tzinfo is not None


def test_storage_put_posts_to_correct_path():
    """_storage_put hits <user_id>/latest.json with x-upsert=true."""

    class _FakeResp:
        def read(self):
            return b""
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass

    calls: list[dict] = []

    def _fake_urlopen(req, timeout=None):
        calls.append({"url": req.full_url, "headers": dict(req.headers), "method": req.method})
        return _FakeResp()

    import urllib.request
    with patch.object(urllib.request, "urlopen", _fake_urlopen):
        _storage_put("https://stub.supabase.co", "svc-key", "user-abc", b'{}')

    assert len(calls) == 1
    assert "user-abc" in calls[0]["url"]
    assert "latest.json" in calls[0]["url"]
    assert calls[0]["method"] == "POST"
    assert calls[0]["headers"].get("X-upsert") == "true"
