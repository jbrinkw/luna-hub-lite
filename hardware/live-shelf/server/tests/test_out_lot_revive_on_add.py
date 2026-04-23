"""out → on_shelf revive on ADD event — hot-path test.

Validates the 2026-04-27 fix in ``handlers/scale_events.py``: when the
classifier picks a lot whose status is ``out`` (TTL-reaped / previously
removed) for an ADD event, the hot path must now:

  1. Flip the lot back to ``status='on_shelf'`` (preserved behaviour).
  2. Write a ``new_arrival`` session_resolutions row so the reconciler's
     claimed_event_ids skip logic covers the add_event_id (prevents
     Pass 3 from writing a SECOND new_arrival at session close).
  3. Emit a cloud ``new_arrival`` event so the cloud's ``added`` branch
     runs → ``resolve_add_to_shelf_lot`` step-4 revives the empty lot.

Before the fix the hot path just ran ``update_lot(status='on_shelf')``
with zero cloud traffic. A TTL-reaped lot placed back on the shelf
stayed at qty=0 on cloud until session close — and even the session-
close reconciler Pass 3 often saw status='on_shelf' (the hot path
already flipped it) so it wrote ``new_arrival`` locally but nothing
was emitted to cloud at hot-path time. This test locks in the fix.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self):
        return []

    def get_recently_out_lots(self, window_seconds):
        return []

    def get_in_flight_lots(self, max_age_seconds=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


_BC = [0]


def _setup_lot(conn, weight_g=200.0, status="on_shelf"):
    _BC[0] += 1
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=f"Revive Item {_BC[0]}", barcode=f"R-{_BC[0]}",
            net_weight_g=weight_g, gross_weight_g=weight_g,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status=status,
              current_weight_g=weight_g, initial_weight_g=weight_g),
    )
    return product, lot


def _make_handler(conn, tmp_path, cloud_emitter=None, **kwargs):
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
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
    defaults.update(kwargs)
    handler = ScaleHandler(**defaults)
    if cloud_emitter is not None:
        handler._cloud_emitter = cloud_emitter
    return handler


def _open_session(conn):
    return storage_repo.open_session(
        conn, "2026-04-27T12:00:00.000Z", initial_weight_g=200.0,
    ).session_id


def _record_add(conn, session_id, *, delta_g, ts="2026-04-27T12:05:00.000Z"):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0, after_weight_g=delta_g,
            direction="add", session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _resolutions_for(conn, session_id):
    return [
        dict(row) for row in conn.execute(
            "SELECT * FROM session_resolutions WHERE session_id=? "
            "ORDER BY created_at",
            (session_id,),
        )
    ]


def test_out_lot_add_flips_to_on_shelf_and_writes_new_arrival_resolution(
    tmp_path,
):
    """ADD against an out-status lot writes new_arrival resolution +
    flips status to on_shelf."""
    conn = init_db(":memory:")
    _, lot = _setup_lot(conn, weight_g=200.0, status="out")
    # Out lots have current_weight_g=0.0 and a last_out_at; mirror reality.
    conn.execute(
        "UPDATE lots SET current_weight_g = 0.0, "
        "last_out_at = '2026-04-27T08:00:00.000Z' WHERE lot_id = ?",
        (lot.lot_id,),
    )
    conn.commit()

    mock_emitter = MagicMock()
    mock_emitter.emit_reconciler_resolution.return_value = "outbox-id-1"
    handler = _make_handler(conn, tmp_path, cloud_emitter=mock_emitter)

    session_id = _open_session(conn)
    event_id = _record_add(conn, session_id, delta_g=200.0)

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-27T12:05:00.000Z",
        delta_g=200.0,
        session_id=session_id,
        event_id=event_id,
    )

    # 1. Lot flipped to on_shelf with the new weight.
    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now is not None
    assert lot_now.status == "on_shelf"
    assert lot_now.current_weight_g == 200.0

    # 2. new_arrival resolution row written.
    resolutions = _resolutions_for(conn, session_id)
    new_arrival = [r for r in resolutions if r["pattern"] == "new_arrival"]
    assert len(new_arrival) == 1, (
        f"expected exactly one new_arrival row; got {resolutions!r}"
    )
    assert new_arrival[0]["lot_id"] == lot.lot_id
    assert new_arrival[0]["add_event_id"] == event_id


def test_out_lot_add_emits_cloud_new_arrival_event(tmp_path):
    """ADD against an out-status lot emits a new_arrival cloud event."""
    conn = init_db(":memory:")
    _, lot = _setup_lot(conn, weight_g=150.0, status="out")
    conn.execute(
        "UPDATE lots SET current_weight_g = 0.0 WHERE lot_id = ?",
        (lot.lot_id,),
    )
    conn.commit()

    mock_emitter = MagicMock()
    handler = _make_handler(conn, tmp_path, cloud_emitter=mock_emitter)

    session_id = _open_session(conn)
    event_id = _record_add(conn, session_id, delta_g=150.0)

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.92,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-27T12:05:00.000Z",
        delta_g=150.0,
        session_id=session_id,
        event_id=event_id,
    )

    # Exactly one cloud emit: the new_arrival.
    assert mock_emitter.emit_reconciler_resolution.call_count == 1, (
        f"expected exactly one cloud emit; got "
        f"{mock_emitter.emit_reconciler_resolution.call_args_list!r}"
    )
    call_kwargs = mock_emitter.emit_reconciler_resolution.call_args.kwargs
    assert call_kwargs["pattern"] == "new_arrival"
    assert call_kwargs["product_id"] == lot.product_id
    assert call_kwargs["delta_g"] == 150.0
    assert call_kwargs["pi_event_id"] == event_id
    assert call_kwargs["kind"] == "live_shelf"


def test_on_shelf_lot_add_does_not_emit_new_arrival(tmp_path):
    """Baseline: ADD against an already on_shelf lot (not coming back
    from out) must NOT emit the new_arrival cloud event — that branch
    is strictly for out→on_shelf revives."""
    conn = init_db(":memory:")
    _, lot = _setup_lot(conn, weight_g=200.0, status="on_shelf")

    mock_emitter = MagicMock()
    handler = _make_handler(conn, tmp_path, cloud_emitter=mock_emitter)

    session_id = _open_session(conn)
    event_id = _record_add(conn, session_id, delta_g=200.0)

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.90,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-27T12:05:00.000Z",
        delta_g=200.0,
        session_id=session_id,
        event_id=event_id,
    )

    assert mock_emitter.emit_reconciler_resolution.call_count == 0, (
        "on_shelf → on_shelf ADD must not emit a new_arrival cloud event "
        "(reconciler handles these at session close)"
    )
    # No new_arrival resolution either.
    resolutions = _resolutions_for(conn, session_id)
    assert not any(r["pattern"] == "new_arrival" for r in resolutions), (
        f"no new_arrival should be written for on_shelf → on_shelf; "
        f"got {resolutions!r}"
    )


def test_out_lot_add_with_zero_weight_skips_cloud_emit(tmp_path):
    """Defensive: if lot_weight_g is 0 (implausible — classifier picked
    the lot but delta was negligible), skip the cloud emit. We still
    flip local state and write the resolution row."""
    conn = init_db(":memory:")
    _, lot = _setup_lot(conn, weight_g=100.0, status="out")

    mock_emitter = MagicMock()
    handler = _make_handler(conn, tmp_path, cloud_emitter=mock_emitter)

    session_id = _open_session(conn)
    event_id = _record_add(conn, session_id, delta_g=0.0)

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.90,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-27T12:05:00.000Z",
        delta_g=0.0,
        session_id=session_id,
        event_id=event_id,
    )

    # Zero-weight cloud emit would be garbage; skip it.
    assert mock_emitter.emit_reconciler_resolution.call_count == 0
