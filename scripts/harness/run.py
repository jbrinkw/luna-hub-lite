#!/usr/bin/env python3
"""Harness entrypoint.

Usage
-----
    pnpm harness                  # run every registered scenario
    pnpm harness <scenario-name>  # run one scenario by name
    pnpm harness --scenario NAME  # same, explicit form

Exit codes (from docs/VERIFY.md §"Exit codes")
  0  — all scenarios passed
  non-zero — at least one scenario failed. Human-readable message on
             stderr, structured JSON artifact at ``.verify/harness.json``
             (schema from docs/VERIFY.md §"JSON artifact schema (shared)").

Design notes
------------
* We do NOT start or stop ``supabase start``. Per VERIFY.md §"Scenario
  contract" point 4, supabase stays running between scenarios to amortize
  startup. The orchestrator verifies the stack is reachable via an HTTP
  + postgres healthcheck and fails fast with an actionable error when
  it's not.
* Scenarios are imported for side-effects (``@scenario`` decorator self-
  registers into ``orchestrator._REGISTRY``). The ``discover_scenarios``
  helper below imports every ``.py`` under ``scenarios/`` that isn't
  dunder-prefixed.
* One ``HarnessContext`` per scenario. Each scenario is fully
  self-contained (fresh user, fresh device, fresh Pi SQLite) so they can
  run in any order with no contamination.
* Failures don't abort the whole run — we record the failure, continue
  with remaining scenarios, and report an aggregate summary at the end.
  This matches the behavior every test runner has and makes the meta-test
  simpler: a single deliberately-broken scenario can coexist with passing
  scenarios in one invocation.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import importlib.util
import json
import os
import pathlib
import sys
import time
import traceback
from typing import List, Optional

# ---------------------------------------------------------------------------
# venv re-exec: pnpm runs us with the system python3, which typically lacks
# psycopg2 + flask + requests. The live-shelf Pi venv already has them all.
# Re-exec under the venv python so ``pnpm harness`` works out of the box.
# Skipped when we're already running under a python that has psycopg2 (the
# meta-test invokes us directly with the live-shelf venv python, or CI may
# install the deps globally).
# ---------------------------------------------------------------------------
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_VENV_PY = _REPO_ROOT / "hardware" / "live-shelf" / ".venv" / "bin" / "python3"


def _has_deps() -> bool:
    try:
        import psycopg2  # noqa: F401
        import requests  # noqa: F401
        return True
    except ImportError:
        return False


if not _has_deps() and _VENV_PY.is_file() and sys.executable != str(_VENV_PY):
    os.execv(str(_VENV_PY), [str(_VENV_PY), __file__, *sys.argv[1:]])

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
HARNESS_DIR = pathlib.Path(__file__).resolve().parent
SCENARIO_DIR = HARNESS_DIR / "scenarios"
# ``.verify/`` lives at the repo root in normal use, but we honor
# ``HARNESS_VERIFY_DIR`` so meta-tests can redirect into a tmp_path
# without polluting the dev checkout. Resolving lazily (not at import
# time) lets tests override the env var between invocations.


def _verify_dir() -> pathlib.Path:
    override = os.environ.get("HARNESS_VERIFY_DIR")
    if override:
        return pathlib.Path(override)
    return REPO_ROOT / ".verify"


def _artifact_path() -> pathlib.Path:
    return _verify_dir() / "harness.json"

# Importing orchestrator requires ``scripts/`` on sys.path so the
# package-relative imports in scenarios (``from scripts.harness.orchestrator
# import ...``) resolve in both ``python scripts/harness/run.py`` and
# ``python -m scripts.harness.run`` invocations.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.harness.orchestrator import (  # noqa: E402
    HarnessContext,
    ScenarioFailure,
    SupabaseUnreachable,
    ensure_supabase_running,
    registered_scenarios,
)


def discover_scenarios() -> None:
    """Import every scenario module so its ``@scenario`` call fires.

    We avoid ``importlib.import_module("scripts.harness.scenarios.X")``
    because that requires the parent package to be importable as a
    proper package (``scripts/__init__.py`` exists but isn't guaranteed
    at every repo state). Fall back to loading by file path — functionally
    identical for the decorator side-effect.
    """
    for path in sorted(SCENARIO_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        module_name = f"scripts.harness.scenarios.{path.stem}"
        if module_name in sys.modules:
            continue
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load scenario module: {path}")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)


def _iso_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


def _run_one(name: str, fn, *, tmp_root: pathlib.Path) -> dict:
    """Run a single scenario and return its JSON-serializable record."""
    tmp_dir = tmp_root / name
    ctx = HarnessContext(name=name, tmp_dir=tmp_dir)
    t0 = time.perf_counter()
    ok = True
    failures: List[dict] = []
    try:
        fn(ctx)
    except ScenarioFailure:
        # ``check(..., ok=False)`` raised — the failure is already in
        # ctx.failures. Recording here just flips ``ok``.
        ok = False
    except Exception as exc:  # noqa: BLE001 — scenario-level crashes
        ok = False
        failures.append({
            "check": "scenario_crashed",
            "message": f"{type(exc).__name__}: {exc}",
            "detail": traceback.format_exc(limit=5),
        })
    finally:
        duration_ms = (time.perf_counter() - t0) * 1000.0
        try:
            ctx.teardown()
        except Exception:  # noqa: BLE001 — teardown logged inside
            pass

    ok = ok and all(c.ok for c in ctx.checks)
    # Merge ctx-recorded failures with crash-level ones. ctx.failures
    # carries check-name + message; crash failures above already do.
    failures.extend(ctx.failures)

    return {
        "name": name,
        "ok": bool(ok),
        "duration_ms": round(duration_ms, 2),
        "checks": [
            {"name": c.name, "ok": c.ok, "evidence": c.evidence}
            for c in ctx.checks
        ],
        "failures": failures,
    }


def _emit_artifact(records: List[dict], *, started_at: str, total_ms: float) -> dict:
    """Build + write the .verify/harness.json artifact."""
    aggregate_checks: List[dict] = []
    aggregate_failures: List[dict] = []
    for r in records:
        # Roll each scenario into a single top-level check (so readers
        # that only scan the outer ``checks`` get a per-scenario summary)
        # AND attach the per-scenario check list verbatim so fine-grained
        # evidence is preserved.
        aggregate_checks.append({
            "name": f"scenario:{r['name']}",
            "ok": r["ok"],
            "evidence": json.dumps({
                "duration_ms": r["duration_ms"],
                "checks": r["checks"],
            }),
        })
        for f in r["failures"]:
            aggregate_failures.append({
                "check": f"{r['name']}:{f['check']}",
                "message": f.get("message", ""),
                "detail": f.get("detail", ""),
            })

    artifact = {
        "gate": "harness",
        "ok": all(r["ok"] for r in records),
        "ran_at": started_at,
        "duration_ms": round(total_ms, 2),
        "checks": aggregate_checks,
        "failures": aggregate_failures,
        "scenarios": records,  # full per-scenario detail for CI log scrape
    }

    verify_dir = _verify_dir()
    artifact_path = _artifact_path()
    verify_dir.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(artifact, indent=2) + "\n")
    return artifact


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pnpm harness",
        description="Run Pi↔Cloud contract scenarios. See docs/VERIFY.md.",
    )
    # Positional alias so ``pnpm harness <name>`` works the way the spec
    # examples show.
    parser.add_argument(
        "scenario_pos", nargs="?", default=None, metavar="SCENARIO",
        help="run a single scenario by name (same as --scenario)",
    )
    parser.add_argument(
        "--scenario", dest="scenario_flag", default=None,
        help="run a single scenario by name",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="print the registered scenario names and exit",
    )
    parser.add_argument(
        "--skip-supabase-check", action="store_true",
        help="skip the supabase-reachable healthcheck (for meta-tests)",
    )
    args = parser.parse_args(argv)

    try:
        discover_scenarios()
    except Exception as exc:  # noqa: BLE001
        print(f"harness: failed to import scenarios: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 2

    registry = registered_scenarios()
    if args.list:
        for name in sorted(registry):
            print(name)
        return 0

    # Sentinel scenarios are meta-test fixtures (see
    # docs/VERIFY.md §"Meta-test" + scripts/harness/tests/test_harness_meta.py).
    # They deliberately fail / trivially pass and have no Pi/cloud
    # semantics. Excluded from the default "run everything" path so
    # ``pnpm harness`` reflects real scenario health, not sentinel
    # noise. Still runnable explicitly via ``--scenario broken_sentinel``.
    SENTINELS = {"broken_sentinel", "passing_sentinel"}

    target = args.scenario_flag or args.scenario_pos
    if target is not None:
        if target not in registry:
            known = ", ".join(sorted(registry)) or "(none registered)"
            print(
                f"harness: unknown scenario {target!r}. Known: {known}",
                file=sys.stderr,
            )
            return 2
        to_run = [target]
    else:
        to_run = sorted(name for name in registry if name not in SENTINELS)

    if not to_run:
        print("harness: no scenarios registered", file=sys.stderr)
        return 2

    if not args.skip_supabase_check:
        try:
            ensure_supabase_running()
        except SupabaseUnreachable as exc:
            print(f"harness: supabase unreachable: {exc}", file=sys.stderr)
            return 2

    started_at = _iso_now()
    t_run = time.perf_counter()

    tmp_root = pathlib.Path(
        os.environ.get(
            "HARNESS_TMP_ROOT",
            str(_verify_dir() / "tmp"),
        )
    )
    tmp_root.mkdir(parents=True, exist_ok=True)

    records: List[dict] = []
    for name in to_run:
        print(f"harness: running {name!r}", file=sys.stderr)
        record = _run_one(name, registry[name], tmp_root=tmp_root)
        status = "ok" if record["ok"] else "FAIL"
        print(
            f"harness: {name} {status} ({record['duration_ms']:.1f}ms)",
            file=sys.stderr,
        )
        if not record["ok"]:
            for f in record["failures"]:
                print(
                    f"  ✗ {f.get('check', '?')}: {f.get('message', '')}",
                    file=sys.stderr,
                )
        records.append(record)

    total_ms = (time.perf_counter() - t_run) * 1000.0
    artifact = _emit_artifact(records, started_at=started_at, total_ms=total_ms)

    # Summary line — useful in CI log scraping.
    total = len(records)
    passed = sum(1 for r in records if r["ok"])
    print(
        f"harness: {passed}/{total} scenarios passed in {total_ms:.1f}ms "
        f"→ {_artifact_path()}",
        file=sys.stderr,
    )
    return 0 if artifact["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
