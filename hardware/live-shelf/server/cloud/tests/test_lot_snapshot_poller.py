"""Unit tests for :mod:`server.cloud.lot_snapshot_poller`.

The ``LotSnapshotPoller`` mirrors cloud ``chefbyte.stock_lots`` deltas
into the Pi's ``cloud_lots`` SQLite table. Cloud wins on conflict.

Coverage:
  * First tick (no watermark): full pull, rows inserted, watermark written.
  * Delta tick: sends ``updated_since``, only rows newer than the
    watermark are included.
  * Tombstone (deleted_at set): Pi-side cloud_lots row is hard-deleted.
  * Tombstone flags Pi ``lots`` row to 'lost' if it was in_flight.
  * Cloud 5xx (CloudError): tick returns 0, state file untouched.
  * Generic exception: tick returns 0, thread-safe.
  * Malformed rows (missing lot_id / product_id / updated_at) skipped
    without poisoning the rest of the batch.
  * Watermark advances from all returned rows (including tombstones) so
    the same rows aren't re-fetched.
  * Idempotency: applying the same lot twice produces the same DB state.
  * Settings-cache branch: when a settings_cache is provided, classifier
    flag is propagated; cache kept on settings fetch error.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.lot_snapshot_poller import LotSnapshotPoller  # noqa: E402
from server.cloud.settings_cache import ClassifierSettings, ClassifierSettingsCache  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    c.execute("PRAGMA foreign_keys = ON")
    return c


def _lot(
    lot_id: str | None = None,
    product_id: str = "prod-A",
    qty: float = 2.0,
    updated_at: str = "2026-04-21T12:00:00Z",
    deleted_at: str | None = None,
) -> dict:
    return {
        "lot_id": lot_id or str(uuid.uuid4()),
        "product_id": product_id,
        "location_id": None,
        "qty_containers": qty,
        "expires_on": None,
        "in_flight_since": None,
        "in_flight_kind": None,
        "pickup_event_id": None,
        "created_at": "2026-04-01T00:00:00Z",
        "updated_at": updated_at,
        "deleted_at": deleted_at,
    }


def _payload(*lots: dict) -> dict:
    return {"lots": list(lots)}


def _poller(client, conn, state_path, *, fetch_fn=None, settings_cache=None):
    return LotSnapshotPoller(
        client,
        conn,
        state_path=state_path,
        fetch_snapshot_fn=fetch_fn,
        settings_cache=settings_cache,
    )


def _all_cloud_lot_ids(conn: sqlite3.Connection) -> set[str]:
    return {r["lot_id"] for r in conn.execute("SELECT lot_id FROM cloud_lots").fetchall()}


# ---------------------------------------------------------------------------
# First tick / watermark
# ---------------------------------------------------------------------------


def test_first_tick_inserts_lots_and_writes_watermark(conn, tmp_path):
    """Empty Pi + cloud lots → INSERT all; watermark written."""
    state_path = tmp_path / "state.json"
    lot1 = _lot("lot-1", updated_at="2026-04-20T10:00:00Z")
    lot2 = _lot("lot-2", updated_at="2026-04-21T12:00:00Z")

    fetch = MagicMock(return_value=_payload(lot1, lot2))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    applied = p.tick_once()

    assert applied == 2
    assert _all_cloud_lot_ids(conn) == {"lot-1", "lot-2"}
    assert p.high_watermark == "2026-04-21T12:00:00Z"
    assert state_path.exists()

    saved = json.loads(state_path.read_text())
    assert saved["high_watermark"] == "2026-04-21T12:00:00Z"


def test_first_tick_sends_updated_since_none(conn, tmp_path):
    fetch = MagicMock(return_value=_payload())
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()
    fetch.assert_called_once_with(p._client, updated_since=None)


def test_delta_tick_sends_cached_watermark(conn, tmp_path):
    state_path = tmp_path / "state.json"
    lot = _lot("lot-1", updated_at="2026-04-20T10:00:00Z")
    fetch = MagicMock(return_value=_payload(lot))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    p.tick_once()
    assert p.high_watermark == "2026-04-20T10:00:00Z"

    # Second tick
    fetch.return_value = _payload()
    p.tick_once()
    assert fetch.call_args_list[-1] == (
        (p._client,), {"updated_since": "2026-04-20T10:00:00Z"}
    )


# ---------------------------------------------------------------------------
# UPSERT / UPDATE
# ---------------------------------------------------------------------------


def test_upsert_updates_existing_row(conn, tmp_path):
    lot_id = "lot-1"
    lot_v1 = _lot(lot_id, qty=1.0, updated_at="2026-04-20T10:00:00Z")
    lot_v2 = _lot(lot_id, qty=5.0, updated_at="2026-04-21T12:00:00Z")

    fetch = MagicMock(return_value=_payload(lot_v1))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    fetch.return_value = _payload(lot_v2)
    p.tick_once()

    row = conn.execute("SELECT qty_containers FROM cloud_lots WHERE lot_id = ?", (lot_id,)).fetchone()
    assert row is not None
    assert float(row["qty_containers"]) == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# Tombstone
# ---------------------------------------------------------------------------


def test_tombstone_deletes_cloud_lot_row(conn, tmp_path):
    lot_id = "lot-del"
    live = _lot(lot_id, updated_at="2026-04-20T10:00:00Z")
    fetch = MagicMock(return_value=_payload(live))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()
    assert lot_id in _all_cloud_lot_ids(conn)

    dead = _lot(lot_id, updated_at="2026-04-21T12:00:00Z", deleted_at="2026-04-21T12:00:00Z")
    fetch.return_value = _payload(dead)
    applied = p.tick_once()

    assert applied == 1
    assert lot_id not in _all_cloud_lot_ids(conn)


def test_tombstone_flags_inflight_pi_lot_to_lost(conn, tmp_path):
    """Cloud-side tombstone for a lot that is in_flight on Pi must flag
    the Pi lot as 'lost' so the local state machine recovers (Audit #3)."""
    # Seed a product row first (lots.product_id FK)
    conn.execute(
        "INSERT INTO products (product_id, name, net_weight_g) VALUES (?, ?, ?)",
        ("prod-A", "Test Product", 100.0),
    )
    conn.commit()

    # Seed a Pi lot in 'in_flight' status
    pi_lot_id = str(uuid.uuid4())
    pickup_event_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, pickup_event_id) "
        "VALUES (?, ?, 'in_flight', datetime('now'), ?)",
        (pi_lot_id, "prod-A", pickup_event_id),
    )
    # Seed matching cloud_lots row
    cloud_lot_id = "cloud-lot-1"
    conn.execute(
        """
        INSERT INTO cloud_lots (lot_id, product_id, qty_containers, updated_at, pickup_event_id)
        VALUES (?, ?, 1.0, ?, ?)
        """,
        (cloud_lot_id, "prod-A", "2026-04-20T10:00:00Z", pickup_event_id),
    )
    conn.commit()

    # Now cloud tombstones that lot
    dead = _lot(cloud_lot_id, updated_at="2026-04-21T12:00:00Z", deleted_at="2026-04-21T12:00:00Z")
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    pi_row = conn.execute("SELECT status FROM lots WHERE lot_id = ?", (pi_lot_id,)).fetchone()
    assert pi_row is not None
    assert pi_row["status"] == "lost"


