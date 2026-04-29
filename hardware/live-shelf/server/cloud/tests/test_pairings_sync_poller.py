"""Unit tests for :mod:`server.cloud.pairings_sync_poller`.

Mocks the network layer via ``fetch_catalog_fn`` injection and asserts
that the Pi's SQLite ``scale_pairings`` table converges on the cloud
response per tick. Mirrors the structure of
``test_lot_snapshot_poller.py`` and ``test_event_overrides_poller.py``
so the test suite stays readable side-by-side.

Coverage map (matches the brief's required tests):
  * UPSERTs new cloud rows into Pi local
  * Translates cloud ``live_scale`` → Pi ``single_item``
  * Deletes Pi-local rows whose cloud counterpart vanished
  * Preserves Pi's local ``last_heartbeat_ts`` (does NOT overwrite)
  * Idempotent across ticks (no spurious writes when nothing changed)
  * Resilient to cloud failure (CloudError, generic Exception, bad payload)
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add the live-shelf dir to sys.path so ``from server.*`` resolves
# regardless of how pytest is invoked.
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.catalog import Catalog  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402
from server.cloud.pairings_sync_poller import (  # noqa: E402
    PairingsSyncPoller,
    _SHELF_KIND_TRANSLATION,
)
from server.storage.migrations import apply_migrations  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory SQLite with the Pi schema applied + FKs enforced."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    # Migrations toggle FKs OFF/ON during the schema build; the live
    # ``lifecycle.connect_db`` re-enables them once for the connection
    # lifetime. Replicate that here so FK constraints actually fire
    # during tests — otherwise the upsert paths would silently accept
    # references to non-existent products/lots and we'd lose a real
    # invariant from our coverage.
    c.execute("PRAGMA foreign_keys = ON")
    return c


def _seed_product(conn: sqlite3.Connection, product_id: str, name: str = "Stub") -> None:
    """Seed a minimal product row so ``scale_pairings.product_id`` FK is
    satisfiable. ``net_weight_g`` is the only non-NULL column without a
    default in the products schema; everything else is NULL-tolerant."""
    conn.execute(
        "INSERT INTO products (product_id, name, net_weight_g) VALUES (?, ?, ?)",
        (product_id, name, 100.0),
    )
    conn.commit()


def _seed_lot(conn: sqlite3.Connection, lot_id: str, product_id: str) -> None:
    """Seed a minimal lots row for FK satisfaction."""
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id, product_id),
    )
    conn.commit()


def _pairing(
    scale_id: str,
    kind: str,
    *,
    product_id: str | None = None,
    lot_id: str | None = None,
) -> dict:
    """Cloud-shaped pairing dict matching the /catalog projection."""
    return {
        "scale_id": scale_id,
        "kind": kind,
        "product_id": product_id,
        "lot_id": lot_id,
    }


def _catalog(*pairings: dict) -> Catalog:
    """Wrap pairings in a Catalog dataclass — what fetch_catalog returns."""
    return Catalog(
        products=[],
        stock=[],
        pairings=list(pairings),
        locations=[],
    )


def _read_pairing(conn: sqlite3.Connection, device_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM scale_pairings WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    return dict(row) if row is not None else None


def _all_device_ids(conn: sqlite3.Connection) -> set[str]:
    return {
        r["device_id"]
        for r in conn.execute("SELECT device_id FROM scale_pairings").fetchall()
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_first_tick_inserts_all_cloud_rows(conn, tmp_path):
    """Empty Pi + non-empty cloud → every cloud row INSERTed; Pi mirrors
    cloud after one tick."""
    _seed_product(conn, "prod-A")
    state_path = tmp_path / "last_pairings_sync.json"

    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-01", "live_shelf"),
            _pairing("scale-02", "catch_all"),
            _pairing("scale-03", "live_scale", product_id="prod-A"),
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn, state_path=state_path, fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()

    assert applied == 3
    assert _all_device_ids(conn) == {"scale-01", "scale-02", "scale-03"}

    s3 = _read_pairing(conn, "scale-03")
    assert s3 is not None
    assert s3["product_id"] == "prod-A"


def test_translates_live_scale_to_single_item(conn, tmp_path):
    """Cloud ``kind = 'live_scale'`` lands on Pi as
    ``shelf_id = 'single_item'`` — the legacy Pi term enforced by the
    SQLite CHECK constraint."""
    _seed_product(conn, "prod-X")
    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-03", "live_scale", product_id="prod-X"),
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    poller.tick_once()

    row = _read_pairing(conn, "scale-03")
    assert row is not None
    assert row["shelf_id"] == "single_item", (
        "cloud 'live_scale' must translate to Pi 'single_item'"
    )

    # Sanity: the other two cloud kinds pass through unchanged.
    assert _SHELF_KIND_TRANSLATION["live_shelf"] == "live_shelf"
    assert _SHELF_KIND_TRANSLATION["catch_all"] == "catch_all"


def test_deletes_pi_rows_missing_from_cloud(conn, tmp_path):
    """User un-pairs in cloud → next tick removes the Pi-local row.

    Cloud is source of truth; Pi-only rows are stale and must go.
    """
    # Seed Pi with a row that the cloud will NOT return.
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, last_heartbeat_ts) "
        "VALUES ('scale-09', 'single_item', '2026-04-28T00:00:00Z')"
    )
    # And one that cloud WILL still return.
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id) "
        "VALUES ('scale-01', 'live_shelf')"
    )
    conn.commit()

    fake = MagicMock(
        return_value=_catalog(_pairing("scale-01", "live_shelf"))
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()

    assert _all_device_ids(conn) == {"scale-01"}
    # 1 mutation: the DELETE. The scale-01 row was already in sync, so
    # it must NOT count as a mutation (idempotency rule).
    assert applied == 1


def test_does_not_clobber_local_last_heartbeat_ts(conn, tmp_path):
    """The Pi's ``last_heartbeat_ts`` tracks ESP→Pi heartbeats; the
    cloud's value tracks Pi→cloud heartbeats. They mean different
    things — the poller MUST leave the Pi column alone, even when
    the cloud row exists and has its own (different) heartbeat data
    in some other column."""
    _seed_product(conn, "prod-A")
    pi_hb = "2026-04-28T12:34:56Z"
    conn.execute(
        "INSERT INTO scale_pairings "
        "  (device_id, shelf_id, product_id, last_heartbeat_ts, first_seen_at) "
        "VALUES ('scale-03', 'single_item', 'prod-A', ?, '2026-04-20T00:00:00Z')",
        (pi_hb,),
    )
    conn.commit()

    # Cloud returns the same row but conceptually "changed" — flip
    # product_id to a different valid value to force an UPDATE path.
    _seed_product(conn, "prod-B")
    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-03", "live_scale", product_id="prod-B"),
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    poller.tick_once()

    row = _read_pairing(conn, "scale-03")
    assert row is not None
    assert row["product_id"] == "prod-B"  # cloud-authoritative column did update
    assert row["last_heartbeat_ts"] == pi_hb, (
        "Pi-local last_heartbeat_ts must be preserved across pairings sync"
    )
    assert row["first_seen_at"] == "2026-04-20T00:00:00Z", (
        "Pi-local first_seen_at must also be preserved"
    )


def test_idempotent_when_cloud_and_pi_already_match(conn, tmp_path):
    """Two ticks with identical cloud state → second tick mutates 0 rows.

    Guards against churn — the table is read by the dashboard via
    realtime; a spurious UPDATE per tick would trigger needless UI
    re-renders.
    """
    _seed_product(conn, "prod-A")
    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-01", "live_shelf"),
            _pairing("scale-03", "live_scale", product_id="prod-A"),
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    applied_first = poller.tick_once()
    applied_second = poller.tick_once()

    assert applied_first == 2  # both inserts
    assert applied_second == 0, (
        "second tick with unchanged cloud state must be a no-op"
    )
    # Fetch was called both ticks — we don't short-circuit the network
    # call, only the DB writes.
    assert fake.call_count == 2


def test_lot_id_sync_when_cloud_provides_one(conn, tmp_path):
    """Cloud-provided ``lot_id`` propagates to Pi (and the FK to
    ``lots`` resolves)."""
    _seed_product(conn, "prod-A")
    _seed_lot(conn, "lot-1", "prod-A")
    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-03", "live_scale", product_id="prod-A", lot_id="lot-1"),
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    poller.tick_once()

    row = _read_pairing(conn, "scale-03")
    assert row is not None
    assert row["lot_id"] == "lot-1"


def test_cloud_error_does_not_kill_thread_or_mutate_state(conn, tmp_path):
    """Transient cloud outage → tick_once returns 0, advances backoff,
    leaves the state file untouched, and does NOT wipe Pi rows."""
    # Seed an existing Pi row; if the poller mistakenly treated a fetch
    # error as "cloud has zero pairings", it would DELETE this.
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id) "
        "VALUES ('scale-01', 'live_shelf')"
    )
    conn.commit()

    fake = MagicMock(side_effect=CloudError(503, "service unavailable"))
    state_path = tmp_path / "state.json"
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=state_path,
        fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()

    assert applied == 0
    assert _all_device_ids(conn) == {"scale-01"}, (
        "fetch failure must NOT be interpreted as 'cloud has no pairings'"
    )
    assert not state_path.exists(), (
        "state file is only written on a successful tick"
    )


def test_unexpected_exception_caught(conn, tmp_path):
    """A non-CloudError raised by fetch must also be swallowed — the
    thread MUST never die from a transient issue."""
    fake = MagicMock(side_effect=RuntimeError("boom"))
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    # Must not raise.
    applied = poller.tick_once()
    assert applied == 0


def test_writes_watermark_on_successful_tick(conn, tmp_path):
    """Successful tick persists ``last_synced_at`` so /healthz +
    operators can see liveness — even when ``applied == 0``."""
    fake = MagicMock(return_value=_catalog())  # empty cloud, empty Pi
    state_path = tmp_path / "state.json"
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=state_path,
        fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()

    assert applied == 0
    assert state_path.exists()
    saved = json.loads(state_path.read_text())
    assert saved["version"] == 1
    assert isinstance(saved["last_synced_at"], str)
    assert poller.last_synced_at == saved["last_synced_at"]


def test_skips_pairings_with_unknown_kind(conn, tmp_path):
    """Defensive: a future cloud kind we don't know how to translate
    must NOT crash + must NOT pollute the Pi with a CHECK-violating
    INSERT."""
    fake = MagicMock(
        return_value=_catalog(
            _pairing("scale-01", "live_shelf"),
            {"scale_id": "scale-99", "kind": "future_thing"},  # unknown
            {"scale_id": "scale-bad"},  # missing kind
            {"kind": "live_shelf"},  # missing scale_id
            "not-a-dict",
        )
    )
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()

    assert applied == 1
    assert _all_device_ids(conn) == {"scale-01"}


def test_malformed_payload_does_not_raise(conn, tmp_path):
    """If the catalog response somehow has a non-list ``pairings``
    field, log + skip rather than crash."""
    bad_catalog = Catalog(
        products=[], stock=[], locations=[],
    )
    # Force the malformed shape past the dataclass default.
    object.__setattr__(bad_catalog, "pairings", "not-a-list")  # type: ignore[arg-type]
    fake = MagicMock(return_value=bad_catalog)
    poller = PairingsSyncPoller(
        MagicMock(), conn,
        state_path=tmp_path / "state.json",
        fetch_catalog_fn=fake,
    )

    applied = poller.tick_once()
    assert applied == 0
