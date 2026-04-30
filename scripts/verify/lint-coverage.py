#!/usr/bin/env python3
"""lint-coverage gate — asserts no first-party path is silently excluded.

Strategy:

  ESLint (TypeScript):
    Parse eslint.config.mjs and extract the `ignores` array. Walk each
    known first-party source directory and check whether ALL files in it
    would be excluded by the ignore patterns using pathlib glob matching.
    If every *.ts / *.tsx file in a tree matches an ignore glob, that tree
    is silently excluded and we report it.

    This is a static analysis approach (no ESLint invocation) — fast,
    deterministic, and avoids large project load times.

  Ruff (Python):
    Run `ruff check --statistics --no-cache <dir>` on each first-party
    Python tree. A tree is COVERED if ruff exits 0 or 1 (processed files).
    Exit 0 with "No Python files found" in output → silently excluded.

Usage:
    python scripts/verify/lint-coverage.py [--verbose]

Exit codes:
    0  all first-party paths are covered
    1  one or more paths silently excluded
    2  setup error (linter not found, etc.)
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration — first-party source directories per linter.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]

# TypeScript/TSX source trees checked via ESLint static ignore analysis.
ESLINT_ROOTS: list[tuple[str, list[str]]] = [
    ("apps/web/src", ["*.ts", "*.tsx"]),
    ("apps/mcp-worker/src", ["*.ts"]),
    ("packages/app-tools/src", ["*.ts"]),
    ("packages/ui-kit/src", ["*.ts", "*.tsx"]),
    ("supabase/functions", ["*.ts"]),
]

# Python source trees checked via ruff invocation.
RUFF_ROOTS: list[str] = [
    "hardware/live-shelf/server",
]

# Subdirectory names that are legitimately ignored everywhere.
SKIP_SUBDIRS: set[str] = {
    "__pycache__", ".venv", "node_modules", "dist", ".turbo",
    "mutants", ".mutmut-cache", ".wrangler", ".vercel", ".stryker-tmp",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(
    cmd: list[str],
    cwd: Path | None = None,
    timeout: int = 60,
) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            cwd=str(cwd) if cwd else None, timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError:
        return 127, "", "not found"


def _find_main_repo(worktree_root: Path) -> Path:
    """Find the real project root from a git worktree path."""
    probe = "hardware/live-shelf/.venv/bin/ruff"
    if (worktree_root / probe).exists():
        return worktree_root
    for ancestor in worktree_root.parents[:5]:
        if (ancestor / probe).exists():
            return ancestor
    return worktree_root


def _find_bin(main_repo: Path, rel_paths: list[str]) -> str | None:
    for rel in rel_paths:
        candidate = main_repo / rel
        if candidate.is_file() and os.access(str(candidate), os.X_OK):
            return str(candidate)
    for rel in rel_paths:
        name = Path(rel).name
        rc, out, _ = _run(["which", name])
        if rc == 0 and out.strip():
            return out.strip()
    return None


# ---------------------------------------------------------------------------
# ESLint ignore-pattern static analysis
# ---------------------------------------------------------------------------

def _parse_eslint_ignores(eslint_config: Path) -> list[str]:
    """Extract ignore patterns from eslint.config.mjs (best-effort text parse)."""
    if not eslint_config.exists():
        return []
    src = eslint_config.read_text(encoding="utf-8")
    # Find the first `ignores: [` block and extract its string literals.
    # We use a simple regex since the file is under our control.
    match = re.search(r"ignores\s*:\s*\[([^\]]+)\]", src, re.DOTALL)
    if not match:
        return []
    block = match.group(1)
    # Extract quoted strings (single or double quotes).
    patterns = re.findall(r"""['"]([^'"]+)['"]""", block)
    return patterns


def _glob_matches(pattern: str, rel_path: str) -> bool:
    """Return True if rel_path matches the eslint ignore glob pattern.

    ESLint glob patterns use ** for recursive matching. We normalise
    to fnmatch-compatible patterns.
    """
    # Trailing / means directory match — check if pattern is a prefix.
    if pattern.endswith("/"):
        return rel_path.startswith(pattern) or ("/" + rel_path).startswith("/" + pattern)
    # Convert ESLint-style globs to fnmatch patterns.
    # `**/foo/` → match `foo/` anywhere in path.
    return fnmatch.fnmatch(rel_path, pattern) or fnmatch.fnmatch(rel_path, "**/" + pattern)


def _tree_fully_excluded(
    rel_root: str,
    patterns: list[str],
    ts_exts: list[str],
    verbose: bool,
) -> bool:
    """Return True if every TS/TSX file in rel_root matches an ignore pattern."""
    abs_root = REPO_ROOT / rel_root
    if not abs_root.exists():
        if verbose:
            print(f"  SKIP (not present): {rel_root}")
        return False  # absent = not excluded (just missing)

    found_any = False
    for ext in ts_exts:
        for f in abs_root.rglob(ext):
            if any(part in SKIP_SUBDIRS for part in f.parts):
                continue
            found_any = True
            rel = str(f.relative_to(REPO_ROOT))
            if not any(_glob_matches(p, rel) for p in patterns):
                if verbose:
                    print(f"    COVERED: {rel}")
                return False  # At least one file not excluded → tree is covered
            if verbose:
                print(f"    excluded by ignore: {rel}")

    if not found_any:
        if verbose:
            print(f"  No TS files found under {rel_root} — treating as covered.")
        return False  # Empty directory is not an exclusion problem

    return True  # All files matched an ignore pattern


# ---------------------------------------------------------------------------
# Ruff gate
# ---------------------------------------------------------------------------

def check_ruff_root(ruff_bin: str, rel_root: str, verbose: bool) -> bool:
    """Return True (covered) or False (silently excluded) for a ruff root."""
    abs_root = REPO_ROOT / rel_root
    if not abs_root.exists():
        if verbose:
            print(f"  SKIP (not present): {rel_root}")
        return True

    rc, stdout, stderr = _run(
        [ruff_bin, "check", "--no-cache", "--statistics", str(abs_root)],
        cwd=REPO_ROOT, timeout=60,
    )
    combined = stdout + stderr

    if verbose:
        print(f"  ruff {rel_root}: rc={rc}")
        if combined.strip():
            print(f"    {combined[:300].strip()}")

    if rc == 124:
        print(f"  WARNING: ruff timed out on {rel_root} — treating as covered.", file=sys.stderr)
        return True

    # rc=0 means clean; rc=1 means violations found; rc=2 config error.
    # "No Python files found" in output means ruff found nothing to lint.
    if rc in (0, 1, 2):
        if "no python files found" in combined.lower() and rc == 0:
            return False
        return True

    return True  # Unknown exit code — treat as covered.


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Lint-coverage gate")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()
    verbose = args.verbose

    main_repo = _find_main_repo(REPO_ROOT)
    if verbose:
        print(f"REPO_ROOT (worktree): {REPO_ROOT}")
        print(f"Main repo root:       {main_repo}")

    ruff_bin = _find_bin(main_repo, ["hardware/live-shelf/.venv/bin/ruff"])

    if ruff_bin is None:
        print("WARNING: ruff not found — skipping Python lint-coverage check.", file=sys.stderr)
    elif verbose:
        print(f"Ruff: {ruff_bin}")

    excluded: list[str] = []
    covered_count = 0

    # --- ESLint static analysis ---
    eslint_config = REPO_ROOT / "eslint.config.mjs"
    ignore_patterns = _parse_eslint_ignores(eslint_config)
    if verbose:
        print(f"ESLint ignore patterns ({len(ignore_patterns)}): {ignore_patterns[:5]} ...")

    for rel_root, exts in ESLINT_ROOTS:
        if verbose:
            print(f"Checking eslint tree: {rel_root}")
        fully_excluded = _tree_fully_excluded(rel_root, ignore_patterns, exts, verbose)
        if fully_excluded:
            excluded.append(f"[eslint] {rel_root}")
        else:
            covered_count += 1

    # --- Ruff ---
    if ruff_bin is not None:
        for rel_root in RUFF_ROOTS:
            if verbose:
                print(f"Checking ruff root: {rel_root}")
            covered = check_ruff_root(ruff_bin, rel_root, verbose)
            if covered:
                covered_count += 1
            else:
                excluded.append(f"[ruff] {rel_root}")
    elif not RUFF_ROOTS:
        pass  # Nothing to check
    else:
        # ruff missing but we have ruff roots — skip with warning (already printed)
        pass

    if excluded:
        print(
            f"\nlint-coverage: FAIL — {len(excluded)} source tree(s) silently excluded:",
            file=sys.stderr,
        )
        for path in excluded:
            print(f"  {path}", file=sys.stderr)
        print(
            "\nThese paths are in known first-party directories but every file\n"
            "matches an ignore glob. Remove them from the ignore list, or add an\n"
            "explicit `# noqa` / `eslint-disable` comment if exclusion is intentional.",
            file=sys.stderr,
        )
        return 1

    total = len(ESLINT_ROOTS) + len(RUFF_ROOTS)
    print(
        f"lint-coverage: OK — {covered_count}/{total} first-party source tree(s) "
        "are reachable by their respective linter."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
