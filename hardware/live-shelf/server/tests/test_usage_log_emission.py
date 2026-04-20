"""End-to-end tests verifying usage_log rows are emitted at the 4 sites
(USAGE_LOG_PLAN.md §4)."""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self): return []
    def get_recently_out_lots(self, w): return []
    def get_in_flight_lots(self, max_age_seconds=None): return []
    def get_certified_not_on_shelf(self): return []


_BC = [0]


def _setup_lot(conn, weight_g=200.0, name="Yogurt"):
    _BC[0] += 1
    product = storage_repo.create_product(
        conn,
        ProductIn(name=name, barcode=f"UE-{_BC[0]}",
                  net_weight_g=weight_g, gross_weight_g=weight_g,
                  unit_type="solid", container_type="tub", certified=1),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=weight_g, initial_weight_g=weight_g),
    )
    return product, lot


def _make_handler(conn, tmp_path, **kwargs):
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )
    defaults.update(kwargs)
    return ScaleHandler(**defaults)


def _record_event(conn, *, session_id, direction, delta_g, ts):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(ts=ts, delta_g=delta_g,
                     before_weight_g=0.0, after_weight_g=0.0,
                     direction=direction, session_id=session_id,
                     classifier_status="pending"),
    )
    return ev.event_id


# ---------------------------------------------------------------------------
# Site 1: in_flight_return
# ---------------------------------------------------------------------------


