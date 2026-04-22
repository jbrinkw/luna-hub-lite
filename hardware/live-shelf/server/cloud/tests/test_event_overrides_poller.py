"""Unit tests for :mod:`server.cloud.event_overrides_poller`.

Multi-call sequences per the testing guide: initial sync → cloud
mutation → next sync → assert Pi state converged. The fetch layer is
faked via the ``fetch_overrides_fn`` injection so no HTTP spin-up is
needed, but the Pi's SQLite + lock + state machine are all real.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.event_overrides_poller import EventOverridesPoller  # noqa: E402
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


def _seed_product_and_lot(
    conn: sqlite3.Connection,
    *,
    product_id: str = "prod-1",
    net_weight_g: float = 1000.0,
    initial_weight_g: float = 1000.0,
) -> str:
    """Insert a product + one active on_shelf lot, return the lot_id."""
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g,
            certified, created_at, updated_at
        ) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
        """,
        (product_id, f"Product {product_id}", net_weight_g),
    )
    lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g,
            initial_weight_g, shelf_id
        ) VALUES (?, ?, 'on_shelf', ?, ?, 'live_shelf')
        """,
        (lot_id, product_id, initial_weight_g, initial_weight_g),
    )
    conn.commit()
    return lot_id


def _override_payload(
    client_event_id: str,
    product_id: str,
    resolved_lot_id: str,
    qty_containers: float,
    *,
    updated_at: str = "2026-04-21T12:00:00Z",
) -> dict:
    """Construct the shape the cloud /overrides endpoint emits."""
    return {
        "overrides": [
            {
                "override_id": str(uuid.uuid4()),
                "client_event_id": client_event_id,
                "updated_at": updated_at,
                "stock_qty_override": None,
                "macros_servings_override": None,
                "calories_override": None,
                "protein_override": None,
                "carbs_override": None,
                "fat_override": None,
                "macro_logging_enabled": True,
                "is_voided": False,
                "event_kind_override": None,
                "resolved_lot_id": resolved_lot_id,
                "product_id": product_id,
                "pi_event_id": None,
            },
        ],
        "lots": [
            {
                "lot_id": resolved_lot_id,
                "product_id": product_id,
                "qty_containers": qty_containers,
                "last_update_source": "manual",
                "last_update_ts": updated_at,
            },
        ],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_first_tick_sends_none_and_applies_lot_weight(conn, tmp_path):
    """Fresh state file → first call sends updated_since=None, and the
    cloud's qty_containers is converted to current_weight_g on the
    matching local lot."""
    lot_id = _seed_product_and_lot(conn, net_weight_g=1000.0)
    state_path = tmp_path / "last_overrides_sync.json"

    client = MagicMock()
    # Cloud says the lot's qty = 0.5 container (half full after override).
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-1", "prod-1", "cloud-lot-uuid-1", 0.5,
            updated_at="2026-04-21T12:00:00Z",
        ),
    )

    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 1
    fake_fetch.assert_called_once_with(client, updated_since=None)

    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    # 0.5 containers * 1000g/container = 500g.
    assert row["current_weight_g"] == pytest.approx(500.0)

    # Watermark persisted.
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T12:00:00Z"


def test_second_tick_uses_watermark_and_advances(conn, tmp_path):
    """Multi-call: tick 1 applies 0.5 containers → tick 2 sees cloud
    edit to 0.75 containers, uses the prior watermark, and advances."""
    lot_id = _seed_product_and_lot(conn, net_weight_g=800.0)
    state_path = tmp_path / "last_overrides_sync.json"

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-a", "prod-1", "cloud-lot-1", 0.5,
            updated_at="2026-04-21T10:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    assert poller.tick_once() == 1
    assert poller.high_watermark == "2026-04-21T10:00:00Z"

    # Tick 2: cloud edits servings → new lot state arrives.
    fake_fetch.return_value = _override_payload(
        "evt-a", "prod-1", "cloud-lot-1", 0.75,
        updated_at="2026-04-21T12:00:00Z",
    )
    applied = poller.tick_once()

    assert applied == 1
    # Second call sent the prior watermark.
    assert fake_fetch.call_args_list[-1].kwargs["updated_since"] == "2026-04-21T10:00:00Z"
    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(0.75 * 800.0)
    assert poller.high_watermark == "2026-04-21T12:00:00Z"


def test_cloud_error_keeps_watermark_and_bumps_backoff(conn, tmp_path):
    """CloudError on fetch must not advance the watermark or mutate lots.
    Next tick retries the same updated_since."""
    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T09:00:00Z"})
    )
    original_mtime = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(side_effect=CloudError(503, "cloud down"))
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 0
    assert poller.high_watermark == "2026-04-21T09:00:00Z"
    assert state_path.stat().st_mtime_ns == original_mtime

    # Backoff advanced.
    first = poller._next_backoff()  # noqa: SLF001
    second = poller._next_backoff()  # noqa: SLF001
    assert second >= first


def test_empty_overrides_no_state_rewrite(conn, tmp_path):
    """No overrides in the delta → watermark file untouched (no churn)."""
    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-21T08:00:00Z"})
    )
    before_mtime = state_path.stat().st_mtime_ns

    client = MagicMock()
    fake_fetch = MagicMock(return_value={"overrides": [], "lots": []})
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 0
    assert poller.high_watermark == "2026-04-21T08:00:00Z"
    assert state_path.stat().st_mtime_ns == before_mtime


def test_missing_local_lot_skipped_with_log(conn, tmp_path, caplog):
    """Cloud reports an override for a product the Pi never saw (no
    active lot). We log + skip rather than crash — future placement
    will re-materialize."""
    # Product exists but no lot.
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-orphan', 'Orphan', 500.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    state_path = tmp_path / "last_overrides_sync.json"

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-o", "prod-orphan", "cloud-lot-orphan", 1.0,
            updated_at="2026-04-21T12:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 0  # nothing to write.
    # Watermark still advances (the override was acknowledged, just
    # nothing to apply locally).
    assert poller.high_watermark == "2026-04-21T12:00:00Z"


def test_product_without_net_weight_skipped(conn, tmp_path):
    """A product with net_weight_g=0 (or NULL) can't be converted
    containers→grams. We skip + log and move on."""
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-no-net', 'NoNet', NULL, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g,
            shelf_id
        ) VALUES (?, 'prod-no-net', 'on_shelf', 200.0, 'live_shelf')
        """,
        (lot_id,),
    )
    conn.commit()

    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-nn", "prod-no-net", "cloud-lot-nn", 0.5,
            updated_at="2026-04-21T12:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 0
    # The lot's weight is untouched.
    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == 200.0


