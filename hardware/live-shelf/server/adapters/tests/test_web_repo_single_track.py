"""Unit tests for ``RepoWebAdapter.get_single_track_scales`` /
``get_single_track_state``.

The web_repo adapter is what the Flask routes hit at runtime — the
template-level tests in ``server/web/tests/test_routes.py`` use a
FakeRepo to keep the test surface narrow, but the FakeRepo is only
trustworthy if the real adapter agrees with its contract. These tests
drive the real adapter against a real in-memory SQLite, with:

  * the products + scale_pairings + scale_events shape mirrored from
    the production migrations, and
  * the volatile ``_SCALE_RUNTIME_STATE`` heartbeat cache populated /
    cleared between tests so the runtime override branch is exercised.

Surfaces under test:

  * empty input → empty list (and matching get_single_track_state)
  * fully paired row joins through to product name/brand
  * unpaired row (product_id IS NULL) renders without a join crash
  * lot pointer round-trips
  * latest scale_events row is the one that ends up in the dict
    (multiple rows present, newest by ts wins)
  * heartbeat runtime cache supersedes the scale_events weight when
    fresh, falls back when absent
  * is_online flag honors a 60s heartbeat window
  * sort order: paired-by-name asc, unpaired last
"""

from __future__ import annotations

import datetime as _dt
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.web_repo import RepoWebAdapter  # noqa: E402
from server.handlers import scale_events as _scale_events  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db_conn():
    conn = init_db(":memory:")
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture()
def db_lock() -> threading.RLock:
    return threading.RLock()


@pytest.fixture()
def adapter(
    db_conn: sqlite3.Connection, db_lock: threading.RLock,
) -> RepoWebAdapter:
    return RepoWebAdapter(db_conn, db_lock=db_lock)


