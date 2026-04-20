"""Tests for :mod:`server.intake.off_lookup`.

HTTP is mocked with :class:`httpx.MockTransport` so no network calls escape
the test process. Each test targets a specific branch of the parser:
populated success, sparse success, 404, 5xx, malformed JSON, network error.
"""

from __future__ import annotations

import json

import httpx
import pytest

from server.intake.off_lookup import lookup_barcode

# A realistic (trimmed) OFF v2 response. The shape mirrors what the real
# API returns for a common grocery barcode.
_FULL_PAYLOAD = {
    "status": 1,
    "product": {
        "product_name": "Heinz Tomato Ketchup",
        "brands": "Heinz",
        "product_quantity": "340",
        "serving_quantity": "17",
        "serving_size": "1 tbsp (17 g)",
        "nutriments": {
            "energy-kcal_serving": 20,
        },
        "ecoscore_data": {
            "packaging_info": "Plastic bottle",
        },
        "image_front_url": "https://example.com/ketchup.jpg",
    },
}


def _make_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_full_payload_maps_every_field():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/123456789012.json")
        return httpx.Response(200, json=_FULL_PAYLOAD)

    with _make_client(handler) as client:
        off = lookup_barcode("123456789012", client=client)

    assert off.found is True
    assert off.barcode == "123456789012"
    assert off.product_name == "Heinz Tomato Ketchup"
    assert off.brands == "Heinz"
    assert off.product_quantity_g == pytest.approx(340.0)
    assert off.serving_quantity_g == pytest.approx(17.0)
    assert off.serving_size == "1 tbsp (17 g)"
    assert off.energy_kcal_per_serving == pytest.approx(20.0)
    assert off.packaging_info == "Plastic bottle"
    assert off.image_front_url == "https://example.com/ketchup.jpg"


def test_sparse_payload_leaves_missing_fields_as_none():
    payload = {"status": 1, "product": {"product_name": "Mystery Yogurt"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("9999999999999", client=client)

    assert off.found is True
    assert off.product_name == "Mystery Yogurt"
    assert off.brands is None
    assert off.product_quantity_g is None
    assert off.energy_kcal_per_serving is None
    assert off.packaging_info is None


def test_404_returns_not_found_but_preserves_barcode():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"status": 0})

    with _make_client(handler) as client:
        off = lookup_barcode("0000000000000", client=client)

    assert off.found is False
    assert off.barcode == "0000000000000"
    assert off.product_name is None


def test_status_zero_treated_as_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        # OFF sometimes returns HTTP 200 with status=0 for unknown barcodes
        return httpx.Response(200, json={"status": 0, "product": None})

    with _make_client(handler) as client:
        off = lookup_barcode("1111111111111", client=client)

    assert off.found is False
    assert off.barcode == "1111111111111"


def test_server_error_swallowed_as_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream boom")

    with _make_client(handler) as client:
        off = lookup_barcode("2222222222222", client=client)

    assert off.found is False


def test_malformed_json_swallowed_as_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="this is not json")

    with _make_client(handler) as client:
        off = lookup_barcode("3333333333333", client=client)

    assert off.found is False


def test_network_error_swallowed_as_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope", request=request)

    with _make_client(handler) as client:
        off = lookup_barcode("4444444444444", client=client)

    assert off.found is False
    assert off.barcode == "4444444444444"


def test_empty_barcode_short_circuits_without_http_call():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("HTTP must not be called for an empty barcode")

    with _make_client(handler) as client:
        off = lookup_barcode("", client=client)
        off2 = lookup_barcode("   ", client=client)

    assert off.found is False
    assert off.barcode == ""
    assert off2.found is False


def test_packaging_info_falls_back_to_top_level_packaging_field():
    payload = {
        "status": 1,
        "product": {
            "product_name": "Widget",
            "packaging": "Glass jar",
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("5555555555555", client=client)

    assert off.packaging_info == "Glass jar"


def test_non_string_product_name_stringified():
    # OFF occasionally returns numeric product IDs where names should be
    # — make sure we don't crash or drop the value.
    payload = {"status": 1, "product": {"product_name": 12345}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("6666666666666", client=client)

    assert off.product_name == "12345"


def test_base_url_override_used_for_request_path():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=_FULL_PAYLOAD)

    with _make_client(handler) as client:
        lookup_barcode(
            "1234",
            client=client,
            base_url="https://custom.example/api/v2/product",
        )

    assert len(calls) == 1
    assert calls[0] == "https://custom.example/api/v2/product/1234.json"


def test_invalid_json_structure_status_missing():
    # OFF edge case: top-level `product` key missing entirely
    payload = {"code": "7777777777777"}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("7777777777777", client=client)

    assert off.found is False


def test_user_agent_header_sent():
    captured_ua: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_ua.append(request.headers.get("user-agent", ""))
        return httpx.Response(200, json=_FULL_PAYLOAD)

    # Force owns_client path to exercise the real header wiring
    orig_client = httpx.Client

    class _SpyClient(httpx.Client):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, transport=httpx.MockTransport(handler), **{k: v for k, v in kwargs.items() if k != "transport"})

    # Monkeypatch at call site only
    import server.intake.off_lookup as mod

    mod.httpx.Client = _SpyClient  # type: ignore[assignment]
    try:
        off = lookup_barcode("8888888888888")
    finally:
        mod.httpx.Client = orig_client  # type: ignore[assignment]

    assert off.found is True
    assert captured_ua and "luna-hub-lite" in captured_ua[0]


def test_serving_quantity_as_number_not_string():
    # OFF sometimes returns numbers rather than strings for quantity fields
    payload = {
        "status": 1,
        "product": {
            "product_name": "Thing",
            "product_quantity": 500,
            "serving_quantity": 50.5,
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("9090909090909", client=client)

    assert off.product_quantity_g == pytest.approx(500.0)
    assert off.serving_quantity_g == pytest.approx(50.5)


def test_garbage_quantity_skipped():
    payload = {
        "status": 1,
        "product": {
            "product_name": "Thing",
            "product_quantity": "not-a-number",
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _make_client(handler) as client:
        off = lookup_barcode("1010101010101", client=client)

    assert off.product_quantity_g is None
