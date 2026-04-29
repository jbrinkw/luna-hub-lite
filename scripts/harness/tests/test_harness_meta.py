"""Meta-tests for the harness gate itself.

Per docs/VERIFY.md §"Meta-test":

    A ``scripts/harness/tests/test_harness_meta.py`` must include a
    deliberately-failing scenario (``broken_sentinel``) and assert the
    harness correctly reports FAIL on it (exit non-zero + artifact
    shows ``ok: false``). Otherwise the harness could silently report
    pass when scenarios don't actually run.

We invoke ``run.py`` as a subprocess (not via an in-process call) so
the test covers the full entrypoint:

  * argv parsing
  * scenario discovery
  * registry lookup
  * per-scenario execution + teardown
  * artifact writing (JSON + exit code)

Both legs are required:

  1. ``broken_sentinel`` — exit nonzero, artifact ok=false, scenario
     check ``always_fails_by_design`` recorded.
  2. ``passing_sentinel`` — exit 0, artifact ok=true, scenario check
     ``always_passes_by_design`` recorded.

Without leg 2, a harness that crashed after every scenario could fake
"detected failure" in leg 1 via the crash — but that would also mean
no scenario ever passes, which leg 2 catches.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
RUN_PY = REPO_ROOT / "scripts" / "harness" / "run.py"


def _invoke_harness(
    scenario_name: str, *, artifact_dir: pathlib.Path,
) -> subprocess.CompletedProcess:
    """Run ``run.py --scenario NAME`` in a subprocess with a scratch artifact dir.

    We point ``.verify/`` to a per-test tmp dir via env override so
    concurrent meta-tests don't stomp each other and no CI build-artifact
    leftover lingers between runs.

    ``--skip-supabase-check`` is passed because the sentinel scenarios
    don't touch Supabase; forcing a live stack for a meta-test would
    make the test runnable only on a dev machine with ``supabase start``
    up.
    """
    env = os.environ.copy()
    # Redirect the artifact dir via HARNESS_VERIFY_DIR so concurrent
    # meta-tests (+ dev-checkout .verify/ folder) don't collide.
    env["HARNESS_VERIFY_DIR"] = str(artifact_dir / ".verify")
    env["HARNESS_TMP_ROOT"] = str(artifact_dir / "tmp")
    # For hermetic meta-tests the harness must not talk to Supabase.
    # Both sentinels are pure no-ops but the orchestrator's default
    # healthcheck would still probe the stack — --skip-supabase-check
    # disables it so this test can run on any dev machine.
    return subprocess.run(
        [sys.executable, str(RUN_PY), "--scenario", scenario_name,
         "--skip-supabase-check"],
        cwd=str(artifact_dir),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _read_artifact(artifact_dir: pathlib.Path) -> dict:
    path = artifact_dir / ".verify" / "harness.json"
    assert path.exists(), (
        f"meta-test: expected artifact at {path}; harness may have "
        f"crashed before the write"
    )
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Negative leg: broken_sentinel must fail visibly
# ---------------------------------------------------------------------------


def test_broken_sentinel_fails_visibly(tmp_path):
    """Deliberately-failing scenario: harness must exit non-zero AND
    write an artifact showing ok=false.

    If this test ever passes despite the harness returning 0 or writing
    ok=true, the harness's failure-detection wiring is broken — every
    subsequent scenario could report green on a failure and we'd never
    know.
    """
    result = _invoke_harness("broken_sentinel", artifact_dir=tmp_path)

    assert result.returncode != 0, (
        f"broken_sentinel must exit non-zero; got {result.returncode}. "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )

    artifact = _read_artifact(tmp_path)
    assert artifact["gate"] == "harness"
    assert artifact["ok"] is False, (
        f"artifact ok must be False for broken_sentinel; got {artifact!r}"
    )
    # Scenario-level: the broken sentinel is present and ok=False.
    scenarios = {s["name"]: s for s in artifact["scenarios"]}
    assert "broken_sentinel" in scenarios, (
        f"broken_sentinel must appear in artifact.scenarios; got "
        f"{sorted(scenarios)}"
    )
    assert scenarios["broken_sentinel"]["ok"] is False
    # The specific failure-by-design check must have been recorded so
    # the artifact gives operators an actionable reason.
    check_names = [
        c["name"] for c in scenarios["broken_sentinel"]["checks"]
    ]
    assert "always_fails_by_design" in check_names, (
        f"expected check 'always_fails_by_design' in {check_names}"
    )


# ---------------------------------------------------------------------------
# Positive leg: passing_sentinel must succeed visibly
# ---------------------------------------------------------------------------


def test_passing_sentinel_succeeds_visibly(tmp_path):
    """Trivially-passing scenario: harness must exit 0 AND artifact ok=true.

    Pairs with the negative leg. Without this, a harness that always
    fails could still satisfy the negative assertion and we'd never
    notice.
    """
    result = _invoke_harness("passing_sentinel", artifact_dir=tmp_path)

    assert result.returncode == 0, (
        f"passing_sentinel must exit 0; got {result.returncode}. "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )

    artifact = _read_artifact(tmp_path)
    assert artifact["ok"] is True, f"artifact ok must be True; got {artifact!r}"
    scenarios = {s["name"]: s for s in artifact["scenarios"]}
    assert scenarios["passing_sentinel"]["ok"] is True


# ---------------------------------------------------------------------------
# CLI hygiene
# ---------------------------------------------------------------------------


def test_list_flag_prints_registered_scenarios(tmp_path):
    """``run.py --list`` must include every importable scenario file.

    Guards against a regression where scenario discovery silently drops a
    module — if a scenario has a broken import, it disappears from the
    registry without any test failure. This test dynamically enumerates
    ``scenarios/`` and asserts that every non-sentinel, non-dunder ``.py``
    file appears in the --list output, proving all files were importable.

    A broken import in any scenario WILL cause the listing to miss that
    scenario, failing this assertion. This is the desired behaviour.
    """
    SCENARIO_DIR = REPO_ROOT / "scripts" / "harness" / "scenarios"

    # Collect all .py basenames (excluding __init__.py and dunder files).
    found_files = {
        p.stem
        for p in SCENARIO_DIR.glob("*.py")
        if not p.name.startswith("_")
    }
    assert found_files, "No scenario files found — check SCENARIO_DIR path"

    env = os.environ.copy()
    result = subprocess.run(
        [sys.executable, str(RUN_PY), "--list", "--skip-supabase-check"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        f"--list must exit 0; got {result.returncode}. "
        f"stderr={result.stderr!r}"
    )
    listed = set(result.stdout.strip().splitlines())

    # Every file on disk must be in the registered listing. If a file is
    # present but not listed, its @scenario decorator is missing or its
    # import failed silently.
    missing_from_list = found_files - listed
    assert not missing_from_list, (
        f"These scenario files are on disk but NOT registered (broken import "
        f"or missing @scenario decorator): {sorted(missing_from_list)}. "
        f"Listed: {sorted(listed)}"
    )

    # Every listed name must correspond to a file on disk. Guards against a
    # scenario being registered twice or from a stale cached module.
    extra_in_list = listed - found_files
    assert not extra_in_list, (
        f"These names appear in --list but have no matching .py file: "
        f"{sorted(extra_in_list)}"
    )

    # Count parity: len(listed) == len(found_files).
    # A broken import causes the module to be absent from the registry, so
    # len(listed) < len(found_files) — this assertion catches that too.
    assert len(listed) == len(found_files), (
        f"Registered scenario count ({len(listed)}) != file count "
        f"({len(found_files)}). A file may have a broken import that causes "
        f"it to be silently dropped from the registry."
    )


def test_unknown_scenario_returns_nonzero(tmp_path):
    """``run.py --scenario NONEXISTENT`` must fail fast with a non-zero exit.

    The CLI's error path is load-bearing: CI scripts pass scenario
    names via ``pnpm harness <name>``, and a typo should surface
    immediately rather than silently skipping + exiting 0.
    """
    env = os.environ.copy()
    result = subprocess.run(
        [sys.executable, str(RUN_PY), "--scenario", "does_not_exist",
         "--skip-supabase-check"],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    # Error message mentions the bogus name so operators can spot the typo.
    assert "does_not_exist" in (result.stderr + result.stdout)
