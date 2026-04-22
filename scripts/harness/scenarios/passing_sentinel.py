"""Deliberately-passing scenario used by the harness meta-test.

Companion to ``broken_sentinel.py``. Needed so the meta-test can
verify the POSITIVE leg of the wiring: "a scenario that records only
ok=True checks must yield exit 0 + artifact ok=true".

Without this, a buggy harness that crashed the moment any scenario's
checks finished could still "pass" the negative meta-test (because a
crash still yields non-zero exit). Having a separate happy-path
sentinel pins both directions.

No Pi / cloud side-effects — single trivially-true check, same "does
not require supabase" property as ``broken_sentinel``.
"""

from __future__ import annotations

from scripts.harness.orchestrator import HarnessContext, scenario


@scenario("passing_sentinel")
def _passing_sentinel(ctx: HarnessContext) -> None:
    ctx.check(
        "always_passes_by_design",
        True,
        evidence=(
            "This scenario exists as the positive meta-test leg. "
            "If it ever fails, the harness wiring itself is broken."
        ),
    )
