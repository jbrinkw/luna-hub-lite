"""Unit tests for ``server.cloud.catalog.fetch_catalog``."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.catalog import Catalog, fetch_catalog  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402

import pytest  # noqa: E402


def test_fetch_catalog_parses_all_four_lists():
    """Happy path: every list field round-trips."""
    client = MagicMock()
    client.get.return_value = {
        "products": [{"product_id": "p1", "name": "Ketchup"}],
        "stock": [{"stock_id": "s1", "product_id": "p1", "qty": 3}],
        "pairings": [{"scale_id": "scale-01", "product_id": "p1"}],
        "locations": [{"location_id": "l1", "name": "Fridge"}],
    }
    before = datetime.now(tz=timezone.utc)
    cat = fetch_catalog(client)
    after = datetime.now(tz=timezone.utc)

    client.get.assert_called_once_with("/catalog")
    assert isinstance(cat, Catalog)
    assert cat.products == [{"product_id": "p1", "name": "Ketchup"}]
    assert cat.stock[0]["stock_id"] == "s1"
    assert cat.pairings[0]["scale_id"] == "scale-01"
    assert cat.locations[0]["name"] == "Fridge"
    # Fetched-at is stamped within the call window.
    assert before <= cat.fetched_at <= after


def test_fetch_catalog_tolerates_missing_fields():
    """A partial response (e.g. user with no pairings yet) must still
    produce a valid Catalog with empty lists."""
    client = MagicMock()
    client.get.return_value = {"products": [], "stock": []}
    cat = fetch_catalog(client)
    assert cat.products == []
    assert cat.stock == []
    assert cat.pairings == []
    assert cat.locations == []


def test_fetch_catalog_tolerates_empty_response():
    """Defensive: if the edge function returns ``{}`` we get an empty
    catalog rather than a KeyError."""
    client = MagicMock()
    client.get.return_value = {}
    cat = fetch_catalog(client)
    assert cat.products == []
    assert cat.stock == []


def test_fetch_catalog_tolerates_malformed_list_items():
    """Non-dict entries inside a list get filtered — the classifier
    adapter shouldn't have to dict-check every iteration."""
    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "p1"},
            "not-a-dict",       # noqa — intentional bad shape
            None,               # noqa — intentional bad shape
            {"product_id": "p2"},
        ],
    }
    cat = fetch_catalog(client)
    assert len(cat.products) == 2
    assert {p["product_id"] for p in cat.products} == {"p1", "p2"}


def test_fetch_catalog_propagates_cloud_error():
    """Network/auth failures surface so the caller can decide whether
    to fall back to a stale catalog."""
    client = MagicMock()
    client.get.side_effect = CloudError(401, "unauthorized")
    with pytest.raises(CloudError) as excinfo:
        fetch_catalog(client)
    assert excinfo.value.status_code == 401


def test_fetch_catalog_rejects_wrapped_list_shape():
    """Deep-audit finding #14: the ``{"_list":[...]}`` fallback branch
    in ``_as_list`` was dead and silently masked protocol drift. The
    catalog endpoint is contracted to return an object whose list
    fields are plain JSON arrays — anything else should raise so the
    classifier doesn't see a silently-empty pool. Operators need a
    loud signal when the cloud starts emitting a new shape."""
    client = MagicMock()
    client.get.return_value = {
        "products": {"_list": [{"product_id": "p9"}]},
        "stock": [],
        "pairings": [],
        "locations": [],
    }
    with pytest.raises(TypeError, match="catalog field must be"):
        fetch_catalog(client)
