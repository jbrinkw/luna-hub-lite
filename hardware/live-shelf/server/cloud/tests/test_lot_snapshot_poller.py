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
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.lot_snapshot_poller import (  # noqa: E402
    INITIAL_BACKOFF_S,
    LotSnapshotPoller,
    _SyncState,
)
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

    # Malformed rows return False from _apply_one (they never RAISE), so
    # they're treated as permanent defects whose updated_at still advances
    # the watermark — re-fetching them forever would be pure waste. (This
    # is the deliberate counterpart to C2-01, where a row that RAISES
    # sqlite3.Error instead holds the watermark back for retry.)
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


# ---------------------------------------------------------------------------
# Audit gap G2 — cloud catch-all reaper clears in_flight on a live row
# (NOT a tombstone), Pi `lots.status='in_flight'` must flip to 'out'.
# ---------------------------------------------------------------------------


def _seed_inflight_pi_and_cloud(
    conn: sqlite3.Connection,
    *,
    cloud_lot_id: str,
    product_id: str = "prod-A",
    pickup_event_id: str | None = None,
    prior_in_flight_since: str = "2026-04-20T10:00:00Z",
) -> tuple[str, str]:
    """Helper: seed a Pi `lots` row in 'in_flight' + matching cloud_lots row.

    Returns ``(pi_lot_id, pickup_event_id)`` for downstream assertions.
    """
    conn.execute(
        "INSERT OR IGNORE INTO products (product_id, name, net_weight_g) "
        "VALUES (?, ?, ?)",
        (product_id, "Test Product", 100.0),
    )
    pi_lot_id = str(uuid.uuid4())
    pe_id = pickup_event_id or str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, "
        "                  pickup_event_id) "
        "VALUES (?, ?, 'in_flight', datetime('now'), ?)",
        (pi_lot_id, product_id, pe_id),
    )
    conn.execute(
        """
        INSERT INTO cloud_lots (lot_id, product_id, qty_containers,
                                in_flight_since, in_flight_kind,
                                pickup_event_id, updated_at)
        VALUES (?, ?, 1.0, ?, 'catch_all', ?, ?)
        """,
        (cloud_lot_id, product_id, prior_in_flight_since, pe_id,
         prior_in_flight_since),
    )
    conn.commit()
    return pi_lot_id, pe_id


def test_g2_inflight_clear_flips_pi_lot_to_out(conn, tmp_path):
    """Cloud reaper clears in_flight_since on a live (non-tombstoned) cloud lot.

    The Pi `lots` row that maps to this cloud lot via pickup_event_id is
    currently 'in_flight'. After processing the inbound update, that Pi
    row must flip to status='out' with in_flight_since=NULL and
    pickup_event_id=NULL. The cloud_lots mirror must reflect the cleared
    markers too (in_flight_since IS NULL on the upserted row).
    """
    cloud_lot_id = "cloud-lot-reaped"
    pi_lot_id, _pe_id = _seed_inflight_pi_and_cloud(
        conn, cloud_lot_id=cloud_lot_id,
        prior_in_flight_since="2026-04-20T10:00:00Z",
    )

    # Inbound update: in_flight_since cleared, deleted_at NULL (NOT a
    # tombstone), updated_at bumped (the reaper signature).
    reaped = _lot(
        cloud_lot_id,
        updated_at="2026-04-28T06:00:00Z",
        deleted_at=None,
    )
    # _lot already sets in_flight_since=None and in_flight_kind=None and
    # pickup_event_id=None — exactly what the reaper writes.
    assert reaped["in_flight_since"] is None
    assert reaped["pickup_event_id"] is None

    fetch = MagicMock(return_value=_payload(reaped))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    applied = p.tick_once()

    assert applied == 1
    pi_row = conn.execute(
        "SELECT status, in_flight_since, pickup_event_id "
        "  FROM lots WHERE lot_id = ?",
        (pi_lot_id,),
    ).fetchone()
    assert pi_row is not None
    # Note: NOT 'lost' — the reaper didn't decide the lot was consumed;
    # 'out' means cleanly resolved off-shelf.
    assert pi_row["status"] == "out"
    assert pi_row["in_flight_since"] is None
    assert pi_row["pickup_event_id"] is None

    # And the cloud_lots mirror reflects the cleared markers.
    cl_row = conn.execute(
        "SELECT in_flight_since FROM cloud_lots WHERE lot_id = ?",
        (cloud_lot_id,),
    ).fetchone()
    assert cl_row is not None
    assert cl_row["in_flight_since"] is None


