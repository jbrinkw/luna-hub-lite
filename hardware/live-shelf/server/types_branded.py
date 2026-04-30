"""Branded (NewType) wrappers for cross-process UUID namespaces.

Problem: Pi-local lot UUIDs and cloud stock-lot UUIDs are both valid UUID
strings, but they live in entirely separate ID spaces. A Pi lot_id passed
directly to the cloud ``apply_live_weight_sync`` handler will always produce
``applied=false`` because the cloud looks it up in ``stock_lots`` — a
completely different table. Format-only validation (UUID regex) cannot detect
this class of bug.

Solution: NewType wrappers make the static type checker (mypy --strict) reject
mismatches at the call site. Parsers validate namespace provenance against the
actual lookup table before promoting a raw string to a branded type, so the
invariant "this UUID exists in namespace X" is established at the boundary and
propagated through the call graph without repeated re-validation.

Usage pattern::

    cloud_lot_id = parse_cloud_lot_id(row["cloud_lot_id"], conn)
    emitter.emit_live_weight_sync(pi_lot_id=cloud_lot_id, ...)

A ``ValueError`` (``InvalidIdError``) at the parser call is the correct
failure mode — it surfaces the namespace mismatch as a hard error at the
boundary rather than silently producing an ``applied=false`` cloud event that
is hard to diagnose in production.
"""

from __future__ import annotations

import re
import sqlite3
from typing import NewType

# ---------------------------------------------------------------------------
# Branded type aliases
# ---------------------------------------------------------------------------

# UUID known to exist in cloud ``chefbyte.stock_lots.lot_id``.
CloudLotId = NewType("CloudLotId", str)

# UUID known to exist in Pi-local ``lots.lot_id`` (different namespace!).
PiLocalLotId = NewType("PiLocalLotId", str)

# UUID known to exist in cloud ``chefbyte.products.product_id``.
CloudProductId = NewType("CloudProductId", str)

# UUID known to exist in Pi-local ``scale_events.event_id``.
PiLocalEventId = NewType("PiLocalEventId", str)

# ---------------------------------------------------------------------------
# Error type
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class InvalidIdError(ValueError):
    """Raised when a raw string fails namespace or format validation.

    Attributes
    ----------
    raw:
        The original string that was rejected.
    expected_namespace:
        Human-readable label for the expected type (e.g. ``"CloudLotId"``).
    table_queried:
        The lookup table checked, or ``"format check"`` when the UUID regex
        itself failed before any DB query was attempted.
    """

    def __init__(
        self,
        raw: str,
        expected_namespace: str,
        table_queried: str,
    ) -> None:
        super().__init__(
            f"{raw!r} not found in {table_queried} (expected {expected_namespace})"
        )
        self.raw = raw
        self.expected_namespace = expected_namespace
        self.table_queried = table_queried


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _assert_uuid_format(raw: str, namespace: str) -> None:
    """Raise ``InvalidIdError`` if *raw* is not a well-formed UUID string."""
    if not _UUID_RE.match(raw):
        raise InvalidIdError(raw, namespace, "format check")


# ---------------------------------------------------------------------------
# Parsers — validate namespace provenance against actual lookup tables
# ---------------------------------------------------------------------------


def parse_cloud_lot_id(raw: str, conn: sqlite3.Connection) -> CloudLotId:
    """Promote *raw* to ``CloudLotId`` after verifying it in ``cloud_lots``.

    The Pi maintains a ``cloud_lots`` mirror of the cloud's
    ``chefbyte.stock_lots`` table (synced by :class:`LotSnapshotPoller`).
    Querying the mirror confirms the UUID belongs to the cloud namespace
    without requiring a network call.

    Raises ``InvalidIdError`` if *raw* is not a valid UUID or is absent from
    ``cloud_lots``.
    """
    _assert_uuid_format(raw, "CloudLotId")
    cursor = conn.execute("SELECT 1 FROM cloud_lots WHERE lot_id = ?", (raw,))
    if not cursor.fetchone():
        raise InvalidIdError(raw, "CloudLotId", "cloud_lots")
    return CloudLotId(raw)


def parse_pi_local_lot_id(raw: str, conn: sqlite3.Connection) -> PiLocalLotId:
    """Promote *raw* to ``PiLocalLotId`` after verifying it in ``lots``.

    Pi-local lot UUIDs live in the Pi's ``lots`` table. They are distinct from
    cloud ``stock_lots.lot_id`` values even when the same product is
    represented — this is the core of the namespace-conflation bug class.

    Raises ``InvalidIdError`` if *raw* is not a valid UUID or is absent from
    ``lots``.
    """
    _assert_uuid_format(raw, "PiLocalLotId")
    cursor = conn.execute("SELECT 1 FROM lots WHERE lot_id = ?", (raw,))
    if not cursor.fetchone():
        raise InvalidIdError(raw, "PiLocalLotId", "lots")
    return PiLocalLotId(raw)


def parse_cloud_product_id(raw: str, conn: sqlite3.Connection) -> CloudProductId:
    """Promote *raw* to ``CloudProductId`` after verifying it in ``cloud_products``.

    The Pi maintains a ``cloud_products`` mirror of ``chefbyte.products``.

    Raises ``InvalidIdError`` if *raw* is not a valid UUID or is absent from
    ``cloud_products``.
    """
    _assert_uuid_format(raw, "CloudProductId")
    cursor = conn.execute(
        "SELECT 1 FROM cloud_products WHERE product_id = ?", (raw,)
    )
    if not cursor.fetchone():
        raise InvalidIdError(raw, "CloudProductId", "cloud_products")
    return CloudProductId(raw)


def parse_pi_local_event_id(raw: str, conn: sqlite3.Connection) -> PiLocalEventId:
    """Promote *raw* to ``PiLocalEventId`` after verifying it in ``scale_events``.

    Raises ``InvalidIdError`` if *raw* is not a valid UUID or is absent from
    ``scale_events``.
    """
    _assert_uuid_format(raw, "PiLocalEventId")
    cursor = conn.execute(
        "SELECT 1 FROM scale_events WHERE event_id = ?", (raw,)
    )
    if not cursor.fetchone():
        raise InvalidIdError(raw, "PiLocalEventId", "scale_events")
    return PiLocalEventId(raw)


__all__ = [
    "CloudLotId",
    "PiLocalLotId",
    "CloudProductId",
    "PiLocalEventId",
    "InvalidIdError",
    "parse_cloud_lot_id",
    "parse_pi_local_lot_id",
    "parse_cloud_product_id",
    "parse_pi_local_event_id",
]
