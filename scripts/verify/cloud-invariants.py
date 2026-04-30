#!/usr/bin/env python3
"""Production-data sweep: assert cloud_outbox payload invariants over a live SQLite DB.

Usage:
    python scripts/verify/cloud-invariants.py /path/to/livetrack.db

Exits 0 if all rows pass.  Prints each violation and exits 1 if any fail.

The sweep walks every row in `cloud_outbox`, deserializes the JSON payload,
and runs assert_payload_invariants against the same connection.  The mirror
tables (cloud_lots, cloud_products, scale_events, review_queue) must exist in
the same DB file.

This is a read-only sweep — it does not modify any data.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path


def _find_server_root() -> Path:
    """Locate hardware/live-shelf/server relative to this script's repo root."""
    here = Path(__file__).resolve()
    # Walk up to find the repo root (contains hardware/ directory).
    for parent in here.parents:
        candidate = parent / "hardware" / "live-shelf" / "server"
        if candidate.is_dir():
            return candidate
    raise RuntimeError(
        "Could not locate hardware/live-shelf/server — "
        "run this script from within the luna-hub-lite repository."
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} /path/to/livetrack.db", file=sys.stderr)
        return 2

    db_path = Path(argv[1])
    if not db_path.exists():
        print(f"error: DB not found: {db_path}", file=sys.stderr)
        return 2

    # Ensure the server package is importable.
    server_root = _find_server_root()
    repo_root = server_root.parent.parent.parent  # hardware/ -> live-shelf/ -> repo/
    if str(repo_root / "hardware" / "live-shelf") not in sys.path:
        sys.path.insert(0, str(repo_root / "hardware" / "live-shelf"))

    from server.cloud.invariants import InvariantViolation, assert_payload_invariants  # noqa: PLC0415

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        rows = conn.execute(
            "SELECT id, payload FROM cloud_outbox ORDER BY id"
        ).fetchall()
    except sqlite3.OperationalError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    violations: list[str] = []

    for row in rows:
        row_id = row["id"]
        raw = row["payload"]
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            violations.append(f"  row {row_id}: JSON parse error — {exc}")
            continue
        if not isinstance(payload, dict):
            violations.append(f"  row {row_id}: payload is not a dict (got {type(payload).__name__})")
            continue
        try:
            assert_payload_invariants(payload, conn)
        except InvariantViolation as exc:
            violations.append(f"  row {row_id}: {exc}")

    if violations:
        print(f"FAIL: {len(violations)} violation(s) in {db_path}:")
        for v in violations:
            print(v)
        return 1

    print(f"OK: {len(rows)} cloud_outbox row(s) passed invariant checks ({db_path})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
