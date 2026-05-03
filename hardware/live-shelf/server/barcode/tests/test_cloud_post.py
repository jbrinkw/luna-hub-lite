"""Verify CloudClient.post_barcode_scan POST shape.

Task 8 (USB-Scanner): exercises the network seam that forwards a
USB-scanner-decoded barcode to the cloud's `/shelf-ingest/barcode-scan`
endpoint. We patch the underlying `post` method so the test never makes
a real HTTP call — the only contract verified here is *what shape* gets
sent and *that the cloud response passes through unchanged*. Idempotency
on the cloud side (re-posting same `pi_event_id` returns the original
transaction) is enforced server-side and validated by the edge function
tests, not here.
"""
from __future__ import annotations

from unittest.mock import patch

from server.cloud.client import CloudClient


def test_post_barcode_scan_routes_to_correct_endpoint():
    client = CloudClient(base_url="https://x", import_key="k")
    with patch.object(client, "post") as mock_post:
        mock_post.return_value = {"transaction_id": "tx-1", "status": "applied"}
        result = client.post_barcode_scan(barcode="123", pi_event_id="evt-1")
        mock_post.assert_called_once()
        path = mock_post.call_args.args[0]
        body = mock_post.call_args.args[1]
        assert path == "/barcode-scan"
        assert body["barcode"] == "123"
        assert body["pi_event_id"] == "evt-1"
        assert result["transaction_id"] == "tx-1"


def test_post_barcode_scan_omits_optional_fields_when_unset():
    client = CloudClient(base_url="https://x", import_key="k")
    with patch.object(client, "post") as mock_post:
        mock_post.return_value = {}
        client.post_barcode_scan(barcode="456", pi_event_id="evt-2")
        body = mock_post.call_args.args[1]
        assert "mode" not in body
        assert "qty" not in body
        assert "unit" not in body


def test_post_barcode_scan_includes_optional_fields_when_set():
    client = CloudClient(base_url="https://x", import_key="k")
    with patch.object(client, "post") as mock_post:
        mock_post.return_value = {}
        client.post_barcode_scan(
            barcode="789",
            pi_event_id="evt-3",
            mode="consume_macros",
            qty=1.5,
            unit="serving",
        )
        body = mock_post.call_args.args[1]
        assert body["mode"] == "consume_macros"
        assert body["qty"] == 1.5
        assert body["unit"] == "serving"