@pytest.fixture(autouse=True)
def _clear_runtime_cache():
    """Ensure each test starts with a clean ``_SCALE_RUNTIME_STATE``.

    The cache is module-global; without resetting between tests, a
    previous test's heartbeat can leak into a later test's "no
    heartbeat" branch and silently mask regressions.
    """
    with _scale_events._SCALE_RUNTIME_LOCK:
        _scale_events._SCALE_RUNTIME_STATE.clear()
    yield
    with _scale_events._SCALE_RUNTIME_LOCK:
        _scale_events._SCALE_RUNTIME_STATE.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_product(conn: sqlite3.Connection, *, name: str, brand: str) -> str:
    p = storage_repo.create_product(
        conn,
        ProductIn(
            name=name,
            brand=brand,
            barcode=f"bc-{name.lower().replace(' ', '-')}",
            net_weight_g=500.0,
            gross_weight_g=520.0,
            tare_weight_g=20.0,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    return p.product_id


def _seed_pairing(
    conn: sqlite3.Connection,
    *,
    device_id: str,
    product_id: str | None = None,
    lot_id: str | None = None,
    last_heartbeat_ts: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO scale_pairings (
            device_id, shelf_id, product_id, lot_id,
            first_seen_at, last_heartbeat_ts
        ) VALUES (?, 'single_item', ?, ?, ?, ?)
        """,
        (
            device_id, product_id, lot_id,
            "2026-04-28T11:00:00Z", last_heartbeat_ts,
        ),
    )
    conn.commit()


def _seed_scale_event(
    conn: sqlite3.Connection,
    *,
    event_id: str,
    device_id: str,
    ts: str,
    after_weight_g: float,
    delta_g: float,
    direction: str = "noise",
) -> None:
    conn.execute(
        """
        INSERT INTO scale_events (
            event_id, ts, device_id, delta_g,
            before_weight_g, after_weight_g, direction,
            shelf_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'single_item')
        """,
        (
            event_id, ts, device_id, delta_g,
            after_weight_g - delta_g, after_weight_g, direction,
        ),
    )
    conn.commit()


def _push_runtime(
    *, device_id: str, weight_g: float, stable: bool = True,
    age_s: float = 1.0,
) -> None:
    """Inject a heartbeat into the runtime cache. ``age_s`` lets tests
    exercise the freshness-TTL gate (10s window in production)."""
    ts = (
        _dt.datetime.now(_dt.timezone.utc)
        - _dt.timedelta(seconds=age_s)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with _scale_events._SCALE_RUNTIME_LOCK:
        _scale_events._SCALE_RUNTIME_STATE[device_id] = {
            "device_id": device_id,
            "weight_g": weight_g,
            "stable": stable,
            "ts": ts,
            "uptime_s": 100,
        }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_empty_when_no_pairings(adapter):
    assert adapter.get_single_track_scales() == []
    state = adapter.get_single_track_state()
    assert state == {
        "shelf_id": "single_item",
        "scales_total": 0,
        "scales_online": 0,
        "scales": [],
    }


def _seed_lot(
    conn: sqlite3.Connection, *, lot_id: str, product_id: str,
) -> None:
    """Insert a minimal on_shelf lot satisfying the lots.product_id FK so
    a scale_pairings row can reference it."""
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g,
            shelf_id
        ) VALUES (?, ?, 'on_shelf', 500.0, 'single_item')
        """,
        (lot_id, product_id),
    )
    conn.commit()


def test_paired_row_joins_product_fields(adapter, db_conn):
    """Spec contract: paired row exposes product_name + product_brand
    via the LEFT JOIN to ``products``. Asserts the join column landed
    in the dict (mutation: drop the JOIN → product_name is None →
    test fails)."""
    product_id = _seed_product(db_conn, name="Heinz Ketchup", brand="Heinz")
    _seed_lot(db_conn, lot_id="lot-1", product_id=product_id)
    _seed_pairing(
        db_conn, device_id="scale-A", product_id=product_id, lot_id="lot-1",
    )
    rows = adapter.get_single_track_scales()
    assert len(rows) == 1
    r = rows[0]
    assert r["device_id"] == "scale-A"
    assert r["shelf_id"] == "single_item"
    assert r["product_id"] == product_id
    assert r["product_name"] == "Heinz Ketchup"
    assert r["product_brand"] == "Heinz"
    assert r["lot_id"] == "lot-1"


def test_unpaired_row_does_not_crash(adapter, db_conn):
    """An ESP heartbeats and the auto-register handler mints a row
    with NULL product_id. The LEFT JOIN must still return the row —
    product_name + product_brand come back as None."""
    _seed_pairing(db_conn, device_id="scale-X", product_id=None, lot_id=None)
    rows = adapter.get_single_track_scales()
    assert len(rows) == 1
    assert rows[0]["product_id"] is None
    assert rows[0]["product_name"] is None
    assert rows[0]["product_brand"] is None
    assert rows[0]["lot_id"] is None


def test_no_events_yet_leaves_event_fields_none(adapter, db_conn):
    """A pairing with NO scale_events rows must set the last_event_*
    fields to None (template branches to "no events yet")."""
    _seed_pairing(db_conn, device_id="scale-Y", product_id=None)
    rows = adapter.get_single_track_scales()
    assert len(rows) == 1
    assert rows[0]["last_event_ts"] is None
    assert rows[0]["last_event_kind"] is None
    assert rows[0]["last_event_delta_g"] is None


def test_latest_scale_events_row_wins(adapter, db_conn):
    """Multiple scale_events rows for the same device_id → the newest
    by ``ts`` is the one whose fields land in the dict. Catches a
    regression where the ORDER BY is dropped or reversed."""
    pid = _seed_product(db_conn, name="Milk", brand="Brand")
    _seed_pairing(db_conn, device_id="scale-M", product_id=pid)
    _seed_scale_event(
        db_conn, event_id="ev-1", device_id="scale-M",
        ts="2026-04-28T08:00:00Z",
        after_weight_g=999.0, delta_g=-10.0, direction="noise",
    )
    _seed_scale_event(
        db_conn, event_id="ev-2", device_id="scale-M",
        ts="2026-04-28T12:00:00Z",
        after_weight_g=850.0, delta_g=-149.0, direction="noise",
    )
    _seed_scale_event(
        db_conn, event_id="ev-3", device_id="scale-M",
        ts="2026-04-28T10:00:00Z",  # middle by ts → MUST NOT win
        after_weight_g=900.0, delta_g=-99.0, direction="noise",
    )
    rows = adapter.get_single_track_scales()
    assert len(rows) == 1
    r = rows[0]
    assert r["last_event_ts"] == "2026-04-28T12:00:00Z"
    assert r["last_event_kind"] == "noise"
    assert r["last_event_delta_g"] == -149.0
    # current_weight falls back to after_weight_g of the latest event
    # because no heartbeat is in the runtime cache.
    assert r["current_weight_g"] == 850.0


def test_heartbeat_runtime_overrides_scale_events_weight(
    adapter, db_conn,
):
    """When a fresh heartbeat is in ``_SCALE_RUNTIME_STATE``, its
    weight + stable flag supersede the scale_events-derived value.
    Mirrors the live-shelf + catch-all "fresher heartbeat wins"
    convention."""
    pid = _seed_product(db_conn, name="Soda", brand="Brand")
    _seed_pairing(db_conn, device_id="scale-S", product_id=pid)
    _seed_scale_event(
        db_conn, event_id="ev-old", device_id="scale-S",
        ts="2026-04-28T08:00:00Z",
        after_weight_g=200.0, delta_g=-10.0, direction="noise",
    )
    _push_runtime(device_id="scale-S", weight_g=187.5, stable=True)
    rows = adapter.get_single_track_scales()
    r = rows[0]
    assert r["current_weight_g"] == 187.5  # NOT 200.0 from scale_events
    assert r["scale_stable"] is True


def test_heartbeat_within_window_marks_online(adapter, db_conn):
    """Fresh heartbeat (1s old) → ``is_online=True``. Catches a
    regression where the window comparison is inverted or the field
    is dropped."""
    _seed_pairing(db_conn, device_id="scale-N", product_id=None)
    _push_runtime(device_id="scale-N", weight_g=10.0, age_s=1.0)
    rows = adapter.get_single_track_scales()
    assert rows[0]["is_online"] is True


def test_no_heartbeat_marks_offline(adapter, db_conn):
    """Pairing exists, no heartbeat ever recorded (last_heartbeat_ts
    = NULL, runtime cache empty) → is_online=False."""
    _seed_pairing(db_conn, device_id="scale-O", product_id=None)
    rows = adapter.get_single_track_scales()
    assert rows[0]["is_online"] is False
    assert rows[0]["last_heartbeat_ts"] is None


def test_persisted_heartbeat_ts_within_window_marks_online(
    adapter, db_conn,
):
    """When the runtime cache is empty BUT scale_pairings carries a
    fresh ``last_heartbeat_ts``, the row is still flagged online —
    this is the post-restart path (cache cleared, DB intact)."""
    fresh_ts = (
        _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=5)
    ).isoformat(timespec="seconds").replace("+00:00", "Z")
    _seed_pairing(
        db_conn, device_id="scale-P", product_id=None,
        last_heartbeat_ts=fresh_ts,
    )
    rows = adapter.get_single_track_scales()
    assert rows[0]["is_online"] is True


def test_stale_persisted_heartbeat_marks_offline(adapter, db_conn):
    """A heartbeat older than the 60s window → offline. Catches a
    regression where the freshness check uses the wrong unit or the
    wrong direction of comparison."""
    stale_ts = (
        _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=120)
    ).isoformat(timespec="seconds").replace("+00:00", "Z")
    _seed_pairing(
        db_conn, device_id="scale-Q", product_id=None,
        last_heartbeat_ts=stale_ts,
    )
    rows = adapter.get_single_track_scales()
    assert rows[0]["is_online"] is False