def test_unreadable_state_file_degrades_to_full_resync(conn, tmp_path):
    """Corrupt state file → full re-sync (updated_since=None) and
    the state file is rewritten cleanly on success."""
    _ = _seed_product_and_lot(conn, net_weight_g=500.0)
    state_path = tmp_path / "last_overrides_sync.json"
    state_path.write_text("{invalid json")

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-r", "prod-1", "cloud-lot-r", 1.0,
            updated_at="2026-04-21T13:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 1
    fake_fetch.assert_called_once_with(client, updated_since=None)
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T13:00:00Z"


def test_voided_override_still_applies_lot_state(conn, tmp_path):
    """Even when is_voided=true, the cloud has already reconciled
    stock_lots. We apply whatever cloud sent in the lots[] array — the
    void semantics are resolved server-side."""
    lot_id = _seed_product_and_lot(conn, net_weight_g=1000.0)
    state_path = tmp_path / "last_overrides_sync.json"

    payload = _override_payload(
        "evt-v", "prod-1", "cloud-lot-v", 1.0,
        updated_at="2026-04-21T14:00:00Z",
    )
    payload["overrides"][0]["is_voided"] = True
    # Cloud backed out the decrement: lot now at full 1.0 containers.
    payload["lots"][0]["qty_containers"] = 1.0

    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    poller.tick_once()

    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(1000.0)
