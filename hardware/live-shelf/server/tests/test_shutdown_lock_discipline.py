"""Static-analysis guard for the shutdown / worker-list lock discipline.

Why this test exists
====================

``ScaleEventHandler`` (``server/handlers/scale_events.py``) spawns
fire-and-forget worker threads from request handlers. Each spawn site
must decide whether to dispatch *while* atomically appending to
``self._workers``. Otherwise ``stop()`` may race the spawn:

    Spawn site            stop()
    ------------------    ----------------------------
    is_set()? False
                          set shutdown
                          snapshot + clear _workers
                          join() (empty)
                          conn.close()
    create + append       <-- thread later touches conn -> segfault

This regression class was the cause of the segfault that commit
``34895f0`` was supposed to eliminate. The fix is: every check of
``self._shutdown_event.is_set()`` in a spawn path must run *inside*
``with self._workers_lock:`` so the append in the same critical section
is atomic with the check.

This meta-test enforces that discipline at AST level so future spawn
sites (or refactors) can't reintroduce the bug. It is deterministic —
no race, no scheduler dependency — and runs as part of the regular
pytest suite.

Mechanism
---------

1. Parse ``scale_events.py`` (and ``app.py``) with the stdlib ``ast``
   module.
2. Walk every node; find ``Attribute`` references whose attribute name
   is ``is_set`` and whose target is ``self._shutdown_event`` (covers
   both ``foo.is_set`` and ``foo.is_set()``).
3. Assert each such node is lexically nested inside a ``With`` whose
   context expression is ``self._workers_lock``. Walk a parent map up
   from the node to find the enclosing ``With``.
4. Allow-list: the sweeper loop's ``while not
   self._shutdown_event.is_set():`` and ``self._shutdown_event.wait()``
   sleep paths inside ``start_sweeper`` are NOT spawn sites — they're
   inside the worker itself, not racing thread tracking. They live in
   designated helpers and are excluded by line range / containing
   function name.

If new spawn sites are added without the lock, this test fails with a
clear message naming the violating file:line.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Iterator, Optional

import pytest


# ---------------------------------------------------------------------------
# Files under static analysis. Add new files here when shutdown-event /
# worker-tracking patterns spread to other modules.
# ---------------------------------------------------------------------------

_REPO_HARDWARE_ROOT = Path(__file__).resolve().parents[2]

# (relative_path, function_names_whose_is_set_calls_are_NOT_spawn_sites)
#
# In ``scale_events.py`` the only legitimate non-spawn ``is_set`` use
# lives inside ``start_sweeper._loop`` — that ``while not
# self._shutdown_event.is_set():`` is the worker LOOP itself, not a
# spawn dispatch, and it does NOT need to hold ``_workers_lock``. The
# corresponding helper function is named ``_loop`` and is nested inside
# ``start_sweeper``. We exempt by walking up the function chain.
_FILES: tuple[tuple[str, frozenset[str]], ...] = (
    (
        "server/handlers/scale_events.py",
        # Functions whose body's ``is_set`` calls are NOT spawn-site
        # checks (they're either the loop predicate of a daemon thread
        # already started, or the wait() sleep path).
        frozenset({"_loop"}),
    ),
    (
        "server/app.py",
        # ``app.py`` does not currently spawn workers under a lock-vs-
        # shutdown-event protocol; every reference to a shutdown event
        # there is at app-startup / app-shutdown time, NOT in a request
        # path racing a teardown. The check still runs (so any future
        # ``self._shutdown_event.is_set()`` *combined with* a
        # ``_workers_lock`` pattern is enforced), but no exemption is
        # needed today — see the ``_resolves_to_shutdown_event`` filter.
        frozenset(),
    ),
)


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------


def _build_parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    """Return a {child -> parent} map for every node in ``tree``."""
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    return parents


def _walk_up(
    node: ast.AST, parents: dict[ast.AST, ast.AST]
) -> Iterator[ast.AST]:
    """Yield ``node`` then every ancestor up to the module root."""
    cur: Optional[ast.AST] = node
    while cur is not None:
        yield cur
        cur = parents.get(cur)


def _resolves_to_shutdown_event(node: ast.AST) -> bool:
    """True iff ``node`` is the attribute access ``self._shutdown_event``."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "_shutdown_event"
        and isinstance(node.value, ast.Name)
        and node.value.id == "self"
    )