def test_g2_inflight_clear_no_matching_pi_row_still_upserts(conn, tmp_path):
    """Reaper signature with no matching Pi `lots` row: no exception,
    cloud_lots mirror still updates."""
    cloud_lot_id = "cloud-lot-no-pi"
    # Seed only the cloud_lots row — no corresponding Pi `lots` row.
    conn.execute(
        """
        INSERT INTO cloud_lots (lot_id, product_id, qty_containers,
                                in_flight_since, in_flight_kind,
                                pickup_event_id, updated_at)
        VALUES (?, 'prod-orphan', 1.0, '2026-04-20T10:00:00Z',
                'catch_all', 'pe-orphan', '2026-04-20T10:00:00Z')
        """,
        (cloud_lot_id,),
    )
    conn.commit()

    reaped = _lot(
        cloud_lot_id,
        product_id="prod-orphan",
        updated_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(reaped))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    # Must not raise.
    applied = p.tick_once()

    assert applied == 1
    cl_row = conn.execute(
        "SELECT in_flight_since, updated_at FROM cloud_lots WHERE lot_id = ?",
        (cloud_lot_id,),
    ).fetchone()
    assert cl_row is not None
    assert cl_row["in_flight_since"] is None
    assert cl_row["updated_at"] == "2026-04-28T06:00:00Z"

    # Pi `lots` row count for the orphan product must remain ZERO — the
    # in_flight-clear handler must NOT mint a phantom Pi lot when no
    # matching row exists. (Reviewer coverage gap: original test only
    # asserted "no exception"; this pins the negative observation.)
    pi_count = conn.execute(
        "SELECT COUNT(*) AS n FROM lots WHERE product_id = 'prod-orphan'",
    ).fetchone()["n"]
    assert pi_count == 0, (
        f"orphan-cloud-lot path minted {pi_count} Pi lots — should be 0"
    )


def test_g2_only_triggers_on_actual_transition_not_first_insert(conn, tmp_path):
    """Sanity: a brand-new cloud lot with in_flight_since=NULL must NOT
    trigger the flip path — there's no prior in_flight state to clear.

    If the detection code had a bug where it fired on EVERY row with
    in_flight_since=NULL (rather than only on the transition from
    not-NULL → NULL), it would falsely flip any existing in_flight Pi
    lot that happened to share a product_id with this new cloud row.
    """
    # Seed a Pi in_flight lot for prod-A (no matching cloud_lots row
    # yet — first time we see this product from cloud).
    conn.execute(
        "INSERT OR IGNORE INTO products (product_id, name, net_weight_g) "
        "VALUES (?, ?, ?)",
        ("prod-A", "Test Product", 100.0),
    )
    pi_lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, "
        "                  pickup_event_id) "
        "VALUES (?, 'prod-A', 'in_flight', datetime('now'), 'pe-existing')",
        (pi_lot_id,),
    )
    conn.commit()

    # A brand-new cloud lot for the same product — in_flight_since=NULL
    # from the start (not a clear-transition; just a new live row).
    fresh = _lot("cloud-fresh", product_id="prod-A",
                 updated_at="2026-04-28T06:00:00Z")
    fetch = MagicMock(return_value=_payload(fresh))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    # Pi lot must NOT have been flipped — no transition occurred.
    pi_row = conn.execute(
        "SELECT status FROM lots WHERE lot_id = ?", (pi_lot_id,),
    ).fetchone()
    assert pi_row["status"] == "in_flight"


