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

from server.cloud import event_overrides_poller as eop_mod  # noqa: E402
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


# ---------------------------------------------------------------------------
# Gap G3 + G4 + G7 + G9 — direct regression coverage.
# ---------------------------------------------------------------------------


def test_g3_ambiguous_fallback_skips_without_mutating_either_lot(
    conn, tmp_path, caplog,
):
    """Gap G3: when the resolved_lot_id lookup misses (no cloud_lots
    mirror row) AND >1 active Pi lot exists for the product, the
    fallback must REFUSE to apply — otherwise it picks the wrong lot
    and silently mutates it.

    Asserts: NEITHER lot is touched, WARNING logged, watermark NOT
    advanced (TRANSIENT skip), and the /healthz ambiguous-skip counter
    increments.
    """
    # Two active in-flight Pi lots for the same product. The cloud
    # sends an override with a resolved_lot_id that has NO cloud_lots
    # mirror row (G3 trigger).
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
    lot_a = _seed_pi_lot(
        conn, product_id="prod-multi", pickup_event_id="pi-evt-A",
        status="in_flight", current_weight_g=600.0,
        last_seen_at="2026-04-26T09:00:00Z",
    )
    lot_b = _seed_pi_lot(
        conn, product_id="prod-multi", pickup_event_id="pi-evt-B",
        status="in_flight", current_weight_g=400.0,
        last_seen_at="2026-04-26T11:00:00Z",  # would win the legacy heuristic
    )
    # NO cloud_lots mirror row for "cloud-lot-unhydrated".

    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-amb", "prod-multi", "cloud-lot-unhydrated", 0.25,
            updated_at="2026-04-26T12:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )

    with caplog.at_level("WARNING"):
        applied = poller.tick_once()

    assert applied == 0
    # NEITHER lot is mutated. The wrong-lot rewrite was the G3 bug.
    # Verify weight AND last_seen_at — a regression that silently
    # stamped last_seen_at without changing weight would still mutate
    # state we care about.
    row_a = conn.execute(
        "SELECT current_weight_g, last_seen_at FROM lots WHERE lot_id = ?",
        (lot_a,),
    ).fetchone()
    row_b = conn.execute(
        "SELECT current_weight_g, last_seen_at FROM lots WHERE lot_id = ?",
        (lot_b,),
    ).fetchone()
    assert row_a["current_weight_g"] == pytest.approx(600.0)
    assert row_b["current_weight_g"] == pytest.approx(400.0)
    assert row_a["last_seen_at"] == "2026-04-26T09:00:00Z"
    assert row_b["last_seen_at"] == "2026-04-26T11:00:00Z"

    # Watermark NOT advanced — ambiguous is TRANSIENT.
    assert poller.high_watermark is None

    # WARNING logged with override_id + product.
    matching = [
        r for r in caplog.records
        if r.levelname == "WARNING" and "AMBIGUOUS" in r.getMessage()
    ]
    assert matching, "expected an AMBIGUOUS WARNING log"
    msg = matching[0].getMessage()
    assert "prod-multi" in msg
    assert "evt-amb" in msg or "override_id" in msg

    # /healthz counter incremented.
    assert poller.skipped_ambiguous_count == 1