# ---------------------------------------------------------------------------
# Cloud error handling
# ---------------------------------------------------------------------------


def test_cloud_error_returns_0_and_leaves_state_untouched(conn, tmp_path):
    state_path = tmp_path / "s.json"
    fetch = MagicMock(side_effect=CloudError(503, "Service Unavailable"))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    applied = p.tick_once()

    assert applied == 0
    assert p.high_watermark is None
    assert not state_path.exists()


def test_generic_exception_caught_returns_0(conn, tmp_path):
    fetch = MagicMock(side_effect=RuntimeError("connection reset"))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    applied = p.tick_once()
    assert applied == 0


def test_cloud_error_does_not_delete_existing_pi_rows(conn, tmp_path):
    """fetch failure must NOT be misinterpreted as 'zero lots' and
    delete existing cloud_lots rows."""
    # Insert a cloud_lots row directly
    conn.execute(
        "INSERT INTO cloud_lots (lot_id, product_id, qty_containers, updated_at) "
        "VALUES ('lot-keep', 'prod-A', 1.0, '2026-04-20T10:00:00Z')"
    )
    conn.commit()

    fetch = MagicMock(side_effect=CloudError(502, "Bad Gateway"))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    assert "lot-keep" in _all_cloud_lot_ids(conn)


# ---------------------------------------------------------------------------
# Malformed rows
# ---------------------------------------------------------------------------


