#!/usr/bin/env python3
"""Test quality static analyzer for luna-hub-lite.

Walks the test directories and flags shallow-coverage patterns that
frequently produce false-positive tests — tests that pass while the
code under test is broken. Intentionally heuristic: regex + simple
state machines over JS/TS/SQL, ast (best-effort) over Python.

Usage:
    python3 scripts/audit_test_quality.py            # human-readable
    python3 scripts/audit_test_quality.py --json     # write JSON report
    python3 scripts/audit_test_quality.py --quiet    # summary only

Exit code:
    0 — no CRITICAL findings
    1 — at least one CRITICAL finding (suitable for CI gating)
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Iterator

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Directories to walk + exclude rules
# ---------------------------------------------------------------------------

INCLUDE_DIRS: list[Path] = [
    REPO_ROOT / "apps" / "web" / "src" / "__tests__",
    REPO_ROOT / "apps" / "web" / "e2e",
    REPO_ROOT / "apps" / "mcp-worker" / "src" / "__tests__",
    REPO_ROOT / "packages" / "app-tools" / "src" / "__tests__",
    REPO_ROOT / "hardware" / "live-shelf" / "server",  # subtrees filtered below
    REPO_ROOT / "supabase" / "tests",
    REPO_ROOT / "scripts",  # for e2e_shelf_ingest_prod.py
]

EXCLUDE_PATH_FRAGMENTS = (
    "/node_modules/",
    "/.venv/",
    "/site-packages/",
    "/.git/",
    "/legacy/",
    "/dist/",
    "/build/",
    "/.next/",
)

TS_EXTS = {".ts", ".tsx"}
PY_EXTS = {".py"}
SQL_EXTS = {".sql"}


@dataclass
class Finding:
    file: str
    test_name: str
    line: int
    pattern: str
    severity: str  # CRITICAL / HIGH / MEDIUM / LOW
    excerpt: str

    def as_dict(self) -> dict:
        return asdict(self)


SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------


def iter_test_files() -> Iterator[Path]:
    for root in INCLUDE_DIRS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            p = str(path)
            if any(frag in p for frag in EXCLUDE_PATH_FRAGMENTS):
                continue
            ext = path.suffix
            name = path.name
            if ext in TS_EXTS:
                if name.endswith(".test.ts") or name.endswith(".test.tsx") or name.endswith(".spec.ts"):
                    yield path
            elif ext in PY_EXTS:
                if name.startswith("test_") or name.endswith("_test.py"):
                    yield path
                elif path == REPO_ROOT / "scripts" / "e2e_shelf_ingest_prod.py":
                    yield path
            elif ext in SQL_EXTS:
                if "tests" in path.parts:
                    yield path


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def excerpt(line_text: str, max_len: int = 160) -> str:
    s = line_text.rstrip()
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# JS/TS analyzer
# ---------------------------------------------------------------------------

# Match test declarations: it/test/describe + optional modifiers (.skip/.todo/.only/.each)
TS_TEST_DECL = re.compile(
    r"""
    \b(?P<fn>it|test|describe)
    (?P<mod>\.(?:skip|todo|only|each)(?:\(.*?\))?)?
    \s*\(
    \s*
    (?P<str>
        '(?:\\.|[^'\\])*'
      | "(?:\\.|[^"\\])*"
      | `(?:\\.|[^`\\])*`
    )
    """,
    re.VERBOSE | re.DOTALL,
)

TS_DISABLED_NAMES = re.compile(
    r"""\b(xit|xdescribe|xtest)\s*\(""",
    re.VERBOSE,
)

# Weak matcher patterns (inside a test block)
TS_WEAK_MATCHERS = [
    ("toBeTruthy", re.compile(r"\.toBeTruthy\s*\(\s*\)")),
    ("toBeFalsy", re.compile(r"\.toBeFalsy\s*\(\s*\)")),
    ("toBeDefined", re.compile(r"\.toBeDefined\s*\(\s*\)")),
    ("not.toBeNull", re.compile(r"\.not\.toBeNull\s*\(\s*\)")),
    ("not.toBeUndefined", re.compile(r"\.not\.toBeUndefined\s*\(\s*\)")),
    ("expect.anything", re.compile(r"expect\.anything\s*\(\s*\)")),
    ("expect.any", re.compile(r"expect\.any\s*\(")),  # any() is weak-ish
]

# Strong matchers — presence of any of these in a test body indicates the
# test probably has real value assertions and the weak/count-only findings
# are likely incidental companions.
TS_STRONG_MATCHER_RE = re.compile(
    r"\.(?:"
    r"toBe|toEqual|toStrictEqual|toMatchObject|toContain|toContainEqual"
    r"|toHaveProperty|toMatchSnapshot|toBeCloseTo|toMatch|toHaveLength"
    r"|toBeGreaterThan|toBeLessThan|toBeGreaterThanOrEqual|toBeLessThanOrEqual"
    r"|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith"
    r"|toThrow|toThrowError|rejects|resolves"
    r")\s*\("
)

# Matchers that accept a concrete value (not expect.anything/any). Used to
# tell "expect(x).toBe(42)" apart from "expect(x).toBe(expect.anything())".
# The raw regex for presence-only — we additionally inspect the argument.

# Count-only: expect(...length).toBe(n) / toEqual(n) / toBeGreaterThan(n) etc.
TS_COUNT_ONLY = re.compile(
    r"expect\(\s*[^\)]*\.length\s*\)\s*\.\s*"
    r"(toBe|toEqual|toBeGreaterThan|toBeLessThan|toBeGreaterThanOrEqual|toBeLessThanOrEqual|toHaveLength)\s*\("
)

# Mock tautology: expect(mock).toHaveBeenCalledWith(someVar) where someVar is
# trivially derived within the test (same scope, no transformation). We flag
# any toHaveBeenCalledWith that takes a bare identifier or expect.anything
# as argument — that's the class of assertions that can pass regardless of
# real behavior.
TS_MOCK_WEAK_CALL = re.compile(
    r"\.toHaveBeenCalledWith\s*\(\s*(expect\.anything\s*\(\s*\)|expect\.any\s*\([^)]*\))\s*\)"
)

# Silent-skip parametrization: test.each([]) / it.each([])
TS_EMPTY_EACH = re.compile(r"\b(it|test|describe)\.each\s*\(\s*\[\s*\]\s*\)")

# Timeout-masked: Playwright/Vitest timeout > 30000
TS_BIG_TIMEOUT = re.compile(r"\btimeout\s*:\s*(\d{5,})")
TS_BIG_TIMEOUT_SECOND = re.compile(
    r"\b(?:it|test)\s*\([^,]+,[^,]+,\s*(\d{5,})\s*\)"
)

# try/catch with swallowed assertion — catch block containing no expect( at any depth
# (detected via per-test scanning below)

# Tautology: variable compared to itself (rough)
TS_SELF_COMPARE = re.compile(
    r"expect\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)\s*\.\s*"
    r"(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)"
)


def _find_block(text: str, open_idx: int) -> tuple[int, int] | None:
    """Given position of '{' char, return (start, end) of matched block.

    Very rough brace matcher — ignores braces inside strings/regex/comments
    heuristically. Good enough for flagging, not for semantic correctness.
    """
    depth = 0
    i = open_idx
    in_str: str | None = None
    in_line_comment = False
    in_block_comment = False
    n = len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return (open_idx, i + 1)
        i += 1
    return None


def _line_of(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def _extract_ts_tests(text: str) -> list[tuple[str, str, int, int, int, str]]:
    """Return list of (kind, name, start_idx, end_idx, line, modifier).

    Strategy: after the test name string, find the `=>` of the arrow
    function (most tests use arrow callbacks). The `{` *after* that is
    the true body. For non-arrow (`function () { ... }`) callbacks we
    fall back to the first `{` after the `)` of the first argument list.
    """
    out = []
    for m in TS_TEST_DECL.finditer(text):
        fn = m.group("fn")
        mod_raw = m.group("mod") or ""
        raw_name = m.group("str") or ""
        name = raw_name[1:-1] if len(raw_name) >= 2 else raw_name
        tail = m.end()
        # Scan a bounded window to find the callback body.
        window_end = min(len(text), tail + 4000)
        window = text[tail:window_end]
        # Prefer '=>' body (arrow fn)
        arrow = window.find("=>")
        brace_idx = -1
        if arrow >= 0:
            after_arrow = tail + arrow + 2
            b = text.find("{", after_arrow)
            if 0 <= b <= after_arrow + 20:
                brace_idx = b
        if brace_idx < 0:
            # fallback: `function (...) { ... }` form or just `it('x', () => expr)`
            # look for 'function' keyword in window
            fn_kw = re.search(r"\bfunction\b", window)
            if fn_kw:
                after_fn = tail + fn_kw.end()
                b = text.find("{", after_fn)
                if b >= 0:
                    brace_idx = b
        if brace_idx < 0:
            # last resort: first '{' after the name — may be wrong (destructure)
            # so we skip tests where we can't confidently locate the body.
            continue
        block = _find_block(text, brace_idx)
        if not block:
            continue
        start, end = block
        line = _line_of(text, m.start())
        out.append((fn, name, start, end, line, mod_raw))
    return out


def _catch_without_expect(block_text: str) -> list[int]:
    """Return relative offsets of catch clauses whose body lacks `expect(`
    or `fail(` / `throw`.

    Recognizes the "collect into failures[] then throw at end" pattern by
    looking for `.push(` inside catch plus a later `throw` in the outer
    block. Ignores catches inside nested request/response callbacks — those
    typically discard expected parse errors, not test assertions.
    """
    hits = []
    # Is there a later `throw` in the outer block? If so, catch-to-list
    # patterns are legitimate.
    outer_throws = bool(re.search(r"\bthrow\s+new\s+", block_text))
    # Find catch blocks: catch( ... ) { ... }  or catch { ... }
    pat = re.compile(r"\bcatch\s*(?:\([^)]*\))?\s*\{")
    for m in pat.finditer(block_text):
        open_brace = m.end() - 1
        blk = _find_block(block_text, open_brace)
        if not blk:
            continue
        bstart, bend = blk
        body = block_text[bstart + 1 : bend - 1]
        # skip if the body is empty/whitespace only — flag harder
        stripped = re.sub(r"//[^\n]*", "", body)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        stripped = stripped.strip()
        if not stripped:
            hits.append(m.start())
            continue
        if ("expect(" in body) or ("throw" in body) or (".fail(" in body) or re.search(r"\breject\w*\(", body):
            continue
        # Capture-then-rethrow-later pattern: catch pushes onto a list and
        # the outer test body throws based on that list.
        if re.search(r"\.push\s*\(", body) and outer_throws:
            continue
        hits.append(m.start())
    return hits


def analyze_ts(path: Path, findings: list[Finding]) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return

    # File-level: disabled-test names (xit/xdescribe)
    for m in TS_DISABLED_NAMES.finditer(text):
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=_line_of(text, m.start()),
                pattern="disabled-test",
                severity="MEDIUM",
                excerpt=excerpt(text.splitlines()[_line_of(text, m.start()) - 1]),
            )
        )

    # File-level: silent-skip parametrization with empty array
    for m in TS_EMPTY_EACH.finditer(text):
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=_line_of(text, m.start()),
                pattern="empty-parametrization",
                severity="CRITICAL",
                excerpt=excerpt(text.splitlines()[_line_of(text, m.start()) - 1]),
            )
        )

    # Per-test scanning
    tests = _extract_ts_tests(text)
    file_has_test = any(t[0] in ("it", "test") for t in tests)
    file_has_error_case = False
    error_case_re = re.compile(
        r"\.(rejects|throws|toThrow|toReject)\b|\bisError\s*:\s*true\b|\.not\.toEqual\(\s*undefined|expect\(.*?\)\s*\.\s*toThrow|await\s+expect\(.*?\)\s*\.\s*rejects"
    )
    if error_case_re.search(text):
        file_has_error_case = True

    for kind, name, start, end, line, mod in tests:
        if kind == "describe":
            continue
        body = text[start:end]

        # Does the test body contain at least one strong-matcher call?
        # Used to dampen weak-matcher and count-only severity when a real
        # value-checking assertion is present alongside the weak one.
        has_strong = bool(TS_STRONG_MATCHER_RE.search(body))
        # Count expect(...) calls — tests with a single assertion that is
        # weak are far more dangerous than tests with 10 strong + 1 weak.
        expect_count = len(re.findall(r"\bexpect\s*\(", body))

        # Disabled/todo modifier
        if mod:
            if ".skip" in mod:
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=name,
                        line=line,
                        pattern="disabled-test",
                        severity="MEDIUM",
                        excerpt=excerpt(text.splitlines()[line - 1]),
                    )
                )
            if ".todo" in mod:
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=name,
                        line=line,
                        pattern="disabled-test",
                        severity="LOW",
                        excerpt=excerpt(text.splitlines()[line - 1]),
                    )
                )
            if ".only" in mod:
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=name,
                        line=line,
                        pattern="only-focus",
                        severity="HIGH",
                        excerpt=excerpt(text.splitlines()[line - 1]),
                    )
                )
            if ".each" in mod:
                # Detect empty-each with modifier too (already caught but redundant-safe)
                each_match = re.search(r"\.each\s*\(\s*\[\s*\]\s*\)", mod)
                if each_match:
                    findings.append(
                        Finding(
                            file=rel(path),
                            test_name=name,
                            line=line,
                            pattern="empty-parametrization",
                            severity="CRITICAL",
                            excerpt=excerpt(text.splitlines()[line - 1]),
                        )
                    )

        # Weak matchers
        for label, pat in TS_WEAK_MATCHERS:
            weak_hits = list(pat.finditer(body))
            for wm in weak_hits:
                # Default severity by matcher family
                sev = "MEDIUM" if label in ("toBeTruthy", "toBeFalsy") else "LOW"
                # Promote: if this is the ONLY assertion in the test, it's
                # highly likely a false-positive test.
                if expect_count <= 1 and not has_strong:
                    sev = "CRITICAL" if label in ("toBeTruthy", "toBeFalsy") else "HIGH"
                # Demote: if the test has 2+ strong matchers nearby, weak
                # matchers are usually incidental (e.g. `expect(x).toBeDefined();
                # expect(x.name).toBe('foo')`). Drop LOW further to LOW (noop)
                # but drop MEDIUM → LOW.
                elif has_strong and sev == "MEDIUM":
                    sev = "LOW"
                local_line = line + body.count("\n", 0, wm.start())
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=name,
                        line=local_line,
                        pattern=f"weak-matcher:{label}",
                        severity=sev,
                        excerpt=excerpt(text.splitlines()[local_line - 1] if local_line - 1 < len(text.splitlines()) else ""),
                    )
                )

        # Mock tautology: toHaveBeenCalledWith(expect.anything()) etc.
        for mm in TS_MOCK_WEAK_CALL.finditer(body):
            local_line = line + body.count("\n", 0, mm.start())
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=name,
                    line=local_line,
                    pattern="mock-tautology",
                    severity="HIGH",
                    excerpt=excerpt(
                        text.splitlines()[local_line - 1]
                        if local_line - 1 < len(text.splitlines())
                        else ""
                    ),
                )
            )

        # Self-compare tautology
        for tm in TS_SELF_COMPARE.finditer(body):
            local_line = line + body.count("\n", 0, tm.start())
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=name,
                    line=local_line,
                    pattern="tautology-self-compare",
                    severity="CRITICAL",
                    excerpt=excerpt(
                        text.splitlines()[local_line - 1]
                        if local_line - 1 < len(text.splitlines())
                        else ""
                    ),
                )
            )

        # Count-only assertions — flag when no OTHER expectation in the
        # same test verifies a specific row's field value. `length` on its
        # own is insufficient: if the query returns the wrong rows but the
        # correct count, the test still passes.
        count_only_matches = list(TS_COUNT_ONLY.finditer(body))
        if count_only_matches:
            # A "specific" assertion looks at a member/field/item of the
            # array under test. Heuristics:
            #   - expect(arr[N]...)
            #   - expect(thing.find(...))
            #   - expect(arr[0].field)
            #   - toMatchObject / toEqual / toContainEqual / toHaveProperty
            #     / toMatch  (value-shape assertions)
            strong_shape = re.search(
                r"expect\([^)]*\)\.(?:toEqual|toStrictEqual|toMatchObject|toContain|toContainEqual|toHaveProperty|toMatchSnapshot|toMatch)\s*\(",
                body,
            )
            # expect(data[0]...) / expect(data![0]...) / expect(rows[0].field) /
            # expect(Number(data[0].x)) / expect(data[0]?.field) …
            # Allow any number of wrapping calls/operators before `[N]`.
            has_indexed = re.search(
                r"expect\(\s*[^)]*?[A-Za-z_$][\w$]*!?\??\s*\[\s*\d+\s*\]",
                body,
            )
            has_find_or_filter = re.search(
                r"\.(?:find|filter|some|every|map)\s*\(",
                body,
            )
            # toBe(<literal>) counts as "value check" — strings, numbers (non-
            # zero is a signal; zero-length counts may be the same as length
            # checks), booleans, null. The regex accepts any simple literal
            # argument. Explicitly excludes a single numeric literal so that
            # `.toBe(n)` on a length is still flagged as count-only.
            has_value_toBe = re.search(
                r"expect\([^)]*\)\s*\.\s*toBe\s*\(\s*"
                r"(?:'[^']*'|\"[^\"]*\"|`[^`]*`|true|false|null|undefined)\s*\)",
                body,
            )
            # toBeCloseTo always checks a numeric value — that's a real check
            has_close_to = ".toBeCloseTo(" in body
            # Number(x).toBe(n) — classic numeric equality, strong
            has_number_toBe = bool(
                re.search(
                    r"expect\(\s*Number\s*\([^)]+\)\s*\)\s*\.\s*toBe\s*\(\s*\d",
                    body,
                )
            )
            is_shallow = not (
                strong_shape
                or has_indexed
                or has_find_or_filter
                or has_value_toBe
                or has_close_to
                or has_number_toBe
            )
            if is_shallow:
                for cm in count_only_matches:
                    local_line = line + body.count("\n", 0, cm.start())
                    findings.append(
                        Finding(
                            file=rel(path),
                            test_name=name,
                            line=local_line,
                            pattern="count-only-assertion",
                            severity="HIGH",
                            excerpt=excerpt(
                                text.splitlines()[local_line - 1]
                                if local_line - 1 < len(text.splitlines())
                                else ""
                            ),
                        )
                    )

        # Timeout-masked
        for tm in TS_BIG_TIMEOUT.finditer(body):
            ms = int(tm.group(1))
            if ms > 30000:
                local_line = line + body.count("\n", 0, tm.start())
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=name,
                        line=local_line,
                        pattern=f"big-timeout:{ms}ms",
                        severity="LOW",
                        excerpt=excerpt(
                            text.splitlines()[local_line - 1]
                            if local_line - 1 < len(text.splitlines())
                            else ""
                        ),
                    )
                )

        # try/catch without expect in catch
        for co in _catch_without_expect(body):
            local_line = line + body.count("\n", 0, co)
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=name,
                    line=local_line,
                    pattern="catch-swallows-error",
                    severity="HIGH",
                    excerpt=excerpt(
                        text.splitlines()[local_line - 1]
                        if local_line - 1 < len(text.splitlines())
                        else ""
                    ),
                )
            )

        # Empty body (no assertions, no function calls)
        body_inner = body[body.find("{") + 1 : body.rfind("}")]
        stripped = re.sub(r"//[^\n]*", "", body_inner)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL).strip()
        if stripped == "":
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=name,
                    line=line,
                    pattern="empty-test-body",
                    severity="HIGH",
                    excerpt=excerpt(text.splitlines()[line - 1]),
                )
            )
        elif not re.search(
            r"\bexpect\s*\(|\bassert\s*\(|\bexpectError\s*\(|\bexpectDbRow\s*\(|\bcountDbRows\s*\(",
            body_inner,
        ):
            # no assertion at all — could be a todo stub
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=name,
                    line=line,
                    pattern="no-assertion",
                    severity="HIGH",
                    excerpt=excerpt(text.splitlines()[line - 1]),
                )
            )

    # Happy-path-only at file level (skip e2e and integration — they often test full flows)
    if file_has_test and not file_has_error_case:
        # Only flag for unit suites — integration/e2e often legitimately focus on happy paths
        p = rel(path)
        if ("/unit/" in p) or ("/__tests__/unit/" in p) or (p.endswith(".test.ts") and "/integration/" not in p and "/e2e/" not in p):
            findings.append(
                Finding(
                    file=p,
                    test_name="(file-level)",
                    line=1,
                    pattern="happy-path-only-file",
                    severity="LOW",
                    excerpt=excerpt(path.name + " — no error-case assertion detected"),
                )
            )


