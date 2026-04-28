"""Naming hygiene invariant — pin the lesson from the
``_mint_pi_lot_for_inventory_only_pick`` confusion.

Background (decisions.md #45 + the retro):

    The original helper was named ``_mint_pi_lot_for_inventory_only_pick``.
    The name "mint" misled subsequent agents into thinking it was the
    deprecated catalog-mint code path that decision #45 forbade. It was
    actually the populate-mirror path (Pi-local cache row mirroring an
    existing cloud lot). The confusion led to follow-up bugs and
    near-regressions of decision #45 on every code review since.

    The function was renamed in 2026-04-27 to
    ``_populate_pi_lot_mirror_from_cloud`` to make its intent
    self-evident.

What this invariant pins:

    Any function under ``server/handlers/`` or ``server/classifier/``
    whose name contains "mint" MUST carry a docstring that explicitly
    documents whether it is the populate-mirror path or the
    catalog-mint path. Without that signpost, the next agent has to
    reverse-engineer the intent from the code and risks mis-naming a
    sibling helper or invoking the wrong one.

How: AST-walk every Python module in the live-shelf server package
under the watched directories, find every ``def`` whose name contains
"mint", and assert the docstring contains one of the explicit signal
phrases. Adding a new function with "mint" in its name without the
signal trips this test.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest


_SERVER_ROOT = Path(__file__).resolve().parents[2]

# Directories whose Python files are subject to the naming rule.
# Limit to surfaces where lot-mint vs populate-mirror confusion can
# bite — handlers (apply path) and classifier (candidate selection).
_WATCHED_DIRS = (
    _SERVER_ROOT / "handlers",
    _SERVER_ROOT / "classifier",
)

# Phrases that, if present in the docstring, prove the author thought
# about the distinction. Any one is sufficient.
_DISAMBIGUATION_PHRASES = (
    "populate-mirror",
    "populate mirror",
    "Pi-local cache",
    "Pi-local mirror",
    "decisions.md #45",
    "decision #45",
    "catalog-mint",
    "catalog mint",
    "NOT a 'mint'",
    "NOT a mint",
    "NOT a creation",
    "NOT a \"mint\"",
    "minting from a place event is forbidden",
    "do NOT mint",
    "this is the populate-mirror path",
)


def _iter_watched_python_files():
    for d in _WATCHED_DIRS:
        if not d.is_dir():
            continue
        for path in d.rglob("*.py"):
            # Skip tests + cached bytecode dirs.
            if "tests" in path.parts:
                continue
            if "__pycache__" in path.parts:
                continue
            yield path


def _functions_with_mint_in_name(path: Path):
    """Yield (qualified_name, ast.FunctionDef) for every def whose
    name contains "mint" (case-insensitive)."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if "mint" in node.name.lower():
                yield path, node


def _has_disambiguation(node: ast.AST) -> bool:
    doc = ast.get_docstring(node) or ""
    return any(phrase.lower() in doc.lower() for phrase in _DISAMBIGUATION_PHRASES)


# --- Tests -----------------------------------------------------------------


class TestNoCatalogMintNamingDrift:
    """Pin: every ``mint``-named function under handlers/ and classifier/
    must carry a docstring that disambiguates "populate-mirror" from
    "catalog-mint" — the lesson from
    ``_mint_pi_lot_for_inventory_only_pick``.
    """

    def test_every_mint_function_documents_its_intent(self):
        offenders: list[str] = []
        seen_any = False
        for path, node in (
            (p, fn)
            for path in _iter_watched_python_files()
            for (p, fn) in _functions_with_mint_in_name(path)
        ):
            seen_any = True
            if not _has_disambiguation(node):
                rel = path.relative_to(_SERVER_ROOT.parent)
                offenders.append(
                    f"{rel}::{node.name} (line {node.lineno}) — docstring "
                    f"missing populate-mirror / catalog-mint disambiguation"
                )

        if offenders:
            pytest.fail(
                "Naming hygiene violation: functions with 'mint' in the "
                "name MUST disambiguate populate-mirror vs catalog-mint "
                "intent in their docstring (decisions.md #45 + the "
                "retro on `_mint_pi_lot_for_inventory_only_pick`). "
                "Either rename the function, or add one of: "
                f"{list(_DISAMBIGUATION_PHRASES)} to the docstring.\n\n"
                "Offenders:\n  - " + "\n  - ".join(offenders)
            )

        # Belt-and-braces — if no mint-named functions exist at all,
        # the test is trivially passing for the wrong reason.
        # Currently `_mint_pi_lot_for_catalog_pick` (intentional
        # catalog mint per decision #54) covers this.
        assert seen_any, (
            "No 'mint'-named functions found under handlers/ or "
            "classifier/. The test is trivially passing — verify "
            "the watched dirs are correct."
        )
