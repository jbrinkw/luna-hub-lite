#!/usr/bin/env python3
"""Reset Pi cloud_outbox rows that were marked failed_permanently.

Post-CI recovery helper for the 2026-04-22 Pi↔Cloud sync audit.
Between the time the Pi started emitting ``in_flight_pickup`` cloud
events and the time CI deployed the matching shelf-ingest edge
function, every emit hit a 400 and got flagged ``failed_permanently=1``.
Those rows won't retry automatically.

Usage (on the Pi):

    cd /home/jeremy/live-shelf
    .venv/bin/python3 scripts/reset_permanent_failures.py
    # Optional filter: only reset rows whose last_error matches a pattern
    .venv/bin/python3 scripts/reset_permanent_failures.py --match "invalid event_kind"

After the reset the cloud worker's next tick (30s) will re-send the
rows. An idempotent shelf_event_log UNIQUE(user_id, client_event_id)
on the cloud side makes replays safe.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path("/home/jeremy/live-shelf/data/shelf.sqlite3")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--db", default=str(DEFAULT_DB),
        help=f"SQLite path (default {DEFAULT_DB})",
    )
    ap.add_argument(
        "--match", default=None,
        help="Only reset rows whose last_error contains this substring. "
             "Default: reset ALL failed_permanently rows.",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be reset without touching the DB.",
    )
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"error: DB file not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    if args.match:
        rows = conn.execute(
            "SELECT outbox_id, last_error, substr(payload_json, 1, 200) AS p "
            "FROM cloud_outbox "
            "WHERE failed_permanently = 1 "
            "  AND last_error LIKE ?",
            (f"%{args.match}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT outbox_id, last_error, substr(payload_json, 1, 200) AS p "
            "FROM cloud_outbox "
            "WHERE failed_permanently = 1",
        ).fetchall()

    if not rows:
        print("no failed_permanently rows matched — nothing to reset")
        return 0

    print(f"found {len(rows)} row(s):")
    for r in rows:
        print(f"  [{r['outbox_id']}] err={r['last_error']!s} :: {r['p']!s}")

    if args.dry_run:
        print("\ndry-run: no changes applied")
        return 0

    ids = [r["outbox_id"] for r in rows]
    placeholders = ",".join("?" * len(ids))
    with conn:
        conn.execute(
            f"UPDATE cloud_outbox "
            f"   SET failed_permanently = 0, "
            f"       last_error = NULL, "
            f"       attempts = 0 "
            f" WHERE outbox_id IN ({placeholders})",
            ids,
        )
    print(f"\nreset {len(ids)} row(s) — cloud worker will retry on next tick")
    return 0


if __name__ == "__main__":
    sys.exit(main())