# ---------------------------------------------------------------------------
# Python analyzer (ast where possible, regex fallback)
# ---------------------------------------------------------------------------


PY_WEAK_MATCHERS_IN_ASSERT = re.compile(
    r"\bassert\s+[A-Za-z_][A-Za-z0-9_\.\[\]\(\)]*\s*(?:#.*)?$",
    re.MULTILINE,
)


def _py_has_decorator(node: ast.FunctionDef, *names: str) -> str | None:
    for d in node.decorator_list:
        # @pytest.mark.skip / @pytest.mark.skipif
        src = ast.unparse(d) if hasattr(ast, "unparse") else ""
        for n in names:
            if n in src:
                return src
    return None


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        return _call_name(node.func)
    if isinstance(node, ast.Attribute):
        return f"{_call_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def analyze_py(path: Path, findings: list[Finding]) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return  # best-effort
    lines = text.splitlines()

    # Walk top-level and class-level test functions
    def walk_funcs(body, class_name: str | None = None):
        for node in body:
            if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                yield from walk_funcs(node.body, node.name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("test_"):
                    yield node, class_name

    file_has_error_case = False
    # Crude scan: any "with pytest.raises" or "assertRaises"
    if re.search(r"\bpytest\.raises\b|\.assertRaises\b|\braises\s*=\s*", text):
        file_has_error_case = True

    for fn, cls in walk_funcs(tree.body):
        qname = f"{cls}::{fn.name}" if cls else fn.name

        # Disabled via decorator
        dec = _py_has_decorator(fn, "skip", "skipif", "xfail")
        if dec:
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=qname,
                    line=fn.lineno,
                    pattern="disabled-test",
                    severity="MEDIUM" if "xfail" not in dec else "LOW",
                    excerpt=excerpt(f"decorator: {dec}"),
                )
            )

        # parametrize with empty list
        for d in fn.decorator_list:
            src = ast.unparse(d) if hasattr(ast, "unparse") else ""
            if "parametrize" in src and re.search(r"\[\s*\]", src):
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=qname,
                        line=fn.lineno,
                        pattern="empty-parametrization",
                        severity="CRITICAL",
                        excerpt=excerpt(src),
                    )
                )
            if "timeout" in src:
                m = re.search(r"timeout\s*[=(]\s*(\d+)", src)
                if m and int(m.group(1)) > 30:
                    findings.append(
                        Finding(
                            file=rel(path),
                            test_name=qname,
                            line=fn.lineno,
                            pattern=f"big-timeout:{m.group(1)}s",
                            severity="LOW",
                            excerpt=excerpt(src),
                        )
                    )

        # Walk inside the function
        asserts: list[ast.Assert] = []
        has_expect_raises = False
        has_raises_in_catch: list[ast.Try] = []
        for child in ast.walk(fn):
            if isinstance(child, ast.Assert):
                asserts.append(child)
            elif isinstance(child, ast.With):
                for item in child.items:
                    src = ast.unparse(item.context_expr) if hasattr(ast, "unparse") else ""
                    if "pytest.raises" in src or "assertRaises" in src:
                        has_expect_raises = True
            elif isinstance(child, ast.Try):
                # try/except that doesn't assert or re-raise
                for handler in child.handlers:
                    hs = handler.body
                    has_assert_or_raise = any(
                        isinstance(n, (ast.Assert, ast.Raise))
                        or (
                            isinstance(n, ast.Expr)
                            and isinstance(n.value, ast.Call)
                            and "fail" in _call_name(n.value)
                        )
                        for n in ast.walk(handler) if not isinstance(n, ast.Try)
                    )
                    # Pattern: except captures into an `errors.append(exc)` list;
                    # the actual assertion is `assert not errors` later in the
                    # test body. Treat that as legitimate — the errors list is
                    # referenced later.
                    handler_src = ast.unparse(handler) if hasattr(ast, "unparse") else ""
                    captures_to_list = bool(
                        re.search(r"\b\w+\.append\s*\(", handler_src)
                    )
                    errors_asserted_later = False
                    if captures_to_list:
                        # crude: is there `assert ... error` or `assert not error`
                        # in the function body referencing similar names?
                        fn_src_outer = ast.unparse(fn) if hasattr(ast, "unparse") else ""
                        if re.search(
                            r"assert\s+(?:not\s+)?(?:len\()?\s*(?:errors?|exc|exceptions?|failures?)",
                            fn_src_outer,
                        ):
                            errors_asserted_later = True
                    if not has_assert_or_raise and not errors_asserted_later:
                        # pass / ... / print / nothing — swallow
                        only_pass = all(
                            isinstance(n, (ast.Pass, ast.Expr))
                            for n in hs
                        )
                        if only_pass:
                            findings.append(
                                Finding(
                                    file=rel(path),
                                    test_name=qname,
                                    line=handler.lineno,
                                    pattern="catch-swallows-error",
                                    severity="HIGH",
                                    excerpt=excerpt(
                                        lines[handler.lineno - 1]
                                        if handler.lineno - 1 < len(lines)
                                        else ""
                                    ),
                                )
                            )

        # Empty body / no assertions
        # A body that is just a docstring + pass counts as empty.
        def _meaningful(stmts: list[ast.stmt]) -> bool:
            for s in stmts:
                if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str):
                    continue
                if isinstance(s, ast.Pass):
                    continue
                return True
            return False

        if not _meaningful(fn.body):
            findings.append(
                Finding(
                    file=rel(path),
                    test_name=qname,
                    line=fn.lineno,
                    pattern="empty-test-body",
                    severity="HIGH",
                    excerpt=excerpt(lines[fn.lineno - 1] if fn.lineno - 1 < len(lines) else ""),
                )
            )
        else:
            fn_src = ast.unparse(fn) if hasattr(ast, "unparse") else ""
            has_helper_assert = bool(
                re.search(
                    r"\bself\.assert|\bcheck\s*\(|\bverify\w*\s*\(|\bexpect\w*\s*\(|\bassert_\w+\s*\(",
                    fn_src,
                )
            )
            # Intentional "should not raise" tests — the call itself IS the
            # assertion (pytest fails the test if it raises). Recognize by
            # function name: swallow, no_raise, does_not_raise, is_noop,
            # handles, survives.
            noraise_name = bool(
                re.search(
                    r"(?:swallow|no_raise|does_not_raise|is_noop|is_no_op|handles_|survives_|tolerates_)",
                    fn.name,
                )
            )
            if not asserts and not has_expect_raises and not has_helper_assert and not noraise_name:
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=qname,
                        line=fn.lineno,
                        pattern="no-assertion",
                        severity="HIGH",
                        excerpt=excerpt(lines[fn.lineno - 1] if fn.lineno - 1 < len(lines) else ""),
                    )
                )

        # Weak assertions: `assert x` with a single name (truthy-only)
        for a in asserts:
            if isinstance(a.test, ast.Name) or (
                isinstance(a.test, ast.Attribute)
                and isinstance(a.test.value, ast.Name)
            ):
                findings.append(
                    Finding(
                        file=rel(path),
                        test_name=qname,
                        line=a.lineno,
                        pattern="weak-matcher:truthy-only",
                        severity="MEDIUM",
                        excerpt=excerpt(
                            lines[a.lineno - 1] if a.lineno - 1 < len(lines) else ""
                        ),
                    )
                )

        # Tautology: `assert x == x` or `for y in LIST: assert y in LIST`
        for a in asserts:
            if isinstance(a.test, ast.Compare) and len(a.test.ops) == 1:
                left_src = ast.unparse(a.test.left) if hasattr(ast, "unparse") else ""
                right_src = (
                    ast.unparse(a.test.comparators[0])
                    if hasattr(ast, "unparse")
                    else ""
                )
                if left_src and left_src == right_src:
                    findings.append(
                        Finding(
                            file=rel(path),
                            test_name=qname,
                            line=a.lineno,
                            pattern="tautology-self-compare",
                            severity="CRITICAL",
                            excerpt=excerpt(
                                lines[a.lineno - 1] if a.lineno - 1 < len(lines) else ""
                            ),
                        )
                    )

        # for-loop tautology: `for x in ALLOWED: assert x in ALLOWED`
        for child in ast.walk(fn):
            if isinstance(child, ast.For):
                iter_src = (
                    ast.unparse(child.iter) if hasattr(ast, "unparse") else ""
                )
                target_src = (
                    ast.unparse(child.target) if hasattr(ast, "unparse") else ""
                )
                for n in ast.walk(child):
                    if isinstance(n, ast.Assert) and isinstance(n.test, ast.Compare):
                        if any(isinstance(op, ast.In) for op in n.test.ops):
                            left_src = (
                                ast.unparse(n.test.left) if hasattr(ast, "unparse") else ""
                            )
                            right_src = (
                                ast.unparse(n.test.comparators[0])
                                if hasattr(ast, "unparse")
                                else ""
                            )
                            if left_src == target_src and right_src == iter_src:
                                findings.append(
                                    Finding(
                                        file=rel(path),
                                        test_name=qname,
                                        line=n.lineno,
                                        pattern="tautology-iter-contains",
                                        severity="CRITICAL",
                                        excerpt=excerpt(
                                            lines[n.lineno - 1]
                                            if n.lineno - 1 < len(lines)
                                            else ""
                                        ),
                                    )
                                )

    # file-level happy-path-only
    any_test = any(
        isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_")
        for n in ast.walk(tree)
    )
    if any_test and not file_has_error_case:
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=1,
                pattern="happy-path-only-file",
                severity="LOW",
                excerpt=excerpt(path.name + " — no pytest.raises / assertRaises"),
            )
        )


