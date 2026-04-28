"""Extended prompt-purity invariants — pins decision #45 across every
shelf kind and broadens the forbidden-key list to cover every
lot-lifecycle field that has been added since the original guard
landed.

The original ``TestPromptPurity`` lives in :file:`test_prompt.py` and
guarded the live-shelf path. This file extends the guarantee to:

  1. **Every shelf kind** — live_shelf, single_item, catch_all. A
     forbidden key creeping into a per-shelf-specific projection
     would slip past the original test.
  2. **Every why_candidate reason** — in_flight / recently_out /
     top_up_target / inventory_only / catalog_not_on_shelf /
     currently_on_shelf / sentinel. Each surfaces a different code
     path (``_from_lot``, ``_from_product``,
     ``_from_inventory_only_product``, ``_lot_keyed`` rebuild).
  3. **Expanded forbidden-key list** — the original guard listed
     ``lot_id / expires_on / qty_containers / in_flight_since``.
     Decisions #43 / #45 / #56 added ``pickup_weight_g``,
     ``in_flight_kind``, ``pickup_event_id``,
     ``pi_event_id`` ; this file pins those too. New design adds
     belong here, not in the production projection.

DO NOT relax these assertions to make a future refactor easier.
Remove a leak from ``Candidate.to_prompt_dict`` or the per-pool
projection — never the test.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.classifier.candidate_pool import (
    pool_for_add,
    pool_for_catch_all,
    pool_for_remove,
)
from server.classifier.models import (
    Candidate,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
    ScaleEvent,
)
from server.classifier.prompt import build_messages_payload


# Forbidden lot-level / lifecycle field names. None of these may appear
# inside the rendered classifier prompt body (system + user blocks),
# nor inside the per-candidate ``to_prompt_dict`` projection.
#
# When you add a new lot-lifecycle field that's important to the
# bookkeeping but irrelevant to the classifier's product-identification
# job, ADD IT HERE so a future agent can't leak it. The classifier
# sees products only.
_FORBIDDEN_KEYS = (
    # Original guard (decisions.md #42).
    "lot_id",
    "expires_on",
    "qty_containers",
    "in_flight_since",
    "current_weight_g",
    "last_out_at",
    "pickup_session_id",
    # 2026-04-27+: pickup-resolve and catch-all delta-capture markers.
    # Decisions #43, #45, #55, #56.
    "pickup_weight_g",
    "pickup_event_id",
    # 2026-04-27 (#56): catch-all kind discriminator. Pi state machine
    # uses it to route first-vs-second event; classifier must never
    # see it.
    "in_flight_kind",
    # 2026-04-27 (#55, #56): pi-event ids, used as outbox/audit keys
    # in the cloud apply path. Not a classifier signal.
    "pi_event_id",
    "client_event_id",
)


_TINY_JPEG = bytes.fromhex(
    "FFD8FFE000104A4649460001010000480048000000FFD9"
)


@pytest.fixture
def image_paths(tmp_path: Path) -> dict[str, str]:
    paths: dict[str, str] = {}
    for key in ("before", "after", "ref"):
        p = tmp_path / f"{key}.jpg"
        p.write_bytes(_TINY_JPEG)
        paths[key] = str(p)
    return paths


def _event(image_paths, *, direction="add", delta=300.0) -> ScaleEvent:
    return ScaleEvent(
        event_id="evt_invariant",
        session_id="sesn_invariant",
        ts="2026-04-28T00:00:00.000Z",
        delta_g=delta,
        before_weight_g=0.0,
        after_weight_g=delta,
        direction=direction,  # type: ignore[arg-type]
        before_frame_path=image_paths["before"],
        after_frame_path=image_paths["after"],
    )


def _serialise_prompt_text(payload: dict) -> str:
    """Concat every text block (system + user) into one string."""
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
    return "\n".join(chunks)


# --- Stub source covering every why_candidate reason ----------------------


class _AllReasonsSource:
    """Returns one row per branch with a distinct sentinel substring
    embedded in the lot_id so a leak is grep-able from the prompt."""

    _SECRET = "LOT_FORBIDDEN_LEAK_SENTINEL"

    def _lot(self, suffix: str, status: str = "on_shelf") -> LotCandidate:
        return LotCandidate(
            lot_id=f"{self._SECRET}_{suffix}",
            product_id=f"prod_{suffix}",
            name=f"Item {suffix}",
            brand=None,
            expected_weight_g=200.0,
            container_type="bottle",
            status=status,  # type: ignore[arg-type]
            reference_image_paths=(),
        )

    def _product(self, suffix: str) -> ProductCandidate:
        return ProductCandidate(
            product_id=f"prod_{suffix}",
            name=f"Item {suffix}",
            brand=None,
            expected_weight_g=150.0,
            container_type="bottle",
            reference_image_paths=(),
        )

    def get_on_shelf_lots(self, shelf_id=None):
        return [self._lot("on_shelf", "on_shelf")]

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return [self._lot("out", "out")]

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return [self._lot("in_flight", "in_flight")]

    def get_inventory_only_products(self, shelf_id=None):
        return [self._product("inventory_only")]

    def get_certified_not_on_shelf(self):
        return [self._product("catalog")]

    def get_catch_all_in_flight_lots(self):
        return [self._lot("ca_in_flight", "in_flight")]

    def get_catch_all_inventory_lots(self):
        return [self._lot("ca_inventory", "on_shelf")]


def _ctx(shelf_id: str | None) -> ClassifierContext:
    return ClassifierContext(source=_AllReasonsSource(), shelf_id=shelf_id)


def _check_pool_payload_purity(pool, image_paths, *, label: str) -> None:
    """Build a payload from a pool and assert no forbidden key leaks."""
    event = _event(image_paths)
    payload = build_messages_payload(event, pool)
    text = _serialise_prompt_text(payload)
    for key in _FORBIDDEN_KEYS:
        assert key not in text, (
            f"[{label}] prompt body leaked forbidden lot-level key "
            f"{key!r}. Decisions #42/#45/#56: classifier sees products "
            f"only. Fix the leak in candidate_pool / models — do NOT "
            f"relax this assertion."
        )
    # Lot-id sentinel must never appear (the source embeds it in lot_id).
    assert _AllReasonsSource._SECRET not in text, (
        f"[{label}] prompt body leaked the lot_id sentinel. The "
        f"per-candidate projection is exposing internal lot_id state."
    )


# --- Per-shelf prompt purity ----------------------------------------------


class TestPromptPurityAcrossShelves:
    """Decision #45 + #56: every shelf kind's pool must produce a
    lot-free prompt. A bug in one shelf's projection cannot be hidden
    by another shelf's clean projection.
    """

    def test_live_shelf_add_pool_prompt_is_lot_free(self, image_paths):
        pool = pool_for_add(delta_g=300.0, ctx=_ctx("live_shelf"))
        _check_pool_payload_purity(pool, image_paths, label="live_shelf:add")

    def test_single_item_add_pool_prompt_is_lot_free(self, image_paths):
        pool = pool_for_add(delta_g=300.0, ctx=_ctx("single_item"))
        _check_pool_payload_purity(pool, image_paths, label="single_item:add")

    def test_catch_all_pool_prompt_is_lot_free(self, image_paths):
        # Catch-all is lot-keyed (candidate_id IS lot_id) per decision
        # #56, so the candidate_id field will literally contain the
        # lot_id sentinel — that's by design. Strip the sentinel guard
        # for catch-all and only check forbidden field NAMES (which
        # would still indicate a leak of qty/expires_on/etc.).
        pool = pool_for_catch_all(delta_g=120.0, ctx=_ctx("catch_all"))
        event = _event(image_paths)
        payload = build_messages_payload(event, pool)
        text = _serialise_prompt_text(payload)
        # Forbidden keys excluding "lot_id" — catch-all candidates ARE
        # lot-keyed by design but must still not expose lot lifecycle
        # state (qty / pickup / etc.).
        catch_all_forbidden = [k for k in _FORBIDDEN_KEYS if k != "lot_id"]
        for key in catch_all_forbidden:
            assert key not in text, (
                f"[catch_all] prompt body leaked forbidden lot-lifecycle "
                f"key {key!r}. Decision #56 keeps lot_id as the "
                f"candidate_id but every other lot-lifecycle field is "
                f"still off-limits — these are bookkeeping, not "
                f"identification signals."
            )

    def test_remove_pool_prompt_is_lot_free(self, image_paths):
        pool = pool_for_remove(delta_g=-300.0, ctx=_ctx("live_shelf"))
        _check_pool_payload_purity(pool, image_paths, label="live_shelf:remove")


# --- Direct contract test on Candidate.to_prompt_dict ---------------------


class TestCandidatePromptDictPurity:
    """Direct unit test on the projection function — every forbidden
    key must be absent from the dict regardless of which fields the
    in-memory Candidate carries."""

    def test_to_prompt_dict_omits_every_forbidden_key(self):
        cand = Candidate(
            candidate_id="prod_x",
            name="X",
            brand=None,
            expected_weight_g=100.0,
            container_type="bottle",
            why_candidate="currently_on_shelf",
            reference_image_paths=(),
            product_id="prod_x",
            lot_id="LOT_DO_NOT_LEAK",
        )
        d = cand.to_prompt_dict()
        for key in _FORBIDDEN_KEYS:
            assert key not in d, (
                f"Candidate.to_prompt_dict() leaked {key!r}: {d!r}. "
                f"Add the field to the per-candidate projection's "
                f"deny-list, not to the prompt."
            )
        # The internal lot_id value must not appear ANYWHERE in the
        # serialised dict (under any key name).
        assert "LOT_DO_NOT_LEAK" not in json.dumps(d), (
            "Candidate.to_prompt_dict() embedded lot_id under some "
            "non-canonical key name. Audit the projection."
        )
