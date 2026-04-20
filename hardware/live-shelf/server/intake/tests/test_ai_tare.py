"""Tests for :mod:`server.intake.ai_tare`.

The Anthropic SDK is stubbed end-to-end — no real HTTP is ever issued.
Each test builds a :class:`FakeClient` whose ``messages.create`` returns a
pre-scripted response object so we can assert both the request the SDK
would have received (prompt shape, images, params) and the parsed result.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from server.intake import ai_tare
from server.intake.ai_tare import (
    AiTareApiError,
    AiTareMalformedOutput,
    AiTareUnavailable,
    _build_payload,
    _encode_image_block,
    _extract_json,
    _extract_text_from_response,
    _parse_estimate,
    _render_product_text,
    estimate,
    resolve_model,
)
from server.intake.models import AiTareProductForm, TareEstimate


# --- Helpers -------------------------------------------------------------

_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def ref_images(tmp_path: Path) -> list[str]:
    paths: list[str] = []
    for i in (1, 2):
        p = tmp_path / f"ref{i}.jpg"
        p.write_bytes(_TINY_JPEG + bytes([i]))
        paths.append(str(p))
    return paths


@dataclass
class _FakeBlock:
    type: str
    text: str = ""


@dataclass
class _FakeResponse:
    content: list[Any]


class FakeClient:
    """Minimal stand-in for ``anthropic.Anthropic()``.

    Exposes a ``messages.create`` attribute that records its call args and
    returns a pre-scripted response (or raises a pre-scripted exception).
    """

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.messages = self  # so client.messages.create works

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("FakeClient: out of scripted responses")
        value = self._responses.pop(0)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, _FakeResponse):
            return value
        # Plain strings are treated as a single text-block final answer.
        return _FakeResponse(content=[_FakeBlock(type="text", text=value)])


def _valid_json(
    *,
    tare: float = 175.0,
    confidence: str = "medium",
    appears_sealed: bool = True,
    reasoning: str = "Looks like a standard glass jar.",
) -> str:
    return json.dumps(
        {
            "tare_weight_g": tare,
            "confidence": confidence,
            "appears_sealed": appears_sealed,
            "reasoning": reasoning,
        }
    )


# --- resolve_model --------------------------------------------------------


class TestResolveModel:
    def test_default(self, monkeypatch):
        monkeypatch.delenv("LIVE_SHELF_TARE_MODEL", raising=False)
        assert resolve_model() == "claude-sonnet-4-6"

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("LIVE_SHELF_TARE_MODEL", "claude-opus-4-6-exp")
        assert resolve_model() == "claude-opus-4-6-exp"

    def test_explicit_beats_env(self, monkeypatch):
        monkeypatch.setenv("LIVE_SHELF_TARE_MODEL", "from-env")
        assert resolve_model("explicit") == "explicit"


# --- Image encoding ------------------------------------------------------


class TestImageEncoding:
    def test_base64_roundtrip(self, tmp_path: Path):
        p = tmp_path / "sample.jpg"
        p.write_bytes(_TINY_JPEG)
        block = _encode_image_block(p)
        assert block["type"] == "image"
        assert block["source"]["type"] == "base64"
        assert block["source"]["media_type"] == "image/jpeg"
        decoded = base64.standard_b64decode(block["source"]["data"])
        assert decoded == _TINY_JPEG

    def test_media_type_fallback(self, tmp_path: Path):
        # Extension-less file still yields a sensible media type.
        p = tmp_path / "frame"
        p.write_bytes(_TINY_JPEG)
        block = _encode_image_block(p)
        assert block["source"]["media_type"] == "image/jpeg"


# --- Prompt rendering ----------------------------------------------------


class TestRenderProductText:
    def test_all_fields_filled(self):
        form = AiTareProductForm(
            name="Heinz Tomato Ketchup",
            brand="Heinz",
            variant=None,
            net_weight_g=340.0,
            serving_weight_g=17.0,
            servings_per_container=20,
            unit_type="liquid",
            container_type="bottle",
        )
        text = _render_product_text(form, measured_gross_g=510.5, is_partial=False)
        assert "Heinz Tomato Ketchup" in text
        assert "net_weight_g: 340" in text
        assert "serving_weight_g: 17" in text
        assert "servings_per_container: 20" in text
        assert "unit_type: liquid" in text
        assert "container_type: bottle" in text
        assert "Measured gross on scale: 510.5 g" in text
        assert "partially used: false" in text

    def test_missing_gross_omits_line(self):
        form = AiTareProductForm(name="Generic")
        text = _render_product_text(form, measured_gross_g=None, is_partial=None)
        assert "Measured gross" not in text
        assert "partially used" not in text
        # Nulls render explicitly so the model sees a stable schema.
        assert "net_weight_g: null" in text
        assert "variant: null" in text

    def test_partial_true_is_flagged(self):
        form = AiTareProductForm(name="Jar", net_weight_g=100)
        text = _render_product_text(form, measured_gross_g=None, is_partial=True)
        assert "partially used: true" in text


# --- JSON extraction / parsing ------------------------------------------


class TestExtractJson:
    def test_plain_passthrough(self):
        text = '{"tare_weight_g": 100}'
        assert _extract_json(text) == text

    def test_strips_fences(self):
        text = '```json\n{"tare_weight_g": 100}\n```'
        assert _extract_json(text) == '{"tare_weight_g": 100}'

    def test_extracts_from_preamble(self):
        text = 'My answer: {"tare_weight_g": 100, "confidence": "high"}.'
        assert (
            _extract_json(text) == '{"tare_weight_g": 100, "confidence": "high"}'
        )

    def test_empty_raises(self):
        with pytest.raises(AiTareMalformedOutput):
            _extract_json("")

    def test_no_braces_raises(self):
        with pytest.raises(AiTareMalformedOutput):
            _extract_json("just prose")


class TestParseEstimate:
    def test_valid_payload(self):
        parsed = _parse_estimate(_valid_json(tare=175, confidence="high"))
        assert isinstance(parsed, TareEstimate)
        assert parsed.tare_weight_g == 175.0
        assert parsed.confidence == "high"
        assert parsed.appears_sealed is True
        assert "glass jar" in parsed.reasoning.lower()

    def test_confidence_is_lowercased(self):
        parsed = _parse_estimate(_valid_json(confidence="HIGH"))
        assert parsed.confidence == "high"

    def test_float_tare_allowed(self):
        parsed = _parse_estimate(_valid_json(tare=175.6))
        assert parsed.tare_weight_g == 175.6

    def test_invalid_confidence_rejected(self):
        bad = json.dumps(
            {
                "tare_weight_g": 100,
                "confidence": "extreme",
                "appears_sealed": True,
                "reasoning": "x",
            }
        )
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate(bad)

    def test_non_boolean_sealed_rejected(self):
        bad = json.dumps(
            {
                "tare_weight_g": 100,
                "confidence": "low",
                "appears_sealed": "maybe",
                "reasoning": "x",
            }
        )
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate(bad)

    def test_missing_tare_rejected(self):
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate(
                json.dumps(
                    {
                        "confidence": "low",
                        "appears_sealed": False,
                        "reasoning": "",
                    }
                )
            )

    def test_negative_tare_rejected(self):
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate(_valid_json(tare=-5))

    def test_malformed_json_rejected(self):
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate("absolutely not json")

    def test_non_object_rejected(self):
        with pytest.raises(AiTareMalformedOutput):
            _parse_estimate('["tare"]')


# --- Text extraction from SDK response ----------------------------------


class TestExtractText:
    def test_concatenates_text_blocks_skipping_thinking(self):
        resp = _FakeResponse(
            content=[
                _FakeBlock(type="thinking", text="<internal reasoning>"),
                _FakeBlock(type="text", text='{"foo":'),
                _FakeBlock(type="text", text=' "bar"}'),
            ]
        )
        assert _extract_text_from_response(resp) == '{"foo": "bar"}'

    def test_empty_response(self):
        assert _extract_text_from_response(_FakeResponse(content=[])) == ""


# --- Payload construction ------------------------------------------------


class TestBuildPayload:
    def test_images_first_then_text(self, ref_images):
        form = AiTareProductForm(name="Jar", net_weight_g=100)
        payload = _build_payload(
            ref_image_paths=ref_images,
            product_form=form,
            measured_gross_g=150.0,
            is_partial=False,
            model="claude-opus-4-6",
            max_tokens=1500,
            thinking_budget_tokens=3000,
        )
        content = payload.messages[0]["content"]
        # Images come before the text block.
        assert content[0]["type"] == "image"
        assert content[1]["type"] == "image"
        assert content[2]["type"] == "text"
        # All supplied images are encoded.
        assert len([b for b in content if b["type"] == "image"]) == 2
        # Text block includes the full metadata block.
        assert "Jar" in content[2]["text"]
        assert "Measured gross on scale: 150.0 g" in content[2]["text"]


# --- End-to-end estimate() ----------------------------------------------


class TestEstimate:
    def test_happy_path(self, ref_images):
        client = FakeClient([_valid_json(tare=175, confidence="medium")])
        form = AiTareProductForm(
            name="Ketchup",
            net_weight_g=340,
            container_type="bottle",
            unit_type="liquid",
        )
        result, model, budget = estimate(
            ref_image_paths=ref_images,
            product_form=form,
            measured_gross_g=510.5,
            is_partial=False,
            client=client,
        )
        assert result.tare_weight_g == 175
        assert result.confidence == "medium"
        assert result.appears_sealed is True
        # Defaults changed to Sonnet + no thinking (cost optimization).
        assert model == "claude-sonnet-4-6"
        assert budget == 0

        # SDK was called with the expected shape.
        assert len(client.calls) == 1
        call = client.calls[0]
        assert call["model"] == "claude-sonnet-4-6"
        assert call["max_tokens"] == 512
        assert call["temperature"] == 0
        # No thinking param when budget is 0.
        assert "thinking" not in call

        # Prompt includes images + metadata.
        user_content = call["messages"][0]["content"]
        image_blocks = [b for b in user_content if b["type"] == "image"]
        text_blocks = [b for b in user_content if b["type"] == "text"]
        assert len(image_blocks) == 2
        assert len(text_blocks) == 1
        assert "Ketchup" in text_blocks[0]["text"]
        assert "Measured gross on scale: 510.5 g" in text_blocks[0]["text"]
        assert "partially used: false" in text_blocks[0]["text"]

    def test_images_base64_encoded(self, ref_images):
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Jar")
        estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
        )
        call = client.calls[0]
        image_blocks = [
            b
            for b in call["messages"][0]["content"]
            if b["type"] == "image"
        ]
        # Each image_block's data decodes back to the original bytes.
        with open(ref_images[0], "rb") as f:
            expected = f.read()
        decoded = base64.standard_b64decode(image_blocks[0]["source"]["data"])
        assert decoded == expected

    def test_malformed_then_valid_retries_once(self, ref_images):
        client = FakeClient(["not json at all", _valid_json(tare=200)])
        form = AiTareProductForm(name="Thing")
        result, _, _ = estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
        )
        assert result.tare_weight_g == 200
        assert len(client.calls) == 2

    def test_two_malformed_raises(self, ref_images):
        client = FakeClient(["nope", "still nope"])
        form = AiTareProductForm(name="Thing")
        with pytest.raises(AiTareMalformedOutput):
            estimate(
                ref_image_paths=ref_images,
                product_form=form,
                client=client,
            )
        assert len(client.calls) == 2

    def test_api_error_retries_once_then_raises(self, ref_images):
        # ai_tare now mirrors the classifier's retry semantics: a transient
        # API error on attempt 1 gets one retry. If the second call also
        # errors, AiTareApiError is raised with the LAST error's context.
        client = FakeClient([RuntimeError("boom"), RuntimeError("still broken")])
        form = AiTareProductForm(name="Thing")
        with pytest.raises(AiTareApiError) as excinfo:
            estimate(
                ref_image_paths=ref_images,
                product_form=form,
                client=client,
            )
        assert "still broken" in str(excinfo.value)
        assert len(client.calls) == 2

    def test_api_error_on_first_attempt_then_success(self, ref_images):
        # First call fails, second succeeds — estimate returns the parsed
        # second response rather than raising.
        client = FakeClient([RuntimeError("boom"), _valid_json()])
        form = AiTareProductForm(name="Thing")
        result = estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
        )
        assert result is not None
        assert len(client.calls) == 2

    def test_no_images_raises(self):
        form = AiTareProductForm(name="Thing")
        with pytest.raises(ValueError):
            estimate(
                ref_image_paths=[],
                product_form=form,
                client=FakeClient([_valid_json()]),
            )

    def test_missing_gross_omits_scale_line(self, ref_images):
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Thing", net_weight_g=100)
        estimate(
            ref_image_paths=ref_images,
            product_form=form,
            measured_gross_g=None,
            is_partial=None,
            client=client,
        )
        text = client.calls[0]["messages"][0]["content"][-1]["text"]
        assert "Measured gross" not in text
        assert "partially used" not in text

    def test_is_partial_flag_included(self, ref_images):
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Thing")
        estimate(
            ref_image_paths=ref_images,
            product_form=form,
            is_partial=True,
            client=client,
        )
        text = client.calls[0]["messages"][0]["content"][-1]["text"]
        assert "partially used: true" in text

    def test_model_override(self, ref_images):
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Thing")
        _, model_used, _ = estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
            model="claude-opus-4-6-test",
        )
        assert model_used == "claude-opus-4-6-test"
        assert client.calls[0]["model"] == "claude-opus-4-6-test"

    def test_thinking_opt_in(self, ref_images):
        """Passing a positive budget enables extended thinking + bumps max_tokens."""
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Thing")
        _, _, budget_used = estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
            thinking_budget_tokens=2000,
        )
        assert budget_used == 2000
        call = client.calls[0]
        assert call["thinking"] == {"type": "enabled", "budget_tokens": 2000}
        # max_tokens should be auto-bumped above the thinking budget.
        assert call["max_tokens"] > 2000
        # Anthropic rejects temperature!=1 when extended thinking is enabled,
        # so it must be omitted entirely (SDK default of 1 is required).
        assert "temperature" not in call

    def test_no_api_key_without_client_raises_unavailable(
        self, ref_images, monkeypatch
    ):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        form = AiTareProductForm(name="Thing")
        with pytest.raises(AiTareUnavailable):
            estimate(
                ref_image_paths=ref_images,
                product_form=form,
                # No client — forces the module to look up the env var.
            )

    def test_system_prompt_present(self, ref_images):
        client = FakeClient([_valid_json()])
        form = AiTareProductForm(name="Thing")
        estimate(
            ref_image_paths=ref_images,
            product_form=form,
            client=client,
        )
        system = client.calls[0]["system"]
        assert "empty container" in system.lower() or "tare" in system.lower()
        assert "STRICT JSON" in system