# ---------------------------------------------------------------------------
# SQL (pgTAP) analyzer — lightweight
# ---------------------------------------------------------------------------

PLAN_RE = re.compile(r"\bSELECT\s+plan\s*\(\s*(\d+)\s*\)", re.IGNORECASE)
# Count top-level `is(`, `ok(`, `isnt(`, `throws_ok(`, etc. assertion calls.
ASSERT_RE = re.compile(
    r"\b(?:SELECT\s+)?("
    r"is|isnt|ok|throws_ok|lives_ok|results_eq|bag_eq|set_eq|row_eq"
    r"|has_table|has_column|col_is_pk|has_function|schemas_are|columns_are"
    r"|column_privs_are|function_privs_are|col_not_null|col_type_is"
    r"|has_index|has_trigger|has_schema|has_extension|has_enum"
    r"|is_empty|isnt_empty|cmp_ok|matches|doesnt_match|hasnt_\w+"
    r")\s*\(",
    re.IGNORECASE,
)


def analyze_sql(path: Path, findings: list[Finding]) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        return
    if not re.search(r"\bplan\s*\(", text, re.IGNORECASE):
        return  # helper file, not a pgTAP test
    m = PLAN_RE.search(text)
    if not m:
        return
    plan = int(m.group(1))
    asserts = len(ASSERT_RE.findall(text))
    if plan == 0:
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=_line_of(text, m.start()),
                pattern="pgtap-plan-zero",
                severity="CRITICAL",
                excerpt=excerpt(text.splitlines()[_line_of(text, m.start()) - 1]),
            )
        )
    elif asserts < plan:
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=_line_of(text, m.start()),
                pattern=f"pgtap-plan-mismatch:plan={plan}/asserts={asserts}",
                severity="HIGH",
                excerpt=excerpt(text.splitlines()[_line_of(text, m.start()) - 1]),
            )
        )
    # File with no throws_ok and no negative cases is happy-path only
    if not re.search(r"\bthrows_ok\b|\bisnt\b", text, re.IGNORECASE):
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=_line_of(text, m.start()),
                pattern="happy-path-only-file",
                severity="LOW",
                excerpt=excerpt("pgTAP file has no throws_ok / isnt assertions"),
            )
        )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# L9 extension: production-shape gap detection