def test_malformed_row_missing_lot_id_skipped(conn, tmp_path):
    bad = {"product_id": "prod-A", "updated_at": "2026-04-21T12:00:00Z", "qty_containers": 1.0}
    good = _lot("lot-ok", updated_at="2026-04-21T12:00:00Z")
    fetch = MagicMock(return_value=_payload(bad, good))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    applied = p.tick_once()

    assert applied == 1
    assert "lot-ok" in _all_cloud_lot_ids(conn)


def test_malformed_row_missing_product_id_skipped(conn, tmp_path):
    bad = {"lot_id": "lot-bad", "updated_at": "2026-04-21T12:00:00Z", "qty_containers": 1.0}
    fetch = MagicMock(return_value=_payload(bad))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    applied = p.tick_once()
    assert applied == 0


def test_malformed_rows_do_not_poison_watermark_advance(conn, tmp_path):
    """All rows malformed: watermark still advances from their updated_at."""
    bad_rows = [
        {"lot_id": "bad-1", "updated_at": "2026-04-22T10:00:00Z"},  # missing product_id
        {"product_id": "prod-A", "updated_at": "2026-04-23T10:00:00Z"},  # missing lot_id
    ]
    fetch = MagicMock(return_value={"lots": bad_rows})
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    # updated_at values are read before _apply_one, so max is still tracked
    assert p.high_watermark == "2026-04-23T10:00:00Z"


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_idempotent_second_tick_same_data(conn, tmp_path):
    """Applying the same lot row twice produces the same state and
    tick 2 reports 1 mutation (upsert with no change = still True in SQLite)."""
    lot = _lot("lot-1", qty=3.0, updated_at="2026-04-21T12:00:00Z")
    fetch = MagicMock(return_value=_payload(lot))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    p.tick_once()
    p.tick_once()  # Same data — no new rows in cloud delta, watermark unchanged

    row = conn.execute("SELECT qty_containers FROM cloud_lots WHERE lot_id = 'lot-1'").fetchone()
    assert row is not None
    assert float(row["qty_containers"]) == pytest.approx(3.0)


# ---------------------------------------------------------------------------
# Settings cache
# ---------------------------------------------------------------------------


def test_settings_cache_updated_on_tick(conn, tmp_path):
    cache = ClassifierSettingsCache()
    assert cache.get().chefbyte_classifier_fallback_enabled is False

    settings_payload = {"chefbyte_classifier_fallback_enabled": True}
    lot = _lot("lot-1")
    fetch_snapshot = MagicMock(return_value=_payload(lot))
    fetch_settings = MagicMock(return_value=settings_payload)

    p = LotSnapshotPoller(
        MagicMock(),
        conn,
        state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch_snapshot,
        settings_cache=cache,
        fetch_settings_fn=fetch_settings,
    )
    p.tick_once()

    assert cache.get().chefbyte_classifier_fallback_enabled is True


def test_settings_cache_kept_on_settings_fetch_error(conn, tmp_path):
    cache = ClassifierSettingsCache()
    cache.update(ClassifierSettings(chefbyte_classifier_fallback_enabled=True))

    fetch_snapshot = MagicMock(return_value=_payload())
    fetch_settings = MagicMock(side_effect=CloudError(500, "boom"))

    p = LotSnapshotPoller(
        MagicMock(),
        conn,
        state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch_snapshot,
        settings_cache=cache,
        fetch_settings_fn=fetch_settings,
    )
    p.tick_once()

    # Cache retains its previous value
    assert cache.get().chefbyte_classifier_fallback_enabled is True
