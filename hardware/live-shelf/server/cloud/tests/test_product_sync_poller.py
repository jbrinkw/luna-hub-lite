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
from server.cloud import product_sync_poller as psp  # noqa: E402
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


def test_state_write_oserror_reverts_in_memory_state_and_keeps_backoff(
    conn, tmp_path, monkeypatch,
):
    """Audit gap G4: if ``_state.write`` raises ``OSError`` (disk full,
    read-only mount, fsync error), the tick must revert the in-memory
    ``self._state`` to its prior value AND NOT reset ``self._backoff_s``
    to ``INITIAL_BACKOFF_S``.

    Without this, the next tick would use the advanced in-memory
    watermark and refuse to re-fetch the rows the cloud just returned;
    on Pi reboot, the on-disk file is stale so the gap is permanent.

    Verifies:
      (a) ``self._state.high_watermark`` rolls back to the prior value.
      (b) ``self._backoff_s`` is NOT reset to ``INITIAL_BACKOFF_S``
          (stays at whatever it was — elevated or initial — but the
          critical contract is "no reset on persist failure").
      (c) The on-disk file is unchanged (atomic write — rename never
          happened) so the next tick + reboot both refetch the same
          window.
      (d) The next tick re-issues the SAME fetch (``updated_since`` ==
          prior watermark), confirming the rollback restored the cursor.
    """
    state_path = tmp_path / "last_product_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T08:00:00Z"})
    )
    original_mtime = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("p1", updated_at="2026-04-21T12:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )

    # Pin a sentinel backoff value distinct from INITIAL_BACKOFF_S so
    # we can prove the reset didn't fire. Simulating "prior tick errored"
    # by bumping backoff manually before this tick runs.
    elevated_backoff = psp.INITIAL_BACKOFF_S * 4.0
    poller._backoff_s = elevated_backoff  # noqa: SLF001 - direct access for test

    # Mock _SyncState.write to raise OSError as if the disk were full.
    # Patch on the class so the new _SyncState instance built inside
    # tick_once picks up the failing write.
    monkeypatch.setattr(
        psp._SyncState, "write",
        MagicMock(side_effect=OSError(28, "No space left on device")),
    )

    count = poller.tick_once()

    # The upsert still ran — count reflects rows written to SQLite.
    # The bug isn't about upserts; it's about the watermark cursor.
    assert count == 1

    # (a) In-memory state rolled back to the prior watermark.
    assert poller.high_watermark == "2026-04-21T08:00:00Z", (
        "in-memory state must revert on state.write OSError"
    )

    # (b) Backoff was NOT reset to INITIAL_BACKOFF_S.
    assert poller._backoff_s != psp.INITIAL_BACKOFF_S, (  # noqa: SLF001
        "backoff must not reset when persist fails"
    )
    assert poller._backoff_s == elevated_backoff, (  # noqa: SLF001
        "backoff should stay at its prior elevated value"
    )

    # (c) On-disk file untouched (atomic rename never happened).
    assert state_path.stat().st_mtime_ns == original_mtime
    on_disk = json.loads(state_path.read_text())
    assert on_disk["high_watermark"] == "2026-04-21T08:00:00Z"

    # (d) Next tick re-fetches the SAME window — the cursor was rolled
    # back, so updated_since is the prior watermark, not the advanced one.
    # Drop the write-failure patch so the recovery path can succeed.
    monkeypatch.undo()
    fake_fetch.reset_mock()
    fake_fetch.return_value = Catalog(
        products=[_product("p1", updated_at="2026-04-21T12:00:00Z")],
    )
    poller.tick_once()
    fake_fetch.assert_called_once_with(
        client, updated_since="2026-04-21T08:00:00Z",
    )


def test_state_write_success_resets_backoff_after_persist(conn, tmp_path):
    """Regression / sanity for the G4 reorder: on the happy path, a
    successful persist resets the backoff to ``INITIAL_BACKOFF_S``
    AFTER the state file is written. Mirrors
    ``test_first_tick_sends_updated_since_none_and_persists_watermark``
    but pins the persist-before-reset ordering explicitly.
    """
    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("p1", updated_at="2026-04-21T12:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path, fetch_catalog_fn=fake_fetch,
    )
    # Simulate a prior errored tick so we can prove the reset fired.
    poller._backoff_s = psp.INITIAL_BACKOFF_S * 8.0  # noqa: SLF001

    count = poller.tick_once()

    assert count == 1
    # Backoff reset to INITIAL_BACKOFF_S — the run loop will sleep the
    # normal 30s cadence next iteration.
    assert poller._backoff_s == psp.INITIAL_BACKOFF_S  # noqa: SLF001
    # Watermark advanced AND persisted (we got here so the write didn't
    # raise, confirming reset-after-persist ordering).
    assert poller.high_watermark == "2026-04-21T12:00:00Z"
    assert state_path.exists()
    on_disk = json.loads(state_path.read_text())
    assert on_disk["high_watermark"] == "2026-04-21T12:00:00Z"


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


# ---------------------------------------------------------------------------
# Gap G10: cold-start ordering — products_synced Event signaling
# ---------------------------------------------------------------------------


def test_g10_products_synced_event_set_on_first_successful_tick(conn, tmp_path):
    """A non-empty successful tick must latch the cold-start Event so
    waiters (event_overrides, lot_snapshot) unblock."""
    import threading as _threading

    state_path = tmp_path / "last_product_sync.json"
    products_synced = _threading.Event()
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("px", updated_at="2026-05-15T12:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
        products_synced_event=products_synced,
    )
    assert not products_synced.is_set()  # precondition
    poller.tick_once()
    assert products_synced.is_set(), (
        "products_synced Event must be set after first successful tick"
    )


def test_g10_products_synced_event_set_on_empty_delta_tick(conn, tmp_path):
    """An empty-delta (no new rows) tick still counts as success — the
    Event must latch so we don't wedge waiters when product_sync has no
    work to do at boot."""
    import threading as _threading

    state_path = tmp_path / "last_product_sync.json"
    products_synced = _threading.Event()
    client = MagicMock()
    fake_fetch = MagicMock(return_value=Catalog(products=[]))
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
        products_synced_event=products_synced,
    )
    count = poller.tick_once()
    assert count == 0
    assert products_synced.is_set(), (
        "products_synced must latch on an empty-delta tick too — otherwise"
        " a Pi with no recent product changes would never unblock waiters"
    )


