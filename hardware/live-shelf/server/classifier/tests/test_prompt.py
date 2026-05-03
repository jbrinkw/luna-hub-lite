"""Tests for prompt assembly (plan §7.1)."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from server.classifier.models import Candidate, ScaleEvent, UNKNOWN_CANDIDATE_ID
from server.classifier.prompt import (
    INSTRUCTION_TEXT,
    SYSTEM_PROMPT,
    build_catch_all_messages_payload,
    build_messages_payload,
    build_system_prompt,
)


# --- Fixtures --------------------------------------------------------------

# A minimal valid JPEG header + single FFD9 end marker. The classifier
# prompt just needs *some* bytes to base64-encode; it doesn't decode them.
_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def image_paths(tmp_path: Path) -> dict[str, str]:
    """Create disposable before/after/reference JPEG files."""

    paths: dict[str, str] = {}
    for key in ("before", "after", "ref1", "ref2"):
        p = tmp_path / f"{key}.jpg"
        p.write_bytes(_TINY_JPEG)
        paths[key] = str(p)
    return paths


def _event(before: str, after: str, *, direction="remove", delta=-340.0) -> ScaleEvent:
    return ScaleEvent(
        event_id="evt_1",
        session_id="sesn_1",
        ts="2026-04-15T12:00:00.000Z",
        delta_g=delta,
        before_weight_g=2000.0,
        after_weight_g=2000.0 + delta,
        direction=direction,  # type: ignore[arg-type]
        before_frame_path=before,
        after_frame_path=after,
    )


def _candidate(
    cid: str,
    *,
    name: str,
    weight: float | None = 340,
    why: str = "currently_on_shelf",
    refs: tuple[str, ...] = (),
) -> Candidate:
    return Candidate(
        candidate_id=cid,
        name=name,
        brand=None,
        expected_weight_g=weight,
        container_type="bottle",
        why_candidate=why,  # type: ignore[arg-type]
        reference_image_paths=refs,
    )


# --- System prompt ---------------------------------------------------------


class TestSystemPrompt:
    def test_system_prompt_mentions_valid_actions(self):
        prompt = build_system_prompt()
        assert prompt == SYSTEM_PROMPT
        for action in ("removed", "added", "added_to_existing", "unknown"):
            assert f'"{action}"' in prompt

    def test_system_prompt_demands_strict_json(self):
        assert "STRICT JSON" in SYSTEM_PROMPT
        assert "Do not include any text outside the JSON object." in SYSTEM_PROMPT


# --- Payload structure -----------------------------------------------------


class TestPayloadStructure:
    def test_minimal_payload_has_system_and_messages(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [_candidate("L1", name="Ketchup")]
        payload = build_messages_payload(event, candidates)
        assert "system" in payload
        assert "messages" in payload
        assert isinstance(payload["messages"], list)
        assert payload["messages"][0]["role"] == "user"

    def test_system_has_cache_control(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        payload = build_messages_payload(event, [_candidate("L1", name="A")])
        system = payload["system"]
        assert isinstance(system, list)
        assert system[0]["type"] == "text"
        assert system[0]["cache_control"] == {"type": "ephemeral"}

    def test_system_cache_disabled_when_requested(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        payload = build_messages_payload(
            event, [_candidate("L1", name="A")], enable_system_cache=False
        )
        assert isinstance(payload["system"], str)
        assert payload["system"] == SYSTEM_PROMPT


class TestUserContentOrdering:
    def test_ordering_candidates_then_weight_then_frames_then_instruction(
        self, image_paths
    ):
        event = _event(image_paths["before"], image_paths["after"])
        cand = _candidate("L1", name="Ketchup")
        payload = build_messages_payload(event, [cand])
        blocks = payload["messages"][0]["content"]

        # New ordering: cache-stable prefix (candidate JSON + reference
        # images + cache breakpoint) comes FIRST, then fresh per-event
        # content (weight text + before/after frames + instruction).
        types = [b["type"] for b in blocks]

        # First block: candidate JSON header (cache-stable).
        assert types[0] == "text"
        assert "Candidates (ranked by likelihood)" in blocks[0]["text"]

        # Next: weight change text (after cache breakpoint — fresh).
        assert types[1] == "text"
        assert "Weight change" in blocks[1]["text"]
        assert "Event direction" in blocks[1]["text"]

        # Then: before frame image + caption.
        assert types[2] == "image"
        assert types[3] == "text"
        assert blocks[3]["text"] == "[above: before frame]"

        # Then: after frame image + caption.
        assert types[4] == "image"
        assert types[5] == "text"
        assert blocks[5]["text"] == "[above: after frame]"

        # Final block: instruction.
        assert blocks[-1]["type"] == "text"
        assert blocks[-1]["text"] == INSTRUCTION_TEXT

    def test_reference_images_inlined_per_candidate(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [
            _candidate(
                "L1",
                name="Ketchup",
                refs=(image_paths["ref1"], image_paths["ref2"]),
            ),
            _candidate("L2", name="Mustard", refs=(image_paths["ref1"],)),
        ]
        payload = build_messages_payload(event, candidates)
        blocks = payload["messages"][0]["content"]

        # Two images before+after, one weight text, one candidate JSON text,
        # then per-candidate (header + 2 refs) + (header + 1 ref), then instruction.
        image_count = sum(1 for b in blocks if b["type"] == "image")
        # 2 event frames + 2 refs for L1 + 1 ref for L2 = 5
        assert image_count == 5

        # Expect candidate-header markers for each candidate. Headers use
        # numeric indexes only — name/id interpolation was removed as a
        # prompt-injection hardening measure (the model reads name + id
        # from the structured JSON candidate block above).
        header_texts = [
            b["text"] for b in blocks if b["type"] == "text" and b["text"].startswith("[candidate #")
        ]
        assert any("#1" in t for t in header_texts)
        assert any("#2" in t for t in header_texts)


# --- Candidate JSON shape --------------------------------------------------


class TestCandidateJson:
    def test_candidate_json_is_valid_and_ordered(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [
            _candidate("L1", name="Ketchup", why="recently_out"),
            _candidate("L2", name="Mustard", why="currently_on_shelf"),
            _candidate(
                UNKNOWN_CANDIDATE_ID,
                name="Unknown / new item",
                weight=None,
                why="sentinel",
            ),
        ]
        payload = build_messages_payload(event, candidates)
        blocks = payload["messages"][0]["content"]
        json_block = next(
            b for b in blocks
            if b["type"] == "text" and "Candidates (ranked by likelihood)" in b["text"]
        )
        # Extract the JSON substring — we know it follows the header line.
        json_text = json_block["text"].split("\n", 1)[1]
        parsed = json.loads(json_text)
        assert isinstance(parsed, list)
        # Order matches the input order.
        assert [c["candidate_id"] for c in parsed] == ["L1", "L2", UNKNOWN_CANDIDATE_ID]
        # Every entry has the keys required by §4.5 plus our reference count.
        for entry in parsed:
            for key in (
                "candidate_id",
                "name",
                "brand",
                "expected_weight_g",
                "container_type",
                "why_candidate",
                "reference_image_count",
            ):
                assert key in entry

    def test_candidate_reference_images_are_base64_encoded(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [_candidate("L1", name="Ketchup", refs=(image_paths["ref1"],))]
        payload = build_messages_payload(event, candidates)
        blocks = payload["messages"][0]["content"]
        image_blocks = [b for b in blocks if b["type"] == "image"]
        # At least one image block must be the reference image.
        for block in image_blocks:
            assert block["source"]["type"] == "base64"
            assert block["source"]["media_type"].startswith("image/")
            # Verify it's decodable — don't care about the content.
            decoded = base64.b64decode(block["source"]["data"])
            assert decoded == _TINY_JPEG


# --- Cache control ---------------------------------------------------------


class TestCacheControl:
    def test_candidate_metadata_cached_by_default(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        payload = build_messages_payload(
            event,
            [_candidate("L1", name="A")],
        )
        blocks = payload["messages"][0]["content"]
        # Find the block with cache_control on the user content. It should
        # be the last block BEFORE the instruction (the candidate JSON or
        # the last reference image).
        cached_indices = [
            i for i, b in enumerate(blocks) if "cache_control" in b
        ]
        assert cached_indices, "Expected at least one cached user block"
        # Instruction block is the final block and must not be cached.
        assert "cache_control" not in blocks[-1]

    def test_candidate_cache_can_be_disabled(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"])
        payload = build_messages_payload(
            event,
            [_candidate("L1", name="A")],
            enable_candidate_cache=False,
        )
        blocks = payload["messages"][0]["content"]
        cached_indices = [
            i for i, b in enumerate(blocks) if "cache_control" in b
        ]
        assert cached_indices == [], "Expected no cache_control on user blocks"


# --- Weight text ----------------------------------------------------------


class TestWeightText:
    def test_add_direction_reads_as_gained(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"], direction="add", delta=120.0)
        payload = build_messages_payload(event, [_candidate("L1", name="A")])
        blocks = payload["messages"][0]["content"]
        text_block = next(b for b in blocks if b["type"] == "text" and "Weight change" in b["text"])
        assert "shelf gained" in text_block["text"]
        assert "Event direction: add" in text_block["text"]

    def test_remove_direction_reads_as_dropped(self, image_paths):
        event = _event(image_paths["before"], image_paths["after"], direction="remove", delta=-340.0)
        payload = build_messages_payload(event, [_candidate("L1", name="A")])
        blocks = payload["messages"][0]["content"]
        text_block = next(b for b in blocks if b["type"] == "text" and "Weight change" in b["text"])
        assert "shelf dropped" in text_block["text"]
        assert "Event direction: remove" in text_block["text"]


# --- Prompt-purity invariant (decisions.md #42) -----------------------------


# Per-lot field names that MUST NEVER appear in the classifier prompt body.
# The classifier sees products only; lot resolution is purely deterministic
# on the apply path (``_pick_best_lot_for_product`` in
# ``handlers/scale_events.py``). User design intent: "the classifier agent
# shouldn't be seeing individual lots. matching should be done programmatically."
_FORBIDDEN_LOT_KEYS = (
    "lot_id",
    "expires_on",
    "qty_containers",
    "in_flight_since",
    "pickup_weight_g",
    "current_weight_g",
    "pickup_event_id",
    "last_out_at",
    "pickup_session_id",
)


def _serialise_prompt_text(payload: dict) -> str:
    """Concatenate every text block from a prompt payload.

    Image blocks are skipped — they're base64 bytes, not prose. The
    system prompt is also included so a regression that puts a
    forbidden key in the cached prefix doesn't slip through.
    """
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


class TestPromptPurity:
    """Decisions.md #42 — classifier never sees lot-level fields.

    These tests grep the rendered prompt body for forbidden keys. If
    one fires, the candidate-pool builder or ``Candidate.to_prompt_dict``
    is leaking lot-level state into the model's view — the user has
    explicitly forbidden this. Fix the leak; do NOT relax the test.
    """

    def test_to_prompt_dict_has_no_forbidden_keys(self):
        # Direct contract test on the per-candidate projection.
        cand = Candidate(
            candidate_id="prod_123",
            name="Chicken",
            brand="Tyson",
            expected_weight_g=540.0,
            container_type="container",
            why_candidate="currently_on_shelf",
            reference_image_paths=(),
            product_id="prod_123",
            lot_id="lot_xyz_must_not_leak",
        )
        d = cand.to_prompt_dict()
        for key in _FORBIDDEN_LOT_KEYS:
            assert key not in d, (
                f"Candidate.to_prompt_dict() leaked forbidden lot-level "
                f"key {key!r}: {d!r}"
            )
        # Positive: candidate_id is the product_id, not the lot_id.
        assert d["candidate_id"] == "prod_123"
        # The internal lot_id field must not appear.
        assert "lot_xyz_must_not_leak" not in json.dumps(d)

    def test_full_payload_text_has_no_forbidden_keys(self, image_paths):
        # End-to-end: render a full prompt payload and grep every text
        # block for forbidden lot fields.
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [
            Candidate(
                candidate_id="prod_a",
                name="Item A",
                brand=None,
                expected_weight_g=120.0,
                container_type="bottle",
                why_candidate="currently_on_shelf",
                reference_image_paths=(image_paths["ref1"],),
                product_id="prod_a",
                lot_id="LOT_SECRET_DO_NOT_LEAK_A",
            ),
            Candidate(
                candidate_id="prod_b",
                name="Item B",
                brand=None,
                expected_weight_g=320.0,
                container_type="jar",
                why_candidate="recently_out",
                reference_image_paths=(),
                product_id="prod_b",
                lot_id="LOT_SECRET_DO_NOT_LEAK_B",
            ),
        ]
        payload = build_messages_payload(event, candidates)
        prompt_text = _serialise_prompt_text(payload)
        for key in _FORBIDDEN_LOT_KEYS:
            assert key not in prompt_text, (
                f"Prompt body leaked forbidden lot-level key {key!r}. "
                f"This violates decisions.md #42. Fix the leak in "
                f"candidate_pool / models, do NOT relax this assertion."
            )
        # The internal lot_id values must not appear anywhere in the
        # serialised prompt text — they were stored on the Candidate
        # but should be projected away by ``to_prompt_dict``.
        assert "LOT_SECRET_DO_NOT_LEAK_A" not in prompt_text
        assert "LOT_SECRET_DO_NOT_LEAK_B" not in prompt_text

    def test_no_lot_status_or_in_flight_in_prompt(self, image_paths):
        # Specifically pin that ``status`` (on_shelf / out / in_flight)
        # never appears as a JSON key — the classifier should not
        # reason about per-lot lifecycle state.
        event = _event(image_paths["before"], image_paths["after"])
        candidates = [
            Candidate(
                candidate_id="prod_x",
                name="Item X",
                brand=None,
                expected_weight_g=200.0,
                container_type=None,
                why_candidate="in_flight",
                reference_image_paths=(),
                product_id="prod_x",
                lot_id="lot_inflight_x",
            ),
        ]
        payload = build_messages_payload(event, candidates)
        prompt_text = _serialise_prompt_text(payload)
        # JSON-quoted to avoid false positives from prose mentions of
        # the word "status" in human-readable instructions.
        assert '"status":' not in prompt_text
        assert '"in_flight_since":' not in prompt_text
        assert '"pickup_weight_g":' not in prompt_text


# --- Catch-all tare-estimation instruction (Task 6) ------------------------


def test_catch_all_instruction_requests_tare_when_needs_tare_set():
    """When any candidate has needs_tare_estimate=True, the instruction
    text MUST tell the model to also produce estimated_tare_g for that
    candidate. When no candidate needs it, the tare instruction stays
    silent (saves prompt tokens on the common case)."""
    candidates_with_need = [
        Candidate(candidate_id="lot-1", name="Pasta Box", brand=None,
                  expected_weight_g=500.0, container_type="cardboard_box",
                  why_candidate="inventory_only",
                  needs_tare_estimate=True, net_weight_g=500.0,
                  product_id="p-1", lot_id="lot-1"),
    ]
    candidates_no_need = [
        Candidate(candidate_id="lot-2", name="Olive Oil", brand=None,
                  expected_weight_g=750.0, container_type="glass_bottle",
                  why_candidate="inventory_only",
                  needs_tare_estimate=False, net_weight_g=750.0,
                  product_id="p-2", lot_id="lot-2"),
    ]
    event = ScaleEvent(event_id="e1", session_id=None, ts="2026-05-02T00:00:00Z",
                      delta_g=505.0, before_weight_g=0.0, after_weight_g=505.0,
                      direction="add", before_frame_path=None,
                      after_frame_path=None)
    p_with = build_catch_all_messages_payload(event, candidates_with_need)
    p_without = build_catch_all_messages_payload(event, candidates_no_need)
    text_with = " ".join(
        b["text"] for b in p_with["messages"][0]["content"] if b.get("type") == "text"
    )
    text_without = " ".join(
        b["text"] for b in p_without["messages"][0]["content"] if b.get("type") == "text"
    )
    # Tare-instruction block appears only when needed.
    assert "estimated_tare_g" in text_with
    assert "empty container" in text_with.lower()
    assert "estimated_tare_g" not in text_without


def test_catch_all_system_prompt_acknowledges_estimated_tare_g():
    """The system prompt's schema MUST acknowledge the optional
    estimated_tare_g field so the model's strict-JSON instruction
    doesn't conflict with the conditional tare-estimation block.

    Task 6 added a conditional instruction that asks the model to
    return ``estimated_tare_g`` for some candidates, but the original
    catch-all system prompt declared a strict 4-field schema with
    "Do not include any text outside the JSON object." That contradiction
    risks the model dropping the tare field to comply with the strict
    schema. This test pins the schema-block fix so future edits don't
    regress it.
    """
    from server.classifier.prompt import CATCH_ALL_SYSTEM_PROMPT
    assert "estimated_tare_g" in CATCH_ALL_SYSTEM_PROMPT, (
        "System prompt must mention estimated_tare_g so model knows "
        "the field is permitted (Task 6 + Task 7 dependency)."
    )
