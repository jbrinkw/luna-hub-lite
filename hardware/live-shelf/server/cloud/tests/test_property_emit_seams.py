"""Hypothesis property-based tests for the 3 emit seams in cloud/integration.py.

Regression coverage for the lot_id bridge bug:
  * The bug: an emitter swapped a pi-local UUID (e.g. a local lots.lot_id or
    session_resolutions.lot_id) into a cloud-namespace payload key (e.g.
    payload["pi_lot_id"] or payload["product_id"]). The cloud then used the
    Pi's internal identifier to look up a cloud stock_lots row — a mismatch
    that resulted in wrong lots being updated or no match at all.
  * Property tests generate DISTINCT UUIDs for pi-local and cloud namespaces
    across 200 random inputs each, then assert:
      (a) Every cloud-namespace key in the payload holds the cloud-namespace UUID.
      (b) No key in the payload holds the pi-local UUID (namespace conflation).

The three seams tested here were the original locus of the bug:
  1. emit_live_weight_sync   — cloud key ``pi_lot_id`` (stock_lots.lot_id UUID)
  2. in_flight_pickup        — via emit_reconciler_resolution(pattern=...);
                               cloud key ``product_id`` (products UUID)
  3. emit_catch_all_first_measurement — cloud keys ``product_id`` + ``pi_event_id``

Audit reference: docs/audit/IMPLEMENTATION_AUDIT_*.md (lot_id bridge bug, 2026-04-28).
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

# Ensure the live-shelf server root is importable when pytest is invoked
# from an arbitrary working directory (matches the pattern used by all
# other test files in this package).
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.storage import init_db  # noqa: E402


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# A strategy that generates a random UUID v4 string.
_uuids = st.uuids(version=4).map(str)


@st.composite
def _distinct_uuid_pairs(draw: st.DrawFn) -> tuple[str, str]:
    """Generate two distinct UUID strings (a, b) where a != b."""
    a = draw(_uuids)
    b = draw(_uuids)
    # UUID v4 collision probability is ~1-in-2^122; the while loop handles it.
    while b == a:
        b = draw(_uuids)
    return (a, b)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_emitter() -> tuple[sqlite3.Connection, CloudEventEmitter]:
    """Return (conn, enabled emitter) backed by an in-memory DB."""
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    return conn, emitter


def _last_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None, "expected at least one outbox row"
    return json.loads(row["payload_json"])


def _flatten_values(payload: dict[str, Any]) -> list[tuple[str, Any]]:
    """Return (key, value) pairs from the top-level payload dict.

    Deliberately flat — the emit payloads are all shallow dicts, so
    a recursive walk would add complexity without benefit. Sub-dicts
    (``proposed``, ``user_response``) are skipped: they're only present
    on review_queue_* events which are outside this test's scope.
    """
    return [
        (k, v)
        for k, v in payload.items()
        if not isinstance(v, dict)
    ]


# ---------------------------------------------------------------------------
# Seam 1: emit_live_weight_sync
#
# Cloud-namespace key: ``pi_lot_id`` — must hold the cloud lot UUID passed
# by the caller. The caller (weight_sync_poller) resolves the cloud lot_id
# from the ``cloud_lots`` mirror table; the emitter must pass it through
# verbatim. Conflating the Pi's local ``lots.lot_id`` (a different UUID)
# would stamp a Pi-internal row ID onto the cloud event.
# ---------------------------------------------------------------------------


@given(
    pi_local_lot_id=_uuids,
    cloud_lot_id=_uuids,
    scale_id=st.from_regex(r"scale-[0-9]{2}", fullmatch=True),
    kind=st.sampled_from(["live_shelf", "live_scale"]),
    observed_weight_g=st.floats(
        min_value=0.0, max_value=50_000.0, allow_nan=False, allow_infinity=False
    ),
)
@settings(max_examples=200, deadline=None)
def test_live_weight_sync_uses_cloud_lot_id(
    pi_local_lot_id: str,
    cloud_lot_id: str,
    scale_id: str,
    kind: str,
    observed_weight_g: float,
) -> None:
    """Regression: emit_live_weight_sync must place the cloud lot UUID at
    payload['pi_lot_id'], never the pi-local lot UUID.

    The parameter is named ``pi_lot_id`` in the emitter signature because
    it represents the identifier the Pi holds for the cloud lot (obtained
    from the cloud_lots mirror). It is NOT the Pi's own internal lot_id.
    Any swap would cause the cloud to look up a non-existent lot.
    """
    if pi_local_lot_id == cloud_lot_id:
        # Degenerate case: with identical UUIDs we cannot distinguish a swap.
        # Return so Hypothesis generates another example.
        return

    conn, emitter = _make_emitter()
    try:
        cid = emitter.emit_live_weight_sync(
            scale_id=scale_id,
            kind=kind,
            pi_lot_id=cloud_lot_id,  # caller passes the cloud UUID here
            observed_weight_g=observed_weight_g,
        )
        assert cid is not None, "emit should succeed for valid inputs"
        payload = _last_payload(conn)

        # Cloud-namespace assertion: payload["pi_lot_id"] MUST be cloud_lot_id.
        assert payload["pi_lot_id"] == cloud_lot_id, (
            f"payload['pi_lot_id']={payload['pi_lot_id']!r} != "
            f"cloud_lot_id={cloud_lot_id!r} — namespace conflation bug"
        )

        # Namespace-isolation assertion: pi_local_lot_id must not appear at
        # any *_lot_id key in the payload.
        for key, value in _flatten_values(payload):
            if "lot_id" in key:
                assert value != pi_local_lot_id, (
                    f"payload[{key!r}]={value!r} equals pi_local_lot_id "
                    f"{pi_local_lot_id!r} — pi-local UUID leaked into cloud payload"
                )

        # Idempotency under key-order: re-serialise and re-parse.
        round_tripped = json.loads(json.dumps(payload))
        assert round_tripped["pi_lot_id"] == cloud_lot_id

        # No None / NaN values in the payload.
        for key, value in _flatten_values(payload):
            assert value is not None, f"payload[{key!r}] is None"
            if isinstance(value, float):
                import math
                assert math.isfinite(value), (
                    f"payload[{key!r}]={value!r} is NaN or Inf"
                )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Seam 2: in_flight_pickup via emit_reconciler_resolution
#
# Cloud-namespace key: ``product_id`` — the cloud's products.product_id UUID.
# The Pi's session_resolutions table stores ``lot_id`` (a local UUID that
# identifies the physical lot on the shelf). The reconciler adapter resolves
# lot_id → product_id before calling this emitter. If that resolution step
# is bypassed or the wrong field is passed, the cloud receives a Pi-internal
# UUID at ``product_id`` and the inventory update silently no-ops.
# ---------------------------------------------------------------------------


@given(
    pi_local_lot_id=_uuids,
    cloud_product_id=_uuids,
    scale_id=st.from_regex(r"scale-[0-9]{2}", fullmatch=True),
    delta_g=st.floats(
        min_value=-50_000.0, max_value=0.0, allow_nan=False, allow_infinity=False
    ),
)
@settings(max_examples=200, deadline=None)
def test_in_flight_pickup_uses_cloud_product_id(
    pi_local_lot_id: str,
    cloud_product_id: str,
    scale_id: str,
    delta_g: float,
) -> None:
    """Regression: emit_reconciler_resolution(pattern='in_flight_pickup') must
    place the cloud product UUID at payload['product_id'], never the pi-local
    lot UUID.

    The adapter resolves local lot_id → cloud product_id before calling the
    emitter. Passing pi_local_lot_id at the product_id argument would cause
    the cloud apply_shelf_event to look up a non-existent product.
    """
    if pi_local_lot_id == cloud_product_id:
        return

    conn, emitter = _make_emitter()
    try:
        cid = emitter.emit_reconciler_resolution(
            pattern="in_flight_pickup",
            product_id=cloud_product_id,  # caller passes the cloud UUID here
            scale_id=scale_id,
            kind="live_shelf",
            delta_g=delta_g,
        )
        assert cid is not None, (
            "emit_reconciler_resolution(in_flight_pickup) should succeed"
        )
        payload = _last_payload(conn)

        # Cloud-namespace assertion.
        assert payload["product_id"] == cloud_product_id, (
            f"payload['product_id']={payload['product_id']!r} != "
            f"cloud_product_id={cloud_product_id!r} — namespace conflation bug"
        )

        # Namespace-isolation: pi_local_lot_id must not appear at product_id.
        assert payload.get("product_id") != pi_local_lot_id, (
            f"payload['product_id'] equals pi_local_lot_id={pi_local_lot_id!r}"
            " — pi-local lot UUID leaked into cloud product_id field"
        )

        # event_kind check.
        assert payload["event_kind"] == "in_flight_pickup"

        # Idempotency under key-order.
        round_tripped = json.loads(json.dumps(payload))
        assert round_tripped["product_id"] == cloud_product_id

        # No None / NaN values.
        for key, value in _flatten_values(payload):
            assert value is not None, f"payload[{key!r}] is None"
            if isinstance(value, float):
                import math
                assert math.isfinite(value), (
                    f"payload[{key!r}]={value!r} is NaN or Inf"
                )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Seam 3: emit_catch_all_first_measurement
#
# Cloud-namespace keys: ``product_id`` (cloud products UUID) and
# ``pi_event_id`` (scale_events.event_id from the Pi's DB — used by the
# cloud as pickup_event_id to correlate the second measurement). Neither
# field should be confused with a local lot UUID.
# ---------------------------------------------------------------------------


@given(
    pi_local_lot_id=_uuids,
    cloud_product_id=_uuids,
    pi_event_id=_uuids,
    scale_id=st.from_regex(r"scale-[0-9]{2}", fullmatch=True),
    measured_weight_g=st.floats(
        min_value=1.0, max_value=50_000.0, allow_nan=False, allow_infinity=False
    ),
)
@settings(max_examples=200, deadline=None)
def test_catch_all_first_measurement_uses_cloud_product_id(
    pi_local_lot_id: str,
    cloud_product_id: str,
    pi_event_id: str,
    scale_id: str,
    measured_weight_g: float,
) -> None:
    """Regression: emit_catch_all_first_measurement must place the cloud product
    UUID at payload['product_id'] and the Pi event UUID at payload['pi_event_id'],
    never substituting the pi-local lot UUID at either field.

    The catch-all flow captures the first observed weight for a lot the Pi
    hasn't catalogued yet. The cloud uses product_id + pi_event_id together
    to stamp in_flight_since + pickup_event_id on the matching lot.
    Conflating pi_local_lot_id with cloud_product_id at either key causes the
    cloud handler to match (or mint) the wrong lot.
    """
    if pi_local_lot_id == cloud_product_id:
        return
    if pi_local_lot_id == pi_event_id:
        return

    conn, emitter = _make_emitter()
    try:
        cid = emitter.emit_catch_all_first_measurement(
            scale_id=scale_id,
            product_id=cloud_product_id,  # cloud UUID
            measured_weight_g=measured_weight_g,
            pi_event_id=pi_event_id,
        )
        assert cid is not None, "emit should succeed for valid inputs"
        payload = _last_payload(conn)

        # Cloud-namespace assertion: product_id must be the cloud UUID.
        assert payload["product_id"] == cloud_product_id, (
            f"payload['product_id']={payload['product_id']!r} != "
            f"cloud_product_id={cloud_product_id!r} — namespace conflation bug"
        )

        # pi_event_id must be the Pi event UUID, not pi_local_lot_id.
        assert payload["pi_event_id"] == pi_event_id, (
            f"payload['pi_event_id']={payload['pi_event_id']!r} != "
            f"pi_event_id={pi_event_id!r}"
        )

        # Namespace-isolation: pi_local_lot_id must not appear at either key.
        assert payload["product_id"] != pi_local_lot_id, (
            f"payload['product_id'] equals pi_local_lot_id — conflation bug"
        )
        assert payload.get("pi_event_id") != pi_local_lot_id, (
            f"payload['pi_event_id'] equals pi_local_lot_id — conflation bug"
        )

        # event_kind check.
        assert payload["event_kind"] == "catch_all_first_measurement"
        assert payload["kind"] == "catch_all"

        # delta_g is repurposed as the absolute weight for this event kind.
        import math
        assert math.isclose(payload["delta_g"], measured_weight_g, rel_tol=1e-6), (
            f"payload['delta_g']={payload['delta_g']!r} != "
            f"measured_weight_g={measured_weight_g!r}"
        )

        # Idempotency under key-order.
        round_tripped = json.loads(json.dumps(payload))
        assert round_tripped["product_id"] == cloud_product_id
        assert round_tripped["pi_event_id"] == pi_event_id

        # No None / NaN values.
        for key, value in _flatten_values(payload):
            assert value is not None, f"payload[{key!r}] is None"
            if isinstance(value, float):
                assert math.isfinite(value), (
                    f"payload[{key!r}]={value!r} is NaN or Inf"
                )
    finally:
        conn.close()
