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
    will re-materialize.

    Audit finding #4: a skipped override FREEZES the watermark so the
    next tick re-fetches it. Otherwise the override is permanently
    lost. The retry path is the Pi observing the lot via a future
    placement.
    """
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
    # Watermark stays None (initial) because the only override in the
    # window was skipped. Next tick will retry from the same starting
    # point.
    assert poller.high_watermark is None


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


# ---------------------------------------------------------------------------
# Audit findings #2, #4, #9 — direct regression coverage.
# ---------------------------------------------------------------------------


def _seed_pi_lot(
    conn: sqlite3.Connection,
    *,
    product_id: str,
    pickup_event_id: str | None,
    status: str = "in_flight",
    current_weight_g: float = 100.0,
    last_seen_at: str | None = None,
    in_flight_since: str | None = "2026-04-26T08:00:00Z",
    shelf_id: str = "catch_all",
) -> str:
    """Seed one Pi lot with explicit pickup_event_id for catch-all linkage."""
    lot_id = str(uuid.uuid4())
    if status != "in_flight":
        in_flight_since = None
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g,
            last_seen_at, in_flight_since, pickup_event_id, shelf_id
        ) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
        """,
        (
            lot_id, product_id, status, current_weight_g,
            last_seen_at, in_flight_since, pickup_event_id, shelf_id,
        ),
    )
    conn.commit()
    return lot_id


def _seed_cloud_lot_mirror(
    conn: sqlite3.Connection,
    *,
    cloud_lot_id: str,
    product_id: str,
    pickup_event_id: str | None,
    qty_containers: float = 1.0,
    in_flight_since: str | None = None,
    in_flight_kind: str | None = None,
) -> None:
    """Seed a cloud_lots mirror row keyed by cloud lot_id."""
    conn.execute(
        """
        INSERT INTO cloud_lots (
            lot_id, product_id, qty_containers, updated_at,
            pickup_event_id, in_flight_since, in_flight_kind
        ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
        """,
        (
            cloud_lot_id, product_id, qty_containers,
            pickup_event_id, in_flight_since, in_flight_kind,
        ),
    )
    conn.commit()


def test_resolved_lot_id_picks_correct_lot_not_most_recent(conn, tmp_path):
    """Audit finding #2: when multiple Pi lots exist for the same
    product, the override must target the lot whose cloud_lots mirror
    has the matching pickup_event_id — NOT the most-recently-used lot
    (which is what the legacy heuristic picked)."""
    # Single product with two ACTIVE in-flight Pi lots, distinguished
    # only by their pickup_event_id. The "most recently used" lot is
    # WRONG_LOT (later last_seen_at); the cloud override actually
    # targets RIGHT_LOT.
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-multi', 'Multi-lot', 800.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    right_lot = _seed_pi_lot(
        conn, product_id="prod-multi", pickup_event_id="pi-evt-RIGHT",
        status="in_flight", current_weight_g=600.0,
        last_seen_at="2026-04-26T09:00:00Z",
    )
    wrong_lot = _seed_pi_lot(
        conn, product_id="prod-multi", pickup_event_id="pi-evt-WRONG",
        status="in_flight", current_weight_g=400.0,
        last_seen_at="2026-04-26T11:00:00Z",  # most recent → legacy picks this
    )
    # cloud_lots mirror for the cloud lot the override actually targets,
    # carrying the pickup_event_id link to RIGHT_LOT.
    _seed_cloud_lot_mirror(
        conn, cloud_lot_id="cloud-lot-RIGHT",
        product_id="prod-multi", pickup_event_id="pi-evt-RIGHT",
    )

    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-multi", "prod-multi", "cloud-lot-RIGHT", 0.25,
            updated_at="2026-04-26T12:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()
    assert applied == 1

    # RIGHT_LOT got the new weight (0.25 containers * 800g = 200g).
    right = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (right_lot,),
    ).fetchone()
    assert right["current_weight_g"] == pytest.approx(200.0)
    # WRONG_LOT was untouched — the heuristic-picked lot is NOT what
    # the override targeted.
    wrong = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (wrong_lot,),
    ).fetchone()
    assert wrong["current_weight_g"] == pytest.approx(400.0)


def test_skipped_override_freezes_watermark_and_retries(conn, tmp_path):
    """Audit finding #4: a SKIP must NOT advance the watermark.
    Multi-call: tick 1 fails to apply (no Pi product) → watermark stays;
    tick 2 with the product hydrated re-applies the same override."""
    # No product yet — the override SKIPs at the missing-product step.
    state_path = tmp_path / "last_overrides_sync.json"
    payload_v1 = _override_payload(
        "evt-late", "prod-late", "cloud-lot-late", 0.5,
        updated_at="2026-04-26T10:00:00Z",
    )
    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload_v1)

    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()
    assert applied == 0
    # Watermark FROZEN at None (initial) — finding #4.
    assert poller.high_watermark is None
    # State file MUST NOT be written for a frozen watermark = None
    # transition (it was None before, still None).
    assert not state_path.exists()

    # Tick 2: the product + lot have been hydrated by other pollers.
    # Cloud sends the SAME override again (same updated_at) because the
    # watermark didn't advance.
    _seed_product_and_lot(
        conn, product_id="prod-late", net_weight_g=600.0,
        initial_weight_g=600.0,
    )
    fake_fetch.return_value = payload_v1  # same row, idempotent retry
    applied2 = poller.tick_once()
    assert applied2 == 1
    # Now the watermark advances.
    assert poller.high_watermark == "2026-04-26T10:00:00Z"


