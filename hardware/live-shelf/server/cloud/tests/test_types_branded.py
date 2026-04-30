"""Unit tests for branded ID types (types_branded.py).

Key regression coverage: A Pi-local lot UUID and a cloud stock_lot UUID are
both valid UUID strings but live in entirely different namespaces. Tests use
DISTINCT UUIDs for each namespace so a "format check only" validator cannot
accidentally pass a Pi-local UUID as a CloudLotId.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from server.types_branded import (
    CloudLotId,
    CloudProductId,
    InvalidIdError,
    PiLocalEventId,
    PiLocalLotId,
    parse_cloud_lot_id,
    parse_cloud_product_id,
    parse_pi_local_event_id,
    parse_pi_local_lot_id,
)

# ---------------------------------------------------------------------------
# Distinct UUIDs — different values per namespace to prevent accidental match
# ---------------------------------------------------------------------------

CLOUD_LOT_UUID = "11111111-0000-4000-8000-000000000001"
PI_LOCAL_LOT_UUID = "22222222-0000-4000-8000-000000000002"  # different namespace!
CLOUD_PRODUCT_UUID = "33333333-0000-4000-8000-000000000003"
PI_LOCAL_EVENT_UUID = "44444444-0000-4000-8000-000000000004"
ABSENT_UUID = "99999999-0000-4000-8000-000000000099"  # valid format, absent everywhere


# ---------------------------------------------------------------------------
# In-memory SQLite fixture with the minimal schema mirrors
# ---------------------------------------------------------------------------


@pytest.fixture()
def db() -> sqlite3.Connection:
    """Return a fresh in-memory SQLite connection with mirror tables seeded."""
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE cloud_lots (lot_id TEXT PRIMARY KEY)"
    )
    conn.execute(
        "CREATE TABLE lots (lot_id TEXT PRIMARY KEY)"
    )
    conn.execute(
        "CREATE TABLE cloud_products (product_id TEXT PRIMARY KEY)"
    )
    conn.execute(
        "CREATE TABLE scale_events (event_id TEXT PRIMARY KEY)"
    )
    # Seed distinct UUIDs into their respective namespaces
    conn.execute("INSERT INTO cloud_lots VALUES (?)", (CLOUD_LOT_UUID,))
    conn.execute("INSERT INTO lots VALUES (?)", (PI_LOCAL_LOT_UUID,))
    conn.execute("INSERT INTO cloud_products VALUES (?)", (CLOUD_PRODUCT_UUID,))
    conn.execute("INSERT INTO scale_events VALUES (?)", (PI_LOCAL_EVENT_UUID,))
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# parse_cloud_lot_id
# ---------------------------------------------------------------------------


class TestParseCloudLotId:
    def test_valid_present_uuid_returns_branded(self, db: sqlite3.Connection) -> None:
        result = parse_cloud_lot_id(CLOUD_LOT_UUID, db)
        assert result == CLOUD_LOT_UUID
        # NewType is still str at runtime; confirm the value is preserved
        assert isinstance(result, str)

    def test_pi_local_lot_uuid_rejected_namespace_mismatch(
        self, db: sqlite3.Connection
    ) -> None:
        """Core regression: PI_LOCAL_LOT_UUID is a valid UUID but NOT in cloud_lots.

        This is the exact namespace-conflation bug class this module prevents.
        A format-only validator would pass PI_LOCAL_LOT_UUID here.
        """
        with pytest.raises(InvalidIdError) as exc_info:
            parse_cloud_lot_id(PI_LOCAL_LOT_UUID, db)
        err = exc_info.value
        assert err.raw == PI_LOCAL_LOT_UUID
        assert err.expected_namespace == "CloudLotId"
        assert err.table_queried == "cloud_lots"

    def test_absent_uuid_raises_with_table_info(
        self, db: sqlite3.Connection
    ) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_cloud_lot_id(ABSENT_UUID, db)
        err = exc_info.value
        assert err.table_queried == "cloud_lots"
        assert ABSENT_UUID in str(err)

    def test_invalid_format_rejected_before_db(
        self, db: sqlite3.Connection
    ) -> None:
        """Format check fires first; DB must not be consulted."""
        with pytest.raises(InvalidIdError) as exc_info:
            parse_cloud_lot_id("not-a-uuid", db)
        assert exc_info.value.table_queried == "format check"


# ---------------------------------------------------------------------------
# parse_pi_local_lot_id
# ---------------------------------------------------------------------------


class TestParsePiLocalLotId:
    def test_valid_present_uuid_returns_branded(self, db: sqlite3.Connection) -> None:
        result = parse_pi_local_lot_id(PI_LOCAL_LOT_UUID, db)
        assert result == PI_LOCAL_LOT_UUID

    def test_cloud_lot_uuid_rejected_namespace_mismatch(
        self, db: sqlite3.Connection
    ) -> None:
        """CLOUD_LOT_UUID is absent from lots — namespace mismatch is detected."""
        with pytest.raises(InvalidIdError) as exc_info:
            parse_pi_local_lot_id(CLOUD_LOT_UUID, db)
        err = exc_info.value
        assert err.expected_namespace == "PiLocalLotId"
        assert err.table_queried == "lots"

    def test_absent_uuid_raises(self, db: sqlite3.Connection) -> None:
        with pytest.raises(InvalidIdError):
            parse_pi_local_lot_id(ABSENT_UUID, db)

    def test_invalid_format_raises_before_db(
        self, db: sqlite3.Connection
    ) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_pi_local_lot_id("bad", db)
        assert exc_info.value.table_queried == "format check"


# ---------------------------------------------------------------------------
# parse_cloud_product_id
# ---------------------------------------------------------------------------


class TestParseCloudProductId:
    def test_valid_present_uuid_returns_branded(self, db: sqlite3.Connection) -> None:
        result = parse_cloud_product_id(CLOUD_PRODUCT_UUID, db)
        assert result == CLOUD_PRODUCT_UUID

    def test_absent_uuid_raises(self, db: sqlite3.Connection) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_cloud_product_id(ABSENT_UUID, db)
        assert exc_info.value.table_queried == "cloud_products"

    def test_invalid_format_raises_before_db(
        self, db: sqlite3.Connection
    ) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_cloud_product_id("not-a-uuid!", db)
        assert exc_info.value.table_queried == "format check"


# ---------------------------------------------------------------------------
# parse_pi_local_event_id
# ---------------------------------------------------------------------------


class TestParsePiLocalEventId:
    def test_valid_present_uuid_returns_branded(self, db: sqlite3.Connection) -> None:
        result = parse_pi_local_event_id(PI_LOCAL_EVENT_UUID, db)
        assert result == PI_LOCAL_EVENT_UUID

    def test_absent_uuid_raises(self, db: sqlite3.Connection) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_pi_local_event_id(ABSENT_UUID, db)
        assert exc_info.value.table_queried == "scale_events"

    def test_invalid_format_raises_before_db(
        self, db: sqlite3.Connection
    ) -> None:
        with pytest.raises(InvalidIdError) as exc_info:
            parse_pi_local_event_id("", db)
        assert exc_info.value.table_queried == "format check"


# ---------------------------------------------------------------------------
# InvalidIdError shape
# ---------------------------------------------------------------------------


class TestInvalidIdError:
    def test_fields_populated(self) -> None:
        err = InvalidIdError("bad-id", "CloudLotId", "cloud_lots")
        assert isinstance(err, ValueError)
        assert isinstance(err, InvalidIdError)
        assert err.raw == "bad-id"
        assert err.expected_namespace == "CloudLotId"
        assert err.table_queried == "cloud_lots"
        assert "bad-id" in str(err)
        assert "cloud_lots" in str(err)
        assert "CloudLotId" in str(err)
