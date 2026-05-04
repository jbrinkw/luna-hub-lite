"""Tests for :class:`server.classifier.cloud_candidate_source.CloudCandidateSource`.

Covers:
  - Happy-path mapping Catalog → LotCandidate / ProductCandidate
  - Filtering stock rows with qty_containers <= 0
  - Nearest-expiration ordering (ASC NULLS LAST)
  - Cold start (no prior fetch) → raises on CloudError
  - Success then CloudError within TTL → serves cached catalog
  - Success then CloudError past TTL → raises
  - has_catalog() lifecycle

The cold-start integration (classifier short-circuits to UNKNOWN) is
covered separately in tests below by invoking ``classify_event`` with
a source that reports ``has_catalog()==False``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.classifier.cloud_candidate_source import CloudCandidateSource  # noqa: E402
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
    ScaleEvent,
)
from server.classifier.classify import classify_event  # noqa: E402
from server.cloud.catalog import Catalog  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402


# --- Helpers --------------------------------------------------------------


_SAMPLE_CATALOG_PAYLOAD = {
    "products": [
        {
            "product_id": "p1",
            "name": "Ketchup",
            "brand": "Heinz",
            "gross_weight_g": 340,
            "net_weight_g": 300,
            "container_type": "bottle",
        },
        {
            "product_id": "p2",
            "name": "Mustard",
            "brand": "French's",
            "gross_weight_g": 200,
            "container_type": "jar",
        },
        {
            "product_id": "p3",
            "name": "OrphanProduct",
            "gross_weight_g": 150,
        },
    ],
    "stock": [
        # p1 has two lots with different expirations — nearest first.
        {
            "stock_id": "s_p1_late",
            "product_id": "p1",
            "qty_containers": 2,
            "expires_on": "2026-05-01",
        },
        {
            "stock_id": "s_p1_early",
            "product_id": "p1",
            "qty_containers": 1,
            "expires_on": "2026-04-20",
        },
        {
            "stock_id": "s_p2_noexp",
            "product_id": "p2",
            "qty_containers": 3,
            "expires_on": None,
        },
        # Depleted stock row — should be filtered out.
        {
            "stock_id": "s_depleted",
            "product_id": "p2",
            "qty_containers": 0,
            "expires_on": "2026-04-01",
        },
        # Orphaned stock (product missing) — should be skipped.
        {
            "stock_id": "s_orphan",
            "product_id": "p999",
            "qty_containers": 5,
        },
    ],
    "pairings": [],
    "locations": [],
}


def _make_client(payload=None, *, error=None):
    """Build a MagicMock CloudClient returning ``payload`` (or raising)."""
    client = MagicMock()
    if error is not None:
        client.get.side_effect = error
    else:
        client.get.return_value = payload or _SAMPLE_CATALOG_PAYLOAD
    return client


class _FakeClock:
    """Deterministic ``monotonic``-style clock."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:  # pragma: no cover - trivial
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


# --- Happy-path mapping ---------------------------------------------------


def test_refresh_populates_catalog():
    src = CloudCandidateSource(_make_client())
    assert src.has_catalog() is False
    cat = src.refresh()
    assert isinstance(cat, Catalog)
    assert src.has_catalog() is True


def test_get_on_shelf_lots_maps_catalog_stock_to_lot_candidates():
    src = CloudCandidateSource(_make_client())
    src.refresh()
    lots = list(src.get_on_shelf_lots())
    # Depleted + orphan stock rows excluded.
    ids = [lot.lot_id for lot in lots]
    assert "s_depleted" not in ids
    assert "s_orphan" not in ids
    # Expected survivors: two p1 lots + one p2 lot.
    assert len(lots) == 3
    # Each maps to the right product metadata.
    lot_by_id = {lot.lot_id: lot for lot in lots}
    assert lot_by_id["s_p1_early"].name == "Ketchup"
    assert lot_by_id["s_p1_early"].expected_weight_g == 340
    assert lot_by_id["s_p2_noexp"].brand == "French's"


