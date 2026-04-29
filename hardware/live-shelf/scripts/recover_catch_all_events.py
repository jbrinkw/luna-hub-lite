#!/usr/bin/env python3
"""Reset failed/classified catch-all events so the sweeper re-runs them.

Recovery helper for the 2026-04-28 catch-all single-frame redesign.
Before the redesign, catch-all events were classified with the
SHELF prompt — which framed the task as "compare before vs after
given a delta" instead of "identify the item in this single image".
The mismatch produced bogus reasoning ("X is 65% of catalog weight,
plausible") and shipped the wrong item_id to the apply path.

This script resets specific events back to ``classifier_status='pending'``
so the next sweeper tick (or the next inline dispatch) re-classifies
them with the new catch-all prompt + single-frame payload.

Default targets are the two events the user flagged:
  * ``6baa809d-066f-4c2c-8d25-f7f3ad0f87e0`` (the same-file bug
    repro that landed at status='failed' before commit 114396a)
  * ``7f5bee47-...``  (classifier returned shelf-flavored reasoning
    showing the wrong prompt was active)

Usage (on the Pi):

    cd /home/jeremy/live-shelf
    .venv/bin/python3 scripts/recover_catch_all_events.py
    # Or specify event_id prefixes directly:
    .venv/bin/python3 scripts/recover_catch_all_events.py 6baa809d 7f5bee47
    # Dry-run to see what would change:
    .venv/bin/python3 scripts/recover_catch_all_events.py --dry-run

After the reset:
  * The sweeper picks them up within ``min_age_seconds`` (default 5s)
    on its next tick (default 10-30s loop, see app.py).
  * The sweeper's catch-all recovery branch (handlers/scale_events.py
    line ~4300) re-dispatches with the persisted frame paths.
  * ``classify_event`` selects the new catch-all prompt because
    ``ctx.shelf_id == 'catch_all'``.

The script also clears the stale ``classification`` column so the
old wrong reasoning doesn't pollute audit views post-recovery. Frame
paths on the row are preserved (the JPEGs on disk are still good —
only the classifier output was wrong).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path("/home/jeremy/live-shelf/data/shelf.sqlite3")
DEFAULT_TARGETS = ["6baa809d", "7f5bee47"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "event_id_prefixes", nargs="*",
        help=(
            "Event-id prefixes to reset (matched via LIKE 'prefix%'). "
            f"Default: {', '.join(DEFAULT_TARGETS)}"
        ),
    )
    ap.add_argument(
        "--db", default=str(DEFAULT_DB),
        help=f"SQLite path (default {DEFAULT_DB})",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Print what would change without touching the DB.",
    )
    args = ap.parse_args()

    targets = args.event_id_prefixes or list(DEFAULT_TARGETS)

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"error: DB file not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    matched: list[sqlite3.Row] = []
    for prefix in targets:
        rows = conn.execute(
            """
            SELECT event_id,
                   shelf_id,
                   classifier_status,
                   substr(classification, 1, 200) AS cls_short,
                   before_frame_path,
                   after_frame_path
              FROM scale_events
             WHERE event_id LIKE ?
            """,
            (f"{prefix}%",),
        ).fetchall()
        if not rows:
            print(f"warning: no event matched prefix {prefix!r}")
            continue
        matched.extend(rows)

    if not matched:
        print("no events matched — nothing to reset")
        return 0

    print(f"found {len(matched)} event(s) to reset:")
    for r in matched:
        print(
            f"  event={r['event_id']} shelf={r['shelf_id']!r} "
            f"status={r['classifier_status']!r}"
        )
        print(f"    before={r['before_frame_path']!s}")
        print(f"    after={r['after_frame_path']!s}")
        if r["cls_short"]:
            print(f"    old_cls={r['cls_short']!s}")

    # Sanity-check: only reset catch_all rows. Fail loudly if a
    # live_shelf event slipped into the target list — that would
    # indicate an operator typo and a live_shelf reset is not what
    # this script is designed for.
    non_catch_all = [r for r in matched if r["shelf_id"] != "catch_all"]
    if non_catch_all:
        print(
            f"\nerror: {len(non_catch_all)} matched event(s) are NOT "
            f"shelf_id='catch_all' — refusing to reset:",
            file=sys.stderr,
        )
        for r in non_catch_all:
            print(
                f"  {r['event_id']}: shelf_id={r['shelf_id']!r}",
                file=sys.stderr,
            )
        return 2

    if args.dry_run:
        print("\ndry-run: no changes applied")
        return 0

    ids = [r["event_id"] for r in matched]
    placeholders = ",".join("?" * len(ids))
    with conn:
        conn.execute(
            f"""
            UPDATE scale_events
               SET classifier_status = 'pending',
                   classification = NULL
             WHERE event_id IN ({placeholders})
            """,
            ids,
        )
    print(
        f"\nreset {len(ids)} event(s) to classifier_status='pending'. "
        "The next sweeper tick will pick them up via the catch_all "
        "recovery branch and re-classify with the single-frame prompt. "
        "Tail the server log for `classifier_prompt_prepared` events "
        "with payload.prompt_variant='catch_all' to confirm."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
