"""Pi-side guards for the 2026-04-27 lot-level scale_pairings refactor.

The cloud now stores ``scale_pairings.lot_id`` (NULL-allowed, FK to
``stock_lots``) and resolves the target lot for live_scale events from
this column when populated. Per the migration plan the Pi does NOT yet
mirror ``scale_pairings.lot_id`` locally — the cloud is authoritative.
This test pins:

  1. ``CloudEventEmitter.emit_single_item_event`` continues to omit
     ``lot_id`` from the emitted payload (Pi defers to cloud's
     pairing-row resolution by design — sending nothing keeps the
     contract one-way).
  2. The rename from ``_mint_pi_lot_for_inventory_only_pick`` to
     ``_populate_pi_lot_mirror_from_cloud`` is bound on the ScaleHandler
     class and the legacy attribute name is GONE — guards against a
     half-applied rename leaving callers calling the wrong symbol.
"""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import sys

import pytest


# Ensure ``server`` package imports resolve under pytest's working dir.
LIVE_SHELF_DIR = Path(__file__).resolve().parents[2]
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB with migrations (including ``cloud_outbox``)."""
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


# ---------------------------------------------------------------------------
# CloudEventEmitter.emit_single_item_event payload shape
# ---------------------------------------------------------------------------


def test_emit_single_item_event_omits_lot_id_when_caller_does_not_supply(conn):
    """Default contract: cloud resolves lot_id from scale_pairings.

    The Pi sends ``product_id`` (or omits it for cloud-resolved
    pairings) but never ``lot_id`` — the cloud function looks up
    scale_pairings.lot_id by (user_id, device_id, scale_id, kind=
    'live_scale') and pins to that lot. Sending lot_id from the Pi
    would create two sources of truth and risk drift.
    """
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_single_item_event(
        scale_id="scale-03",
        product_id=None,
        delta_g=-100.0,
        noise_floor_g=2.0,
        refill_threshold_g=5.0,
        depleted=False,
        occurred_at="2026-04-27T10:00:00.000Z",
    )
    assert cid is not None
    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox"
    ).fetchone()
    assert row is not None
    payload = json.loads(row["payload_json"])
    assert payload["scale_id"] == "scale-03"
    assert payload["kind"] == "live_scale"
    assert payload["event_kind"] == "consumed"
    # Pi MUST NOT include lot_id — cloud resolution is the contract.
    assert "lot_id" not in payload, (
        "emit_single_item_event payload should not include lot_id; cloud "
        f"resolves it via scale_pairings. Got payload={payload!r}"
    )


def test_emit_single_item_event_depleted_branch_keeps_payload_clean(conn):
    """The depleted branch must also omit lot_id."""
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_single_item_event(
        scale_id="scale-03",
        product_id=None,
        delta_g=-500.0,
        noise_floor_g=2.0,
        refill_threshold_g=5.0,
        depleted=True,
        occurred_at="2026-04-27T10:00:00.000Z",
    )
    assert cid is not None
    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox"
    ).fetchone()
    payload = json.loads(row["payload_json"])
    assert payload["event_kind"] == "depleted"
    assert "lot_id" not in payload


# ---------------------------------------------------------------------------
# Rename guard: _populate_pi_lot_mirror_from_cloud (was
# _mint_pi_lot_for_inventory_only_pick).
# ---------------------------------------------------------------------------


def test_populate_pi_lot_mirror_method_exists_under_new_name():
    """The Pi-local cache populate helper must expose the new name."""
    assert hasattr(ScaleHandler, "_populate_pi_lot_mirror_from_cloud"), (
        "ScaleHandler must expose _populate_pi_lot_mirror_from_cloud after "
        "the 2026-04-27 rename. Old call sites pointing at the old name "
        "will fail with AttributeError at runtime."
    )


def test_old_mint_method_name_is_gone():
    """The misleading old name must NOT survive the rename.

    The mint terminology suggests a creation operation; the helper is
    actually a Pi-local cache populate against an existing cloud row.
    Leaving the old binding around invites future contributors to call
    it again under the wrong mental model.
    """
    assert not hasattr(ScaleHandler, "_mint_pi_lot_for_inventory_only_pick"), (
        "ScaleHandler still binds the legacy mint method name. Rename to "
        "_populate_pi_lot_mirror_from_cloud everywhere."
    )