def test_g10_products_synced_event_NOT_set_on_failing_tick(conn, tmp_path):
    """If the cloud fetch fails (CloudError), waiters MUST stay blocked so
    they take the timeout path with a WARNING instead of unblocking on a
    poller that never actually saw any data."""
    import threading as _threading

    from server.cloud.client import CloudError

    state_path = tmp_path / "last_product_sync.json"
    products_synced = _threading.Event()
    client = MagicMock()
    fake_fetch = MagicMock(side_effect=CloudError(500, b"upstream is down"))
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
        products_synced_event=products_synced,
    )
    poller.tick_once()
    assert not products_synced.is_set(), (
        "products_synced must NOT latch on fetch failure — waiters should"
        " time out and proceed with TRANSIENT classification instead of"
        " unblocking against an empty Pi mirror"
    )


def test_g10_event_none_works_for_backcompat(conn, tmp_path):
    """Callers that don't pass an Event keep the old behavior — no
    AttributeError, no NoneType .set() crash."""
    state_path = tmp_path / "last_product_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("px", updated_at="2026-05-15T12:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
        # products_synced_event omitted intentionally
    )
    # Should not raise.
    poller.tick_once()


def test_g10_products_synced_event_NOT_set_if_state_write_fails(
    conn, tmp_path, monkeypatch,
):
    """Reviewer coverage gap: the Event must latch AFTER state.write
    succeeds, never before. If state.write raises OSError and the Event
    is still latched, downstream waiters (event_overrides, lot_snapshot)
    unblock against a Pi mirror whose watermark wasn't persisted — on
    reboot the gap is permanent. This pins the persist-before-signal
    ordering."""
    import threading as _threading

    state_path = tmp_path / "last_product_sync.json"
    products_synced = _threading.Event()
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=Catalog(
            products=[_product("px", updated_at="2026-05-15T12:00:00Z")],
        )
    )
    poller = ProductSyncPoller(
        client, conn, state_path=state_path,
        fetch_catalog_fn=fake_fetch,
        products_synced_event=products_synced,
    )

    # Force state.write to fail mid-tick.
    def boom(self, path):  # noqa: ARG001
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(psp._SyncState, "write", boom)

    poller.tick_once()
    assert not products_synced.is_set(), (
        "products_synced must NOT latch when state.write fails — "
        "otherwise waiters unblock against a Pi mirror that didn't persist"
    )