def test_g3_single_lot_fallback_still_applies(conn, tmp_path):
    """Gap G3: when only ONE active Pi lot exists for the product,
    the fallback is unambiguous and should apply as before.

    This is the safe case the G3 fix must NOT regress — the audit
    only flagged the >1 case.
    """
    # Product + exactly one in_flight Pi lot. No cloud_lots mirror
    # row (forces the fallback path).
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-solo', 'Solo', 1000.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    pi_lot = _seed_pi_lot(
        conn, product_id="prod-solo", pickup_event_id="pi-evt-solo",
        status="in_flight", current_weight_g=1000.0,
    )

    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-solo", "prod-solo", "cloud-lot-unhydrated-solo", 0.4,
            updated_at="2026-04-26T13:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 1
    # 0.4 * 1000 = 400g.
    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (pi_lot,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(400.0)
    # Watermark advanced — clean apply.
    assert poller.high_watermark == "2026-04-26T13:00:00Z"
    # /healthz counter untouched.
    assert poller.skipped_ambiguous_count == 0


def test_g7_permanent_skip_zero_net_weight_advances_watermark(
    conn, tmp_path, caplog,
):
    """Gap G7: a row with PERMANENT-skip reason (zero/null
    net_weight_g) must advance the watermark — otherwise the cursor
    freezes forever on a row no retry will ever apply."""
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-nonet', 'NoNet', NULL, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g, shelf_id
        ) VALUES (?, 'prod-nonet', 'on_shelf', 250.0, 'live_shelf')
        """,
        (lot_id,),
    )
    conn.commit()

    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-nonet", "prod-nonet", "cloud-lot-nonet", 0.5,
            updated_at="2026-04-26T14:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    with caplog.at_level("WARNING"):
        applied = poller.tick_once()

    assert applied == 0
    # G7: PERMANENT skips must advance the watermark.
    assert poller.high_watermark == "2026-04-26T14:00:00Z"
    # The lot's weight is untouched (apply was skipped).
    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(250.0)
    # PERMANENT logged loudly.
    assert any(
        r.levelname == "WARNING" and "PERMANENT" in r.getMessage()
        for r in caplog.records
    )


def test_g7_missing_product_is_transient_then_promoted_permanent(
    conn, tmp_path, caplog, monkeypatch,
):
    """Gap G7: a row whose product_id doesn't exist on the Pi can mean
    either (a) cloud product_sync hasn't caught up yet or (b) the
    product was genuinely deleted in cloud. The poller can't tell from
    inside, so it classifies the skip as TRANSIENT for the first few
    consecutive ticks (giving product_sync time to hydrate), then
    promotes to PERMANENT.

    This test pins both halves: TRANSIENT freezes the watermark on
    early ticks, PERMANENT advances it after the threshold.
    """
    # Pin the threshold low for the test (default is 5).
    monkeypatch.setattr(eop_mod, "_PERMANENT_MISS_THRESHOLD", 3)

    state_path = tmp_path / "last_overrides_sync.json"
    payload = _override_payload(
        "evt-ghost", "prod-ghost", "cloud-lot-ghost", 1.0,
        updated_at="2026-04-26T15:00:00Z",
    )
    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )

    # Ticks 1 + 2: TRANSIENT — watermark frozen.
    assert poller.tick_once() == 0
    assert poller.high_watermark is None
    assert poller.tick_once() == 0
    assert poller.high_watermark is None

    # Tick 3: promoted to PERMANENT — watermark advances.
    with caplog.at_level("WARNING"):
        assert poller.tick_once() == 0
    assert poller.high_watermark == "2026-04-26T15:00:00Z"

    # PERMANENT WARNING logged with the override_id + product_id.
    promote_logs = [
        r for r in caplog.records
        if r.levelname == "WARNING"
        and "missing on Pi" in r.getMessage()
        and "PERMANENT" in r.getMessage()
    ]
    assert promote_logs, "expected a PERMANENT promotion WARNING"
    assert "prod-ghost" in promote_logs[0].getMessage()


def test_g7_state_write_oserror_reverts_state_and_leaves_backoff_elevated(
    conn, tmp_path, monkeypatch, caplog,
):
    """Gap G4 (sibling to G2 G4): if state.write raises OSError after
    a successful apply, the in-memory state must revert to the prior
    watermark AND backoff must NOT reset (stay elevated). Otherwise
    the next tick would loop on the stale in-memory cursor while disk
    sees nothing — silently losing the override on next boot.
    """
    lot_id = _seed_product_and_lot(conn, net_weight_g=1000.0)
    state_path = tmp_path / "last_overrides_sync.json"
    # Prime state with a known prior watermark so we can detect a revert.
    state_path.write_text(
        json.dumps({"version": 1, "high_watermark": "2026-04-26T08:00:00Z"})
    )

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-oserr", "prod-1", "cloud-lot-oserr", 0.5,
            updated_at="2026-04-26T16:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    # Force-elevate the backoff so we can detect that it's left alone.
    poller._backoff_s = 8.0  # noqa: SLF001

    # Monkey-patch _SyncState.write to raise OSError on the apply path.
    def boom(self, path):  # noqa: ARG001
        raise OSError("simulated disk full")
    monkeypatch.setattr(eop_mod._SyncState, "write", boom)

    with caplog.at_level("WARNING"):
        applied = poller.tick_once()

    # The DB row was still updated (lot weight reflects the apply); the
    # failure was purely on persisting the watermark.
    assert applied == 1
    row = conn.execute(
        "SELECT current_weight_g FROM lots WHERE lot_id = ?", (lot_id,),
    ).fetchone()
    assert row["current_weight_g"] == pytest.approx(500.0)

    # G4: in-memory state REVERTED to the prior watermark so disk and
    # memory agree.
    assert poller.high_watermark == "2026-04-26T08:00:00Z"

    # G4: backoff is left elevated (NOT reset to INITIAL_BACKOFF_S).
    assert poller._backoff_s == 8.0  # noqa: SLF001

    # A WARNING was emitted noting the revert.
    assert any(
        r.levelname == "WARNING"
        and "reverting" in r.getMessage().lower()
        for r in caplog.records
    )


def test_g4_successful_state_write_resets_backoff(conn, tmp_path):
    """Companion to the G4 OSError test: on the success path, backoff
    DOES reset. This pins the ordering — reset happens AFTER state.write
    completes, not before.
    """
    _ = _seed_product_and_lot(conn, net_weight_g=1000.0)
    state_path = tmp_path / "last_overrides_sync.json"

    client = MagicMock()
    fake_fetch = MagicMock(
        return_value=_override_payload(
            "evt-ok", "prod-1", "cloud-lot-ok", 0.5,
            updated_at="2026-04-26T17:00:00Z",
        ),
    )
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    poller._backoff_s = 16.0  # noqa: SLF001 - start elevated
    poller.tick_once()

    # Successful write → backoff reset, watermark advanced.
    assert poller._backoff_s == 1.0  # noqa: SLF001 - INITIAL_BACKOFF_S
    assert poller.high_watermark == "2026-04-26T17:00:00Z"


def test_g7_mixed_batch_permanent_in_middle_does_not_freeze_chain(
    conn, tmp_path,
):
    """Gap G7 + G9 convergence: a batch with [APPLIED, PERMANENT,
    APPLIED] (chronological) must advance the watermark all the way
    to the last row — the PERMANENT in the middle must NOT freeze it.

    Pre-G7 this was the bug: any skip (regardless of cause) froze the
    cursor on the first non-applied row.
    """
    # Two products that apply cleanly + one with zero net_weight_g
    # (PERMANENT skip) sandwiched between them.
    _seed_product_and_lot(conn, product_id="prod-mid-a", net_weight_g=400.0)
    _seed_product_and_lot(conn, product_id="prod-mid-c", net_weight_g=600.0)
    # Product with NULL net_weight_g + matching lot → PERMANENT skip.
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-mid-b', 'NoNet', NULL, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    lot_b = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g, shelf_id
        ) VALUES (?, 'prod-mid-b', 'on_shelf', 100.0, 'live_shelf')
        """,
        (lot_b,),
    )
    conn.commit()

    # Build a payload with three rows in chronological order.
    payload = {
        "overrides": [
            {
                "override_id": "o-a", "client_event_id": "ea",
                "updated_at": "2026-04-26T18:00:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-a",
                "product_id": "prod-mid-a", "pi_event_id": None,
            },
            {
                "override_id": "o-b", "client_event_id": "eb",
                "updated_at": "2026-04-26T18:01:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-b",
                "product_id": "prod-mid-b", "pi_event_id": None,
            },
            {
                "override_id": "o-c", "client_event_id": "ec",
                "updated_at": "2026-04-26T18:02:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-c",
                "product_id": "prod-mid-c", "pi_event_id": None,
            },
        ],
        "lots": [
            {"lot_id": "cloud-lot-a", "product_id": "prod-mid-a",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T18:00:00Z"},
            {"lot_id": "cloud-lot-b", "product_id": "prod-mid-b",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T18:01:00Z"},
            {"lot_id": "cloud-lot-c", "product_id": "prod-mid-c",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T18:02:00Z"},
        ],
    }
    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    # Two rows applied (A + C); the middle row was PERMANENT-skipped.
    assert applied == 2
    # Critical: watermark advanced PAST the PERMANENT row to row C's
    # timestamp. Pre-G7 this would have frozen at A's timestamp.
    assert poller.high_watermark == "2026-04-26T18:02:00Z"


def test_g7_transient_in_middle_freezes_at_that_row(conn, tmp_path):
    """Companion to the mixed-batch test: a TRANSIENT skip in the
    middle of an ordered batch MUST freeze the watermark at the row
    BEFORE the TRANSIENT — even if rows after it would apply cleanly.

    This pins the policy: transient = freeze, permanent = advance,
    even within a single batch.
    """
    # Three products: A applies, B causes TRANSIENT (no lot at all for
    # product), C would apply.
    _seed_product_and_lot(conn, product_id="prod-t-a", net_weight_g=400.0)
    # B: product exists, NO lot → TRANSIENT (no active Pi lot).
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-t-b', 'B', 500.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    _seed_product_and_lot(conn, product_id="prod-t-c", net_weight_g=600.0)

    payload = {
        "overrides": [
            {
                "override_id": "o-ta", "client_event_id": "eta",
                "updated_at": "2026-04-26T19:00:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-ta",
                "product_id": "prod-t-a", "pi_event_id": None,
            },
            {
                "override_id": "o-tb", "client_event_id": "etb",
                "updated_at": "2026-04-26T19:01:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-tb",
                "product_id": "prod-t-b", "pi_event_id": None,
            },
            {
                "override_id": "o-tc", "client_event_id": "etc",
                "updated_at": "2026-04-26T19:02:00Z",
                "stock_qty_override": None,
                "event_kind_override": None,
                "is_voided": False, "macro_logging_enabled": True,
                "resolved_lot_id": "cloud-lot-tc",
                "product_id": "prod-t-c", "pi_event_id": None,
            },
        ],
        "lots": [
            {"lot_id": "cloud-lot-ta", "product_id": "prod-t-a",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T19:00:00Z"},
            {"lot_id": "cloud-lot-tb", "product_id": "prod-t-b",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T19:01:00Z"},
            {"lot_id": "cloud-lot-tc", "product_id": "prod-t-c",
             "qty_containers": 0.5, "last_update_source": "manual",
             "last_update_ts": "2026-04-26T19:02:00Z"},
        ],
    }
    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )
    applied = poller.tick_once()

    # Only A applied; B was TRANSIENT (no lot), C never got a chance
    # because the watermark logic stops at the first TRANSIENT.
    # NOTE: the apply loop processes all three rows — C does apply to
    # its lot — but the watermark only advances over the prefix UP TO
    # the first TRANSIENT, so the cursor freezes at A.
    assert applied == 2  # A and C apply mechanically
    # Watermark frozen at A's timestamp (the last APPLIED before B's
    # TRANSIENT skip).
    assert poller.high_watermark == "2026-04-26T19:00:00Z"


# ---------------------------------------------------------------------------
# Gap G10: cold-start ordering — wait on products_synced Event
# ---------------------------------------------------------------------------


def test_g10_proceeds_immediately_when_event_already_set(conn, tmp_path):
    """If product_sync has already latched the Event before our first
    tick (the common case under steady-state operation), we proceed
    without burning any wait time."""
    import threading as _threading
    import time as _time

    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    products_synced = _threading.Event()
    products_synced.set()  # latched before tick fires

    client = MagicMock()
    fake_fetch = MagicMock(return_value={"overrides": [], "lots": []})
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=10.0,  # would block tick for 10s if Event unset
    )
    t0 = _time.monotonic()
    poller.tick_once()
    elapsed = _time.monotonic() - t0
    assert elapsed < 1.0, (
        f"tick should have proceeded immediately; took {elapsed:.2f}s"
    )
    fake_fetch.assert_called_once()


def test_g10_times_out_and_proceeds_with_warning(conn, tmp_path, caplog):
    """If product_sync never latches the Event (failed boot fetch), we
    log a WARNING and proceed after the configured timeout — the
    TRANSIENT classification (G7) handles the residual races."""
    import logging as _logging
    import threading as _threading

    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    products_synced = _threading.Event()  # NEVER set

    client = MagicMock()
    fake_fetch = MagicMock(return_value={"overrides": [], "lots": []})
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=0.05,  # 50ms test timeout
    )
    with caplog.at_level(_logging.WARNING, logger="server.cloud.event_overrides_poller"):
        poller.tick_once()
    fake_fetch.assert_called_once()
    assert any(
        "products_synced wait expired" in rec.message for rec in caplog.records
    ), "WARNING about expired wait must be logged"


def test_g10_waits_only_on_first_tick(conn, tmp_path):
    """Second tick must NOT re-wait — by then either product_sync has
    succeeded or it never will, and a second 5s sleep won't help."""
    import threading as _threading
    import time as _time

    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    products_synced = _threading.Event()  # NEVER set

    client = MagicMock()
    fake_fetch = MagicMock(return_value={"overrides": [], "lots": []})
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
        products_synced_event=products_synced,
        products_synced_wait_s=0.05,
    )
    # First tick — waits, then proceeds (>=50ms elapsed).
    poller.tick_once()
    # Second tick — must NOT wait.
    t0 = _time.monotonic()
    poller.tick_once()
    elapsed = _time.monotonic() - t0
    assert elapsed < 0.04, (
        f"second tick must not wait; took {elapsed*1000:.0f}ms"
    )


def test_g10_no_event_passed_works_for_backcompat(conn, tmp_path):
    """Callers that don't wire the Event (tests, old call sites) still
    work — no wait, no AttributeError."""
    _ = _seed_product_and_lot(conn)
    state_path = tmp_path / "last_overrides_sync.json"
    client = MagicMock()
    fake_fetch = MagicMock(return_value={"overrides": [], "lots": []})
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
        # products_synced_event omitted
    )
    poller.tick_once()


