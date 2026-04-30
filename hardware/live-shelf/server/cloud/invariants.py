"""Runtime cross-namespace invariants for cloud_outbox payloads.

For every payload field whose name resembles a foreign key into a Pi mirror
table (lot_id, pi_lot_id, cloud_lot_id, product_id, event_id, etc.), assert
the value exists in the corresponding mirror. Raises InvariantViolation on
mismatch with the violating key, value, and expected table.

This is the LAST defense before a payload is enqueued to cloud_outbox; if a
namespace-conflation bug slipped past types and validation, this catches it
at the boundary instead of corrupting the cloud DB.
"""
from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from typing import Mapping


class InvariantViolation(ValueError):
    def __init__(self, key: str, value: str, expected_table: str, reason: str):
        self.key = key
        self.value = value
        self.expected_table = expected_table
        self.reason = reason
        super().__init__(
            f"invariant: payload[{key!r}]={value!r} not in {expected_table} ({reason})"
        )


# Map payload-field-suffix -> (table, column).
# Conservative: only known-mapped suffixes are checked. Unknown keys are ignored.
FIELD_TO_MIRROR: dict[str, tuple[str, str]] = {
    "lot_id":       ("cloud_lots",     "lot_id"),
    "pi_lot_id":    ("cloud_lots",     "lot_id"),
    "cloud_lot_id": ("cloud_lots",     "lot_id"),
    "product_id":   ("cloud_products", "product_id"),
    "event_id":     ("scale_events",   "event_id"),
    "review_id":    ("review_queue",   "review_id"),
}


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(str(s))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def assert_payload_invariants(
    payload: Mapping[str, object], conn: sqlite3.Connection
) -> None:
    """Walk payload; for any key matching FIELD_TO_MIRROR, verify the value exists in its mirror table."""
    for key, value in payload.items():
        suffix = key
        # Allow nested dotted keys like 'item.lot_id' by taking the last segment.
        if "." in suffix:
            suffix = suffix.rsplit(".", 1)[-1]
        if suffix not in FIELD_TO_MIRROR:
            continue
        if value is None:
            # Skip nullable refs; the schema decides whether nullable is allowed.
            continue
        if not isinstance(value, str):
            raise InvariantViolation(
                key, repr(value), FIELD_TO_MIRROR[suffix][0], "not a string"
            )
        if not _is_uuid(value):
            raise InvariantViolation(
                key, value, FIELD_TO_MIRROR[suffix][0], "not a UUID"
            )
        table, column = FIELD_TO_MIRROR[suffix]
        cur = conn.execute(
            f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1", (value,)
        )
        if cur.fetchone() is None:
            raise InvariantViolation(
                key, value, table, "value not present in mirror"
            )