def test_sort_order_paired_alpha_then_unpaired(adapter, db_conn):
    """Paired-by-name ascending; unpaired rows sort last."""
    pid_a = _seed_product(db_conn, name="Apples", brand="Brand")
    pid_z = _seed_product(db_conn, name="Zucchini", brand="Brand")
    _seed_pairing(db_conn, device_id="scale-3", product_id=pid_z)
    _seed_pairing(db_conn, device_id="scale-1", product_id=pid_a)
    _seed_pairing(db_conn, device_id="scale-2", product_id=None)
    rows = adapter.get_single_track_scales()
    assert [r["device_id"] for r in rows] == ["scale-1", "scale-3", "scale-2"]
    assert [r["product_name"] for r in rows] == ["Apples", "Zucchini", None]


def test_state_aggregate_counts_match_scales(adapter, db_conn):
    """``get_single_track_state`` totals + online counts must agree
    with the underlying list — catches a refactor where the state
    helper drifts from the row helper."""
    pid = _seed_product(db_conn, name="A", brand="B")
    _seed_pairing(db_conn, device_id="d1", product_id=pid)
    _seed_pairing(db_conn, device_id="d2", product_id=None)
    _seed_pairing(db_conn, device_id="d3", product_id=None)
    _push_runtime(device_id="d1", weight_g=10.0)
    _push_runtime(device_id="d2", weight_g=5.0)
    # d3 has no heartbeat → offline.

    state = adapter.get_single_track_state()
    assert state["shelf_id"] == "single_item"
    assert state["scales_total"] == 3
    assert state["scales_online"] == 2
    # Compact list keys — the dashboard tile reads exactly these.
    for sc in state["scales"]:
        assert set(sc.keys()) == {
            "device_id", "product_id", "product_name",
            "lot_id",
            "current_weight_g", "last_heartbeat_ts",
            "is_online", "scale_stable",
        }


def test_excludes_other_shelf_kinds(adapter, db_conn):
    """A scale_pairings row with shelf_id='live_shelf' or 'catch_all'
    must NOT show up in the single-track output."""
    _seed_pairing(db_conn, device_id="d-st", product_id=None)
    db_conn.execute(
        """
        INSERT INTO scale_pairings (
            device_id, shelf_id, first_seen_at
        ) VALUES (?, ?, '2026-04-28T11:00:00Z')
        """,
        ("d-shelf", "live_shelf"),
    )
    db_conn.execute(
        """
        INSERT INTO scale_pairings (
            device_id, shelf_id, first_seen_at
        ) VALUES (?, ?, '2026-04-28T11:00:00Z')
        """,
        ("d-catch", "catch_all"),
    )
    db_conn.commit()
    device_ids = [r["device_id"] for r in adapter.get_single_track_scales()]
    assert device_ids == ["d-st"]