# ---------------------------------------------------------------------------
# C2-04 (2026-06-15) — non-empty overrides + empty lots[] must not freeze
# ---------------------------------------------------------------------------
#
# Before the fix, _apply_lot_states early-returned whenever ``lots`` was
# empty, leaving every override at the TRANSIENT default. The caller treats
# TRANSIENT as "freeze the watermark", so a batch carrying REAL overrides
# but an empty ``lots[]`` froze the cursor FOREVER — the same override was
# re-fetched every tick and never advanced, blocking every newer override
# behind it. Per the cloud contract (a missing post-reconcile lot row means
# the cloud tombstoned/never-had the lot), that case is PERMANENT and the
# watermark MUST advance. The fix removes the early return so the
# per-override loop classifies each one PERMANENT.


def test_overrides_with_empty_lots_advances_watermark_not_frozen(
    conn, tmp_path, caplog,
):
    """C2-04: a batch with a non-empty override but empty lots[] must
    advance the watermark past it (PERMANENT skip), not freeze forever.

    Mutation check: with the old early-return the watermark stays None
    (frozen) and this assertion goes RED.
    """
    # Product exists on the Pi (so the freeze is NOT a missing-product
    # TRANSIENT — it is purely the empty-lots[] path under test).
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, net_weight_g, certified,
            created_at, updated_at
        ) VALUES ('prod-empty-lots', 'P', 1000.0, 1,
                  datetime('now'), datetime('now'))
        """,
    )
    conn.commit()
    state_path = tmp_path / "last_overrides_sync.json"

    payload = _override_payload(
        "evt-empty", "prod-empty-lots", "cloud-lot-empty", 0.5,
        updated_at="2026-04-21T12:00:00Z",
    )
    # The bug trigger: real override, but the cloud sent NO lots[] rows.
    payload["lots"] = []

    client = MagicMock()
    fake_fetch = MagicMock(return_value=payload)
    poller = EventOverridesPoller(
        client, conn, state_path=state_path,
        fetch_overrides_fn=fake_fetch,
    )

    with caplog.at_level("WARNING"):
        applied = poller.tick_once()

    # Nothing applied (no lot to write), but the watermark ADVANCED past
    # the batch instead of freezing at None forever.
    assert applied == 0
    assert poller.high_watermark == "2026-04-21T12:00:00Z", (
        "watermark must advance past an overrides+empty-lots batch"
    )
    # The override was actually classified (not silently dropped): the
    # PERMANENT 'no matching lot in payload' WARNING was logged for it.
    assert any(
        r.levelname == "WARNING"
        and "no matching lot in payload" in r.getMessage()
        and "PERMANENT" in r.getMessage()
        for r in caplog.records
    ), [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]

    # Watermark persisted to disk so a restart doesn't re-pull the row.
    state = json.loads(state_path.read_text())
    assert state["high_watermark"] == "2026-04-21T12:00:00Z"

    # Second tick: because the watermark advanced, the cloud is queried
    # from AFTER this batch (the row is not stuck being re-fetched).
    fake_fetch.return_value = {"overrides": [], "lots": []}
    poller.tick_once()
    assert (
        fake_fetch.call_args_list[-1].kwargs["updated_since"]
        == "2026-04-21T12:00:00Z"
    )


def test_empty_overrides_and_empty_lots_still_no_churn(conn, tmp_path):
    """C2-04 regression guard: removing the early return must NOT cause
    state churn on a genuinely empty batch (no overrides, no lots). The
    watermark file stays untouched, exactly as before.
    """
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
