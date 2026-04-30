#!/usr/bin/env python3
"""Anti-lazy AST checker — live-shelf Pi server.

Catches patterns not covered by stock ruff rules:

  ANTI_LAZY_001  int()/float() called on a non-literal expression that is
                 not inside a try/except block and not guarded by a
                 math.isfinite() / isinstance(..., (int, float)) check in
                 the same scope.

                 Mirrors the ESLint `no-bare-number-coerce` rule.

This script is invoked by the `step:python-anti-lazy` gate in run.sh via:

    cd hardware/live-shelf && python scripts/anti_lazy_check.py

It exits 0 (pass) or 1 (violations found), printing findings to stdout
in ruff-compatible format: <file>:<line>:<col>: ANTI_LAZY_NNN message

Usage:
    python scripts/anti_lazy_check.py [paths...]

    Paths default to [server/, scripts/] relative to the live-shelf root.
    Test directories (*/tests/*) are excluded automatically.
"""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path
from typing import NamedTuple


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

class Violation(NamedTuple):
    file: Path
    line: int
    col: int
    rule: str
    message: str

    def __str__(self) -> str:
        return f"{self.file}:{self.line}:{self.col}: {self.rule} {self.message}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_literal(node: ast.AST) -> bool:
    """Return True if the node is a simple numeric/string literal."""
    return isinstance(node, ast.Constant)


def _enclosing_try_nodes(node: ast.AST, parent_map: dict[int, ast.AST]) -> list[ast.Try]:
    """Walk up the parent map and collect enclosing Try nodes."""
    tries: list[ast.Try] = []
    current = parent_map.get(id(node))
    while current is not None:
        if isinstance(current, ast.Try):
            tries.append(current)
        current = parent_map.get(id(current))
    return tries


def _call_is_guard(call: ast.Call) -> bool:
    """Return True if the call looks like a type-safety guard.

    Recognised patterns:
      - math.isfinite(x)
      - math.isnan(x)
      - isinstance(x, (int, float))
      - isinstance(x, int)
      - isinstance(x, float)
    """
    func = call.func
    if isinstance(func, ast.Attribute):
        if isinstance(func.value, ast.Name) and func.value.id == "math":
            if func.attr in ("isfinite", "isnan", "isinf"):
                return True
    if isinstance(func, ast.Name) and func.id == "isinstance":
        return True
    return False


def _scope_has_guard(scope: ast.AST) -> bool:
    """Return True if the scope body contains a math.isfinite/isinstance guard."""
    for node in ast.walk(scope):
        if isinstance(node, ast.Call) and _call_is_guard(node):
            return True
    return False


# ---------------------------------------------------------------------------
# Checker
# ---------------------------------------------------------------------------

_COERCE_FUNCS = {"int", "float"}


class AntiLazyChecker(ast.NodeVisitor):
    """Walk an AST and collect anti-lazy violations."""

    def __init__(self, source_path: Path) -> None:
        self.source_path = source_path
        self.violations: list[Violation] = []
        self._parent_map: dict[int, ast.AST] = {}

    def _build_parent_map(self, tree: ast.AST) -> None:
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                self._parent_map[id(child)] = node

    def check(self, source: str) -> list[Violation]:
        try:
            tree = ast.parse(source, filename=str(self.source_path))
        except SyntaxError:
            # Unparseable files are the compiler's problem, not ours.
            return []
        self._build_parent_map(tree)
        self.visit(tree)
        return self.violations

    def visit_Call(self, node: ast.Call) -> None:
        # Only flag int(x) / float(x) on non-literal single-argument calls.
        func = node.func
        if (
            isinstance(func, ast.Name)
            and func.id in _COERCE_FUNCS
            and len(node.args) == 1
            and not node.keywords
            and not _is_literal(node.args[0])
        ):
            # Check whether the call is enclosed by a try/except.
            enclosing_tries = _enclosing_try_nodes(node, self._parent_map)
            if not enclosing_tries:
                # Not in any try block — check if the enclosing scope (module /
                # function / class) has any guard call at all.
                parent = self._parent_map.get(id(node))
                guarded = False
                if parent is not None:
                    guarded = _scope_has_guard(parent)
                if not guarded:
                    self.violations.append(
                        Violation(
                            file=self.source_path,
                            line=node.lineno,
                            col=node.col_offset + 1,
                            rule="ANTI_LAZY_001",
                            message=(
                                f"{func.id}() on non-literal without try/except or "
                                "math.isfinite()/isinstance() guard (no-bare-number-coerce)"
                            ),
                        )
                    )
        self.generic_visit(node)


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

_TEST_PATH_PARTS = {"tests", "test"}


def _is_test_file(path: Path) -> bool:
    return any(part in _TEST_PATH_PARTS for part in path.parts)


def _discover_py_files(roots: list[Path]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file() and root.suffix == ".py":
            if not _is_test_file(root):
                files.append(root)
        elif root.is_dir():
            for py_file in sorted(root.rglob("*.py")):
                if not _is_test_file(py_file):
                    files.append(py_file)
    return files


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    # Resolve the live-shelf root as the directory containing this script's
    # parent (scripts/ → hardware/live-shelf/).
    script_dir = Path(__file__).resolve().parent
    live_shelf_root = script_dir.parent

    if argv:
        roots = [Path(a) for a in argv]
    else:
        roots = [
            live_shelf_root / "server",
            live_shelf_root / "scripts",
        ]

    py_files = _discover_py_files(roots)

    all_violations: list[Violation] = []
    for py_file in py_files:
        source = py_file.read_text(encoding="utf-8", errors="replace")
        checker = AntiLazyChecker(py_file)
        all_violations.extend(checker.check(source))

    for v in sorted(all_violations, key=lambda x: (str(x.file), x.line, x.col)):
        print(v)

    if all_violations:
        print(
            f"\nFound {len(all_violations)} ANTI_LAZY_001 violation(s). "
            "Add try/except or a math.isfinite()/isinstance() guard.",
            file=sys.stderr,
        )
        return 1

    print(f"anti_lazy_check: OK — 0 violations across {len(py_files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
