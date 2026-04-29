#!/usr/bin/env python3
"""Invariants-pinned audit (lens L11).

Greps `docs/`, `AUDIT_*.md`, code comments, and migration headers for
"must / never / always" sentences — design rules that the team
treats as load-bearing. Cross-references each rule against
``supabase/tests/invariants/<*.test.sql>``: every rule must be pinned by
at least one filename keyword OR explicitly waived in
``AUDIT_STRATEGY_MERGED.md §7``.

A rule is a sentence containing ``must``, ``never`` or ``always``,
trimmed to <= 240 chars and lower-cased for matching. Pinning is
filename-keyword based: the rule's noun-phrase keywords (e.g.
``apply_shelf_event``, ``catch_all``, ``logical_date``) must appear in
the filename of an existing invariant test.

Output:

    .verify/audit_invariants_pinned.json
    .verify/audit_invariants_pinned.md

Exit non-zero iff at least one finding is recorded. Findings are
sorted deterministically by (file, line) so runs are byte-identical.
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
# Source ranges
# ---------------------------------------------------------------------------

# Files to scan. Globs are relative to REPO_ROOT. We DELIBERATELY include
# audit-strategy markdowns themselves — they describe rules the audit
# is supposed to enforce, so unpinned rules in those files surface here.
SCAN_PATTERNS: list[str] = [
    "docs/**/*.md",
    "AUDIT_STRATEGY_MERGED.md",
    "AUDIT_STRATEGY.md",
    "AUDIT_STRATEGY_codex.md",
    "AUDIT_FINDINGS_PHASE1.md",
    "AUDIT_FINDINGS_PHASE1_DEFERRED.md",
    "planned-work.md",
    "supabase/migrations/*.sql",
    "hardware/live-shelf/server/storage/schema.sql",
]

EXCLUDE_DIR_FRAGMENTS = (
    "/node_modules/",
    "/.venv/",
    "/legacy/",
    "/dist/",
    "/build/",
    "/.git/",
    "/.verify/",
)

INV_DIR = REPO_ROOT / "supabase" / "tests" / "invariants"

# Rule heuristic: sentence must be a real assertion, not commentary.
# We split on `.` `;` `:` and strip; then keep only sentences with one
# of the trigger words **and** at least one alphanum identifier
# (otherwise things like "we never do x" with no noun are skipped).
TRIGGERS = ("must", "never", "always")

# Words to ignore when extracting "topic keywords" (used to look up
# pinning filenames). Generic words otherwise dominate everything.
STOP_WORDS = set(
    """
    the a an this that these those is are was were be been being
    we you they it our we'll you'll they'll its theirs ours yours
    has have had does do did doing of in on at to from by with
    not no nor or and but so yet for as if then than else
    each every any all some many few both either neither
    one two three four five six seven eight nine ten
    when where while because since until before after into
    via over under up down out off above below between among
    can could should would may might will won won't can't shall
    must mustn't never always sometimes often rarely usually
    rule rules audit lens contract column row table function
    user users feature features must-not never-let always-keep
    cloud edge pi server side client web mobile pi-side
    note notes example examples e.g. eg.
    new old current existing prior previous next future deferred
    """.split()
)

@dataclass
class Rule:
    file: str
    line: int
    raw: str
    topic_keywords: list[str]

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Finding:
    file: str
    line: int
    severity: str
    rule: str
    description: str
    topic_keywords: list[str]

    def as_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def discover_files() -> list[Path]:
    """Resolve glob patterns to a sorted, deduped list of Paths.

    We only return regular files. Skipping non-existent files is fine —
    the audit must be tolerant of in-flight repos.
    """
    seen: set[Path] = set()
    for pat in SCAN_PATTERNS:
        for p in REPO_ROOT.glob(pat):
            if not p.is_file():
                continue
            sp = str(p)
            if any(frag in sp for frag in EXCLUDE_DIR_FRAGMENTS):
                continue
            seen.add(p.resolve())
    return sorted(seen)


SENT_SPLIT = re.compile(r"(?<=[.;:!?])\s+")
LINE_SENT_TRIM = re.compile(r"^[\s>#*\-+`\d.]+")  # markdown bullet/heading lead-in


def _is_real_rule(sent: str) -> bool:
    """Filter heuristic: drop interrogative or hypothetical phrasing."""
    low = sent.lower().strip()
    if not low:
        return False
    if low.endswith("?"):
        return False
    if low.startswith("if "):  # "if X must Y" is conditional, not a rule
        return False
    if "may" in low.split() and "must" not in low.split():
        return False
    return any(w in low.split() for w in TRIGGERS) or any(
        re.search(rf"\b{t}\b", low) for t in TRIGGERS
    )


def _extract_keywords(sent: str) -> list[str]:
    """Pull identifier-like tokens worth matching against test filenames."""
    out: list[str] = []
    seen: set[str] = set()
    for tok in re.findall(r"[A-Za-z][A-Za-z0-9_]{2,}", sent):
        low = tok.lower()
        if low in STOP_WORDS:
            continue
        if low in seen:
            continue
        seen.add(low)
        out.append(low)
    return out


def extract_rules(path: Path) -> list[Rule]:
    """Find every rule sentence in `path` along with line number."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    rules: list[Rule] = []
    for ln_idx, line in enumerate(text.splitlines(), start=1):
        # Strip markdown / SQL comment lead-in for sentence parsing
        cleaned = LINE_SENT_TRIM.sub("", line)
        # SQL comments
        cleaned = re.sub(r"^--\s*", "", cleaned)
        for sent in SENT_SPLIT.split(cleaned):
            sent = sent.strip()
            if len(sent) < 10:
                continue
            if not _is_real_rule(sent):
                continue
            # Also reject sentence fragments where the trigger word is
            # part of a different word (eg "muster", "nevertheless").
            words = re.findall(r"[a-zA-Z][a-zA-Z0-9_'-]*", sent.lower())
            if not any(t in words for t in TRIGGERS):
                continue
            kws = _extract_keywords(sent)
            if not kws:
                continue
            rules.append(
                Rule(
                    file=str(path.relative_to(REPO_ROOT)),
                    line=ln_idx,
                    raw=sent[:240],
                    topic_keywords=kws[:8],
                )
            )
    return rules


