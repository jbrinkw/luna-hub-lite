"""B3 regression: in-session dedup + remove-direction lot status flip.

Two symptoms observed in production:

B3a — Duplicate lot writes in the same session:
  * Two ADD events both wrote ``new_arrival`` against the SAME lot_id
    (impossible double-add — the classifier picked the same parmesan
    lot twice because before/after frames were visually similar).
  * Two REMOVE events both wrote ``consumed_or_removed`` against the
    same parmesan lot (impossible double-remove).

B3b — Remove direction not writing ``status='out'``:
  * Meanwhile, physically-removed items stayed ``on_shelf`` in the DB.
    Root cause was actually B3a (the lot that SHOULD have flipped was
    shadowed by a duplicate apply on the wrong lot). The direct fix is
    in-session dedup; this test also locks in the "remove writes
    status='out'" invariant via the ``record_resolution`` helper's
    equivalent surface.

The fix:
  * ``_apply_lot_update_from_classification`` consults
    ``session_resolutions`` for any prior row referencing the same
    ``lot_id`` + ``session_id`` — if found (and not the same event), it
    logs and bails without touching the lot.
  * The REMOVE path keeps calling ``update_lot(status='out', ...)`` but
    short-circuits when the lot is already ``out`` to avoid re-stamping.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


def _record_event(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    direction: str,
    delta_g: float,
    ts: str,
) -> str:
    """Insert a scale_events row so session_resolutions FK can point at it."""
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts,
            delta_g=delta_g,
            before_weight_g=0.0,
            after_weight_g=0.0,
            direction=direction,
            session_id=session_id,
            classifier_status="classified",
        ),
    )
    return ev.event_id


def _make_handler(conn: sqlite3.Connection, tmp_path: Path) -> ScaleHandler:
    class _NullCandidateSource:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )


def _open_session(conn: sqlite3.Connection) -> str:
    session = storage_repo.open_session(
        conn, "2026-04-16T12:00:00.000Z", initial_weight_g=500.0,
    )
    return session.session_id


def _insert_resolution(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    lot_id: str,
    pattern: str,
    add_event_id: str | None = None,
    remove_event_id: str | None = None,
) -> str:
    """Directly insert a session_resolutions row to simulate a prior apply."""
    resolution_id = str(uuid.uuid4())
    with conn:
        conn.execute(
            """
            INSERT INTO session_resolutions (
                resolution_id, session_id, lot_id, pattern,
                add_event_id, remove_event_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (resolution_id, session_id, lot_id, pattern,
             add_event_id, remove_event_id),
        )
    return resolution_id


# ---------------------------------------------------------------------------
# B3a — in-session dedup
# ---------------------------------------------------------------------------


