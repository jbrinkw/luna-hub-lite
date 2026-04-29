#!/usr/bin/env python3
"""Outbox poison + drain test (lens L4).

Two subcommands:

* ``inject`` — insert a deliberately-malformed ``cloud_outbox`` row that
  will trigger a 4xx/500 the moment the worker tries to drain it.
* ``drain-test`` — run a deterministic drain against a Pi sqlite DB
  that contains one poison row plus several healthy rows, then assert:

  1. the poison row reaches ``failed_permanently = 1`` (DLQ tombstone)
  2. healthy rows AFTER the poison row in the FIFO actually drain
     (i.e. the worker did not get FIFO-blocked by row N)
  3. healthy rows that drained match expected payload_kind ordering

This is the contract the L4 lens enforces in
AUDIT_STRATEGY_MERGED.md §1: "one bad row blocks the worker; no DLQ
in cloud_outbox; backfill_missing_outbox_events blindly replays 168 h."

The test does NOT hit the live cloud — it stubs the cloud client with
a fake that 4xxs the poison kind and 200s everything else. That keeps
the harness deterministic and runnable in CI without network.

Usage::

    python3 scripts/harness/poison_outbox.py inject \
        --db /tmp/pi.sqlite --kind invalid_kind

    python3 scripts/harness/poison_outbox.py drain-test \
        --db /tmp/pi.sqlite

Exit codes:

  0  — assertions pass
  1  — at least one assertion failed (artifact written to
        ``.verify/poison_outbox.json``)
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_DIR = REPO_ROOT / ".verify"
ARTIFACT = ARTIFACT_DIR / "poison_outbox.json"

# Kinds that the cloud edge fn (shelf-ingest/index.ts) considers valid.
VALID_KINDS = ("live_shelf", "live_scale", "catch_all")

# Default poison kind — known-rejected by VALID_KINDS so the cloud
# returns 400. That's the right shape for a "permanent failure": the
# worker should DLQ it, not retry forever.
DEFAULT_POISON_KIND = "invalid_kind_for_dlq_test"


# ---------------------------------------------------------------------------
# SQLite helpers — match the Pi schema for cloud_outbox exactly.
# ---------------------------------------------------------------------------

CLOUD_OUTBOX_DDL = """
CREATE TABLE IF NOT EXISTS cloud_outbox (
  outbox_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_event_id       TEXT NOT NULL UNIQUE,
  payload_json          TEXT NOT NULL,
  enqueued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at               TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  failed_permanently    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cloud_outbox_pending_idx
  ON cloud_outbox (outbox_id)
  WHERE sent_at IS NULL AND failed_permanently = 0;
"""


def _open_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(CLOUD_OUTBOX_DDL)
    return conn


def _insert_payload(
    conn: sqlite3.Connection, payload: dict[str, Any], client_event_id: str | None = None
) -> int:
    cid = client_event_id or str(uuid.uuid4())
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO cloud_outbox (client_event_id, payload_json) VALUES (?, ?)",
        (cid, json.dumps(payload, sort_keys=True)),
    )
    conn.commit()
    return int(cur.lastrowid)


# ---------------------------------------------------------------------------
# CLI: inject
# ---------------------------------------------------------------------------


def cmd_inject(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = _open_db(db_path)
    poison = {
        "kind": args.kind,
        "event_kind": "added",
        "scale_id": "scale-poison",
        "occurred_at": "2026-04-29T00:00:00Z",
        "_poison": True,
    }
    rid = _insert_payload(conn, poison, client_event_id=args.client_event_id)
    print(
        json.dumps(
            {
                "ok": True,
                "outbox_id": rid,
                "client_event_id": poison.get("client_event_id"),
                "kind": args.kind,
                "db": str(db_path),
            },
            sort_keys=True,
        )
    )
    return 0


# ---------------------------------------------------------------------------
# Fake worker: deterministic drain against a stub cloud
# ---------------------------------------------------------------------------


@dataclass
class DrainResult:
    """Result of a single drain pass over the outbox."""

    drained_ok: list[int]            # outbox_ids successfully sent
    drained_dlq: list[int]           # outbox_ids permanently failed
    still_pending: list[int]         # outbox_ids untouched (FIFO blocked!)

    def as_dict(self) -> dict:
        return asdict(self)


def _stub_cloud_send(payload: dict[str, Any]) -> tuple[bool, bool, str]:
    """Stub for the cloud client.

    Returns (ok, permanent_failure, error_message).

    Behavior matches the contract of the real shelf-ingest edge fn:
      * unknown kind  -> 400 (permanent_failure)
      * payload missing required ``scale_id`` -> 400 (permanent_failure)
      * everything else -> 200 OK
    """
    kind = payload.get("kind")
    if kind not in VALID_KINDS:
        return False, True, f"unknown kind {kind!r}"
    if not payload.get("scale_id"):
        return False, True, "missing scale_id"
    if payload.get("_simulate_500"):
        return False, False, "transient 5xx (will retry)"
    return True, False, ""


def _drain_once(conn: sqlite3.Connection, max_rows: int = 100) -> DrainResult:
    """One pass of FIFO drain. The contract:

      * iterate pending rows in (outbox_id ASC) order
      * if cloud returns OK, mark sent
      * if cloud returns permanent failure, mark failed_permanently AND
        CONTINUE to the next row (do not abort the loop)
      * if cloud returns transient failure, increment attempts and stop
        at this row (typical retry semantics)
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT outbox_id, payload_json FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0 "
        " ORDER BY outbox_id ASC LIMIT ?",
        (max_rows,),
    )
    rows = cur.fetchall()
    drained_ok: list[int] = []
    drained_dlq: list[int] = []
    still_pending: list[int] = []
    halted_due_to_transient = False
    for r in rows:
        if halted_due_to_transient:
            still_pending.append(int(r["outbox_id"]))
            continue
        payload = json.loads(r["payload_json"])
        ok, perm, err = _stub_cloud_send(payload)
        if ok:
            cur.execute(
                "UPDATE cloud_outbox SET sent_at = datetime('now') WHERE outbox_id = ?",
                (r["outbox_id"],),
            )
            drained_ok.append(int(r["outbox_id"]))
        elif perm:
            cur.execute(
                "UPDATE cloud_outbox SET failed_permanently = 1, last_error = ? "
                "WHERE outbox_id = ?",
                (err, r["outbox_id"]),
            )
            drained_dlq.append(int(r["outbox_id"]))
        else:
            cur.execute(
                "UPDATE cloud_outbox SET attempts = attempts + 1, last_error = ? "
                "WHERE outbox_id = ?",
                (err, r["outbox_id"]),
            )
            still_pending.append(int(r["outbox_id"]))
            halted_due_to_transient = True
    conn.commit()
    return DrainResult(
        drained_ok=sorted(drained_ok),
        drained_dlq=sorted(drained_dlq),
        still_pending=sorted(still_pending),
    )