def test_in_flight_return_emits_usage_log_with_delta_consumption(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    product, lot = _setup_lot(conn, weight_g=200.0, name="Chobani")
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    remove_id = _record_event(conn, session_id=session_id,
                              direction="remove", delta_g=-200.0,
                              ts="2026-04-17T12:00:05Z")
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={"item_id": lot.lot_id, "confidence": 0.95,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:00:05Z", delta_g=-200.0,
        session_id=session_id, event_id=remove_id,
    )

    add_id = _record_event(conn, session_id=session_id,
                           direction="add", delta_g=180.0,
                           ts="2026-04-17T12:05:00Z")
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={"item_id": lot.lot_id, "confidence": 0.93,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:05:00Z", delta_g=180.0,
        session_id=session_id, event_id=add_id,
    )

    rows = storage_repo.list_usage_log(conn)
    assert len(rows) == 1
    r = rows[0]
    assert r.kind == "in_flight_return"
    assert r.product_id == product.product_id
    assert r.product_name == "Chobani"
    assert r.consumed_g == 20.0
    assert r.pickup_weight_g == 200.0
    assert r.return_weight_g == 180.0
    assert r.session_id == session_id
    assert r.return_event_id == add_id
    assert r.pickup_event_id == remove_id
    assert r.occurred_at == "2026-04-17T12:05:00Z"


def test_in_flight_return_with_topup_emits_negative_consumed_g(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    _, lot = _setup_lot(conn, weight_g=200.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={"item_id": lot.lot_id, "confidence": 0.95,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:00:05Z", delta_g=-200.0,
        session_id=session_id,
        event_id=_record_event(conn, session_id=session_id, direction="remove",
                               delta_g=-200.0, ts="2026-04-17T12:00:05Z"),
    )

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={"item_id": lot.lot_id, "confidence": 0.90,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:05:00Z", delta_g=215.0,  # heavier than pickup
        session_id=session_id,
        event_id=_record_event(conn, session_id=session_id, direction="add",
                               delta_g=215.0, ts="2026-04-17T12:05:00Z"),
    )

    rows = storage_repo.list_usage_log(conn)
    assert len(rows) == 1
    assert rows[0].kind == "in_flight_return"
    assert rows[0].consumed_g == -15.0  # negative = topup


# ---------------------------------------------------------------------------
# Site 2: in_flight_replaced_new_item
# ---------------------------------------------------------------------------


def test_in_flight_replaced_emits_usage_log_with_pickup_weight(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    _, lot = _setup_lot(conn, weight_g=200.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={"item_id": lot.lot_id, "confidence": 0.95,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:00:05Z", delta_g=-200.0,
        session_id=session_id,
        event_id=_record_event(conn, session_id=session_id, direction="remove",
                               delta_g=-200.0, ts="2026-04-17T12:00:05Z"),
    )

    handler._apply_lot_update_from_classification(
        direction="add",
        classification={"item_id": lot.lot_id, "confidence": 0.90,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:05:00Z", delta_g=450.0,
        session_id=session_id,
        event_id=_record_event(conn, session_id=session_id, direction="add",
                               delta_g=450.0, ts="2026-04-17T12:05:00Z"),
    )

    rows = storage_repo.list_usage_log(
        conn, kinds=["in_flight_replaced_new_item"]
    )
    assert len(rows) == 1
    assert rows[0].consumed_g == 200.0
    assert rows[0].pickup_weight_g == 200.0
    assert rows[0].return_weight_g is None


# ---------------------------------------------------------------------------
# Site 3: in_flight_ttl_expired
# ---------------------------------------------------------------------------


def test_in_flight_ttl_expired_emits_usage_log_with_pickup_weight(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=1)
    _, lot = _setup_lot(conn, weight_g=200.0, name="Philly CC")
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    # Seed in_flight with an old pickup time.
    conn.execute(
        """
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-2 hours'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'EV1',
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (session_id, lot.lot_id),
    )
    conn.commit()

    handler._reap_expired_in_flight()

    rows = storage_repo.list_usage_log(conn, kinds=["in_flight_ttl_expired"])
    assert len(rows) == 1
    r = rows[0]
    assert r.consumed_g == 200.0
    assert r.product_name == "Philly CC"
    assert r.session_id == session_id
    assert r.pickup_event_id == "EV1"
    assert r.return_event_id is None


# ---------------------------------------------------------------------------
# Dedup: fast-path emitters are idempotent under retries
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Site 4: reconciler use_return_consumed path
# ---------------------------------------------------------------------------


def test_reconciler_use_return_consumed_emits_usage_log(tmp_path):
    """Legacy reconciler path (ADD against an 'out' lot from a prior
    session) emits a usage_log row via RepoReconcilerAdapter."""
    from server.adapters.reconciler_repo import RepoReconcilerAdapter
    from server.reconciler.reconcile import reconcile_session

    conn = init_db(":memory:")
    product, lot = _setup_lot(conn, weight_g=300.0, name="Leftover Soup")
    # Set lot to 'out' manually (prior session removal).
    conn.execute(
        "UPDATE lots SET status='out', last_out_at='2026-04-16T18:00:00Z' "
        "WHERE lot_id = ?",
        (lot.lot_id,),
    )
    conn.commit()

    session_id = storage_repo.open_session(
        conn, "2026-04-17T09:00:00Z", initial_weight_g=0.0,
    ).session_id
    # ADD event bringing the leftover back lighter (some was eaten off-shelf).
    add_ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-17T09:00:05Z", delta_g=250.0,
            before_weight_g=0.0, after_weight_g=250.0,
            direction="add", session_id=session_id,
            classifier_status="classified",
            classification='{"item_id":"' + lot.lot_id + '",'
                          '"confidence":0.9,"action":"added","multi_match":[],'
                          '"candidate_pool_used":[{"candidate_id":"'
                          + lot.lot_id + '"}]}',
        ),
    )
    # Close the session so reconciler runs.
    conn.execute(
        "UPDATE sessions SET ended_at=?, final_shelf_weight_g=? WHERE session_id=?",
        ("2026-04-17T09:00:10Z", 250.0, session_id),
    )
    conn.commit()

    adapter = RepoReconcilerAdapter(conn=conn, db_lock=threading.RLock())
    reconcile_session(session_id, adapter)

    rows = storage_repo.list_usage_log(conn, kinds=["reconciler_use_return"])
    assert len(rows) == 1
    r = rows[0]
    assert r.product_name == "Leftover Soup"
    # consumption = prior.current_weight_g(300) - ev.after_weight_g(250) = 50
    assert r.consumed_g == 50.0
    assert r.return_event_id == add_ev.event_id
    assert r.session_id == session_id


def test_emit_usage_log_writes_usage_logged_lifecycle_on_success(tmp_path):
    """M3: successful write_usage_log writes a USAGE_LOGGED event_lifecycle
    row keyed to the return_event_id (or pickup_event_id fallback) with a
    payload carrying {usage_id, consumed_g, kind, product_id}."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    product, lot = _setup_lot(conn, weight_g=200.0, name="Yogurt")
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    remove_id = _record_event(conn, session_id=session_id,
                              direction="remove", delta_g=-200.0,
                              ts="2026-04-17T12:00:05Z")
    add_id = _record_event(conn, session_id=session_id,
                           direction="add", delta_g=180.0,
                           ts="2026-04-17T12:05:00Z")

    handler._emit_usage_log(
        lot_id=lot.lot_id,
        product_id=product.product_id,
        product_name="Yogurt",
        product_brand=None,
        container_type="tub",
        consumed_g=20.0,
        pickup_weight_g=200.0,
        return_weight_g=180.0,
        kind="in_flight_return",
        session_id=session_id,
        pickup_event_id=remove_id,
        return_event_id=add_id,
        occurred_at="2026-04-17T12:05:00Z",
    )

    # Usage row landed.
    assert storage_repo.count_usage_log(conn) == 1

    # A USAGE_LOGGED lifecycle row references the return_event_id (the
    # "caused this write" side) — NOT the pickup_event_id. Payload
    # carries consumed_g + kind + product_id + usage_id.
    rows = conn.execute(
        "SELECT event_id, actor, reason_code, payload_json "
        "FROM event_lifecycle WHERE reason_code='usage_logged'"
    ).fetchall()
    assert len(rows) == 1
    ev_id, actor, reason_code, payload_json = rows[0]
    assert ev_id == add_id
    assert actor == "usage"
    assert reason_code == "usage_logged"
    import json
    payload = json.loads(payload_json)
    assert payload["kind"] == "in_flight_return"
    assert payload["consumed_g"] == 20.0
    assert payload["product_id"] == product.product_id
    assert payload.get("usage_id")  # non-empty


def test_emit_usage_log_dedup_rejection_does_not_emit_usage_logged(tmp_path):
    """M3: when the unique-index dedup rejects a duplicate write
    (write_usage_log returns None), the lifecycle emits NEITHER
    USAGE_LOGGED (nothing was written) NOR USAGE_LOG_WRITE_FAILED (no
    exception). Silent no-op."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    product, lot = _setup_lot(conn, weight_g=200.0, name="Yogurt")
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    remove_id = _record_event(conn, session_id=session_id,
                              direction="remove", delta_g=-200.0,
                              ts="2026-04-17T12:00:05Z")
    add_id = _record_event(conn, session_id=session_id,
                           direction="add", delta_g=180.0,
                           ts="2026-04-17T12:05:00Z")

    handler._emit_usage_log(
        lot_id=lot.lot_id, product_id=product.product_id,
        product_name="Yogurt", product_brand=None, container_type="tub",
        consumed_g=20.0, pickup_weight_g=200.0, return_weight_g=180.0,
        kind="in_flight_return", session_id=session_id,
        pickup_event_id=remove_id, return_event_id=add_id,
        occurred_at="2026-04-17T12:05:00Z",
    )

    # Second call with the same pickup_event_id → dedup fires, write
    # returns None.
    handler._emit_usage_log(
        lot_id=lot.lot_id, product_id=product.product_id,
        product_name="Yogurt", product_brand=None, container_type="tub",
        consumed_g=999.0, pickup_weight_g=200.0, return_weight_g=180.0,
        kind="in_flight_return", session_id=session_id,
        pickup_event_id=remove_id, return_event_id=add_id,
        occurred_at="2026-04-17T12:05:00Z",
    )

    # Only one USAGE_LOGGED row — from the first write.
    rows = conn.execute(
        "SELECT COUNT(*) FROM event_lifecycle WHERE reason_code='usage_logged'"
    ).fetchone()
    assert rows[0] == 1
    # No USAGE_LOG_WRITE_FAILED row — dedup isn't a failure.
    failed = conn.execute(
        "SELECT COUNT(*) FROM event_lifecycle "
        "WHERE reason_code='usage_log_write_failed'"
    ).fetchone()
    assert failed[0] == 0


def test_in_flight_return_double_apply_does_not_double_log(tmp_path):
    """If the apply path runs twice for the same return event (retry,
    sweeper + close-hook race, etc.), the unique index on
    pickup_event_id prevents a second usage_log row."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    _, lot = _setup_lot(conn)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00Z", initial_weight_g=200.0,
    ).session_id

    # Pickup
    remove_id = _record_event(conn, session_id=session_id, direction="remove",
                              delta_g=-200.0, ts="2026-04-17T12:00:05Z")
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={"item_id": lot.lot_id, "confidence": 0.95,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:00:05Z", delta_g=-200.0,
        session_id=session_id, event_id=remove_id,
    )
    # Return
    add_id = _record_event(conn, session_id=session_id, direction="add",
                           delta_g=180.0, ts="2026-04-17T12:05:00Z")
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={"item_id": lot.lot_id, "confidence": 0.93,
                        "multi_match": [],
                        "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
        event_ts="2026-04-17T12:05:00Z", delta_g=180.0,
        session_id=session_id, event_id=add_id,
    )
    assert storage_repo.count_usage_log(conn) == 1

    # Direct re-call of _emit_usage_log with the SAME pickup_event_id —
    # the unique index on pickup_event_id must reject the duplicate.
    # (This simulates a retry coming through a different code path that
    # doesn't have the in-session dedup guard above it.)
    handler._emit_usage_log(
        lot_id=lot.lot_id,
        product_id=lot.product_id,
        product_name="Yogurt",
        product_brand=None,
        container_type="tub",
        consumed_g=999.0,  # garbage on purpose
        pickup_weight_g=200.0,
        return_weight_g=180.0,
        kind="in_flight_return",
        session_id=session_id,
        pickup_event_id=remove_id,  # same pickup id → should dedup
        return_event_id=add_id,
        occurred_at="2026-04-17T12:05:00Z",
    )

    # Still exactly one row; garbage consumed_g was NOT persisted.
    rows = storage_repo.list_usage_log(conn)
    assert len(rows) == 1
    assert rows[0].consumed_g == 20.0