# ---------------------------------------------------------------------------
#
# Per AUDIT_STRATEGY_MERGED.md §1 row L9: any test that pre-seeds rows
# (>0) must have a sibling ``*_empty`` test exercising the same code
# path with an EMPTY fixture. Otherwise the empty-table production
# path never gets exercised — exactly how the Pi `scale_pairings`
# empty-in-prod regression slipped through.
#
# Heuristic: a test "pre-seeds" if its body contains an INSERT or
# .insert(...) call before its first assertion. We mark the file as
# "seeded" and look for any sibling test in the same suite whose name
# ends in ``_empty`` / ``_no_rows`` / ``_zero``.
#
# Implementation note: scoping per file (not per test) — most pgTAP
# suites have one file per behavior, and unit suites use describe
# blocks for grouping. Per-file scoping captures both.

_PY_PRESEED_RE = re.compile(r"\bINSERT\s+INTO\b|\.insert\s*\(\s*\{|\binsert_one\s*\(", re.IGNORECASE)
_SQL_PRESEED_RE = re.compile(r"\bINSERT\s+INTO\b", re.IGNORECASE)
_TS_PRESEED_RE = re.compile(r"\.insert\s*\(\s*[\[{]")
_EMPTY_VARIANT_RE = re.compile(r"_empty\b|_no_rows\b|_zero\b|_blank\b", re.IGNORECASE)


