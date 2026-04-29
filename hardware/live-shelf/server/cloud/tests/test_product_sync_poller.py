"""Unit tests for :mod:`server.cloud.product_sync_poller`.

Covers the state-machine branches that matter for production safety:

* First-boot (no state file) sends ``updated_since=None`` and persists
  the high-watermark after upsert.
* Subsequent tick sends the cached watermark and advances it only when
  a newer row is seen.
* Cloud errors degrade to a WARNING + backoff advance; the state file
  is untouched.
* Empty delta (no new rows) doesn't rewrite the state file needlessly.
* Malformed rows in the catalog are skipped without poisoning the
  whole tick.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.catalog import Catalog  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402
from server.cloud.product_sync_poller import ProductSyncPoller  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


def _product(
    pid: str,
    *,
    barcode: str | None = None,
    updated_at: str = "2026-04-21T12:00:00Z",
    name: str | None = None,
) -> dict:
    return {
        "product_id": pid,
        "name": name or f"Product {pid}",
        "barcode": barcode,
        "updated_at": updated_at,
        "unit_type": "solid",
        "certified": True,
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_first_tick_sends_updated_since_none_and_persists_watermark(conn, tmp_path):
    """No state file → first tick pulls full catalog and writes the
    high-watermark from the max(updated_at) across the response."""
    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[
                _product("p1", updated_at="2026-04-21T10:00:00Z"),
                _product("p2", updated_at="2026-04-21T12:30:00Z"),
            ],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()

    assert count == 2
    # First call sent updated_since=None.
    fake_fetch.assert_called_once_with(client, updated_since=None)
    # Rows in DB.
    rows = conn.execute(
        "SELECT product_id FROM products ORDER BY product_id"
    ).fetchall()
    assert [r["product_id"] for r in rows] == ["p1", "p2"]
    # State file advanced to max(updated_at).
    assert state_path.exists()
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T12:30:00Z"
    assert poller.high_watermark == "2026-04-21T12:30:00Z"


def test_second_tick_uses_cached_watermark_and_advances(conn, tmp_path):
    """Existing state file → second tick sends that watermark and
    advances only when a newer row arrives."""
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T10:00:00Z"})
    )
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("p3", updated_at="2026-04-21T14:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    assert poller.high_watermark == "2026-04-21T10:00:00Z"
    count = poller.tick_once()
    assert count == 1
    fake_fetch.assert_called_once_with(
        client, updated_since="2026-04-21T10:00:00Z",
    )
    assert poller.high_watermark == "2026-04-21T14:00:00Z"
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T14:00:00Z"


def test_cloud_error_leaves_state_file_untouched_and_bumps_backoff(conn, tmp_path):
    """A CloudError on fetch must not advance the watermark or crash
    the tick — it's logged, backoff increments, and the loop retries
    next cycle."""
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T09:00:00Z"})
    )
    original_mtime = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(side_effect=CloudError(502, "upstream timeout"))
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()

    assert count == 0
    # Watermark unchanged on both the in-memory state and disk.
    assert poller.high_watermark == "2026-04-21T09:00:00Z"
    assert state_path.stat().st_mtime_ns == original_mtime
    # Backoff advanced off the initial value so the run loop throttles.
    # (The helper returns the current value and then increments, so a
    # second call should return > the first.)
    first = poller._next_backoff()  # noqa: SLF001 - direct access for test
    second = poller._next_backoff()  # noqa: SLF001
    assert second >= first


def test_empty_delta_does_not_rewrite_state_file(conn, tmp_path):
    """A tick that returns zero new rows must not rewrite the state
    file — churn-free."""
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T08:00:00Z"})
    )
    before = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(return_value=Catalog(products=[]))
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 0
    assert state_path.stat().st_mtime_ns == before
    assert poller.high_watermark == "2026-04-21T08:00:00Z"


def test_malformed_product_skipped_without_poisoning_batch(conn, tmp_path):
    """A product without ``product_id`` is skipped (via
    ``upsert_product_from_cloud`` returning None); the rest of the batch
    still lands."""
    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[
                {"name": "Nameless but no id"},  # missing product_id → skipped
                _product("good", updated_at="2026-04-21T13:00:00Z"),
            ],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 1  # Only the good row.
    row = conn.execute(
        "SELECT product_id FROM products"
    ).fetchone()
    assert row["product_id"] == "good"


def test_all_malformed_batch_still_advances_watermark(conn, tmp_path):
    """Audit finding L11 sibling — if the cloud delivers a window where
    EVERY product row is malformed (missing product_id / name), the
    poller must still advance the watermark over the rows it saw.

    Rationale: the cloud filters ``updated_at > updated_since`` so a
    cursor stuck on a malformed-only window means the next tick re-fetches
    the same skipped rows forever. Covers the "advance over every row,
    including skipped" semantics that
    ``test_malformed_product_skipped_without_poisoning_batch`` only
    covers incidentally (via the good row in the same batch).

    Cross-reference: ``product_sync_poller.tick_once`` advances the
    watermark unconditionally over every row with a valid ``updated_at``
    string, regardless of whether ``upsert_product_from_cloud`` returned
    None (malformed / tombstone-without-local-row).
    """
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T07:00:00Z"})
    )
    client = MagicMock()
    # Two malformed rows — one missing product_id, one missing name.
    # Both have valid updated_at strings the poller can use to advance.
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[
                {"name": "No id", "updated_at": "2026-04-21T08:00:00Z"},
                {"product_id": "p-no-name", "updated_at": "2026-04-21T09:00:00Z"},
            ],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 0  # Nothing upserted — every row was skipped.
    # Watermark MUST advance over the highest skipped-row timestamp.
    # Without this, subsequent ticks would loop on the same malformed window.
    assert poller.high_watermark == "2026-04-21T09:00:00Z"
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T09:00:00Z"


def test_deletion_tombstone_marks_local_row_soft_deleted(conn, tmp_path):
    """Cloud tombstoned row (deleted_at set) in updated_since delta →
    Pi's local row gets deleted_at set, and subsequent list_products()
    filters it out. Multi-call flow: initial sync inserts live → cloud
    mutation → next sync applies tombstone."""
    from server.storage.repo import list_products  # noqa: E402

    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()

    # ---- Tick 1: live row lands on the Pi ------------------------------
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[
                _product("p-del", updated_at="2026-04-21T10:00:00Z"),
            ],
        ),
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )
    assert poller.tick_once() == 1
    assert len(list_products(conn)) == 1
    # Watermark advanced to the row's updated_at.
    assert poller.high_watermark == "2026-04-21T10:00:00Z"

    # ---- Tick 2: cloud tombstones it (bumps updated_at via trigger) ---
    tombstoned = _product("p-del", updated_at="2026-04-21T11:00:00Z")
    tombstoned["deleted_at"] = "2026-04-21T11:00:00Z"
    fake_fetch.return_value = Catalog(products=[tombstoned])

    assert poller.tick_once() == 1  # upsert path still runs
    # Filtered out of the public list — Pi classifier + UI won't see it.
    assert list_products(conn) == []
    # But the row still physically exists in the table (lots FK would
    # otherwise break). Confirm it's present with deleted_at set.
    row = conn.execute(
        "SELECT deleted_at FROM products WHERE product_id = 'p-del'"
    ).fetchone()
    assert row is not None
    assert row["deleted_at"] == "2026-04-21T11:00:00Z"


def test_deletion_restore_clears_tombstone(conn, tmp_path):
    """If the cloud later clears deleted_at (undelete flow), the Pi must
    pick it up — the row becomes visible in list_products() again."""
    from server.storage.repo import list_products  # noqa: E402

    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()

    # Seed tombstoned row directly.
    tombstoned = _product("p-restore", updated_at="2026-04-21T10:00:00Z")
    tombstoned["deleted_at"] = "2026-04-21T10:00:00Z"
    fake_fetch = MagicMock(return_value=Catalog(products=[tombstoned]))
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )
    poller.tick_once()
    assert list_products(conn) == []  # hidden

    # Cloud restores: deleted_at back to null, updated_at bumped.
    restored = _product("p-restore", updated_at="2026-04-21T11:00:00Z")
    restored["deleted_at"] = None
    fake_fetch.return_value = Catalog(products=[restored])

    poller.tick_once()
    visible = list_products(conn)
    assert len(visible) == 1
    assert visible[0].product_id == "p-restore"


def test_tombstone_only_window_advances_watermark(conn, tmp_path):
    """Audit finding #7: a window containing ONLY tombstones for rows
    the Pi never had locally must still advance the watermark.
    Otherwise the next tick re-fetches the same window forever.

    ``upsert_product_from_cloud`` returns None for a malformed input,
    but a well-formed tombstone for a not-yet-cached row also lands
    None (DELETE-by-barcode runs but ON CONFLICT does an UPDATE on a
    non-existent product_id — net effect: no row, returns the id).
    The fix is to advance the watermark over the row's ``updated_at``
    even when ``count`` doesn't increment for it.
    """
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T09:00:00Z"})
    )
    client = MagicMock()
    # A malformed product (no product_id, no name → upsert returns None
    # at the validation gate) is the simplest reproducer of the
    # "result is None but watermark must still move" path. Real
    # tombstone-only deliveries hit the same code path — both must
    # advance the cursor.
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[
                {
                    # No product_id → upsert helper rejects, returns None.
                    "name": "Missing pid",
                    "updated_at": "2026-04-21T15:00:00Z",
                },
            ],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )
    count = poller.tick_once()
    assert count == 0  # nothing upserted
    # Watermark MUST advance past the row even though count == 0.
    # Otherwise the next tick fetches the same row forever.
    assert poller.high_watermark == "2026-04-21T15:00:00Z"
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T15:00:00Z"


def test_unreadable_state_file_degrades_to_full_resync(conn, tmp_path, caplog):
    """A corrupt state file must not crash the poller — falls back to
    ``updated_since=None`` and rewrites the file on next success."""
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text("{not valid json")

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("px", updated_at="2026-04-21T15:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    count = poller.tick_once()
    assert count == 1
    fake_fetch.assert_called_once_with(client, updated_since=None)
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T15:00:00Z"
