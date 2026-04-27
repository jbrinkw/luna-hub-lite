"""Unit tests for :mod:`server.cloud.lot_snapshot_poller`.

Mocks the HTTP layer via ``fetch_snapshot_fn`` injection and asserts
that the Pi's SQLite ``cloud_lots`` table converges on the cloud
response per tick. Matches the structure of
``test_product_sync_poller.py`` and ``test_event_overrides_poller.py``
so the test suite stays readable side-by-side.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add the live-shelf dir to sys.path so ``from server.*`` resolves
# regardless of how pytest is invoked (direct file, package mode, harness).
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.lot_snapshot_poller import LotSnapshotPoller  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory SQLite with the full Pi schema applied."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


def _lot(
    lot_id: str,
    *,
    product_id: str = "prod-1",
    qty: float = 1.0,
    location_id: str | None = "loc-1",
    expires_on: str | None = None,
    in_flight_since: str | None = None,
    pickup_event_id: str | None = None,
    updated_at: str = "2026-04-22T12:00:00Z",
    deleted_at: str | None = None,
) -> dict:
    """Construct a cloud-shaped lot dict matching the endpoint projection."""
    return {
        "lot_id": lot_id,
        "product_id": product_id,
        "location_id": location_id,
        "qty_containers": qty,
        "expires_on": expires_on,
        "in_flight_since": in_flight_since,
        "pickup_event_id": pickup_event_id,
        "updated_at": updated_at,
        "deleted_at": deleted_at,
    }


def _payload(*lots: dict) -> dict:
    return {"lots": list(lots)}


def _read_cloud_lot(conn: sqlite3.Connection, lot_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM cloud_lots WHERE lot_id = ?",
        (lot_id,),
    ).fetchone()
    return dict(row) if row is not None else None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_first_tick_sends_none_and_persists_watermark(conn, tmp_path):
    """Fresh state file → first tick sends updated_since=None, inserts
    every row, and writes the high-watermark from max(updated_at)."""
    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_payload(
            _lot("lot-a", qty=2.0, updated_at="2026-04-22T10:00:00Z"),
            _lot("lot-b", qty=0.5, updated_at="2026-04-22T12:30:00Z"),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path,
        fetch_snapshot_fn=fake_fetch,
    )

    count = poller.tick_once()

    assert count == 2
    fake_fetch.assert_called_once_with(client, updated_since=None)

    # Both rows land.
    a = _read_cloud_lot(conn, "lot-a")
    b = _read_cloud_lot(conn, "lot-b")
    assert a is not None and a["qty_containers"] == pytest.approx(2.0)
    assert b is not None and b["qty_containers"] == pytest.approx(0.5)

    # Watermark advanced to max(updated_at) across the payload.
    assert poller.high_watermark == "2026-04-22T12:30:00Z"
    assert state_path.exists()
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-22T12:30:00Z"


def test_second_tick_uses_cached_watermark(conn, tmp_path):
    """A pre-existing state file seeds the watermark; the next tick
    sends it to cloud and advances only on newer rows."""
    state_path = tmp_path / "last_lot_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-22T10:00:00Z"})
    )
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_payload(
            _lot("lot-new", qty=3.0, updated_at="2026-04-22T14:00:00Z"),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )

    assert poller.high_watermark == "2026-04-22T10:00:00Z"
    count = poller.tick_once()
    assert count == 1
    fake_fetch.assert_called_once_with(
        client, updated_since="2026-04-22T10:00:00Z",
    )
    assert poller.high_watermark == "2026-04-22T14:00:00Z"
    row = _read_cloud_lot(conn, "lot-new")
    assert row is not None and row["qty_containers"] == pytest.approx(3.0)


def test_cloud_wins_on_conflict_updates_existing_row(conn, tmp_path):
    """A second tick returning the same lot_id with different values
    overwrites every column (cloud-wins)."""
    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    # Tick 1 seeds the row.
    fake_fetch = MagicMock(
        return_value=_payload(
            _lot(
                "lot-x", qty=1.0, location_id="loc-a",
                updated_at="2026-04-22T10:00:00Z",
            ),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    poller.tick_once()
    original = _read_cloud_lot(conn, "lot-x")
    assert original is not None
    assert original["location_id"] == "loc-a"
    assert original["qty_containers"] == pytest.approx(1.0)

    # Tick 2: cloud mutates qty + location + flags as in-flight.
    fake_fetch.return_value = _payload(
        _lot(
            "lot-x",
            qty=0.0,
            location_id="loc-b",
            in_flight_since="2026-04-22T11:00:00Z",
            pickup_event_id="evt-99",
            updated_at="2026-04-22T11:00:00Z",
        ),
    )
    poller.tick_once()

    updated = _read_cloud_lot(conn, "lot-x")
    assert updated is not None
    assert updated["qty_containers"] == pytest.approx(0.0)
    assert updated["location_id"] == "loc-b"
    assert updated["in_flight_since"] == "2026-04-22T11:00:00Z"
    assert updated["pickup_event_id"] == "evt-99"
    assert updated["updated_at"] == "2026-04-22T11:00:00Z"


def test_tombstone_deletes_local_row(conn, tmp_path):
    """A row arriving with deleted_at set DELETEs the matching Pi row.

    Matches product_sync's soft-delete semantics at the mirror layer:
    the cloud retains the audit trail; the Pi's mirror only needs the
    current state, so a tombstone locally = row gone.
    """
    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    # Tick 1: seed row.
    fake_fetch = MagicMock(
        return_value=_payload(
            _lot("lot-doomed", qty=1.0, updated_at="2026-04-22T10:00:00Z"),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    poller.tick_once()
    assert _read_cloud_lot(conn, "lot-doomed") is not None

    # Tick 2: cloud soft-deletes the row.
    fake_fetch.return_value = _payload(
        _lot(
            "lot-doomed",
            qty=0.0,
            updated_at="2026-04-22T11:00:00Z",
            deleted_at="2026-04-22T11:00:00Z",
        ),
    )
    count = poller.tick_once()
    assert count == 1  # one DELETE applied
    assert _read_cloud_lot(conn, "lot-doomed") is None
    # Watermark still advances past the tombstone so we don't re-fetch.
    assert poller.high_watermark == "2026-04-22T11:00:00Z"


def test_pi_only_row_survives_when_cloud_does_not_return_it(conn, tmp_path):
    """Pi row with no matching cloud entry is left alone (outbox-drain case).

    The poller's delta window doesn't include rows untouched since the
    watermark; we must NOT treat their absence as a deletion signal.
    """
    state_path = tmp_path / "last_lot_sync.json"
    # Manually seed a Pi-only row.
    conn.execute(
        "INSERT INTO cloud_lots ("
        "   lot_id, product_id, qty_containers, updated_at"
        ") VALUES (?, ?, ?, ?)",
        ("pi-only", "prod-z", 7.0, "2026-04-22T09:00:00Z"),
    )
    conn.commit()

    client = MagicMock()
    fake_fetch = MagicMock(return_value=_payload())  # empty delta
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 0

    surviving = _read_cloud_lot(conn, "pi-only")
    assert surviving is not None
    assert surviving["qty_containers"] == pytest.approx(7.0)


def test_cloud_error_leaves_state_and_rows_untouched(conn, tmp_path):
    """A CloudError on fetch must not advance the watermark, insert
    anything, or crash the thread. Backoff advances."""
    state_path = tmp_path / "last_lot_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-22T09:00:00Z"})
    )
    original_mtime = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(side_effect=CloudError(502, "upstream timeout"))
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 0
    assert poller.high_watermark == "2026-04-22T09:00:00Z"
    assert state_path.stat().st_mtime_ns == original_mtime
    # No rows written.
    assert conn.execute("SELECT COUNT(*) FROM cloud_lots").fetchone()[0] == 0
    # Backoff advanced off initial.
    first = poller._next_backoff()  # noqa: SLF001
    second = poller._next_backoff()  # noqa: SLF001
    assert second >= first


def test_empty_delta_does_not_rewrite_state_file(conn, tmp_path):
    """A tick returning zero rows must not rewrite the state file."""
    state_path = tmp_path / "last_lot_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-22T08:00:00Z"})
    )
    before = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(return_value=_payload())
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 0
    assert state_path.stat().st_mtime_ns == before
    assert poller.high_watermark == "2026-04-22T08:00:00Z"


def test_malformed_row_skipped_without_poisoning_batch(conn, tmp_path):
    """A row missing lot_id is skipped; valid rows in the same batch
    still land and the watermark advances to the valid row's updated_at."""
    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_payload(
            {"product_id": "prod-x", "updated_at": "2026-04-22T12:00:00Z"},
            _lot("good", qty=5.0, updated_at="2026-04-22T13:00:00Z"),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    count = poller.tick_once()
    assert count == 1

    good = _read_cloud_lot(conn, "good")
    assert good is not None
    # Watermark = max(updated_at) across rows the poller SAW (including
    # the malformed one, whose timestamp was valid). Both are > None so
    # either could win; the higher one does.
    assert poller.high_watermark == "2026-04-22T13:00:00Z"


def test_non_dict_payload_does_not_advance_watermark(conn, tmp_path):
    """If the cloud returns a non-object (list, string, etc.) we log
    and skip — watermark must not advance, rows must not be touched."""
    state_path = tmp_path / "last_lot_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-22T07:00:00Z"})
    )

    client = MagicMock()
    fake_fetch = MagicMock(return_value=["not", "a", "dict"])
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    count = poller.tick_once()
    assert count == 0
    assert poller.high_watermark == "2026-04-22T07:00:00Z"