def _ts_test_names(text: str) -> list[str]:
    return [n for _, n, *_ in _extract_ts_tests(text)]


def _py_test_names(text: str) -> list[str]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
            "test_"
        ):
            out.append(node.name)
    return out


def _file_has_preseed(text: str, ext: str) -> bool:
    if ext in TS_EXTS:
        return bool(_TS_PRESEED_RE.search(text))
    if ext in PY_EXTS:
        return bool(_PY_PRESEED_RE.search(text))
    if ext in SQL_EXTS:
        return bool(_SQL_PRESEED_RE.search(text))
    return False


def _file_has_empty_sibling(text: str, ext: str, file_path: Path) -> bool:
    """A file passes the L9 contract if either:

    1. it contains a test name with `_empty` / `_no_rows` / `_zero`, OR
    2. a sibling file in the same dir with such a suffix exists.
    """
    if ext in TS_EXTS:
        names = _ts_test_names(text)
    elif ext in PY_EXTS:
        names = _py_test_names(text)
    elif ext in SQL_EXTS:
        # pgTAP files with an "_empty" filename or has_table_empty assert
        return bool(_EMPTY_VARIANT_RE.search(file_path.stem)) or "is_empty" in text
    else:
        names = []
    if any(_EMPTY_VARIANT_RE.search(n or "") for n in names):
        return True
    sib_dir = file_path.parent
    stem = file_path.stem
    for sib in sib_dir.glob("*"):
        if sib == file_path or not sib.is_file():
            continue
        if sib.stem.startswith(stem) and _EMPTY_VARIANT_RE.search(sib.stem):
            return True
        if _EMPTY_VARIANT_RE.search(sib.stem) and stem.startswith(
            sib.stem.split("_empty")[0].split("_no_rows")[0].split("_zero")[0]
        ):
            return True
    return False


