#!/usr/bin/env python3
"""Daily parity export: Pi SQLite -> Supabase Storage.

Reads the live Pi SQLite database, queries cloud REST for each TABLE_PAIR,
runs diff_pair, writes parity-report.json to parity-reports/<user_id>/latest.json.

Environment variables::

    CLOUD_SUPABASE_URL        Supabase project base URL
    CLOUD_SERVICE_ROLE_KEY    service_role JWT
    SUPABASE_USER_ID          UUID of the Hub user who owns the Pi device
    LIVE_SHELF_DB             Path to Pi SQLite (optional override)

No ed25519 signing -- Codex audit (SOLUTION_AUDIT.md Section 2) identified
that as theater. The report is valuable because it exists, is recent, and
shows the drift count.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Locate parity_core: in-repo (dev) or co-located copy (Pi deploy).
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parents[2]
_HARNESS_PATH = _REPO_ROOT / "scripts" / "harness"
_CORE_PATH = str(_HARNESS_PATH) if (_HARNESS_PATH / "parity_core.py").exists() else str(_SCRIPT_DIR)
if _CORE_PATH not in sys.path:
    sys.path.insert(0, _CORE_PATH)

from parity_core import (  # noqa: E402
    TABLE_PAIRS,
    FieldDelta,
    assert_catch_all_namespace_invariant,
    diff_pair,
    _net_weight_lookup,
)

_DEFAULT_PI_DB = "/var/lib/live-shelf/live_shelf.db"
_FALLBACK_PI_DB = str(_SCRIPT_DIR.parent / "data" / "shelf.sqlite3")


def _resolve_db_path() -> Path:
    env = os.environ.get("LIVE_SHELF_DB", "")
    if env:
        return Path(env)
    if Path(_DEFAULT_PI_DB).exists():
        return Path(_DEFAULT_PI_DB)
    return Path(_FALLBACK_PI_DB)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _cloud_get(url: str, key: str, table: str) -> list[dict]:
    schema, tbl = table.split(".", 1) if "." in table else ("public", table)
    endpoint = f"{url}/rest/v1/{tbl}?select=*"
    req = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept-Profile": schema,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


class _CloudRestConn:
    """Adapter so _read_cloud_rows works without modification."""

    def __init__(self, supabase_url: str, service_role_key: str) -> None:
        self._url = supabase_url.rstrip("/")
        self._key = service_role_key
        self._cache: dict[str, list[dict]] = {}

    def fetch_table(self, table: str) -> list[dict]:
        if table not in self._cache:
            self._cache[table] = _cloud_get(self._url, self._key, table)
        return self._cache[table]

    def cursor(self):
        return _FakeCursor(self)


class _FakeCursor:
    def __init__(self, conn: _CloudRestConn) -> None:
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


def _storage_put(supabase_url: str, service_role_key: str, user_id: str, body: bytes) -> None:
    url = supabase_url.rstrip("/")
    path = f"parity-reports/{user_id}/latest.json"
    endpoint = f"{url}/storage/v1/object/{path}"
    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
            "x-upsert": "true",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def run_export(
    *,
    supabase_url: str,
    service_role_key: str,
    user_id: str,
    db_path: Path,
    cloud_conn: Any = None,
) -> dict[str, Any]:
    """Run parity diff and return report dict (does NOT upload).
    cloud_conn is injectable for tests (default: _CloudRestConn)."""
    pi_conn = sqlite3.connect(str(db_path))
    pi_conn.row_factory = sqlite3.Row
    if cloud_conn is None:
        cloud_conn = _CloudRestConn(supabase_url, service_role_key)

    nw = _net_weight_lookup(pi_conn)
    deltas: list[FieldDelta] = []
    deltas_by_table: dict[str, int] = {}
    for pair in TABLE_PAIRS:
        pair_deltas = diff_pair(pair, pi_conn, cloud_conn, net_weight_by_pid=nw)
        deltas_by_table[pair.name] = len(pair_deltas)
        deltas.extend(pair_deltas)
    ns_deltas = assert_catch_all_namespace_invariant(pi_conn, cloud_conn)
    deltas_by_table["catch_all_namespace"] = len(ns_deltas)
    deltas.extend(ns_deltas)

    return {
        "pi_db_sha256": _sha256_file(db_path),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "deltas_total": len(deltas),
        "deltas_by_table": deltas_by_table,
        "findings": [d.as_dict() for d in deltas],
    }


def main() -> int:
    supabase_url = os.environ.get("CLOUD_SUPABASE_URL", "")
    service_role_key = os.environ.get("CLOUD_SERVICE_ROLE_KEY", "")
    user_id = os.environ.get("SUPABASE_USER_ID", "")
    if not supabase_url:
        print("CLOUD_SUPABASE_URL is required", file=sys.stderr)
        return 1
    if not service_role_key:
        print("CLOUD_SERVICE_ROLE_KEY is required", file=sys.stderr)
        return 1
    if not user_id:
        print("SUPABASE_USER_ID is required", file=sys.stderr)
        return 1
    db_path = _resolve_db_path()
    if not db_path.exists():
        print(f"Pi SQLite not found at {db_path}", file=sys.stderr)
        return 1
    print(f"parity_export: reading {db_path}")
    try:
        report = run_export(
            supabase_url=supabase_url,
            service_role_key=service_role_key,
            user_id=user_id,
            db_path=db_path,
        )
    except Exception as exc:
        print(f"parity_export: diff failed: {exc}", file=sys.stderr)
        return 1
    body = json.dumps(report, indent=2, sort_keys=True).encode()
    try:
        _storage_put(supabase_url, service_role_key, user_id, body)
    except Exception as exc:
        print(f"parity_export: storage upload failed: {exc}", file=sys.stderr)
        return 1
    print(f"parity_export: done -- deltas={report['deltas_total']}, at={report['generated_at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