def test_in_flight_since_flip_propagates_to_pi_lot(conn, tmp_path):
    """Audit finding #9: when the cloud override sets in_flight_since,
    the Pi's matching lots row gets ``status='in_flight'`` and
    ``in_flight_since`` populated. When the cloud clears it, the Pi
    flips back to on_shelf."""
    # Seed a Pi lot in on_shelf state with no in-flight cols, plus
    # a cloud_lots mirror linked via pickup_event_id (the link key the
    # poller uses).
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-flip', 'Flip', 500.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    pi_lot = _seed_pi_lot(
        conn, product_id="prod-flip", pickup_event_id="pi-evt-FLIP",
        status="on_shelf", current_weight_g=500.0,
        in_flight_since=None,
    )
    _seed_cloud_lot_mirror(
        conn, cloud_lot_id="cloud-lot-FLIP",
        product_id="prod-flip", pickup_event_id="pi-evt-FLIP",
    )

    state_path = tmp_path / "last_overrides_sync.json"
    # Cloud override flips lot to in_flight at 11:00.
    payload = _override_payload(
        "evt-flip", "prod-flip", "cloud-lot-FLIP", 1.0,
        updated_at="2026-04-26T11:00:00Z",
    )
    payload["lots"][0]["in_flight_since"] = "2026-04-26T11:00:00Z"

    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()
    assert applied == 1

    row = conn.execute(
        "SELECT status, in_flight_since FROM lots WHERE lot_id = ?",
        (pi_lot,),
    ).fetchone()
    assert row["status"] == "in_flight"
    assert row["in_flight_since"] == "2026-04-26T11:00:00Z"

    # Cloud clears in_flight_since on a follow-up override → Pi flips
    # back to on_shelf.
    payload2 = _override_payload(
        "evt-flip", "prod-flip", "cloud-lot-FLIP", 1.0,
        updated_at="2026-04-26T12:00:00Z",
    )
    payload2["lots"][0]["in_flight_since"] = None
    fake_fetch.return_value = payload2
    poller.tick_once()

    row2 = conn.execute(
        "SELECT status, in_flight_since FROM lots WHERE lot_id = ?",
        (pi_lot,),
    ).fetchone()
    assert row2["status"] == "on_shelf"
    assert row2["in_flight_since"] is None


def test_in_flight_side_untouched_when_override_omits_key(conn, tmp_path):
    """Audit finding #9 (conservative side): an override whose lots[]
    entry does NOT carry ``in_flight_since`` must leave the Pi's
    in-flight columns untouched (only the weight changes)."""
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-keep', 'Keep', 1000.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    # Seed an in_flight Pi lot.
    pi_lot = _seed_pi_lot(
        conn, product_id="prod-keep", pickup_event_id="pi-evt-KEEP",
        status="in_flight", current_weight_g=1000.0,
        in_flight_since="2026-04-26T07:00:00Z",
    )
    _seed_cloud_lot_mirror(
        conn, cloud_lot_id="cloud-lot-KEEP",
        product_id="prod-keep", pickup_event_id="pi-evt-KEEP",
    )

    state_path = tmp_path / "last_overrides_sync.json"
    # Override has NO in_flight_since key in the lots[] row → Pi
    # in_flight columns stay put.
    payload = _override_payload(
        "evt-keep", "prod-keep", "cloud-lot-KEEP", 0.5,
        updated_at="2026-04-26T13:00:00Z",
    )
    assert "in_flight_since" not in payload["lots"][0]

    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    poller.tick_once()

    row = conn.execute(
        "SELECT status, in_flight_since, current_weight_g "
        "  FROM lots WHERE lot_id = ?",
        (pi_lot,),
    ).fetchone()
    # Weight changed (0.5 * 1000g = 500g), but in_flight cols unchanged.
    assert row["current_weight_g"] == pytest.approx(500.0)
    assert row["status"] == "in_flight"
    assert row["in_flight_since"] == "2026-04-26T07:00:00Z"


def test_legacy_payload_without_resolved_lot_id_falls_back_to_heuristic(
    conn, tmp_path,
):
    """Old edge function payloads where ``resolved_lot_id`` is null
    must still apply via the legacy product_id-based heuristic. We
    don't want to break payloads in flight when the new code lands."""
    lot_id = _seed_product_and_lot(
        conn, product_id="prod-legacy", net_weight_g=400.0,
    )
    state_path = tmp_path / "last_overrides_sync.json"

    payload = _override_payload(
        "evt-legacy", "prod-legacy", "cloud-lot-legacy", 0.75,
        updated_at="2026-04-26T15:00:00Z",
    )
    # Strip the resolved_lot_id from the override (legacy shape).
    payload["overrides"][0]["resolved_lot_id"] = None

    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()
    assert applied == 1

    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(0.75 * 400.0)