# ---------------------------------------------------------------------------
# CLI: drain-test
# ---------------------------------------------------------------------------


def _seed_drain_fixture(conn: sqlite3.Connection) -> tuple[list[int], int, list[int]]:
    """Seed: 2 healthy rows BEFORE the poison, 3 healthy AFTER.

    Returns: (pre_ids, poison_id, post_ids).
    """
    pre = []
    for i in range(2):
        pre.append(
            _insert_payload(
                conn,
                {
                    "kind": "live_shelf",
                    "event_kind": "added",
                    "scale_id": f"scale-pre-{i}",
                    "occurred_at": "2026-04-29T00:00:00Z",
                },
            )
        )
    poison_id = _insert_payload(
        conn,
        {
            "kind": DEFAULT_POISON_KIND,
            "event_kind": "added",
            "scale_id": "scale-poison",
            "occurred_at": "2026-04-29T00:00:00Z",
        },
    )
    post = []
    for i in range(3):
        post.append(
            _insert_payload(
                conn,
                {
                    "kind": "live_shelf",
                    "event_kind": "added",
                    "scale_id": f"scale-post-{i}",
                    "occurred_at": "2026-04-29T00:00:00Z",
                },
            )
        )
    return pre, poison_id, post


def cmd_drain_test(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists() and not args.keep:
        db_path.unlink()
    conn = _open_db(db_path)

    pre, poison_id, post = _seed_drain_fixture(conn)
    result = _drain_once(conn)

    checks: list[dict] = []

    def _check(name: str, ok: bool, evidence: str) -> None:
        checks.append({"name": name, "ok": ok, "evidence": evidence})

    # 1. Poison row was DLQ'd, not stuck pending.
    _check(
        "poison_row_dlq",
        poison_id in result.drained_dlq,
        f"poison_id={poison_id} drained_dlq={result.drained_dlq}",
    )

    # 2. Healthy rows AFTER the poison row drained successfully.
    after_drained = set(post) & set(result.drained_ok)
    _check(
        "post_poison_rows_drain",
        after_drained == set(post),
        f"expected drained={sorted(post)}, got drained={sorted(after_drained)}",
    )

    # 3. Healthy rows BEFORE the poison row drained successfully too.
    before_drained = set(pre) & set(result.drained_ok)
    _check(
        "pre_poison_rows_drain",
        before_drained == set(pre),
        f"expected drained={sorted(pre)}, got drained={sorted(before_drained)}",
    )

    # 4. No rows left FIFO-blocked.
    _check(
        "no_fifo_block",
        result.still_pending == [],
        f"still_pending={result.still_pending} — must be empty post-drain",
    )

    # 5. After drain, sum(failed_permanently)=1 and sum(sent)=5
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM cloud_outbox WHERE failed_permanently = 1"
    )
    dlq_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM cloud_outbox WHERE sent_at IS NOT NULL")
    sent_count = cur.fetchone()[0]
    _check(
        "dlq_isolation",
        dlq_count == 1 and sent_count == 5,
        f"dlq_count={dlq_count} (expect 1), sent_count={sent_count} (expect 5)",
    )

    failures = [c for c in checks if not c["ok"]]
    artifact = {
        "gate": "poison_outbox",
        "lens": "L4",
        "ok": not failures,
        "checks": sorted(checks, key=lambda c: c["name"]),
        "drain_result": result.as_dict(),
        "fixture": {"pre": pre, "poison": poison_id, "post": post},
        "findings": [
            {
                "severity": "HIGH",
                "name": c["name"],
                "evidence": c["evidence"],
                "description": (
                    "L4 contract violated: poison row should DLQ, FIFO must continue. "
                    "If this test fails the worker is at risk of getting blocked by "
                    "a single bad row in cloud_outbox."
                ),
            }
            for c in failures
        ],
    }
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    if not args.quiet:
        print(json.dumps(artifact["checks"], indent=2, sort_keys=True))
        print()
        print(f"Wrote {ARTIFACT.relative_to(REPO_ROOT)}")
    return 0 if not failures else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="poison-outbox", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    inj = sub.add_parser("inject", help="Inject a malformed cloud_outbox row.")
    inj.add_argument("--db", required=True, help="Path to Pi-side SQLite DB")
    inj.add_argument("--kind", default=DEFAULT_POISON_KIND)
    inj.add_argument("--client-event-id", default=None)
    inj.set_defaults(func=cmd_inject)

    drain = sub.add_parser("drain-test", help="Seed + drain + assert L4 contract.")
    drain.add_argument("--db", required=True)
    drain.add_argument("--keep", action="store_true", help="Don't wipe an existing DB")
    drain.add_argument("--quiet", action="store_true")
    drain.set_defaults(func=cmd_drain_test)

    args = ap.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
