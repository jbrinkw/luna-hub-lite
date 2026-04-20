"""Tiny CLI helpers for SSH-time debugging.

Usage::

    python -m server.tools.trace event <event_id>
    python -m server.tools.trace session <session_id>
    python -m server.tools.trace invariants
    python -m server.tools.trace health [--since-seconds N]

Prints a chronological table of lifecycle rows (or invariant
violations) to stdout. No Flask app needed — just opens the configured
sqlite DB directly.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


def _open_db() -> sqlite3.Connection:
    # Delay the import so ``--help`` doesn't touch disk.
    from ..config import load_config

    cfg = load_config()
    conn = sqlite3.connect(str(cfg.db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _print_timeline(rows: list[dict[str, Any]]) -> None:
    if not rows:
        print("(no lifecycle rows)")
        return
    for r in rows:
        ts = r.get("ts") or ""
        actor = r.get("actor") or "?"
        reason = r.get("reason_code") or "?"
        payload = r.get("payload")
        if payload is None:
            raw = r.get("payload_json")
            if isinstance(raw, str) and raw:
                try:
                    payload = json.loads(raw)
                except Exception:
                    payload = raw
        print(f"  {ts}  {actor:<16}  {reason}")
        if payload:
            try:
                rendered = json.dumps(payload, default=str, indent=2)
            except Exception:
                rendered = str(payload)
            for line in rendered.splitlines():
                print(f"      {line}")


def cmd_event(event_id: str) -> int:
    from ..storage import lifecycle

    with _open_db() as conn:
        rows = lifecycle.get_event_timeline(conn, event_id, limit=500)
    print(f"event {event_id}: {len(rows)} lifecycle rows")
    _print_timeline(rows)
    return 0


def cmd_session(session_id: str) -> int:
    from ..storage import lifecycle

    with _open_db() as conn:
        rows = lifecycle.get_session_timeline(conn, session_id, limit=500)
    print(f"session {session_id}: {len(rows)} lifecycle rows")
    _print_timeline(rows)
    return 0


def cmd_invariants() -> int:
    from .invariants import run_invariant_checks

    with _open_db() as conn:
        violations = run_invariant_checks(conn)
    if not violations:
        print("no invariant violations")
        return 0
    for v in violations:
        print(f"- {v.get('kind')} (count={v.get('count')}): {v.get('detail')}")
        ids = v.get("sample_ids") or []
        if ids:
            print(f"    samples: {', '.join(ids)}")
    return 0


def cmd_health(since_seconds: int) -> int:
    from ..storage import lifecycle

    with _open_db() as conn:
        rows = lifecycle.get_recent_health(
            conn, since_seconds=since_seconds, limit=1000
        )
    print(f"system_health: {len(rows)} snapshots in last {since_seconds}s")
    for r in rows[:40]:
        print(
            f"  {r.get('ts')}  scale={r.get('scale_weight_g')}g  "
            f"pending={r.get('pending_events')} classifying={r.get('classifying_events')} "
            f"failed={r.get('failed_events')} reviews={r.get('pending_reviews')} "
            f"on_shelf={r.get('on_shelf_lot_count')} "
            f"anthropic_calls={r.get('anthropic_calls_total')}/{r.get('anthropic_errors_total')}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="server.tools.trace")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_event = sub.add_parser("event", help="print lifecycle for an event_id")
    p_event.add_argument("event_id")

    p_session = sub.add_parser("session", help="print lifecycle for a session_id")
    p_session.add_argument("session_id")

    sub.add_parser("invariants", help="run invariant checks against the DB")

    p_health = sub.add_parser("health", help="print recent system_health snapshots")
    p_health.add_argument("--since-seconds", type=int, default=3600)

    args = parser.parse_args(argv)
    if args.cmd == "event":
        return cmd_event(args.event_id)
    if args.cmd == "session":
        return cmd_session(args.session_id)
    if args.cmd == "invariants":
        return cmd_invariants()
    if args.cmd == "health":
        return cmd_health(args.since_seconds)
    parser.error(f"unknown command: {args.cmd}")
    return 2  # unreachable


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