# ---------------------------------------------------------------------------
# Pinning
# ---------------------------------------------------------------------------


def invariant_filenames() -> list[str]:
    if not INV_DIR.is_dir():
        return []
    return sorted(p.name.lower() for p in INV_DIR.glob("*.test.sql"))


def is_pinned(rule: Rule, filenames: list[str]) -> tuple[bool, str]:
    """A rule is pinned if at least one of its keywords appears in any
    invariant test filename. We require keyword length >= 4 to avoid
    matching short generic tokens like 'qty' against everything.

    Returns (pinned, evidence-string).
    """
    blob = "\n".join(filenames)
    for kw in rule.topic_keywords:
        if len(kw) < 4:
            continue
        if kw in blob:
            return True, f"keyword `{kw}` appears in invariants/{kw}*.test.sql or similar"
    return False, ""


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--json",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_invariants_pinned.json"),
    )
    ap.add_argument(
        "--md",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_invariants_pinned.md"),
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    files = discover_files()
    rules: list[Rule] = []
    for f in files:
        rules.extend(extract_rules(f))
    rules.sort(key=lambda r: (r.file, r.line))

    invariants = invariant_filenames()

    findings: list[Finding] = []
    pinned_count = 0
    for rule in rules:
        pinned, _ = is_pinned(rule, invariants)
        if pinned:
            pinned_count += 1
            continue
        findings.append(
            Finding(
                file=rule.file,
                line=rule.line,
                severity="MEDIUM",
                rule=rule.raw,
                description=(
                    f"Design rule on line {rule.line} of `{rule.file}` is not pinned "
                    "by any filename keyword in `supabase/tests/invariants/`. "
                    "Add a pgTAP invariant test, or accept the rule as advisory and "
                    "remove the must/never/always wording."
                ),
                topic_keywords=rule.topic_keywords,
            )
        )

    findings.sort(key=lambda f: (f.file, f.line))

    artifact = {
        "gate": "audit_invariants_pinned",
        "lens": "L11",
        "stats": {
            "rules_total": len(rules),
            "rules_pinned": pinned_count,
            "rules_unpinned": len(findings),
            "invariant_files": len(invariants),
        },
        "findings": [f.as_dict() for f in findings],
    }
    out_json = Path(args.json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    lines = [
        "# Invariants Pinned (Lens L11)",
        "",
        f"Total rules detected: **{len(rules)}**",
        f"Pinned by an invariant test: **{pinned_count}**",
        f"Unpinned (findings): **{len(findings)}**",
        f"Invariant test files scanned: **{len(invariants)}**",
        "",
    ]
    if findings:
        lines.append("## Findings")
        lines.append("")
        for f in findings[:300]:
            lines.append(f"- `{f.file}:{f.line}` — _{f.rule}_  ")
            lines.append(
                f"  keywords: {', '.join(f.topic_keywords) if f.topic_keywords else '-'}"
            )
            lines.append("")
        if len(findings) > 300:
            lines.append(f"_(...and {len(findings) - 300} more, see JSON.)_")
    else:
        lines.append("## Findings")
        lines.append("")
        lines.append("None — every detected rule has at least one matching invariant test.")
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
