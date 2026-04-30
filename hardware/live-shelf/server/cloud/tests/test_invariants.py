"""Tests for hardware/live-shelf/server/cloud/invariants.py.

Covers namespace-conflation detection: the runtime asserter that fires at the
cloud_outbox boundary when a UUID refers to the wrong Pi mirror table.

Key regression: the lot_id bridge bug (commit 41a7fbc) — a pi_local_lots UUID
was used as a cloud_lots lot_id.  assert_payload_invariants must detect this.
"""
from __future__ import annotations

import sqlite3
import uuid

import pytest

from server.cloud.invariants import InvariantViolation, assert_payload_invariants


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

CLOUD_LOT_UUID = str(uuid.uuid4())
PI_LOCAL_LOT_UUID = str(uuid.uuid4())   # distinct — never inserted into cloud_lots
CLOUD_PRODUCT_UUID = str(uuid.uuid4())
SCALE_EVENT_UUID = str(uuid.uuid4())
REVIEW_UUID = str(uuid.uuid4())


@pytest.fixture()
def conn() -> sqlite3.Connection:
    """In-memory SQLite with the four Pi mirror tables populated."""
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE cloud_lots (
            lot_id TEXT PRIMARY KEY
        );
        CREATE TABLE cloud_products (
            product_id TEXT PRIMARY KEY
        );
        CREATE TABLE scale_events (
            event_id TEXT PRIMARY KEY
        );
        CREATE TABLE review_queue (
            review_id TEXT PRIMARY KEY
        );
        """
    )
    db.execute("INSERT INTO cloud_lots VALUES (?)", (CLOUD_LOT_UUID,))
    db.execute("INSERT INTO cloud_products VALUES (?)", (CLOUD_PRODUCT_UUID,))
    db.execute("INSERT INTO scale_events VALUES (?)", (SCALE_EVENT_UUID,))
    db.execute("INSERT INTO review_queue VALUES (?)", (REVIEW_UUID,))
    db.commit()
    return db


# ---------------------------------------------------------------------------
# Happy-path
# ---------------------------------------------------------------------------

def test_valid_payload_no_raise(conn):
    """A well-formed payload with all UUIDs present in mirrors passes silently."""
    payload = {
        "lot_id": CLOUD_LOT_UUID,
        "product_id": CLOUD_PRODUCT_UUID,
        "event_id": SCALE_EVENT_UUID,
        "review_id": REVIEW_UUID,
        "quantity": 3.5,
        "notes": "fine",
    }
    # Must not raise.
    assert_payload_invariants(payload, conn)


def test_unknown_field_ignored(conn):
    """Fields not in FIELD_TO_MIRROR are silently skipped."""
    payload = {"foobar_id": str(uuid.uuid4()), "widget": "yes"}
    assert_payload_invariants(payload, conn)


def test_none_value_at_known_field_allowed(conn):
    """None at a known field is skipped — nullability is the schema's job."""
    assert_payload_invariants({"lot_id": None}, conn)


# ---------------------------------------------------------------------------
# Violation cases
# ---------------------------------------------------------------------------

def test_lot_id_not_in_cloud_lots_raises(conn):
    """A valid UUID that is not in cloud_lots raises InvariantViolation."""
    missing = str(uuid.uuid4())
    with pytest.raises(InvariantViolation) as exc_info:
        assert_payload_invariants({"lot_id": missing}, conn)
    err = exc_info.value
    assert err.key == "lot_id"
    assert err.expected_table == "cloud_lots"
    assert "not present in mirror" in err.reason


def test_malformed_uuid_raises(conn):
    """A value that is not a valid UUID raises with reason 'not a UUID'."""
    with pytest.raises(InvariantViolation) as exc_info:
        assert_payload_invariants({"lot_id": "not-a-uuid"}, conn)
    assert exc_info.value.reason == "not a UUID"


def test_non_string_value_raises(conn):
    """A non-string (e.g. int) at a known field raises with reason 'not a string'."""
    with pytest.raises(InvariantViolation) as exc_info:
        assert_payload_invariants({"lot_id": 12345}, conn)
    assert exc_info.value.reason == "not a string"


# ---------------------------------------------------------------------------
# Regression: lot_id bridge bug (commit 41a7fbc)
# ---------------------------------------------------------------------------

def test_pi_local_lot_uuid_rejected_as_lot_id(conn):
    """
    Regression for the namespace-conflation bug:
    A pi_local_lots UUID (PI_LOCAL_LOT_UUID) was erroneously placed in the
    cloud_outbox payload as lot_id.  cloud_lots does NOT contain that UUID, so
    the asserter must fire — catching the bug before it reaches Supabase.
    """
    # PI_LOCAL_LOT_UUID is a valid UUID format but was NEVER inserted into
    # cloud_lots (only CLOUD_LOT_UUID was).
    with pytest.raises(InvariantViolation) as exc_info:
        assert_payload_invariants({"lot_id": PI_LOCAL_LOT_UUID}, conn)
    err = exc_info.value
    assert err.key == "lot_id"
    assert err.expected_table == "cloud_lots"
    assert PI_LOCAL_LOT_UUID == err.value


# ---------------------------------------------------------------------------
# Dotted / aliased key forms
# ---------------------------------------------------------------------------

def test_dotted_key_resolves_suffix(conn):
    """Keys like 'item.lot_id' take the last segment for lookup."""
    assert_payload_invariants({"item.lot_id": CLOUD_LOT_UUID}, conn)


def test_pi_lot_id_alias_checked_against_cloud_lots(conn):
    """pi_lot_id is also checked against cloud_lots (same mirror, different alias)."""
    assert_payload_invariants({"pi_lot_id": CLOUD_LOT_UUID}, conn)


def test_pi_lot_id_missing_raises(conn):
    """pi_lot_id that doesn't exist in cloud_lots raises."""
    with pytest.raises(InvariantViolation) as exc_info:
        assert_payload_invariants({"pi_lot_id": PI_LOCAL_LOT_UUID}, conn)
    assert exc_info.value.expected_table == "cloud_lots"


def test_cloud_lot_id_alias(conn):
    """cloud_lot_id alias also maps to cloud_lots."""
    assert_payload_invariants({"cloud_lot_id": CLOUD_LOT_UUID}, conn)
