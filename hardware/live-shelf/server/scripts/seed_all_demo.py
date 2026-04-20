#!/usr/bin/env python3
"""Interactive seeder for the full Live Shelf demo product set.

Runs :func:`seed_product.seed_one` once per profile file under
``demo_seeds/``. Between products the operator is prompted to remove the
previous item from the shelf and place the next one.

Usage
-----
::

    python seed_all_demo.py --host http://192.168.0.181:8000

    python seed_all_demo.py --list          # just list which profiles would be seeded
    python seed_all_demo.py --only 021000616886,031142523850   # subset
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

# Allow running as a script from anywhere: the sibling seed_product.py is on
# the same directory, so add that directory to sys.path if needed.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from seed_product import (  # noqa: E402 — runtime import after sys.path fix-up
    DEFAULT_HOST,
    DEFAULT_TIMEOUT_S,
    seed_one,
    _prompt,
    _p,
)

DEMO_DIR = _THIS_DIR / "demo_seeds"

# The order the operator sees — matches the order they'll physically stage
# items. Alphanumeric order by barcode keeps things deterministic and avoids
# privileging one SKU over another.
DEFAULT_ORDER = [
    "021000616886",
    "022655306306",
    "031142523850",
    "073410003435",
    "078742062570",
    "078742363127",
]


def discover_profiles(directory: Path) -> list[Path]:
    """Return the profile files in the canonical demo order.

    Profiles not listed in :data:`DEFAULT_ORDER` are appended after the known
    ones, sorted by filename, so adding a new seed JSON automatically shows
    up without editing this module.
    """
    known: list[Path] = []
    for barcode in DEFAULT_ORDER:
        p = directory / f"{barcode}.json"
        if p.is_file():
            known.append(p)
    # Pick up any extras (e.g., a 7th SKU someone dropped in) in name order.
    extras: list[Path] = []
    for p in sorted(directory.glob("*.json")):
        if p.is_file() and p not in known:
            extras.append(p)
    return known + extras


def filter_profiles(profiles: list[Path], only: Optional[list[str]]) -> list[Path]:
    if not only:
        return profiles
    wanted = {bc.strip() for bc in only if bc.strip()}
    return [p for p in profiles if p.stem in wanted]


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Seed all Live Shelf demo products via the intake HTTP API.",
    )
    ap.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Server base URL (default: {DEFAULT_HOST})",
    )
    ap.add_argument(
        "--dir",
        type=Path,
        default=DEMO_DIR,
        help=f"Directory of profile JSON files (default: {DEMO_DIR})",
    )
    ap.add_argument(
        "--only",
        type=str,
        default=None,
        help="Comma-separated list of barcodes to seed (default: all).",
    )
    ap.add_argument(
        "--list",
        action="store_true",
        help="Print the profiles that would be seeded (in order) and exit.",
    )
    ap.add_argument(
        "--skip-lookup",
        action="store_true",
        help="Forward --skip-lookup to each per-product run.",
    )
    ap.add_argument(
        "--yes",
        action="store_true",
        help="Auto-accept all interactive prompts (dry-run / test only).",
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help=f"Per-request HTTP timeout in seconds (default: {DEFAULT_TIMEOUT_S})",
    )
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    args = build_argparser().parse_args(argv)

    directory: Path = args.dir
    if not directory.is_dir():
        print(f"ERROR: profile directory not found: {directory}", file=sys.stderr)
        return 1

    profiles = discover_profiles(directory)
    only = [s for s in (args.only or "").split(",") if s.strip()] or None
    profiles = filter_profiles(profiles, only)

    if not profiles:
        print("ERROR: no profiles matched. Nothing to do.", file=sys.stderr)
        return 1

    if args.list:
        _p(f"Would seed {len(profiles)} product(s) against {args.host}:")
        for i, p in enumerate(profiles, 1):
            _p(f"  {i}. {p.name}")
        return 0

    _p("")
    _p("################################################################")
    _p(f"  Live Shelf demo seeding: {len(profiles)} product(s)")
    _p(f"  Target server: {args.host}")
    _p(f"  Profile dir:   {directory}")
    _p("################################################################")
    _prompt("Ready to start? Press Enter.", auto_yes=args.yes)

    results: list[dict[str, object]] = []
    for idx, profile in enumerate(profiles, 1):
        if idx > 1:
            _prompt(
                f"Remove the previous item from the shelf, then press Enter "
                f"to seed next product ({idx}/{len(profiles)}: {profile.stem}).",
                auto_yes=args.yes,
            )
        result = seed_one(
            profile,
            host=args.host,
            skip_lookup=args.skip_lookup,
            auto_yes=args.yes,
            timeout_s=args.timeout,
        )
        results.append({"profile": profile.name, **result})

    _p("")
    _p("################################################################")
    _p("  All products seeded")
    _p("################################################################")
    for r in results:
        _p(
            f"  {r['profile']:>24}  product_id={r['product_id']}  "
            f"lot_id={r['lot_id']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
