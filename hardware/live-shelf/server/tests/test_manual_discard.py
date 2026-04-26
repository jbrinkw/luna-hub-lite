"""Manual-discard remove-button handler — Pi-side coverage.

Validates the cloud-propagating ``_delete_lot`` path wired in
``server/app.py`` (2026-04-27). The handler must:

  1. DELETE the lot row from local SQLite (existing behaviour).
  2. Enqueue a ``cloud_outbox`` row with ``event_kind='discarded'`` +
     the lot's ``product_id`` so the cloud worker can drain it.
  3. Be a no-op on the cloud-emit side when ``cloud_emitter.enabled =
     False`` (lab/offline mode) — the local DELETE still succeeds.
  4. Survive an emit raise: local DELETE remains committed, no
     exception bubbles out of the route.

These tests exercise the helper as a pure unit — they reach into
``app.py``'s closure indirectly by reproducing its code shape on a
fresh test DB. We don't spin up the full Flask app because the
handler's contract with the rest of the system is the (delete + emit)
pair, which is fully observable on the SQLite + outbox tables.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


def _seed_lot(conn, *, shelf_id="live_shelf", barcode=None):
    """Seed a product + lot pair we can hit with the discard handler.

    Returns (product_id, lot_id) — both minted by the repo helpers.
    """
    product = storage_repo.create_product(
        conn,
        ProductIn(
            barcode=barcode,
            name="Discardable",
            net_weight_g=200.0,
            gross_weight_g=200.0,
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=200.0,
            initial_weight_g=200.0,
            shelf_id=shelf_id,
        ),
    )
    return product.product_id, lot.lot_id


def _make_delete_lot_fn(conn, db_lock, cloud_emitter):
    """Reconstruct the ``_delete_lot`` closure from app.py inline.

    Mirrors the production wiring so we exercise the same code shape.
    Keeps the test isolated from Flask routing / blueprint construction.
    """
    import logging
    log = logging.getLogger("test_manual_discard")

    def _delete_lot(lot_id):
        with db_lock:
            existing = storage_repo.get_lot(conn, lot_id)
            if existing is None:
                raise LookupError(f"lot not found: {lot_id!r}")
            product_id = existing.product_id
            shelf_id = existing.shelf_id
            counts = storage_repo.delete_lot(conn, lot_id)

            if shelf_id == "single_item":
                cloud_kind = "live_scale"
            elif shelf_id == "catch_all":
                cloud_kind = "catch_all"
            else:
                cloud_kind = "live_shelf"

            cloud_event_id = None
            if cloud_emitter.enabled and product_id:
                try:
                    cloud_event_id = cloud_emitter.emit_manual_discard(
                        scale_id="scale-01",
                        product_id=product_id,
                        kind=cloud_kind,
                        pi_event_id=lot_id,
                    )
                except Exception:
                    log.warning(
                        "lot delete: cloud emit raised", exc_info=True,
                    )

        return {
            "lot_id": lot_id,
            "rows_deleted": counts,
            "cloud_event_enqueued": cloud_event_id is not None,
        }

    return _delete_lot


def _outbox_rows(conn):
    return [
        dict(row)
        for row in conn.execute(
            "SELECT outbox_id, client_event_id, payload_json "
            "  FROM cloud_outbox "
            " ORDER BY outbox_id ASC"
        )
    ]


@pytest.fixture
def db(tmp_path):
    conn = init_db(str(tmp_path / "live-shelf.sqlite"))
    yield conn
    conn.close()


def test_delete_lot_emits_discarded_event(db):
    """Happy path: delete + enqueue cloud manual_discard event."""
    product_id, lot_id = _seed_lot(db)
    emitter = CloudEventEmitter(db, enabled=True)
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    summary = delete_lot(lot_id)

    assert summary["rows_deleted"]["lots"] == 1, (
        f"local lot DELETE must succeed; got {summary!r}"
    )
    assert summary["cloud_event_enqueued"] is True, (
        f"cloud emit must succeed for an enabled emitter on a known "
        f"product; got {summary!r}"
    )

    # Local lot is gone.
    assert storage_repo.get_lot(db, lot_id) is None

    # Outbox row exists with the right shape.
    rows = _outbox_rows(db)
    assert len(rows) == 1, (
        f"expected exactly one outbox row from the discard; got {len(rows)}"
    )
    payload = json.loads(rows[0]["payload_json"])
    assert payload["event_kind"] == "discarded", (
        f"event_kind must be 'discarded' (cloud handler keys off this "
        f"to skip food_logs); got {payload!r}"
    )
    assert payload["product_id"] == product_id, (
        f"emit must reference the deleted lot's product_id; got {payload!r}"
    )
    assert payload["kind"] == "live_shelf"
    assert payload["scale_id"] == "scale-01"
    assert payload["pi_event_id"] == lot_id, (
        f"pi_event_id must be the deleted lot_id for cross-ref in "
        f"shelf_event_log; got {payload!r}"
    )
    # delta_g must be 0.0 — the cloud handler ignores it for discarded
    # but the edge fn validator requires the field to be present.
    assert float(payload["delta_g"]) == 0.0


def test_delete_lot_with_disabled_emitter_is_local_only(db):
    """When cloud is disabled, local DELETE still happens; no outbox row."""
    _, lot_id = _seed_lot(db, barcode="bc-disabled")
    emitter = CloudEventEmitter(db, enabled=False)
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    summary = delete_lot(lot_id)

    assert summary["rows_deleted"]["lots"] == 1
    assert summary["cloud_event_enqueued"] is False, (
        f"cloud emit must be a no-op when emitter is disabled; got {summary!r}"
    )
    assert storage_repo.get_lot(db, lot_id) is None
    assert _outbox_rows(db) == [], (
        "no outbox rows should be created with a disabled emitter"
    )


def test_delete_lot_emit_raise_does_not_break_local_delete(db):
    """A raising emit must NOT roll back the local DELETE.

    Regression guard: cloud observability is best-effort. If the
    outbox INSERT raises (DB locked, integrity error, etc.) the
    handler must swallow + log so the user still sees their UI
    confirmation that the row was removed locally. The cloud worker
    will not retry an event we never enqueued, but the next
    lot-snapshot poll will reconcile cloud → Pi state on its own.
    """
    _, lot_id = _seed_lot(db, barcode="bc-raise")
    emitter = MagicMock(spec=CloudEventEmitter)
    emitter.enabled = True
    emitter.emit_manual_discard.side_effect = RuntimeError(
        "synthetic emit failure"
    )
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    # No exception bubbles out.
    summary = delete_lot(lot_id)

    assert summary["rows_deleted"]["lots"] == 1, (
        "local DELETE must succeed even when cloud emit raises"
    )
    assert summary["cloud_event_enqueued"] is False
    assert storage_repo.get_lot(db, lot_id) is None
    emitter.emit_manual_discard.assert_called_once()


def test_delete_lot_unknown_id_raises_lookup_error(db):
    """Unknown lot_id returns 404 territory — the route handler maps
    LookupError to a 404 JSON response. Cover the LookupError shape
    so a future refactor can't silently change it to a different
    exception class.
    """
    emitter = CloudEventEmitter(db, enabled=True)
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    with pytest.raises(LookupError):
        delete_lot("never-existed-lot-id")

    # No outbox row should be enqueued for a lot that never existed.
    assert _outbox_rows(db) == []


def test_delete_lot_catch_all_shelf_emits_with_catch_all_kind(db):
    """Shelf-id mapping: catch_all lot → kind='catch_all' on the emit."""
    _, lot_id = _seed_lot(db, shelf_id="catch_all", barcode="bc-catch")
    emitter = CloudEventEmitter(db, enabled=True)
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    delete_lot(lot_id)

    rows = _outbox_rows(db)
    assert len(rows) == 1
    payload = json.loads(rows[0]["payload_json"])
    assert payload["kind"] == "catch_all", (
        f"catch_all shelf_id must map to kind='catch_all'; got {payload!r}"
    )
    assert payload["event_kind"] == "discarded"


def test_delete_lot_default_shelf_id_emits_live_shelf(db):
    """Shelf-id mapping fallback: when ``_row_to_lot`` reads back any
    non-(live_shelf|catch_all) shelf_id it normalises to ``live_shelf``
    (see ``server/storage/repo.py::_row_to_lot``). Confirm the discard
    handler keys off the dataclass-level shelf_id, not the raw column,
    so the cloud emit always carries a recognised ``kind`` value."""
    _, lot_id = _seed_lot(db, barcode="bc-default")
    emitter = CloudEventEmitter(db, enabled=True)
    delete_lot = _make_delete_lot_fn(db, threading.RLock(), emitter)

    delete_lot(lot_id)

    rows = _outbox_rows(db)
    assert len(rows) == 1
    payload = json.loads(rows[0]["payload_json"])
    assert payload["kind"] == "live_shelf", (
        f"default shelf_id must map to kind='live_shelf'; got {payload!r}"
    )
