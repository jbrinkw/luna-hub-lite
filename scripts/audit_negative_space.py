#!/usr/bin/env python3
"""Negative-space audit (lens L8).

Greps the codebase for "I'll come back to it later" markers — TODO,
FIXME, XXX, HACK, STUB, "future X", "not yet implemented", "deferred"
— and asserts that each hit is one of:

  (a) tracked in `ignore.md` with a date
  (b) explicitly waived in this script's `WAIVERS` list (which mirrors
      `AUDIT_STRATEGY_MERGED.md §7`'s "What NOT to Audit" carve-outs),
  (c) implemented (i.e. the marker is gone — by definition not a
      finding because the regex didn't match)

Anything else becomes a finding.

Output:

    .verify/audit_negative_space.json
    .verify/audit_negative_space.md

Exit non-zero iff at least one finding is recorded.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Scan scope
# ---------------------------------------------------------------------------

SCAN_ROOTS = [
    REPO_ROOT / "apps",
    REPO_ROOT / "hardware",
    REPO_ROOT / "supabase",
    REPO_ROOT / "packages",
    REPO_ROOT / "extensions",
]

EXCLUDE_DIR_FRAGMENTS = (
    "/node_modules/",
    "/.venv/",
    "/legacy/",
    "/dist/",
    "/build/",
    "/.git/",
    "/.verify/",
    "/site-packages/",
    "/.next/",
    "/coverage/",
    "/__pycache__/",
    "/playwright-report/",
    "/test-results/",
    "/.wrangler/",
    "/playwright-report-e2e/",
    "/test-results-e2e/",
    "/.stryker-tmp/",
)

TEXT_EXTS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".sql",
    ".md",
    ".html",
    ".css",
    ".sh",
    ".toml",
    ".yaml",
    ".yml",
    ".ino",
}


PATTERN = re.compile(
    r"(?ix)"
    r"(?:^|[^a-zA-Z0-9_])"
    r"(?P<marker>"
    r"todo"
    r"|fixme"
    r"|xxx"
    r"|hack"
    r"|stub"
    r"|future\s+\w"
    r"|not[\s\-]?yet[\s\-]?implemented"
    r"|deferred"
    r")"
)

# ---------------------------------------------------------------------------
# Allow-list: known-deferred items. Each entry is (file_substr, marker_substr,
# rationale). file_substr matches against the relative-to-repo path. A None
# marker_substr matches every marker in that file.
# ---------------------------------------------------------------------------
WAIVERS: list[tuple[str, str | None, str]] = [
    # In-repo audit + planning docs talk ABOUT TODOs without being them.
    ("AUDIT_FINDINGS_PHASE1.md", None, "audit doc discussing TODO marker family"),
    ("AUDIT_FINDINGS_PHASE1_DEFERRED.md", None, "deferred-findings doc per name"),
    ("AUDIT_STRATEGY.md", None, "strategy doc enumerates marker family"),
    ("AUDIT_STRATEGY_codex.md", None, "strategy doc enumerates marker family"),
    ("AUDIT_STRATEGY_MERGED.md", None, "strategy doc enumerates marker family"),
    ("UX_AUDIT_", None, "UX audit logs reference TODO markers in fixes"),
    ("docs/test-audit-2026-04-27.md", None, "audit log referencing TODOs"),
    ("docs/test-system-fix-plan.md", None, "in-flight planning doc"),
    ("docs/feature-diff.md", None, "diff doc enumerates deferred work"),
    ("docs/SCHEMA_DRIFT_AUDIT.md", None, "audit log describes deferred fixes"),
    ("planned-work.md", None, "user-maintained worklist"),
    # Generated DB types + lockfiles can't be audited for TODO content.
    ("packages/db-types/src/database.ts", None, "generated, not hand-maintained"),
    ("apps/web/dist/", None, "build output"),
    # Live-shelf docs explicitly version their planning artifacts.
    ("hardware/live-shelf/docs/", None, "live-shelf in-flight planning notes"),
    ("hardware/live-shelf/server/static/", None, "vendored JS / fonts"),
    # Test files that intentionally test marker handling.
    ("scripts/audit_test_quality.py", None, "the audit script that LOOKS for markers"),
    ("scripts/audit_negative_space.py", None, "self — defining the patterns"),
    ("scripts/audit_invariants_pinned.py", None, "self — handling rule docs"),
    ("scripts/audit_symmetry_matrix.py", None, "self — defining waivers"),
]


# Track-file: ``ignore.md`` at repo root if present. Format is loose —
# we look for ``YYYY-MM-DD`` near a file:line reference.
TRACKED_PATH = REPO_ROOT / "ignore.md"


@dataclass
class Hit:
    file: str
    line: int
    marker: str
    excerpt: str


@dataclass
class Finding:
    file: str
    line: int
    severity: str
    marker: str
    excerpt: str
    description: str

    def as_dict(self) -> dict:
        return asdict(self)


def _is_excluded(p: Path) -> bool:
    sp = str(p) + "/"
    return any(frag in sp for frag in EXCLUDE_DIR_FRAGMENTS)


def iter_files() -> list[Path]:
    out: list[Path] = []
    for root in SCAN_ROOTS:
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix not in TEXT_EXTS:
                continue
            if _is_excluded(p):
                continue
            out.append(p)
    return sorted(out)


def parse_tracked() -> set[tuple[str, int]]:
    """Read ``ignore.md`` for entries of the form ``path:line``.

    Lines without a ``YYYY-MM-DD`` token nearby are skipped (we want a
    date to discourage stale entries).
    """
    if not TRACKED_PATH.is_file():
        return set()
    text = TRACKED_PATH.read_text(encoding="utf-8", errors="replace")
    out: set[tuple[str, int]] = set()
    for line in text.splitlines():
        m = re.search(r"(?P<file>[A-Za-z0-9_./\-]+\.(?:py|ts|tsx|sql|md|sh)):(?P<ln>\d+)", line)
        if not m:
            continue
        if not re.search(r"\b(20\d{2})-(\d{2})-(\d{2})\b", line):
            continue
        out.add((m.group("file"), int(m.group("ln"))))
    return out


def is_waived(rel_path: str, marker: str) -> str | None:
    for sub, mark_sub, rationale in WAIVERS:
        if sub in rel_path and (mark_sub is None or mark_sub.lower() in marker.lower()):
            return rationale
    return None


def scan_file(p: Path) -> list[Hit]:
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    out: list[Hit] = []
    for ln_idx, line in enumerate(text.splitlines(), start=1):
        m = PATTERN.search(line)
        if not m:
            continue
        marker = m.group("marker").strip().lower()
        excerpt = line.strip()[:200]
        out.append(Hit(file=str(p.relative_to(REPO_ROOT)), line=ln_idx, marker=marker, excerpt=excerpt))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--json",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_negative_space.json"),
    )
    ap.add_argument(
        "--md",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_negative_space.md"),
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    tracked = parse_tracked()

    hits: list[Hit] = []
    for p in iter_files():
        hits.extend(scan_file(p))

    findings: list[Finding] = []
    waived_count = 0
    tracked_count = 0
    for h in hits:
        if (h.file, h.line) in tracked:
            tracked_count += 1
            continue
        rationale = is_waived(h.file, h.marker)
        if rationale is not None:
            waived_count += 1
            continue
        findings.append(
            Finding(
                file=h.file,
                line=h.line,
                severity="MEDIUM",
                marker=h.marker,
                excerpt=h.excerpt,
                description=(
                    f"`{h.marker}` marker at {h.file}:{h.line} is not tracked in "
                    "`ignore.md` (with a date) and not waived in `WAIVERS`. "
                    "Either implement the deferred work, add an entry to "
                    "`ignore.md`, or add a WAIVERS rule."
                ),
            )
        )

    findings.sort(key=lambda f: (f.file, f.line))

    artifact = {
        "gate": "audit_negative_space",
        "lens": "L8",
        "stats": {
            "files_scanned": len(set(h.file for h in hits)),
            "hits_total": len(hits),
            "hits_tracked": tracked_count,
            "hits_waived": waived_count,
            "findings": len(findings),
        },
        "findings": [f.as_dict() for f in findings],
    }
    out_json = Path(args.json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    lines = [
        "# Negative-Space Audit (Lens L8)",
        "",
        f"Hits total: **{len(hits)}**  ",
        f"Tracked in `ignore.md`: **{tracked_count}**  ",
        f"Waived: **{waived_count}**  ",
        f"Findings: **{len(findings)}**",
        "",
    ]
    if findings:
        by_file: dict[str, list[Finding]] = {}
        for f in findings:
            by_file.setdefault(f.file, []).append(f)
        for fpath in sorted(by_file):
            lines.append(f"### `{fpath}` ({len(by_file[fpath])})")
            lines.append("")
            for f in by_file[fpath][:15]:
                lines.append(f"- L{f.line} `{f.marker}`: {f.excerpt}")
            if len(by_file[fpath]) > 15:
                lines.append(f"- _...and {len(by_file[fpath]) - 15} more in this file._")
            lines.append("")
    else:
        lines.append("## Findings")
        lines.append("")
        lines.append(
            "None — every TODO/FIXME/etc marker is tracked in `ignore.md` "
            "or waived."
        )

    md = "\n".join(lines) + "\n"
    out_md = Path(args.md)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md, encoding="utf-8")

    if not args.quiet:
        print(md)
        print(f"Wrote {out_json.relative_to(REPO_ROOT)} ({len(findings)} findings)")

    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
