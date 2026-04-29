"""Smoke tests for the Phase-2 audit scripts.

Each test:

1. Invokes the script as a subprocess on the LIVE repo state.
2. Asserts the script writes its JSON artifact with the expected
   top-level shape (gate, lens, findings list).
3. Asserts deterministic output: a second run produces a byte-identical
   JSON file.

We deliberately do NOT assert ``findings == []``: Phase-2 audits are
allowed to surface findings on the current repo. The point of these
smoke tests is to make sure the script runs end-to-end and emits a
machine-readable artifact in the contract shape the
``verify:audit-phase2`` aggregator depends on.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"


def _run(cmd: list[str], cwd: Path = REPO, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=180,
        env=env if env is not None else os.environ.copy(),
    )


# ---------------------------------------------------------------------------
# 1. audit_symmetry_matrix.py
# ---------------------------------------------------------------------------


def test_audit_symmetry_matrix_runs(tmp_path):
    out_json = tmp_path / "sym.json"
    out_md = tmp_path / "sym.md"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "audit_symmetry_matrix.py"),
            "--json", str(out_json),
            "--md", str(out_md),
            "--quiet",
        ]
    )
    # Exit 0 (no findings) or 1 (findings) are both acceptable for smoke.
    assert res.returncode in (0, 1), f"unexpected exit: {res.returncode}\n{res.stderr}"
    data = json.loads(out_json.read_text())
    assert data["gate"] == "audit_symmetry_matrix"
    assert data["lens"] == "L1"
    assert "findings" in data
    assert "cells" in data
    # Markdown report must exist and be non-empty.
    assert out_md.read_text().startswith("# Symmetry Matrix")


def test_audit_symmetry_matrix_deterministic(tmp_path):
    """Two runs must produce byte-identical JSON output."""
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    cmd_a = [
        sys.executable, str(SCRIPTS / "audit_symmetry_matrix.py"),
        "--json", str(a), "--md", str(tmp_path / "a.md"), "--quiet",
    ]
    cmd_b = [
        sys.executable, str(SCRIPTS / "audit_symmetry_matrix.py"),
        "--json", str(b), "--md", str(tmp_path / "b.md"), "--quiet",
    ]
    _run(cmd_a)
    _run(cmd_b)
    assert a.read_bytes() == b.read_bytes()


# Cells that AUDIT_FINDINGS_PHASE2.md surfaced as HIGH symmetry gaps.
# The Phase-2 fix pass either implemented, waived, or detector-fixed
# each one. This test pins the resolution so a regression (a probe
# narrowing, a waiver getting deleted, or a translator file getting
# renamed) re-flags loudly instead of silently re-opening the gap.
_PHASE2_HIGH_FINDING_CELLS: list[tuple[str, str]] = [
    ("catch_all", "cloud_pairings_sync"),
    ("catch_all", "pi_UI_section"),
    ("catch_all", "weight_sync_to_cloud"),
    ("live_scale", "classifier_prompt"),
    ("live_scale", "cloud_pairings_sync"),
    ("live_shelf", "cloud_pairings_sync"),
    ("live_shelf", "pi_UI_section"),
    ("single_item", "auto_register"),
    ("single_item", "classifier_prompt"),
    ("single_item", "cloud_pairings_sync"),
    ("single_item", "pi_UI_section"),
]


@pytest.mark.parametrize("entity,feature", _PHASE2_HIGH_FINDING_CELLS)
def test_audit_symmetry_phase2_findings_resolved(tmp_path, entity, feature):
    """Each Phase-2 HIGH finding cell must now be `present` or `waived`.

    Locks in the L1 fix pass: lets the detector re-discover whether the
    feature is implemented (`present`) or genuinely doesn't apply
    (`waived`), but never silently regress to `missing`.
    """
    out_json = tmp_path / "sym.json"
    out_md = tmp_path / "sym.md"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "audit_symmetry_matrix.py"),
            "--json", str(out_json),
            "--md", str(out_md),
            "--quiet",
        ]
    )
    assert res.returncode == 0, (
        f"audit_symmetry_matrix exited non-zero ({res.returncode}); "
        f"some symmetry cells are missing again.\nstderr: {res.stderr}"
    )
    data = json.loads(out_json.read_text())
    cell = next(
        (c for c in data["cells"] if c["entity"] == entity and c["feature"] == feature),
        None,
    )
    assert cell is not None, (
        f"cell ({entity}, {feature}) not present in matrix output — "
        "did ENTITIES or PROBES change?"
    )
    assert cell["status"] in ("present", "waived"), (
        f"cell ({entity}, {feature}) regressed to {cell['status']!r} "
        "after Phase-2 L1 fix pass — see AUDIT_STRATEGY_MERGED.md §7."
    )


# ---------------------------------------------------------------------------
# 2. audit_invariants_pinned.py
# ---------------------------------------------------------------------------


def test_audit_invariants_pinned_runs(tmp_path):
    out_json = tmp_path / "inv.json"
    out_md = tmp_path / "inv.md"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "audit_invariants_pinned.py"),
            "--json", str(out_json),
            "--md", str(out_md),
            "--quiet",
        ]
    )
    assert res.returncode in (0, 1), res.stderr
    data = json.loads(out_json.read_text())
    assert data["gate"] == "audit_invariants_pinned"
    assert data["lens"] == "L11"
    assert "stats" in data
    assert "findings" in data
    assert isinstance(data["stats"]["rules_total"], int)


# ---------------------------------------------------------------------------
# 3. audit_negative_space.py
# ---------------------------------------------------------------------------


def test_audit_negative_space_runs(tmp_path):
    out_json = tmp_path / "neg.json"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "audit_negative_space.py"),
            "--json", str(out_json),
            "--md", str(tmp_path / "neg.md"),
            "--quiet",
        ]
    )
    assert res.returncode in (0, 1), res.stderr
    data = json.loads(out_json.read_text())
    assert data["gate"] == "audit_negative_space"
    assert data["lens"] == "L8"
    # files_scanned counts files WITH hits; if all backlog is triaged this
    # can be 0 — but the artifact stats key must always be present.
    assert "files_scanned" in data["stats"]
    assert "findings" in data["stats"]
    assert "hits_total" in data["stats"]


def test_audit_negative_space_inline_waivers():
    """Three inline waiver markers must be recognized so triaged backlog
    survives in source: GitHub issue refs, ignore.md pointers, and the
    explicit ``__deferred__`` sentinel.

    We import ``line_waiver`` directly rather than running the full scan
    so the test pins the contract regardless of the wider repo state.
    """
    sys.path.insert(0, str(SCRIPTS))
    try:
        import audit_negative_space as ans  # noqa: WPS433
    finally:
        sys.path.pop(0)

    # Each entry: (line, expected-rationale-substring)
    cases = [
        ("# TODO #123 — tracked in GH", "github-issue-ref"),
        ("// FIXME(#1234): blah", "github-issue-ref"),
        ("# TODO gh#42: align", "github-issue-ref"),
        ("// TODO: see ignore.md \"Vault Encryption\"", "ignore-md-pointer"),
        ("# Tracked in ignore.md", "ignore-md-pointer"),
        ("// TODO: __deferred__ to phase 3", "deferred-sentinel"),
        ("# nothing to see here", None),
        ("# TODO: implement caching", None),  # actionable, NOT waived
    ]
    for line, expected in cases:
        got = ans.line_waiver(line)
        if expected is None:
            assert got is None, f"expected no waiver for {line!r}, got {got!r}"
        else:
            assert got == expected, (
                f"expected {expected!r} for {line!r}, got {got!r}"
            )


def test_audit_negative_space_actionable_vs_prose():
    """Detector must distinguish actionable markers from descriptive
    prose. This pins the false-positive-reduction work that took the
    L8 backlog from 874 → 0.
    """
    sys.path.insert(0, str(SCRIPTS))
    try:
        import audit_negative_space as ans  # noqa: WPS433
    finally:
        sys.path.pop(0)

    # Use scan_file via a temp file inside REPO so .relative_to() works.
    fixture = REPO / ".verify" / "_neg_space_smoke_fixture.py"
    try:
        fixture.write_text(
            "\n".join(
                [
                    "# TODO: real action",
                    "# FIXME: real action",
                    "import { todoistTools } from 'x';",
                    "class StubSource: pass",
                    "# Stub source",
                    "# A future migration must keep this column",
                    "# Decision deferred: ledger-ize is_active",
                    "this.deferred = new Promise(...);",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        hits = ans.scan_file(fixture)
    finally:
        fixture.unlink(missing_ok=True)

    # Lines 1, 2 (TODO, FIXME) and 7 (deferred:) are actionable.
    flagged_lines = sorted(h.line for h in hits)
    assert flagged_lines == [1, 2, 7], (
        f"expected actionable lines [1, 2, 7], got {flagged_lines}: "
        f"{[h.excerpt for h in hits]}"
    )


# ---------------------------------------------------------------------------
# 4. clock_freeze.py
# ---------------------------------------------------------------------------


def test_clock_freeze_smoke():
    """The CLI smoke prints 'clock_freeze OK' iff the freeze + unfreeze
    both work. This is the strongest cheap end-to-end check we can run
    without spinning up a Postgres connection."""
    res = _run([sys.executable, str(SCRIPTS / "harness" / "clock_freeze.py")])
    assert res.returncode == 0, res.stderr
    assert "clock_freeze OK" in res.stdout


def test_clock_freeze_imports_cleanly():
    """The module must be importable without side-effects on the parent
    process — we don't want a stray ``import`` in another scenario to
    silently install patches.
    """
    src = SCRIPTS / "harness" / "clock_freeze.py"
    res = _run(
        [
            sys.executable,
            "-c",
            (
                "import importlib.util, sys, datetime\n"
                f"spec = importlib.util.spec_from_file_location('cf', r'{src}')\n"
                "mod = importlib.util.module_from_spec(spec)\n"
                "spec.loader.exec_module(mod)\n"
                # datetime.datetime is the real one BEFORE the CM activates
                "assert datetime.datetime is mod._REAL_DATETIME, 'patch should not auto-install'\n"
                "print('ok')\n"
            ),
        ]
    )
    assert res.returncode == 0, res.stderr
    assert "ok" in res.stdout


# ---------------------------------------------------------------------------
# 5. poison_outbox.py
# ---------------------------------------------------------------------------


def test_poison_outbox_drain_test(tmp_path):
    db = tmp_path / "pi.sqlite"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "harness" / "poison_outbox.py"),
            "drain-test",
            "--db", str(db),
            "--quiet",
        ]
    )
    assert res.returncode == 0, res.stdout + res.stderr
    art = REPO / ".verify" / "poison_outbox.json"
    assert art.is_file()
    data = json.loads(art.read_text())
    assert data["ok"] is True
    # Specific check names assert the FIFO contract
    names = {c["name"] for c in data["checks"]}
    assert "poison_row_dlq" in names
    assert "post_poison_rows_drain" in names
    assert "no_fifo_block" in names


def test_poison_outbox_inject(tmp_path):
    db = tmp_path / "inj.sqlite"
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "harness" / "poison_outbox.py"),
            "inject",
            "--db", str(db),
            "--kind", "synthetic_test_kind",
        ]
    )
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert payload["ok"] is True
    assert payload["kind"] == "synthetic_test_kind"
    # And the row was actually written
    import sqlite3
    conn = sqlite3.connect(str(db))
    rows = conn.execute("SELECT COUNT(*) FROM cloud_outbox").fetchone()[0]
    assert rows == 1


# ---------------------------------------------------------------------------
# 6. parity_assert.py
# ---------------------------------------------------------------------------


def test_parity_assert_self_test_finds_drift():
    """The self-test scenario seeds a deliberately asymmetric fixture.

    Engine MUST detect at least one delta — otherwise the parity diff
    is a no-op (false negative).
    """
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "harness" / "parity_assert.py"),
            "self-test",
            "--quiet",
        ]
    )
    # Self-test seeds asymmetry, so exit 1 is the *correct* outcome.
    assert res.returncode == 1, res.stderr
    art = REPO / ".verify" / "parity_assert.json"
    data = json.loads(art.read_text())
    assert data["gate"] == "parity_assert"
    assert data["lens"] == "L2"
    assert data["scenario"] == "self-test"
    assert data["ok"] is False
    # Engine should have flagged BOTH the products `net_weight_g` drift
    # AND the lots `current_weight_g` -> `qty_containers` drift.
    flagged_tables = {f["table"] for f in data["findings"]}
    assert "products" in flagged_tables, f"missing products drift: {flagged_tables}"
    assert "stock_lots" in flagged_tables, f"missing stock_lots drift: {flagged_tables}"


def test_parity_assert_list_scenarios():
    res = _run(
        [
            sys.executable,
            str(SCRIPTS / "harness" / "parity_assert.py"),
            "--list",
        ]
    )
    assert res.returncode == 0
    assert "self-test" in res.stdout


# ---------------------------------------------------------------------------
# 7. extended audit_schema_drift.py (FLOW G — L10)
# ---------------------------------------------------------------------------


def test_audit_schema_drift_flow_g_runs():
    """The FLOW G extension must execute alongside flows A-F without
    error, AND the resulting output must mention 'L10' or 'unit
    annotations' in the new flow header.
    """
    res = _run([sys.executable, str(SCRIPTS / "audit_schema_drift.py")])
    # exit code: any (existing flows may have findings — we don't care
    # for this smoke test).
    assert res.returncode in (0, 1), res.stderr
    out = res.stdout
    assert "G: unit annotations" in out, (
        "FLOW G header missing — extension regressed?\n" + out[:2000]
    )


# ---------------------------------------------------------------------------
# 8. extended audit_test_quality.py (L9 — empty fixture variant)
# ---------------------------------------------------------------------------


def test_audit_test_quality_l9_pattern_present():
    """L9 extension must register its pattern label in the analyzer."""
    res = _run([sys.executable, str(SCRIPTS / "audit_test_quality.py")])
    assert res.returncode in (0, 1)
    assert "missing-empty-fixture-variant" in res.stdout, (
        "L9 pattern not surfaced — extension regressed?\n" + res.stdout[:2000]
    )


# ---------------------------------------------------------------------------
# 9. verify:audit-phase2 wrapper (smoke)
# ---------------------------------------------------------------------------


def test_verify_audit_phase2_script_exists():
    """The pnpm script should exist in package.json."""
    pj = json.loads((REPO / "package.json").read_text())
    assert "verify:audit-phase2" in pj["scripts"], (
        "verify:audit-phase2 not declared in package.json"
    )