def analyze_l9_production_shape(findings: list[Finding]) -> None:
    """Append L9 findings: pre-seeded tests without an `_empty` sibling."""
    for path in iter_test_files():
        ext = path.suffix
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not _file_has_preseed(text, ext):
            continue
        if _file_has_empty_sibling(text, ext, path):
            continue
        findings.append(
            Finding(
                file=rel(path),
                test_name="(file-level)",
                line=1,
                pattern="missing-empty-fixture-variant",
                severity="MEDIUM",
                excerpt=(
                    f"{path.name} pre-seeds rows but has no sibling test/file "
                    f"with `_empty`/`_no_rows`/`_zero` suffix. L9 contract: "
                    f"every >0-row fixture needs an empty-table variant."
                ),
            )
        )


def analyze_all() -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_test_files():
        ext = path.suffix
        try:
            if ext in TS_EXTS:
                analyze_ts(path, findings)
            elif ext in PY_EXTS:
                analyze_py(path, findings)
            elif ext in SQL_EXTS:
                analyze_sql(path, findings)
        except Exception as exc:  # noqa: BLE001
            findings.append(
                Finding(
                    file=rel(path),
                    test_name="(analyzer-error)",
                    line=0,
                    pattern="analyzer-exception",
                    severity="LOW",
                    excerpt=f"{type(exc).__name__}: {exc}",
                )
            )
    analyze_l9_production_shape(findings)
    return findings