def _is_shutdown_is_set_ref(node: ast.AST) -> bool:
    """True iff ``node`` reads ``self._shutdown_event.is_set`` (whether
    or not it's then called). Catches both the bound-method reference
    ``... .is_set`` and the standard ``... .is_set()`` form, since the
    method-resolution attribute access exists in both ASTs."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "is_set"
        and _resolves_to_shutdown_event(node.value)
    )


def _is_workers_lock_with(node: ast.AST) -> bool:
    """True iff ``node`` is ``with self._workers_lock:`` (or
    ``with self._workers_lock as ...:``). We accept the multi-item
    ``with`` form too, as long as ``self._workers_lock`` is one of the
    held context managers."""
    if not isinstance(node, ast.With):
        return False
    for item in node.items:
        ctx = item.context_expr
        if (
            isinstance(ctx, ast.Attribute)
            and ctx.attr == "_workers_lock"
            and isinstance(ctx.value, ast.Name)
            and ctx.value.id == "self"
        ):
            return True
    return False


def _enclosing_function_names(
    node: ast.AST, parents: dict[ast.AST, ast.AST]
) -> set[str]:
    """Names of every FunctionDef / AsyncFunctionDef the node lives
    inside (innermost-first order doesn't matter — we just need the
    set membership for exemption checks)."""
    names: set[str] = set()
    for ancestor in _walk_up(node, parents):
        if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(ancestor.name)
    return names


# ---------------------------------------------------------------------------
# The actual test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rel_path", "exempt_funcs"),
    _FILES,
    ids=[f for f, _ in _FILES],
)
def test_shutdown_check_held_under_workers_lock(
    rel_path: str, exempt_funcs: frozenset[str]
) -> None:
    """Every ``self._shutdown_event.is_set`` inside a spawn site must
    sit inside ``with self._workers_lock:``. Worker-loop predicates
    (named in ``exempt_funcs``) are excluded — those are inside daemon
    threads that have already been tracked."""
    path = _REPO_HARDWARE_ROOT / rel_path
    assert path.exists(), f"missing {path}"

    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    parents = _build_parent_map(tree)

    violations: list[str] = []
    for node in ast.walk(tree):
        if not _is_shutdown_is_set_ref(node):
            continue

        # Skip references inside exempt functions (e.g. the sweeper
        # ``_loop`` predicate — that's a worker LOOP, not a spawn).
        enclosing = _enclosing_function_names(node, parents)
        if enclosing & exempt_funcs:
            continue

        # Walk ancestors looking for ``with self._workers_lock:``.
        held_under_lock = any(
            _is_workers_lock_with(anc)
            for anc in _walk_up(node, parents)
        )
        if not held_under_lock:
            line = getattr(node, "lineno", "?")
            violations.append(
                f"{rel_path}:{line} — `self._shutdown_event.is_set` "
                "is checked outside `with self._workers_lock:`. "
                "Move the check INSIDE the lock and append to "
                "`self._workers` in the same critical section, "
                "otherwise stop() may race the spawn and orphan a "
                "worker that touches self._conn after close() — "
                "the segfault class commit 34895f0 fixed."
            )

    assert not violations, (
        "Shutdown / worker-list lock discipline violated:\n  "
        + "\n  ".join(violations)
    )


def test_at_least_one_protected_site_exists() -> None:
    """Sanity check: this meta-test would silently pass if every
    ``is_set`` reference were removed by mistake. Ensure the file under
    audit still has at least one PROTECTED reference (under the lock).
    Without this, a bad refactor could delete every check and the
    static analyser would happily report green."""
    path = _REPO_HARDWARE_ROOT / "server/handlers/scale_events.py"
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    parents = _build_parent_map(tree)

    protected = 0
    for node in ast.walk(tree):
        if not _is_shutdown_is_set_ref(node):
            continue
        if any(
            _is_workers_lock_with(anc) for anc in _walk_up(node, parents)
        ):
            protected += 1

    # Both ``_dispatch_classification`` and the reconciler dispatch
    # path each contain one protected ``is_set`` check. ``_track_worker``
    # adds a third defensive check.
    assert protected >= 2, (
        f"expected >=2 protected `is_set` checks under "
        f"`with self._workers_lock:`, found {protected}. Did a "
        "refactor delete the spawn-site shutdown guards?"
    )
