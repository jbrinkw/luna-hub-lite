"""Deliberately-failing scenario used by the harness meta-test.

Purpose
-------
Per docs/VERIFY.md §"Meta-test":

    A ``scripts/harness/tests/test_harness_meta.py`` must include a
    deliberately-failing scenario (``broken_sentinel``) and assert the
    harness correctly reports FAIL on it (exit non-zero + artifact
    shows ``ok: false``). Otherwise the harness could silently report
    pass when scenarios don't actually run.

This scenario does the minimum work needed to exercise the full
pipeline (scenario discovery → @scenario registration → run.py invokes
it → ``ctx.check(name, ok=False)`` is recorded → ``_run_one`` reports
failure → artifact writes ``ok: false`` → exit non-zero) while
deliberately failing a single assertion so the meta-test can observe
the failure path.

Why a dedicated failing scenario (and not just mock a failing check)
--------------------------------------------------------------------
* The meta-test is about proving the harness's failure-detection wiring
  works end-to-end. A unit test of ``_run_one`` with a mocked check
  wouldn't catch a bug in ``run.py``'s exit-code computation, artifact
  writing, or CLI glue.
* A real failing scenario forces us to keep the ``--scenario NAME``
  selector working (the meta-test invokes the harness CLI directly).

Non-goals
---------
* NOT a test of any Pi or cloud behavior. The failing check has
  literally nothing to do with shelf code — it's purely a sentinel.
* Does NOT consume cloud resources: no user seed, no device seed, no DB
  writes. This lets the meta-test run without requiring a live
  ``supabase start`` — see ``--skip-supabase-check`` on ``run.py``.
"""

from __future__ import annotations

from scripts.harness.orchestrator import HarnessContext, scenario


@scenario("broken_sentinel")
def _broken_sentinel(ctx: HarnessContext) -> None:
    # First check passes — proves the scenario ran past setup and the
    # check() mechanism works on the happy path. Without this, a
    # catastrophic failure before the intentional failure could look
    # identical to "the scenario ran and failed as designed".
    ctx.check(
        "sentinel_reached",
        True,
        evidence="broken_sentinel scenario was invoked",
    )
    # Intentional failure. ``check(ok=False)`` raises ScenarioFailure,
    # which run.py catches and converts to a ``failures[]`` entry +
    # scenario ok=False. No surrounding try/except here — we want the
    # raise to propagate into run.py's exception handler so the meta-
    # test exercises that path too.
    ctx.check(
        "always_fails_by_design",
        False,
        evidence=(
            "This scenario exists to prove the harness can detect "
            "failure. If this check ever 'passes', the harness is "
            "broken — probably a bug in run.py's exit-code or "
            "artifact-writing logic."
        ),
    )