def test_on_shelf_lots_ordered_nearest_expiration_first():
    src = CloudCandidateSource(_make_client())
    src.refresh()
    lots = list(src.get_on_shelf_lots())
    # s_p1_early (2026-04-20) before s_p1_late (2026-05-01); null-expiration
    # s_p2_noexp pushed to the back.
    ids = [lot.lot_id for lot in lots]
    assert ids.index("s_p1_early") < ids.index("s_p1_late")
    assert ids.index("s_p1_late") < ids.index("s_p2_noexp")


def test_get_certified_not_on_shelf_returns_all_catalog_products():
    src = CloudCandidateSource(_make_client())
    src.refresh()
    products = list(src.get_certified_not_on_shelf())
    ids = {p.product_id for p in products}
    assert ids == {"p1", "p2", "p3"}
    # Products missing ``product_id`` are skipped.
    client = _make_client(
        payload={"products": [{"name": "no-id"}, {"product_id": "ok"}], "stock": []}
    )
    src2 = CloudCandidateSource(client)
    src2.refresh()
    assert [p.product_id for p in src2.get_certified_not_on_shelf()] == ["ok"]


def test_recently_out_and_in_flight_are_empty_in_cloud_mode():
    src = CloudCandidateSource(_make_client())
    src.refresh()
    assert list(src.get_recently_out_lots(86_400)) == []
    assert list(src.get_in_flight_lots()) == []


# --- Fallback TTL behaviour ----------------------------------------------


def test_cloud_error_on_first_fetch_raises():
    client = _make_client(error=CloudError(503, "down"))
    src = CloudCandidateSource(client)
    with pytest.raises(CloudError):
        src.refresh()
    assert src.has_catalog() is False


def test_success_then_cloud_error_within_ttl_returns_cached():
    clock = _FakeClock()
    client = MagicMock()
    src = CloudCandidateSource(client, fallback_ttl_s=300.0, now=clock)

    # First refresh succeeds.
    client.get.return_value = _SAMPLE_CATALOG_PAYLOAD
    cat1 = src.refresh()
    assert cat1 is src.catalog

    # Next refresh fails but within TTL → reuse cached.
    clock.advance(100.0)
    client.get.side_effect = CloudError(502, "bad gateway")
    cat2 = src.refresh()
    assert cat2 is cat1
    assert src.has_catalog() is True
    # Candidate methods still work off the cached catalog.
    assert len(list(src.get_on_shelf_lots())) == 3


def test_success_then_cloud_error_past_ttl_raises():
    clock = _FakeClock()
    client = MagicMock()
    src = CloudCandidateSource(client, fallback_ttl_s=60.0, now=clock)

    client.get.return_value = _SAMPLE_CATALOG_PAYLOAD
    src.refresh()

    clock.advance(120.0)  # past TTL
    client.get.side_effect = CloudError(500, "boom")
    with pytest.raises(CloudError):
        src.refresh()
    # But the last-known catalog remains accessible for any already-running
    # classification that holds a reference.
    assert src.has_catalog() is True


def test_transport_error_treated_like_cloud_error():
    """Non-CloudError transport exceptions also engage the fallback path."""
    clock = _FakeClock()
    client = MagicMock()
    src = CloudCandidateSource(client, fallback_ttl_s=60.0, now=clock)

    client.get.return_value = _SAMPLE_CATALOG_PAYLOAD
    src.refresh()

    # Simulate a ``requests`` timeout — subclasses OSError, not CloudError.
    clock.advance(10.0)
    client.get.side_effect = TimeoutError("read timed out")
    cat = src.refresh()
    assert cat is src.catalog  # cached reused within TTL

    clock.advance(300.0)
    with pytest.raises(TimeoutError):
        src.refresh()