def test_apply_lot_update_skips_duplicate_in_session(tmp_path: Path, caplog):
    """Second apply against the same lot in the same session is a no-op.

    Scenario: classifier runs on event_A, applies an update (lot flips
    status + last_seen_at). A sibling event_B in the SAME session also
    picks the same lot (duplicate). The dedup guard short-circuits
    without re-touching the lot.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Parmesan", barcode="99999",
            net_weight_g=200.0, gross_weight_g=200.0,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=200.0, initial_weight_g=200.0,
        ),
    )

    session_id = _open_session(conn)

    # Simulate that event_A already wrote a consumed_or_removed
    # resolution against this lot.
    event_a_id = _record_event(
        conn, session_id=session_id, direction="remove",
        delta_g=-200.0, ts="2026-04-16T12:00:01.000Z",
    )
    _insert_resolution(
        conn,
        session_id=session_id, lot_id=lot.lot_id,
        pattern="consumed_or_removed", remove_event_id=event_a_id,
    )
    event_b_id = _record_event(
        conn, session_id=session_id, direction="remove",
        delta_g=-200.0, ts="2026-04-16T12:00:10.000Z",
    )
    # Apply the REMOVE side-effect so the lot is already 'out'.
    storage_repo.update_lot(
        conn, lot.lot_id, status="out",
        last_out_at="2026-04-16T12:00:01.000Z",
    )
    initial_last_out = storage_repo.get_lot(conn, lot.lot_id).last_out_at

    # Event B: classifier picks the SAME lot — duplicate pick.
    classification = {
        "item_id": lot.lot_id,
        "action": "removed",
        "confidence": 0.95,
        "multi_match": [],
        "candidate_pool_used": [{"candidate_id": lot.lot_id}],
    }

    with caplog.at_level("WARNING"):
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification=classification,
            event_ts="2026-04-16T12:00:10.000Z",
            delta_g=-200.0,
            session_id=session_id,
            event_id=event_b_id,
        )

    # Lot must be unchanged (last_out_at not re-stamped; no second
    # update_lot call slipped through).
    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "out"
    assert lot_now.last_out_at == initial_last_out, (
        "last_out_at was re-stamped — dedup guard failed (or the "
        "already-out guard re-fired)"
    )

    # The dedup decision was logged.
    assert any(
        "already resolved in session" in rec.getMessage()
        for rec in caplog.records
    ), "expected a warning about duplicate apply"


def test_apply_lot_update_skips_duplicate_new_arrival_mint(tmp_path: Path, caplog):
    """Second ADD for same product in same session must NOT mint a 2nd lot.

    Scenario: two ADD events fire, classifier picks the same
    catalog_not_on_shelf product for both. Only the first should mint
    a fresh lot; the second is a duplicate pick and must be skipped.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="New Item", barcode="12345",
            net_weight_g=150.0, gross_weight_g=150.0,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    session_id = _open_session(conn)

    # Event A minted a lot and wrote a new_arrival resolution.
    event_a_id = _record_event(
        conn, session_id=session_id, direction="add",
        delta_g=150.0, ts="2026-04-16T12:00:01.000Z",
    )
    minted = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=150.0, initial_weight_g=150.0,
        ),
    )
    _insert_resolution(
        conn,
        session_id=session_id, lot_id=minted.lot_id,
        pattern="new_arrival", add_event_id=event_a_id,
    )
    event_b_id = _record_event(
        conn, session_id=session_id, direction="add",
        delta_g=150.0, ts="2026-04-16T12:00:10.000Z",
    )

    # Event B picks the same product_id. candidate_pool lists it as a
    # ``catalog_not_on_shelf`` candidate so the apply path takes the
    # create_lot branch.
    classification = {
        "item_id": product.product_id,
        "action": "added",
        "confidence": 0.95,
        "multi_match": [],
        "candidate_pool_used": [
            {
                "candidate_id": product.product_id,
                "product_id": product.product_id,
                "why_candidate": "catalog_not_on_shelf",
            }
        ],
    }

    before_lot_count = conn.execute(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchone()[0]
    assert before_lot_count == 1  # the one minted by event A

    with caplog.at_level("WARNING"):
        handler._apply_lot_update_from_classification(
            direction="add",
            classification=classification,
            event_ts="2026-04-16T12:00:10.000Z",
            delta_g=150.0,
            session_id=session_id,
            event_id=event_b_id,
        )

    after_lot_count = conn.execute(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchone()[0]
    assert after_lot_count == 1, (
        f"duplicate apply minted a second lot (count {before_lot_count} "
        f"→ {after_lot_count}); dedup guard failed"
    )
    assert any(
        "already received a session_resolution" in rec.getMessage()
        for rec in caplog.records
    ), "expected a warning about duplicate new-lot mint"


# ---------------------------------------------------------------------------
# B3b — remove direction writes status='out'
# ---------------------------------------------------------------------------


def test_apply_lot_update_remove_writes_status_in_flight(tmp_path: Path):
    """Positive case: first REMOVE against an on_shelf lot flips it to
    status='in_flight' and records pickup_weight_g + in_flight_since.

    Pre-in-flight-tracker the apply path wrote status='out' directly.
    IN_FLIGHT_TRACKER_PLAN.md §4.1 changed this: classified REMOVEs now
    stage at ``in_flight`` and only transition to ``out`` via the TTL
    reaper or an explicit replacement. This test locks in the new shape.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Philadelphia", barcode="77777",
            net_weight_g=240.0, gross_weight_g=240.0,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=240.0, initial_weight_g=240.0,
        ),
    )
    assert storage_repo.get_lot(conn, lot.lot_id).status == "on_shelf"

    session_id = _open_session(conn)
    fresh_event_id = _record_event(
        conn, session_id=session_id, direction="remove",
        delta_g=-240.0, ts="2026-04-16T12:00:05.500Z",
    )

    classification = {
        "item_id": lot.lot_id,
        "action": "removed",
        "confidence": 0.93,
        "multi_match": [],
        "candidate_pool_used": [{"candidate_id": lot.lot_id}],
    }
    event_ts = "2026-04-16T12:00:05.500Z"

    handler._apply_lot_update_from_classification(
        direction="remove",
        classification=classification,
        event_ts=event_ts,
        delta_g=-240.0,
        session_id=session_id,
        event_id=fresh_event_id,
    )

    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "in_flight", (
        f"remove path failed to stage in_flight (got {lot_now.status!r})"
    )
    assert lot_now.in_flight_since == event_ts
    assert lot_now.pickup_weight_g == 240.0
    assert lot_now.pickup_event_id == fresh_event_id
    assert lot_now.pickup_session_id == session_id


def test_apply_lot_update_remove_skips_already_out_lot(tmp_path: Path, caplog):
    """Double-remove of an already-out lot must NOT re-stamp last_out_at.

    Guards against a spurious second REMOVE (classifier picks the same
    lot across two events in one session) from overwriting a legitimate
    earlier last_out_at with the later event's ts.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Old Chicken", barcode="33333",
            net_weight_g=300.0, gross_weight_g=300.0,
            unit_type="solid", container_type="tray", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="out",
            current_weight_g=300.0, initial_weight_g=300.0,
            last_out_at="2026-04-15T08:00:00.000Z",
        ),
    )
    initial_last_out = lot.last_out_at

    # NOTE: no session_id passed — so we exercise the *status-out* guard
    # alone, not the session dedup guard.
    classification = {
        "item_id": lot.lot_id,
        "action": "removed",
        "confidence": 0.91,
        "multi_match": [],
        "candidate_pool_used": [{"candidate_id": lot.lot_id}],
    }
    later_ts = "2026-04-16T14:00:00.000Z"

    with caplog.at_level("WARNING"):
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification=classification,
            event_ts=later_ts,
            delta_g=-300.0,
        )

    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "out"
    assert lot_now.last_out_at == initial_last_out, (
        "last_out_at was overwritten on a redundant remove; the "
        "already-out guard failed"
    )
    assert any(
        "already status='out'" in rec.getMessage()
        for rec in caplog.records
    ), "expected a warning about the skipped redundant flip"
