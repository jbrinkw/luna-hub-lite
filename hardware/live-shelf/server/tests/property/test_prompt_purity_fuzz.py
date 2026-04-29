"""Property test: classifier prompt body NEVER contains lot-level fields.

Background: decisions.md #42 codifies that the classifier must see
products only — lot-level state (lot_id, expires_on, qty_containers,
in_flight_since, pickup_weight_g, current_weight_g) MUST never make
it into the prompt body. The fixed-input tests in
``server/classifier/tests/test_prompt.py::TestPromptPurity`` pin two
hand-picked candidate lists, but a future Candidate field projection
that leaks a lot-level value only on certain reason codes / sentinel
patterns could slip past those.

This test fuzzes the candidate list with Hypothesis: random
combinations of reason codes, names containing forbidden substrings
as honeypots, lot_ids embedded in the dataclass, etc. The rendered
prompt MUST NEVER contain the forbidden lot-field JSON keys, and
MUST NEVER contain the synthetic lot_id sentinels we plant.

Mutation hardening: any change to ``Candidate.to_prompt_dict`` that
includes ``lot_id`` (e.g. dropping the projection layer and serialising
the dataclass directly) makes this property fail on the very first
generated case — Hypothesis shrinks to one candidate with one obvious
honeypot lot_id.
"""

from __future__ import annotations

import sys
from pathlib import Path

from hypothesis import given, settings, strategies as st

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.models import Candidate, ScaleEvent  # noqa: E402
from server.classifier.prompt import build_messages_payload  # noqa: E402


_FORBIDDEN_LOT_KEYS = (
    '"lot_id"',
    '"expires_on"',
    '"qty_containers"',
    '"in_flight_since"',
    '"pickup_weight_g"',
    '"current_weight_g"',
    '"pickup_event_id"',
    '"last_out_at"',
    '"pickup_session_id"',
)

# Honeypot prefix planted into every candidate's lot_id. If the prompt
# leaks the lot_id field, this string will appear verbatim in the
# rendered text and the assertion fires with the shrunk minimal case.
_HONEYPOT = "LOT_HONEYPOT_DO_NOT_LEAK_"


# JPEG sentinel — the prompt builder base64-encodes file bytes; any
# valid bytes work for the test since we only inspect text blocks.
_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


def _make_event(tmp_path: Path) -> ScaleEvent:
    before = tmp_path / "before.jpg"
    after = tmp_path / "after.jpg"
    before.write_bytes(_TINY_JPEG)
    after.write_bytes(_TINY_JPEG)
    return ScaleEvent(
        event_id="evt_fuzz",
        session_id="sesn_fuzz",
        ts="2026-04-28T12:00:00.000Z",
        delta_g=-340.0,
        before_weight_g=2_000.0,
        after_weight_g=1_660.0,
        direction="remove",
        before_frame_path=str(before),
        after_frame_path=str(after),
    )


_REASON_CODES = (
    "currently_on_shelf",
    "recently_out",
    "top_up_target",
    "catalog_not_on_shelf",
    "in_flight",
    "inventory_only",
)


@st.composite
def _candidate_st(draw):
    cid_suffix = draw(st.integers(min_value=0, max_value=10_000))
    why = draw(st.sampled_from(_REASON_CODES))
    weight = draw(
        st.one_of(
            st.none(),
            st.floats(min_value=0.0, max_value=10_000.0, allow_nan=False, allow_infinity=False),
        ),
    )
    return Candidate(
        candidate_id=f"prod_{cid_suffix}",
        name=draw(st.text(min_size=1, max_size=20)),
        brand=draw(st.one_of(st.none(), st.text(min_size=1, max_size=10))),
        expected_weight_g=weight,
        container_type=draw(
            st.one_of(st.none(), st.sampled_from(("bottle", "jar", "tub", "bag"))),
        ),
        why_candidate=why,  # type: ignore[arg-type]
        reference_image_paths=(),
        product_id=f"prod_{cid_suffix}",
        lot_id=f"{_HONEYPOT}{cid_suffix}",
    )


@given(candidates=st.lists(_candidate_st(), min_size=1, max_size=8))
@settings(max_examples=60, deadline=None)
def test_prompt_text_never_contains_forbidden_lot_keys_or_honeypot(candidates, tmp_path_factory):
    """For ANY candidate list, the rendered prompt body has no forbidden
    lot-field JSON keys AND no honeypot lot_id substrings."""
    tmp_path = tmp_path_factory.mktemp("prompt_fuzz")
    event = _make_event(tmp_path)
    payload = build_messages_payload(event, candidates)

    # Concatenate every text block from system + messages.
    chunks: list[str] = []
    system = payload["system"]
    if isinstance(system, str):
        chunks.append(system)
    else:
        for block in system:
            if block.get("type") == "text":
                chunks.append(block.get("text", ""))
    for message in payload["messages"]:
        for block in message["content"]:
            if block.get("type") == "text":
                chunks.append(block.get("text", ""))
    prompt_text = "\n".join(chunks)

    for forbidden in _FORBIDDEN_LOT_KEYS:
        assert forbidden not in prompt_text, (
            f"Prompt body leaked forbidden lot-level JSON key {forbidden}. "
            f"Decisions.md #42: classifier must see products only. "
            f"Fix the leak; do NOT relax this assertion."
        )
    assert _HONEYPOT not in prompt_text, (
        "Prompt body leaked the synthetic lot_id honeypot. The "
        "Candidate.to_prompt_dict projection (or its callers) is now "
        "serialising lot_id into the model's view — fix the leak."
    )
