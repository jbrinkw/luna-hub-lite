#!/usr/bin/env python3
"""Backfill ``scale_pairings.lot_id`` on the Pi from cloud truth.

Recovery helper for the 2026-04-29 single-track lot-pin gap. A
single-track (``shelf_id='single_item'`` on Pi, ``kind='live_scale'``
in cloud) pairing row can have ``product_id`` set but ``lot_id IS NULL``.
When that happens, every weight event for that scale falls through to
the FEFO/heuristic resolver (apply_shelf_event live_scale branch tiers
b → c → d in migration ``20260429010000_live_scale_never_mints_v2.sql``)
which is wrong the moment the user has more than one lot for the
product. Recurring sync-drift bugs trace back to this gap.

Cloud-side fix lives in migration
``20260429190000_backfill_live_scale_lot_id.sql`` and the
``ScalesTab.pairScaleMutation`` change. This Pi-side script forces the
local SQLite to converge on the cloud values without waiting for the
60-second ``PairingsSyncPoller`` tick (see
``server/cloud/pairings_sync_poller.py``).

Usage (on the Pi):

    cd /home/jeremy/live-shelf
    .venv/bin/python3 scripts/backfill_live_scale_lot_id.py
    # Dry-run to see what would change:
    .venv/bin/python3 scripts/backfill_live_scale_lot_id.py --dry-run

The script:
  1. Loads the Pi config to get ``cloud_url`` + ``cloud_import_key``.
  2. Fetches ``GET /catalog`` (same endpoint the classifier + the
     PairingsSyncPoller use). The edge function filters server-side
     to pairings owned by THIS Pi's device.
  3. For every cloud pairing row with ``kind='live_scale'`` AND
     ``lot_id IS NOT NULL``, UPDATEs the matching Pi-local row's
     ``lot_id``.
  4. Logs the before/after lot_id values.

Idempotent: if the Pi row already matches the cloud row, no UPDATE is
issued. Safe to run repeatedly. Same translation rules as
``PairingsSyncPoller`` — kind 'live_scale' (cloud) → shelf_id
'single_item' (Pi).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Make the repo's ``server`` package importable when run from
# ``/home/jeremy/live-shelf``. The Pi deploys mirror
# ``hardware/live-shelf/server/`` to ``/home/jeremy/live-shelf/server/``.
_REPO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DIR))

from server.cloud.catalog import fetch_catalog  # noqa: E402
from server.cloud.client import CloudClient, CloudError  # noqa: E402
from server.config import load_config  # noqa: E402

DEFAULT_DB = Path("/home/jeremy/live-shelf/data/shelf.sqlite3")

# Mirrors the table in ``server/cloud/_kind_translate.py`` to avoid an
# import cycle through the live-running app modules.
_CLOUD_TO_PI_KIND = {
    "live_shelf": "live_shelf",
    "catch_all": "catch_all",
    "live_scale": "single_item",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--db", default=str(DEFAULT_DB),
        help=f"SQLite path (default {DEFAULT_DB})",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be updated without touching the DB.",
    )
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"error: DB file not found: {db_path}", file=sys.stderr)
        return 1

    cfg = load_config()
    if not cfg.cloud_enabled:
        print("error: cloud_enabled=False in Pi config; nothing to sync from",
              file=sys.stderr)
        return 1
    if not cfg.cloud_url or not cfg.cloud_import_key:
        print("error: cloud_url / cloud_import_key not configured",
              file=sys.stderr)
        return 1

    client = CloudClient(
        base_url=cfg.cloud_url,
        import_key=cfg.cloud_import_key,
    )

    print(f"fetching cloud catalog from {cfg.cloud_url}/catalog ...")
    try:
        catalog = fetch_catalog(client)
    except CloudError as err:
        print(f"error: cloud fetch failed HTTP {err.status_code}: "
              f"{str(err.body)[:300]}", file=sys.stderr)
        return 2

    cloud_pairings = catalog.pairings or []
    if not isinstance(cloud_pairings, list):
        print(f"error: catalog.pairings is not a list "
              f"(got {type(cloud_pairings).__name__})", file=sys.stderr)
        return 2

    # Only live_scale rows with a non-null lot_id are interesting — those
    # are the ones the cloud has resolved a lot for.
    relevant = [
        p for p in cloud_pairings
        if isinstance(p, dict)
        and p.get("kind") == "live_scale"
        and p.get("lot_id") is not None
    ]
    print(f"  cloud has {len(cloud_pairings)} pairing(s) total, "
          f"{len(relevant)} live_scale row(s) with lot_id set")

    if not relevant:
        print("nothing to backfill — every cloud live_scale row either has "
              "no lot_id, or none belong to this Pi")
        return 0

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    changes: list[tuple[str, str | None, str]] = []  # (device_id, before, after)
    for cloud_row in relevant:
        scale_id = cloud_row.get("scale_id")
        cloud_lot_id = cloud_row.get("lot_id")
        if not isinstance(scale_id, str) or not scale_id.strip():
            print(f"  skip: malformed cloud row {cloud_row!r}")
            continue

        # Cloud's scale_id == Pi's device_id (mirrors the convention in
        # ``server/cloud/pairings_sync_poller.py`` and
        # ``handlers/scale_events.py``).
        pi_row = conn.execute(
            "SELECT device_id, shelf_id, product_id, lot_id "
            "FROM scale_pairings WHERE device_id = ?",
            (scale_id,),
        ).fetchone()
        if pi_row is None:
            print(f"  skip: cloud row scale_id={scale_id!r} has no matching "
                  f"Pi local row (PairingsSyncPoller will INSERT on next tick)")
            continue

        if pi_row["lot_id"] == cloud_lot_id:
            print(f"  ok:   {scale_id} already pinned to lot_id={cloud_lot_id}")
            continue

        changes.append((scale_id, pi_row["lot_id"], cloud_lot_id))

    if not changes:
        print("\nall Pi rows already match cloud — nothing to update")
        return 0

    print(f"\nfound {len(changes)} row(s) to update:")
    for scale_id, before, after in changes:
        print(f"  {scale_id}: lot_id {before!r} → {after!r}")

    if args.dry_run:
        print("\ndry-run: no changes applied")
        return 0

    with conn:
        for scale_id, _before, after in changes:
            conn.execute(
                "UPDATE scale_pairings SET lot_id = ? WHERE device_id = ?",
                (after, scale_id),
            )
    print(f"\nupdated {len(changes)} row(s) — Pi local + cloud now agree")

    # Re-read for verification.
    print("\nfinal state:")
    rows = conn.execute(
        "SELECT device_id, shelf_id, product_id, lot_id "
        "FROM scale_pairings ORDER BY device_id"
    ).fetchall()
    for r in rows:
        print(f"  {r['device_id']}: shelf_id={r['shelf_id']} "
              f"product_id={r['product_id']} lot_id={r['lot_id']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
