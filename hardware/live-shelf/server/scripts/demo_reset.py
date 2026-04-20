#!/usr/bin/env python3
"""Reset the Live Shelf demo data.

Wipes the SQLite DB and the `data/events/*` + `data/refs/*` folders,
then recreates the empty structure. Keeps `camera_locked.json` + any
other config files untouched so calibration persists across resets.

Usage:
    python3 -m server.scripts.demo_reset          # interactive confirm
    python3 -m server.scripts.demo_reset --yes    # skip prompt

Runs as a module so relative imports of `server.config` resolve.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from pathlib import Path

from ..config import AppConfig, ensure_data_dirs, load_config

log = logging.getLogger(__name__)

# Files/directories we preserve across resets (calibration only).
PRESERVE_RELATIVE = {"camera_locked.json"}


def _confirm() -> bool:
    answer = input(
        "This will wipe the DB + all events + all reference images. Continue? [y/N] "
    )
    return answer.strip().lower() in {"y", "yes"}


def _wipe(path: Path) -> None:
    if not path.exists():
        return
    if path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def reset(cfg: AppConfig) -> None:
    data_root = cfg.data_root
    if not data_root.exists():
        log.info("data dir %s does not exist — creating empty layout", data_root)
        ensure_data_dirs(cfg)
        return

    # Delete the DB.
    _wipe(cfg.db_path)
    log.info("removed %s", cfg.db_path)

    # Wipe events subtree entirely.
    _wipe(cfg.events_root)
    log.info("removed %s", cfg.events_root)

    # Wipe refs/<product_id> subdirs but keep the refs root.
    if cfg.refs_root.exists():
        for child in cfg.refs_root.iterdir():
            if child.name in PRESERVE_RELATIVE:
                continue
            _wipe(child)
        log.info("cleared %s", cfg.refs_root)

    ensure_data_dirs(cfg)
    log.info("recreated empty data layout under %s", data_root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="skip the confirmation prompt",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    cfg = load_config()
    if not args.yes and not _confirm():
        log.info("aborted")
        return 1
    reset(cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
