"""Regression pin for live_weight_sync observed_weight_g NULL drift.

Commit-chain context (2026-04-29): a production regression emitted
`live_weight_sync` outbox payloads with `observed_weight_g=NULL` even when
Pi `lots.current_weight_g` was populated; cloud then applied NULL and
`stock_lots.last_observed_weight_g` stayed stale.

This test keeps that exact failure mode pinned at the payload boundary.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.cloud.weight_sync_poller import WeightSyncPoller  # noqa: E402
from server.storage import init_db  # noqa: E402


class _ManualClock:
    def monotonic(self) -> float:
        return 0.0


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


def _seed_product(conn: sqlite3.Connection) -> str:
    pid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO products (product_id, name, certified) VALUES (?, ?, 1)",
        (pid, "Pinned Product"),
    )
    conn.commit()
    return pid


def _seed_lot(conn: sqlite3.Connection, *, product_id: str, weight_g: float) -> str:
    lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, shelf_id) "
        "VALUES (?, ?, 'on_shelf', ?, 'live_shelf')",
        (lot_id, product_id, weight_g),
    )
    conn.commit()
    return lot_id


def test_live_weight_sync_payload_observed_weight_is_non_null(conn):
    product_id = _seed_product(conn)
    lot_id = _seed_lot(conn, product_id=product_id, weight_g=187.625)

    emitter = CloudEventEmitter(conn, enabled=True)
    poller = WeightSyncPoller(emitter, conn, clock=_ManualClock())

    assert poller.tick_once() == 1

    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    payload = json.loads(row["payload_json"])

    assert payload["event_kind"] == "live_weight_sync"
    assert payload["pi_lot_id"] == lot_id
    assert payload["observed_weight_g"] is not None
    assert payload["observed_weight_g"] == pytest.approx(187.625)
    assert payload["delta_g"] == pytest.approx(187.625)
