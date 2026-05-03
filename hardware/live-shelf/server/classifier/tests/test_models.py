"""Direct contract tests on ``classifier.models`` dataclasses.

Pins the schema-level invariants for ``Candidate.to_prompt_dict`` and
``LotCandidate``. Other test files cover prompt-rendering / pool
assembly; this file targets the dataclass projections directly so a
regression there is caught before any pool wiring even runs.

Catch-all auto-import (2026-05-02, Task 5): ``Candidate`` gained a
``needs_tare_estimate`` flag (with paired ``net_weight_g``) so the
prompt can ask the model for an estimated tare when the picked
product has none yet. The flag is surfaced into ``to_prompt_dict``
ONLY when True — set-once means already-captured products don't
waste prompt tokens on the flag.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.models import Candidate  # noqa: E402


def test_candidate_to_prompt_dict_includes_needs_tare_estimate_flag():
    """When a candidate has no tare yet, the prompt dict carries
    needs_tare_estimate=True so the model is told to provide an
    estimate. Set-once: candidates with tare already captured do
    NOT carry the flag (no estimate requested)."""
    c_needs = Candidate(
        candidate_id="p-1",
        name="Pasta Box",
        brand=None,
        expected_weight_g=500.0,
        container_type="cardboard_box",
        why_candidate="inventory_only",
        needs_tare_estimate=True,
        net_weight_g=500.0,
    )
    c_set = Candidate(
        candidate_id="p-2",
        name="Olive Oil",
        brand=None,
        expected_weight_g=750.0,
        container_type="glass_bottle",
        why_candidate="inventory_only",
        needs_tare_estimate=False,
        net_weight_g=750.0,
    )

    d_needs = c_needs.to_prompt_dict()
    d_set = c_set.to_prompt_dict()

    assert d_needs["needs_tare_estimate"] is True
    assert d_needs["net_weight_g"] == 500.0
    assert "needs_tare_estimate" not in d_set
    assert "net_weight_g" not in d_set
