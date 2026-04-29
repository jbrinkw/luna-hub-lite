"""Tests for the live_shelf prompt's handling of partial-fill containers.

Regression coverage for the 2026-04-29 user report on event
``9674af3b-102d-4b5b-9de0-54654f41fa7e``: the classifier flagged a
clear visual match (Chocolate 2% milk bottle) at confidence 0.55 with
reasoning ``"delta is significantly less than catalog weight,
suggesting partially consumed bottle being returned"``. Per the user,
that pattern is the EXPECTED case for any opened-then-replaced
container, not a reason to downgrade confidence below review threshold.

These tests pin the prompt + post-processing so a future refactor can't
silently re-introduce the "delta < catalog ⇒ suspicious" bias.
"""

from __future__ import annotations

import re

from server.classifier.classify import _coerce_confidence
from server.classifier.prompt import (
    INSTRUCTION_TEXT,
    SYSTEM_PROMPT,
    build_system_prompt,
)


class TestSystemPromptPartialFill:
    """The shelf system prompt should explicitly authorise high
    confidence on partial-fill ADDs of bottles / jugs."""

    def test_system_prompt_calls_out_partial_fill_as_normal(self) -> None:
        prompt = build_system_prompt()
        assert prompt == SYSTEM_PROMPT
        # The prompt must explicitly tell the model that placing a
        # partially-consumed container on the shelf is normal usage.
        lowered = prompt.lower()
        assert "partial" in lowered, (
            "system prompt does not mention partial fills — reasoning bias "
            "for `delta < catalog ⇒ suspicious` will resurface"
        )
        # Cover the specific phrasing the user flagged: the prompt must
        # not lead the model to that conclusion.
        # Either the prompt needs a positive instruction ("commit at
        # high confidence") OR an explicit negation of that bias.
        partial_high_conf = re.search(
            r"high\s+confidence",
            prompt,
            re.IGNORECASE,
        )
        assert partial_high_conf is not None, (
            "system prompt must instruct high confidence on visual matches "
            "even with partial-fill weights"
        )

    def test_system_prompt_does_not_treat_partial_as_suspicious(self) -> None:
        """The prompt must NOT instruct the model that delta < catalog
        is suspicious.

        This is the failure mode the user reported: model produced
        ``"delta is significantly less than catalog weight, suggesting
        partially consumed bottle being returned, or the weight sensor
        is only capturing part of the item"`` and dropped confidence
        to 0.55. That reasoning is wrong — partially consumed = normal.

        We allow the phrase to appear within an explicit *negation*
        (``Do NOT reason ...``) so the prompt can tell the model the
        bad reasoning is forbidden.
        """
        prompt = build_system_prompt()
        lowered = prompt.lower()
        anti_pattern_substring = "delta is significantly less than catalog"
        if anti_pattern_substring in lowered:
            # Must appear inside an explicit "do not" / "don't" framing.
            idx = lowered.find(anti_pattern_substring)
            window = lowered[max(0, idx - 60) : idx + len(anti_pattern_substring)]
            assert (
                "do not" in window or "don't" in window or "not " in window
            ), (
                "system prompt mentions the anti-pattern reasoning "
                "without a negating framing — that would seed the bad "
                "reasoning, not block it"
            )


class TestInstructionTextPartialFill:
    """The per-event instruction text echoes the partial-fill rule."""

    def test_instruction_mentions_partial_fill_normality(self) -> None:
        lowered = INSTRUCTION_TEXT.lower()
        assert "partial" in lowered, (
            "INSTRUCTION_TEXT must echo partial-fill normality so the "
            "fresh per-event reminder matches the cached system prompt"
        )

    def test_instruction_does_not_demand_tight_add_weight_match(self) -> None:
        """For ADD events, the prompt must NOT require the placement
        weight to match catalog within ~10%. That's correct for
        REMOVE (where mass arithmetic pins the picked set) but wrong
        for ADD (partially consumed containers are routine).
        """
        # The prior copy said "should have catalog weights summing to
        # |delta_g| within ~10% tolerance" without distinguishing
        # ADD vs REMOVE. We require the new copy to either scope the
        # 10% tolerance to REMOVE or to mention partial-fill explicitly.
        lowered = INSTRUCTION_TEXT.lower()
        if "10%" in lowered or "~10%" in lowered:
            # If 10% is mentioned, it must be REMOVE-scoped: the
            # surrounding sentence (within ~200 chars) should reference
            # REMOVE events. ADD events have partial-fill normality and
            # MUST NOT carry the 10% tolerance demand.
            idx = lowered.find("10%")
            window = lowered[max(0, idx - 200) : idx + 200]
            assert "remove" in window, (
                "INSTRUCTION_TEXT mentions 10% tolerance without REMOVE "
                "scoping — the tight ADD weight match is the bias the "
                "user asked us to remove"
            )
            # And the ADD framing must explicitly authorise partial fills.
            assert "partial" in lowered, (
                "INSTRUCTION_TEXT mentions 10% tolerance but does not "
                "carve out partial-fill ADDs — the bias is still in the "
                "instruction"
            )


class TestConfidencePostProcessing:
    """No post-processing should reduce confidence based on weight ratio.

    The classifier path runs through ``_coerce_confidence`` (clamps to
    [0,1]), then through ``parse_response`` and ``_normalise_unknown``.
    None of those steps should look at delta / catalog ratios. This
    test is a load-bearing assertion that the path stays a pure
    pass-through — if a future refactor introduces a weight-ratio
    confidence penalty, this test breaks.
    """

    def test_coerce_confidence_is_pure_clamp(self) -> None:
        # In-range values pass through untouched.
        assert _coerce_confidence(0.85) == 0.85
        assert _coerce_confidence(0.55) == 0.55
        # Out-of-range values clamp.
        assert _coerce_confidence(1.5) == 1.0
        assert _coerce_confidence(-0.1) == 0.0
        # Strings parse.
        assert _coerce_confidence("0.85") == 0.85

    def test_no_weight_ratio_penalty_in_classify_module(self) -> None:
        """Pin-down test: the classify module must not reference any
        weight/delta ratio when computing confidence. If a future
        change adds something like ``confidence *= delta/catalog``,
        this guard fires."""
        from server.classifier import classify as classify_mod

        src = open(classify_mod.__file__, encoding="utf-8").read()
        # These patterns would indicate weight-ratio confidence math.
        forbidden_patterns = [
            r"confidence\s*\*=\s*.*delta",
            r"confidence\s*\*=\s*.*weight",
            r"confidence\s*=\s*confidence\s*\*\s*",
            r"delta_g\s*/\s*.*weight.*confidence",
        ]
        for pat in forbidden_patterns:
            assert re.search(pat, src) is None, (
                f"classify.py contains weight-ratio confidence math "
                f"matching pattern {pat!r} — that would re-introduce the "
                f"penalty the user asked us to remove"
            )