# --- Classifier cold-start guard -----------------------------------------


_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def frame_paths(tmp_path):
    before = tmp_path / "before.jpg"
    after = tmp_path / "after.jpg"
    before.write_bytes(_TINY_JPEG)
    after.write_bytes(_TINY_JPEG)
    return str(before), str(after)


def test_classifier_cold_start_returns_unknown_without_calling_api(frame_paths):
    """Cold start: cloud source has never fetched → classifier short-circuits.

    The fake Anthropic client would raise if called; the absence of that
    exception is how we confirm the classifier never hit the API.
    """
    before, after = frame_paths

    class _ExplodeOnCall:
        def send(self, *args, **kwargs):  # pragma: no cover - defensive
            raise AssertionError(
                "classifier must not call Anthropic during cold start"
            )

    # CloudError on first fetch → source stays catalog-less.
    client = _make_client(error=CloudError(503, "unavailable"))
    source = CloudCandidateSource(client)
    with pytest.raises(CloudError):
        source.refresh()
    assert source.has_catalog() is False

    ctx = ClassifierContext(source=source, anthropic_client=_ExplodeOnCall())
    event = ScaleEvent(
        event_id="evt_cold",
        session_id="sesn",
        ts="2026-04-19T12:00:00Z",
        delta_g=-340.0,
        before_weight_g=2000.0,
        after_weight_g=1660.0,
        direction="remove",
        before_frame_path=before,
        after_frame_path=after,
    )

    result = classify_event(event, ctx)
    assert result.item_id == UNKNOWN_CANDIDATE_ID
    assert result.action == "unknown"
    assert result.confidence == 0.0
    assert "catalog not yet fetched" in result.reasoning
    # Meta flag so the reconciler / review queue can mark this event
    # as "waiting for cloud" rather than a genuine classifier failure.
    assert result.meta.get("cold_start") is True


def test_classifier_runs_normally_after_catalog_is_fetched(frame_paths):
    """After a successful refresh the cold-start guard does not fire."""
    before, after = frame_paths
    client = _make_client()
    source = CloudCandidateSource(client)
    source.refresh()  # now has a catalog
    assert source.has_catalog() is True

    class _FakeClient:
        def __init__(self):
            self.calls = 0

        def send(self, payload, *, model=None):
            from server.classifier.anthropic_client import ClassifierCallResult

            self.calls += 1
            return ClassifierCallResult(
                text='{"item_id":"p1","action":"removed","confidence":0.9,"reasoning":"ok"}',
                model=model or "claude-sonnet-4-6",
                usage={"input_tokens": 100, "output_tokens": 10},
                raw=None,
            )

    fake = _FakeClient()
    ctx = ClassifierContext(source=source, anthropic_client=fake)
    event = ScaleEvent(
        event_id="evt_warm",
        session_id="sesn",
        ts="2026-04-19T12:00:00Z",
        delta_g=-340.0,
        before_weight_g=2000.0,
        after_weight_g=1660.0,
        direction="remove",
        before_frame_path=before,
        after_frame_path=after,
    )

    result = classify_event(event, ctx)
    assert fake.calls == 1  # classifier reached the API
    assert result.item_id in {"p1"}
    assert result.meta.get("cold_start") is not True


# ---------------------------------------------------------------------------
# Audit C-MED-1 (2026-05-04): cloud-side certified-filter projection tests.
#
# ``_build_catch_all_user_inventory_lots(certified_filter=...)`` projects
# the catalog through the certified flag for the two-pass classifier:
#   * pass-1 reads ``get_catch_all_certified_user_inventory_lots`` →
#     filter=True  → only certified products
#   * pass-2 reads ``get_catch_all_uncertified_user_inventory_lots`` →
#     filter=False → only uncertified (or NULL/missing) products.
#
# Mutation guard: dropping the ``if certified_filter and not is_cert:
# continue`` line at cloud_candidate_source.py:377 would silently let
# uncertified lots leak into pass-1's pool — pass-1 would then match
# uncertified products with no certify push, defeating the entire
# two-pass feature.
# ---------------------------------------------------------------------------