def test_g2_tombstone_path_still_flags_lost(conn, tmp_path):
    """Regression: the refactor that extracted the Pi-lot lookup helper
    must not have broken the tombstone-flags-lost behavior."""
    cloud_lot_id = "cloud-lot-tomb"
    pi_lot_id, _pe_id = _seed_inflight_pi_and_cloud(
        conn, cloud_lot_id=cloud_lot_id,
    )

    dead = _lot(
        cloud_lot_id,
        updated_at="2026-04-28T06:00:00Z",
        deleted_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    pi_row = conn.execute(
        "SELECT status, in_flight_since, pickup_event_id "
        "FROM lots WHERE lot_id = ?",
        (pi_lot_id,),
    ).fetchone()
    # Tombstone path still uses 'lost' (not 'out') — that's the
    # cloud-deleted-the-lot signal vs reaper-resolved-it.
    assert pi_row["status"] == "lost"
    # Lots CHECK invariant: (status='in_flight') == (in_flight_since IS NOT NULL).
    # Flipping status away from 'in_flight' MUST also clear the marker —
    # otherwise the row violates its own constraint. (Reviewer coverage
    # gap: original test only asserted status, not the markers.)
    assert pi_row["in_flight_since"] is None
    assert pi_row["pickup_event_id"] is None


# ---------------------------------------------------------------------------
# T1 cloud-tombstone → REVIVE resurrection (deep audit 2026-06-03).
#
# The cloud-side T1 fix (migration 20260515030000) revives a tombstoned
# stock_lots row IN PLACE: same lot_id, deleted_at flips set → NULL, qty>0.
# A merge writer (import_shopping), or the live_scale claim, can do this to a
# lot the Pi already saw tombstoned. The Pi's lot_snapshot poller receives the
# delta as two ticks against the SAME lot_id:
#
#   tick 1 (tombstone, deleted_at set):
#     * DELETE the cloud_lots mirror row.
#     * flag the matching Pi physical `lots` row to 'lost'.
#   tick 2 (revive, deleted_at NULL, qty>0):
#     * the non-tombstone upsert path re-INSERTs the cloud_lots mirror.
#     * (current code) does NOT touch the physical `lots` row.
#
# CORRECT END STATE — the physical-vs-cloud distinction:
#   * cloud_lots IS a derived mirror of cloud inventory. After the revive it
#     MUST be present + live (qty>0, deleted_at NULL) so the catch-all
#     classifier sees the inventory again. This is the bug that would matter
#     if the mirror were never re-created.
#   * `lots` tracks PHYSICAL shelf presence (on_shelf / in_flight / weight),
#     which is SEPARATE from cloud inventory. A cloud-side inventory revive
#     (import_shopping topping the lot back up, or a live_scale claim) does
#     NOT mean the bottle is physically back on the shelf. So the physical
#     `lots` row must NOT be auto-un-'lost'ed to 'on_shelf' — that would
#     fabricate a physical presence the load cells never observed. It should
#     stay 'lost' until a real physical event (a weight increase) re-places
#     it. Blindly reviving `lots` here would be WRONG.
#
# These tests pin BOTH halves so the behavior can't silently regress either
# way (mirror-not-restored, or physical-lots-wrongly-revived).
# ---------------------------------------------------------------------------


def test_cloud_tombstone_then_revive_restores_mirror_keeps_lots_lost(conn, tmp_path):
    """Tombstone then revive of the SAME cloud lot_id:
    cloud_lots mirror must be RESTORED + live; physical `lots` row stays 'lost'.
    """
    cloud_lot_id = "cloud-lot-revive"
    pi_lot_id, _pe_id = _seed_inflight_pi_and_cloud(
        conn, cloud_lot_id=cloud_lot_id,
    )

    # Sanity: mirror present + Pi lot in_flight before anything happens.
    assert cloud_lot_id in _all_cloud_lot_ids(conn)
    assert (
        conn.execute(
            "SELECT status FROM lots WHERE lot_id = ?", (pi_lot_id,)
        ).fetchone()["status"]
        == "in_flight"
    )

    # ---- tick 1: cloud tombstones the lot ----
    dead = _lot(
        cloud_lot_id,
        updated_at="2026-04-28T06:00:00Z",
        deleted_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    # Post-tombstone: mirror gone, Pi physical lot flagged 'lost'.
    assert cloud_lot_id not in _all_cloud_lot_ids(conn)
    assert (
        conn.execute(
            "SELECT status FROM lots WHERE lot_id = ?", (pi_lot_id,)
        ).fetchone()["status"]
        == "lost"
    )

    # ---- tick 2: cloud REVIVES the same lot_id in place (T1 trigger) ----
    # deleted_at NULL again, qty>0, updated_at bumped past the watermark.
    revived = _lot(
        cloud_lot_id,
        qty=4.0,
        updated_at="2026-04-29T09:00:00Z",
        deleted_at=None,
    )
    fetch.return_value = _payload(revived)
    applied = p.tick_once()

    assert applied == 1

    # (a) cloud_lots mirror RESTORED + live, so the classifier sees inventory.
    mirror = conn.execute(
        "SELECT qty_containers, deleted_at FROM cloud_lots WHERE lot_id = ?",
        (cloud_lot_id,),
    ).fetchone()
    assert mirror is not None, (
        "cloud_lots mirror was NOT restored on revive — the catch-all "
        "classifier would stay blind to the revived inventory"
    )
    assert float(mirror["qty_containers"]) == pytest.approx(4.0)
    # The poller never persists tombstones locally, so a live mirror row has
    # deleted_at NULL.
    assert mirror["deleted_at"] is None

    # (b) Physical `lots` row MUST stay 'lost' — a cloud inventory revive is
    # NOT a physical re-placement. The poller must not fabricate shelf
    # presence the load cells never observed.
    pi_row = conn.execute(
        "SELECT status, in_flight_since, pickup_event_id "
        "FROM lots WHERE lot_id = ?",
        (pi_lot_id,),
    ).fetchone()
    assert pi_row["status"] == "lost", (
        f"physical lots row was wrongly revived to {pi_row['status']!r}; a "
        "cloud-side inventory revive must NOT un-'lost' a physical lot — only "
        "a real weight event may do that"
    )
    # CHECK invariant on a non-in_flight row: markers stay cleared.
    assert pi_row["in_flight_since"] is None
    assert pi_row["pickup_event_id"] is None


def test_cloud_tombstone_then_revive_no_pi_lot_just_restores_mirror(conn, tmp_path):
    """Revive when there is NO physical Pi `lots` row at all (e.g. the lot was
    never physically on this shelf — a pure cloud inventory item). The mirror
    must still be restored live; no phantom `lots` row may be minted."""
    cloud_lot_id = "cloud-lot-revive-no-pi"

    # Seed only a cloud_lots mirror (no Pi `lots` row), product exists for FK.
    conn.execute(
        "INSERT OR IGNORE INTO products (product_id, name, net_weight_g) "
        "VALUES (?, ?, ?)",
        ("prod-cloudonly", "Cloud Only", 100.0),
    )
    conn.execute(
        "INSERT INTO cloud_lots (lot_id, product_id, qty_containers, updated_at) "
        "VALUES (?, 'prod-cloudonly', 1.0, '2026-04-20T10:00:00Z')",
        (cloud_lot_id,),
    )
    conn.commit()

    # tick 1: tombstone (deletes mirror; no Pi lot to flag).
    dead = _lot(
        cloud_lot_id, product_id="prod-cloudonly",
        updated_at="2026-04-28T06:00:00Z", deleted_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()
    assert cloud_lot_id not in _all_cloud_lot_ids(conn)

    # tick 2: revive in place.
    revived = _lot(
        cloud_lot_id, product_id="prod-cloudonly", qty=2.0,
        updated_at="2026-04-29T09:00:00Z", deleted_at=None,
    )
    fetch.return_value = _payload(revived)
    p.tick_once()

    # Mirror restored live.
    mirror = conn.execute(
        "SELECT qty_containers FROM cloud_lots WHERE lot_id = ?",
        (cloud_lot_id,),
    ).fetchone()
    assert mirror is not None
    assert float(mirror["qty_containers"]) == pytest.approx(2.0)

    # No phantom physical lot was minted for this cloud-only product.
    pi_count = conn.execute(
        "SELECT COUNT(*) AS n FROM lots WHERE product_id = 'prod-cloudonly'",
    ).fetchone()["n"]
    assert pi_count == 0


# ---------------------------------------------------------------------------
# Audit gap G4 — state.write OSError must revert in-memory watermark and
# NOT reset backoff (so the next tick refetches the same range with the
# already-elevated retry cadence).
# ---------------------------------------------------------------------------


def test_g4_state_write_oserror_reverts_in_memory_state(conn, tmp_path):
    """If `_state.write` raises OSError on a successful fetch+apply, the
    in-memory watermark must revert to its prior value AND the backoff
    must NOT be reset to INITIAL_BACKOFF_S — so the next tick refetches
    the same range with the already-elevated retry cadence.
    """
    state_path = tmp_path / "s.json"
    lot = _lot("lot-1", updated_at="2026-04-21T12:00:00Z")
    fetch = MagicMock(return_value=_payload(lot))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    # Simulate prior failed-tick backoff state: pretend a previous tick
    # already advanced backoff once (so we can assert it's NOT clobbered
    # back to INITIAL_BACKOFF_S on this failed-persist tick).
    elevated = INITIAL_BACKOFF_S * 4
    p._backoff_s = elevated
    prior_watermark = p._state.high_watermark  # None on first run
    assert prior_watermark is None

    # Now make _SyncState.write blow up on every call.
    with patch.object(_SyncState, "write",
                      side_effect=OSError("disk full")):
        p.tick_once()

    # (a) In-memory watermark reverted to prior (None here).
    assert p.high_watermark == prior_watermark
    # (b) Backoff NOT reset — preserved at its elevated value.
    assert p._backoff_s == elevated
    # (c) On-disk state file was never successfully written.
    assert not state_path.exists()

    # (d) Next tick: same fetch returns same data — the cloud's
    # in-memory state is reverted, so `updated_since` is still the prior
    # watermark (None) and the same rows come back. cloud_lots already
    # has the row from the first apply (in-memory tx committed), so this
    # is an upsert — but the watermark advance + persist is the path we
    # care about.
    fetch.reset_mock()
    # Allow persist to succeed this time.
    p.tick_once()
    # The second tick should have called fetch with the SAME
    # updated_since the first tick used (prior watermark).
    assert fetch.call_args_list[-1] == (
        (p._client,), {"updated_since": prior_watermark}
    )
    # And the watermark is now persisted (backoff reset path took over).
    assert p.high_watermark == "2026-04-21T12:00:00Z"
    assert p._backoff_s == INITIAL_BACKOFF_S


def test_g4_state_write_success_resets_backoff_after_persist(conn, tmp_path):
    """Happy path regression: state.write succeeds → backoff resets to
    INITIAL_BACKOFF_S and the on-disk file matches the in-memory state.
    Pins that the reorder didn't break the success path."""
    state_path = tmp_path / "s.json"
    lot = _lot("lot-1", updated_at="2026-04-21T12:00:00Z")
    fetch = MagicMock(return_value=_payload(lot))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    # Seed an elevated backoff to prove the reset actually fires.
    p._backoff_s = INITIAL_BACKOFF_S * 4

    applied = p.tick_once()

    assert applied == 1
    assert p._backoff_s == INITIAL_BACKOFF_S
    assert p.high_watermark == "2026-04-21T12:00:00Z"
    assert state_path.exists()
    saved = json.loads(state_path.read_text())
    assert saved["high_watermark"] == "2026-04-21T12:00:00Z"


# ---------------------------------------------------------------------------
# Gap G10: cold-start ordering — wait on products_synced Event
# ---------------------------------------------------------------------------


def test_g10_proceeds_immediately_when_event_already_set(conn, tmp_path):
    """Already-latched Event → no blocking on first tick."""
    import threading as _threading
    import time as _time

    products_synced = _threading.Event()
    products_synced.set()
    fetch = MagicMock(return_value=_payload())
    p = LotSnapshotPoller(
        MagicMock(), conn, state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=10.0,  # would block 10s if Event unset
    )
    t0 = _time.monotonic()
    p.tick_once()
    elapsed = _time.monotonic() - t0
    assert elapsed < 1.0, f"tick should not block; took {elapsed:.2f}s"
    fetch.assert_called_once()


def test_g10_times_out_and_proceeds_with_warning(conn, tmp_path, caplog):
    """Unset Event → timeout → WARNING + proceed."""
    import logging as _logging
    import threading as _threading

    products_synced = _threading.Event()  # NEVER set
    fetch = MagicMock(return_value=_payload())
    p = LotSnapshotPoller(
        MagicMock(), conn, state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=0.05,
    )
    with caplog.at_level(_logging.WARNING, logger="server.cloud.lot_snapshot_poller"):
        p.tick_once()
    fetch.assert_called_once()
    assert any(
        "products_synced wait expired" in rec.message for rec in caplog.records
    )


def test_g10_waits_only_on_first_tick(conn, tmp_path):
    """Second tick must not re-wait — saves a 5s sleep per tick forever."""
    import threading as _threading
    import time as _time

    products_synced = _threading.Event()  # NEVER set
    fetch = MagicMock(return_value=_payload())
    p = LotSnapshotPoller(
        MagicMock(), conn, state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=0.05,
    )
    p.tick_once()  # waits 50ms, proceeds
    t0 = _time.monotonic()
    p.tick_once()
    elapsed = _time.monotonic() - t0
    assert elapsed < 0.04, (
        f"second tick must not re-wait; took {elapsed*1000:.0f}ms"
    )


def test_g10_no_event_passed_works_for_backcompat(conn, tmp_path):
    """Old callers (no Event) still work — sanity test for the optional
    constructor argument shape."""
    fetch = MagicMock(return_value=_payload())
    p = LotSnapshotPoller(
        MagicMock(), conn, state_path=tmp_path / "s.json",
        fetch_snapshot_fn=fetch,
        # products_synced_event omitted
    )
    p.tick_once()


# ---------------------------------------------------------------------------
# Audit C2-01 — a row whose ``_apply_one`` RAISES sqlite3.Error must NOT
# advance the watermark past it. The cloud delta filter is a strict
# ``updated_at > watermark``; advancing past a transiently-failed row drops
# it from every future delta window → permanent mirror drift / data loss.
# The row must be RETRIED on the next tick.
# ---------------------------------------------------------------------------


def test_c2_01_failed_apply_does_not_advance_watermark_and_retries(conn, tmp_path):
    """Two snapshot rows; the FIRST raises in ``_apply_one``.

    Expected:
      * watermark does NOT advance to/past the failed row's updated_at;
      * the failed (and the later, valid) row are re-fetched next tick
        (cloud filter would skip them if the watermark had advanced);
      * once the transient fault clears, both rows apply and the
        watermark finally advances.
    """
    state_path = tmp_path / "s.json"
    bad = _lot("lot-bad", updated_at="2026-04-21T10:00:00Z")
    good = _lot("lot-good", updated_at="2026-04-22T12:00:00Z")
    fetch = MagicMock(return_value=_payload(bad, good))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    # Make ONLY the first row's apply raise a transient sqlite fault.
    real_apply = p._apply_one
    fail_for = {"lot-bad"}

    def flaky_apply(lot):
        if lot.get("lot_id") in fail_for:
            raise sqlite3.OperationalError("database is locked")
        return real_apply(lot)

    with patch.object(p, "_apply_one", side_effect=flaky_apply):
        applied = p.tick_once()

    # Only the good row applied this tick.
    assert applied == 1
    assert "lot-good" in _all_cloud_lot_ids(conn)
    assert "lot-bad" not in _all_cloud_lot_ids(conn)

    # CRITICAL: the watermark must NOT have advanced to/past the failed
    # row (2026-04-21T10:00:00Z). It must stay strictly below it so the
    # next delta window re-fetches it. Since the good row is NEWER than
    # the failed row, the watermark cannot jump to the good row either
    # (that would orphan the failed row forever).
    assert p.high_watermark is None or p.high_watermark < "2026-04-21T10:00:00Z", (
        f"watermark advanced to {p.high_watermark!r}, past the failed row — "
        "the failed row is now unreachable in every future delta window"
    )
    # The on-disk state likewise must not pin a watermark that skips the row.
    if state_path.exists():
        saved_hwm = json.loads(state_path.read_text())["high_watermark"]
        assert saved_hwm is None or saved_hwm < "2026-04-21T10:00:00Z"

    # ---- Next tick: the transient fault has cleared. The poller must
    # re-fetch the SAME range (updated_since unchanged) and now apply
    # BOTH rows. This proves the failed row was retried, not silently
    # skipped forever. ----
    last_call = fetch.call_args_list[-1]
    assert last_call.kwargs.get("updated_since") == p.high_watermark

    fail_for.clear()  # fault gone
    applied2 = p.tick_once()

    assert "lot-bad" in _all_cloud_lot_ids(conn), (
        "the previously-failed row was never retried — it is lost"
    )
    assert "lot-good" in _all_cloud_lot_ids(conn)
    # Both rows now applied; watermark finally advances to the batch max.
    assert applied2 >= 1
    assert p.high_watermark == "2026-04-22T12:00:00Z"


def test_c2_01_all_rows_fail_leaves_watermark_untouched(conn, tmp_path):
    """If EVERY row's apply raises, the watermark must not move at all —
    not even to the smallest failed updated_at. (Guards a mutation where
    the failed_floor clamp is dropped and the batch-max leaks through.)"""
    state_path = tmp_path / "s.json"
    r1 = _lot("lot-a", updated_at="2026-04-21T10:00:00Z")
    r2 = _lot("lot-b", updated_at="2026-04-22T12:00:00Z")
    fetch = MagicMock(return_value=_payload(r1, r2))
    p = _poller(MagicMock(), conn, state_path, fetch_fn=fetch)

    def always_raise(_lot):
        raise sqlite3.OperationalError("database is locked")

    with patch.object(p, "_apply_one", side_effect=always_raise):
        applied = p.tick_once()

    assert applied == 0
    assert p.high_watermark is None
    assert not state_path.exists()


# ---------------------------------------------------------------------------
# Audit C2-05 — ``_find_pi_lot_for_cloud_lot`` product-fallback must NOT
# flip an arbitrary in_flight Pi lot when >1 candidate matches the product.
# It must DEFER (skip + log), leaving every candidate untouched, mirroring
# the event_overrides G3 ambiguity guard.
# ---------------------------------------------------------------------------


def _seed_two_inflight_pi_lots_same_product(
    conn: sqlite3.Connection,
    *,
    product_id: str = "prod-dup",
) -> tuple[str, str]:
    """Seed TWO Pi `lots` rows in 'in_flight' for the same product, each
    with its OWN pickup_event_id (so NEITHER links to the cloud lot's
    pickup_event_id — forcing the product fallback). Returns both lot_ids.
    """
    conn.execute(
        "INSERT OR IGNORE INTO products (product_id, name, net_weight_g) "
        "VALUES (?, ?, ?)",
        (product_id, "Dup Product", 100.0),
    )
    pi_lot_a = str(uuid.uuid4())
    pi_lot_b = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, "
        "                  pickup_event_id) "
        "VALUES (?, ?, 'in_flight', '2026-04-20T09:00:00Z', ?)",
        (pi_lot_a, product_id, str(uuid.uuid4())),
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, "
        "                  pickup_event_id) "
        "VALUES (?, ?, 'in_flight', '2026-04-20T10:00:00Z', ?)",
        (pi_lot_b, product_id, str(uuid.uuid4())),
    )
    conn.commit()
    return pi_lot_a, pi_lot_b


def test_c2_05_ambiguous_product_fallback_defers_leaves_both_untouched(
    conn, tmp_path, caplog
):
    """Cloud tombstone whose pickup_event_id links to NO Pi lot, with TWO
    in_flight Pi lots sharing the product. The product fallback must
    refuse to guess: NEITHER lot may be flipped to 'lost'; both stay
    'in_flight'. The skip is counted + logged.
    """
    import logging as _logging

    pi_lot_a, pi_lot_b = _seed_two_inflight_pi_lots_same_product(
        conn, product_id="prod-dup"
    )

    # Cloud lot mirror for the SAME product, with a pickup_event_id that
    # matches NEITHER Pi lot (so the exact-link path misses → product
    # fallback fires).
    cloud_lot_id = "cloud-dup"
    conn.execute(
        """
        INSERT INTO cloud_lots (lot_id, product_id, qty_containers,
                                in_flight_since, in_flight_kind,
                                pickup_event_id, updated_at)
        VALUES (?, 'prod-dup', 1.0, '2026-04-20T10:00:00Z',
                'catch_all', 'pe-unlinked', '2026-04-20T10:00:00Z')
        """,
        (cloud_lot_id,),
    )
    conn.commit()

    # Cloud tombstones the lot → triggers _find_pi_lot_for_cloud_lot.
    dead = _lot(
        cloud_lot_id, product_id="prod-dup",
        updated_at="2026-04-28T06:00:00Z", deleted_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)

    with caplog.at_level(
        _logging.WARNING, logger="server.cloud.lot_snapshot_poller"
    ):
        p.tick_once()

    # NEITHER Pi lot may be flipped — both must still be 'in_flight'.
    statuses = {
        r["lot_id"]: r["status"]
        for r in conn.execute(
            "SELECT lot_id, status FROM lots WHERE product_id = 'prod-dup'"
        ).fetchall()
    }
    assert statuses[pi_lot_a] == "in_flight", (
        f"lot A was arbitrarily flipped to {statuses[pi_lot_a]!r} on an "
        "ambiguous product fallback"
    )
    assert statuses[pi_lot_b] == "in_flight", (
        f"lot B was arbitrarily flipped to {statuses[pi_lot_b]!r} on an "
        "ambiguous product fallback"
    )

    # The ambiguity skip is counted and logged.
    assert p.skipped_ambiguous_count == 1
    assert any(
        "AMBIGUOUS product-fallback" in rec.message for rec in caplog.records
    ), "expected an AMBIGUOUS product-fallback warning log"


def test_c2_05_single_inflight_lot_still_flips_unambiguously(conn, tmp_path):
    """Control: with exactly ONE in_flight Pi lot for the product (no
    pickup_event_id link), the product fallback is unambiguous and still
    flips it. Proves the guard fires ONLY on >1, not on every fallback —
    so it doesn't break the legitimate single-lot recovery path.
    """
    conn.execute(
        "INSERT OR IGNORE INTO products (product_id, name, net_weight_g) "
        "VALUES (?, ?, ?)",
        ("prod-solo", "Solo Product", 100.0),
    )
    pi_lot = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since, "
        "                  pickup_event_id) "
        "VALUES (?, 'prod-solo', 'in_flight', '2026-04-20T09:00:00Z', ?)",
        (pi_lot, str(uuid.uuid4())),
    )
    cloud_lot_id = "cloud-solo"
    conn.execute(
        """
        INSERT INTO cloud_lots (lot_id, product_id, qty_containers,
                                in_flight_since, in_flight_kind,
                                pickup_event_id, updated_at)
        VALUES (?, 'prod-solo', 1.0, '2026-04-20T10:00:00Z',
                'catch_all', 'pe-unlinked', '2026-04-20T10:00:00Z')
        """,
        (cloud_lot_id,),
    )
    conn.commit()

    dead = _lot(
        cloud_lot_id, product_id="prod-solo",
        updated_at="2026-04-28T06:00:00Z", deleted_at="2026-04-28T06:00:00Z",
    )
    fetch = MagicMock(return_value=_payload(dead))
    p = _poller(MagicMock(), conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    status = conn.execute(
        "SELECT status FROM lots WHERE lot_id = ?", (pi_lot,)
    ).fetchone()["status"]
    assert status == "lost", (
        "single unambiguous in_flight lot must still be flipped to 'lost' "
        "on tombstone — the guard must not over-trigger"
    )
    assert p.skipped_ambiguous_count == 0