def test_unreadable_state_file_degrades_to_full_resync(conn, tmp_path):
    """A corrupt state file must not crash the poller — falls back to
    updated_since=None and rewrites the file on next success."""
    state_path = tmp_path / "last_lot_sync.json"
    state_path.write_text("{not valid json")

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_payload(
            _lot("ok", qty=1.0, updated_at="2026-04-22T15:00:00Z"),
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    count = poller.tick_once()
    assert count == 1
    fake_fetch.assert_called_once_with(client, updated_since=None)
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-22T15:00:00Z"


def test_settings_cache_refreshed_each_tick(conn, tmp_path):
    """When wired with a settings_cache, the poller fetches /settings on
    every tick and updates the cache. Failures on /settings must NOT
    affect the lot-snapshot return value or watermark."""
    from server.cloud.settings_cache import (
        ClassifierSettings,
        ClassifierSettingsCache,
    )

    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    fake_fetch_lots = MagicMock(return_value=_payload())  # empty lots
    cache = ClassifierSettingsCache()
    # First tick: cloud returns fallback_enabled=true.
    fake_fetch_settings = MagicMock(
        return_value={"chefbyte_classifier_fallback_enabled": True}
    )
    poller = LotSnapshotPoller(
        client,
        conn,
        state_path=state_path,
        fetch_snapshot_fn=fake_fetch_lots,
        settings_cache=cache,
        fetch_settings_fn=fake_fetch_settings,
    )
    poller.tick_once()
    assert fake_fetch_settings.call_count == 1
    assert cache.get() == ClassifierSettings(
        chefbyte_classifier_fallback_enabled=True
    )

    # Second tick: cloud returns false → cache flips back.
    fake_fetch_settings.return_value = {"chefbyte_classifier_fallback_enabled": False}
    poller.tick_once()
    assert cache.get().chefbyte_classifier_fallback_enabled is False

    # Third tick: cloud /settings raises → cache keeps last good value.
    fake_fetch_settings.side_effect = CloudError(500, "boom")
    poller.tick_once()
    assert cache.get().chefbyte_classifier_fallback_enabled is False  # last good


def test_apply_one_handles_non_numeric_qty_as_zero(conn, tmp_path):
    """If cloud sends a non-numeric qty_containers (shouldn't happen in
    practice, but NUMERIC → JSON conversion can misbehave), fall back
    to 0 rather than raising. Better a wrong zero than a crashed poller."""
    state_path = tmp_path / "last_lot_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_payload(
            {
                "lot_id": "lot-weird",
                "product_id": "prod-1",
                "qty_containers": "not-a-number",
                "updated_at": "2026-04-22T10:00:00Z",
                "deleted_at": None,
            }
        )
    )
    poller = LotSnapshotPoller(
        client, conn, state_path=state_path, fetch_snapshot_fn=fake_fetch,
    )
    count = poller.tick_once()
    assert count == 1
    row = _read_cloud_lot(conn, "lot-weird")
    assert row is not None
    assert row["qty_containers"] == pytest.approx(0.0)