def _seed_catalog_source(
    *,
    products: list[dict],
    stock: list[dict],
) -> CloudCandidateSource:
    """Build a CloudCandidateSource with the catalog pre-populated.

    Bypasses the network refresh path so the projection methods can be
    exercised in isolation. The client mock would never be hit anyway —
    these tests only exercise the in-memory catalog → LotCandidate map.
    """
    payload = {
        "products": products,
        "stock": stock,
        "pairings": [],
        "locations": [],
    }
    src = CloudCandidateSource(_make_client(payload=payload))
    src.refresh()
    return src


def test_catch_all_certified_filters_uncertified_products():
    """Pass-1 source returns ONLY lots whose product has certified=true.

    Pass-2 source returns ONLY lots whose product is uncertified
    (certified=false). Mixed catalog → both projections are disjoint
    and exhaustive.

    A regression that drops the certified_filter branch — letting all
    qty>0 lots flow into both pools — would defeat the two-pass design:
    pass-1 would happily match uncertified products, no certify push
    would fire, and the user's product would never graduate from
    LiveTrack-tracked.
    """
    products = [
        {
            "product_id": "p-cert",
            "name": "Cert Item",
            "certified": True,
            "net_weight_g": 500,
        },
        {
            "product_id": "p-uncert",
            "name": "Uncert Item",
            "certified": False,
            "net_weight_g": 500,
        },
    ]
    stock = [
        {"product_id": "p-cert", "lot_id": "L-C", "qty_containers": 1.0},
        {"product_id": "p-uncert", "lot_id": "L-U", "qty_containers": 1.0},
    ]
    src = _seed_catalog_source(products=products, stock=stock)

    cert_lots = list(src.get_catch_all_certified_user_inventory_lots())
    assert {lot.lot_id for lot in cert_lots} == {"L-C"}, (
        "pass-1 source must return ONLY lots whose product is certified"
    )

    uncert_lots = list(src.get_catch_all_uncertified_user_inventory_lots())
    assert {lot.lot_id for lot in uncert_lots} == {"L-U"}, (
        "pass-2 source must return ONLY lots whose product is uncertified"
    )

    # Sanity: the unfiltered call returns BOTH (back-compat with the
    # legacy single-pool catch-all flow).
    all_lots = list(src.get_catch_all_user_inventory_lots())
    assert {lot.lot_id for lot in all_lots} == {"L-C", "L-U"}


def test_catch_all_certified_handles_string_certified_column():
    """Legacy SQLite shadow stores ``certified`` as the string ``'1'`` / ``'0'``.

    The cloud catalog's ``products.certified`` is a real boolean over
    JSON, but the local-mirror tables and a few legacy projections
    still emit string flags. The coercion at
    :file:`cloud_candidate_source.py:373-374` handles both.

    Mutation guard: dropping the str branch would make ``'0'`` evaluate
    truthy via ``bool('0') == True`` and silently let an uncertified-as-
    string-zero product land in the certified pool.
    """
    products = [
        {
            "product_id": "p-zero",
            "name": "String-Zero-Cert",
            "certified": "0",  # string '0' → uncertified
            "net_weight_g": 500,
        },
        {
            "product_id": "p-one",
            "name": "String-One-Cert",
            "certified": "1",  # string '1' → certified
            "net_weight_g": 500,
        },
        {
            "product_id": "p-true",
            "name": "String-true-Cert",
            "certified": "true",  # string 'true' → certified
            "net_weight_g": 500,
        },
    ]
    stock = [
        {"product_id": "p-zero", "lot_id": "L-zero", "qty_containers": 1.0},
        {"product_id": "p-one", "lot_id": "L-one", "qty_containers": 1.0},
        {"product_id": "p-true", "lot_id": "L-true", "qty_containers": 1.0},
    ]
    src = _seed_catalog_source(products=products, stock=stock)

    cert_lots = list(src.get_catch_all_certified_user_inventory_lots())
    assert {lot.lot_id for lot in cert_lots} == {"L-one", "L-true"}, (
        "string-cert-column: '1' and 'true' must be treated as certified"
    )

    uncert_lots = list(src.get_catch_all_uncertified_user_inventory_lots())
    assert {lot.lot_id for lot in uncert_lots} == {"L-zero"}, (
        "string-cert-column: '0' MUST be treated as uncertified — "
        "regression that drops the str-coercion branch would let "
        "bool('0')==True silently leak '0'-flagged products into the "
        "certified pool"
    )