def format_summary(findings: list[Finding]) -> str:
    by_sev: Counter[str] = Counter(f.severity for f in findings)
    by_pat: Counter[str] = Counter(f.pattern.split(":")[0] for f in findings)
    lines = ["=" * 72, "Test Quality Audit — Summary", "=" * 72]
    lines.append("")
    lines.append("Findings by severity:")
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        lines.append(f"  {sev:<8} {by_sev.get(sev, 0)}")
    lines.append("")
    lines.append(f"Total findings: {len(findings)}")
    lines.append("")
    lines.append("Findings by pattern:")
    for pat, n in by_pat.most_common():
        lines.append(f"  {pat:<28} {n}")
    lines.append("")

    # Top per severity (first 20 of each of CRITICAL, HIGH)
    for sev in ("CRITICAL", "HIGH"):
        rows = [f for f in findings if f.severity == sev]
        if not rows:
            continue
        lines.append(f"--- {sev} findings ({len(rows)}) ---")
        for f in rows[:30]:
            lines.append(
                f"  [{f.pattern}] {f.file}:{f.line}  ::{f.test_name}"
            )
            lines.append(f"      {f.excerpt}")
        if len(rows) > 30:
            lines.append(f"  …and {len(rows) - 30} more")
        lines.append("")

    # Top files (most findings)
    per_file: Counter[str] = Counter(f.file for f in findings)
    lines.append("Top 15 files by finding count:")
    for f_path, n in per_file.most_common(15):
        lines.append(f"  {n:>4}  {f_path}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--json",
        metavar="PATH",
        nargs="?",
        const=str(REPO_ROOT / "scripts" / "test_quality_report.json"),
        default=None,
        help="Write JSON report to this path (default: scripts/test_quality_report.json)",
    )
    ap.add_argument("--quiet", action="store_true", help="Only print the summary")
    args = ap.parse_args()

    findings = analyze_all()
    findings.sort(key=lambda f: (SEVERITY_ORDER.get(f.severity, 99), f.file, f.line))

    if args.json:
        out_path = Path(args.json)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps([f.as_dict() for f in findings], indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {len(findings)} findings to {out_path}", file=sys.stderr)

    if not args.quiet:
        print(format_summary(findings))

    critical = sum(1 for f in findings if f.severity == "CRITICAL")
    return 0 if critical == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