def test_catch_all_uncertified_includes_missing_and_null_certified():
    """Products with ``certified`` missing or None → treat as uncertified.

    Catch-all auto-import (pass-2) is the certify writer; products that
    haven't been touched yet have ``certified`` missing or NULL. They
    must surface in pass-2's pool so the AI can match against them and
    trigger the certify auto-import.
    """
    products = [
        {"product_id": "p-missing", "name": "Missing", "net_weight_g": 500},
        {
            "product_id": "p-null",
            "name": "Null",
            "certified": None,
            "net_weight_g": 500,
        },
    ]
    stock = [
        {"product_id": "p-missing", "lot_id": "L-missing", "qty_containers": 1.0},
        {"product_id": "p-null", "lot_id": "L-null", "qty_containers": 1.0},
    ]
    src = _seed_catalog_source(products=products, stock=stock)

    cert_lots = list(src.get_catch_all_certified_user_inventory_lots())
    assert cert_lots == [], (
        "missing/null certified must NOT land in pass-1's certified pool"
    )

    uncert_lots = list(src.get_catch_all_uncertified_user_inventory_lots())
    assert {lot.lot_id for lot in uncert_lots} == {"L-missing", "L-null"}, (
        "missing/null certified must surface in pass-2's pool so the "
        "two-pass auto-certify can graduate them via the certify push"
    )


def test_legacy_source_without_has_catalog_does_not_trip_guard(frame_paths):
    """Sources that don't expose ``has_catalog()`` (legacy sqlite path)
    must skip the cold-start guard entirely — preserving today's behaviour
    when ``CLOUD_ENABLED=false``."""
    before, after = frame_paths

    class _LegacySource:
        def get_on_shelf_lots(self, shelf_id=None):
            return [
                LotCandidate(
                    lot_id="L1",
                    product_id="prod_L1",
                    name="Ketchup",
                    brand=None,
                    expected_weight_g=340,
                    container_type="bottle",
                    status="on_shelf",
                )
            ]

        def get_recently_out_lots(self, window_seconds, shelf_id=None):
            return []

        def get_certified_not_on_shelf(self):
            return []

    class _FakeClient:
        def send(self, payload, *, model=None):
            from server.classifier.anthropic_client import ClassifierCallResult

            return ClassifierCallResult(
                text='{"item_id":"L1","action":"removed","confidence":0.8,"reasoning":"ok"}',
                model=model or "claude-sonnet-4-6",
                usage={"input_tokens": 10, "output_tokens": 5},
                raw=None,
            )

    ctx = ClassifierContext(source=_LegacySource(), anthropic_client=_FakeClient())
    event = ScaleEvent(
        event_id="evt_legacy",
        session_id=None,
        ts="2026-04-19T12:00:00Z",
        delta_g=-340.0,
        before_weight_g=2000.0,
        after_weight_g=1660.0,
        direction="remove",
        before_frame_path=before,
        after_frame_path=after,
    )

    result = classify_event(event, ctx)
    assert result.item_id == "L1"
    # No cold_start flag — this source doesn't participate in the guard.
    assert "cold_start" not in result.meta
