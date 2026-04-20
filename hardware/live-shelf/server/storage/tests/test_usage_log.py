"""Tests for usage_log table + repo helpers (USAGE_LOG_PLAN.md)."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.migrations import _apply_column_additions  # noqa: E402
from server.storage.models import LotIn, ProductIn, UsageLogIn  # noqa: E402


_BC = [0]


def _setup_product(conn, *, name="Yogurt"):
    _BC[0] += 1
    return storage_repo.create_product(
        conn,
        ProductIn(name=name, barcode=f"UL-{_BC[0]}",
                  net_weight_g=200.0, gross_weight_g=200.0,
                  unit_type="solid", container_type="tub", certified=1),
    )


def _usage_row(product, **overrides) -> UsageLogIn:
    base = dict(
        product_id=product.product_id,
        product_name=product.name,
        product_brand=product.brand,
        container_type=product.container_type,
        consumed_g=25.0,
        kind="in_flight_return",
        occurred_at="2026-04-17T12:05:00.000Z",
        lot_id=None,
        pickup_weight_g=200.0,
        return_weight_g=175.0,
        session_id=None,
        pickup_event_id="E-pick-1",
        return_event_id="E-return-1",
    )
    base.update(overrides)
    return UsageLogIn(**base)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_usage_log_table_created_on_fresh_db():
    conn = init_db(":memory:")
    cols = [r[1] for r in conn.execute("PRAGMA table_info(usage_log)")]
    assert "usage_id" in cols
    assert "consumed_g" in cols
    assert "kind" in cols
    assert "pickup_event_id" in cols


def test_usage_log_migration_idempotent_on_existing_db():
    # Simulate an old DB without usage_log.
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE products (
          product_id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL
        );
        CREATE TABLE lots (
          lot_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE scale_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(session_id),
          ts TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
          delta_g REAL NOT NULL,
          before_weight_g REAL NOT NULL,
          after_weight_g REAL NOT NULL,
          classifier_status TEXT CHECK(classifier_status IN
            ('pending','classifying','classified','review','failed'))
        );
        CREATE TABLE session_resolutions (
          resolution_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          pattern TEXT NOT NULL
        );
        CREATE TABLE review_queue (
          review_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          event_id TEXT
        );
        """
    )
    # Migration creates usage_log.
    _apply_column_additions(conn)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(usage_log)")]
    assert "usage_id" in cols
    # Running again is a no-op.
    _apply_column_additions(conn)
    _apply_column_additions(conn)
    cols2 = [r[1] for r in conn.execute("PRAGMA table_info(usage_log)")]
    assert cols == cols2


# ---------------------------------------------------------------------------
# write_usage_log
# ---------------------------------------------------------------------------


def test_write_usage_log_returns_row_with_id():
    conn = init_db(":memory:")
    product = _setup_product(conn)
    row = storage_repo.write_usage_log(conn, _usage_row(product))
    assert row is not None
    assert row.usage_id
    assert row.product_id == product.product_id
    assert row.product_name == product.name
    assert row.consumed_g == 25.0
    assert row.kind == "in_flight_return"
    assert row.created_at  # auto-stamped


def test_write_usage_log_dedup_rejects_second_row_with_same_pickup_event_id():
    """The unique partial index on pickup_event_id prevents double-
    logging the same in-flight pair. Second write returns None."""
    conn = init_db(":memory:")
    product = _setup_product(conn)
    first = storage_repo.write_usage_log(conn, _usage_row(product))
    second = storage_repo.write_usage_log(
        conn, _usage_row(product, consumed_g=99.0)
    )
    assert first is not None
    assert second is None  # dedup fired
    # Only one row in the table.
    count = conn.execute("SELECT COUNT(*) FROM usage_log").fetchone()[0]
    assert count == 1


def test_write_usage_log_allows_null_pickup_event_id_without_dedup():
    """Partial index excludes NULLs — rows without a pickup event_id can
    coexist. (Covers the backfill fallback case.)"""
    conn = init_db(":memory:")
    product = _setup_product(conn)
    r1 = storage_repo.write_usage_log(
        conn, _usage_row(product, pickup_event_id=None)
    )
    r2 = storage_repo.write_usage_log(
        conn, _usage_row(product, pickup_event_id=None)
    )
    assert r1 is not None
    assert r2 is not None
    assert r1.usage_id != r2.usage_id


# ---------------------------------------------------------------------------
# list_usage_log filters
# ---------------------------------------------------------------------------


class TestListUsageLog:
    def _seed(self, conn):
        p1 = _setup_product(conn, name="Yogurt")
        p2 = _setup_product(conn, name="Cheese")
        storage_repo.write_usage_log(
            conn, _usage_row(p1, pickup_event_id="E1",
                             occurred_at="2026-04-17T10:00:00Z",
                             consumed_g=10.0),
        )
        storage_repo.write_usage_log(
            conn, _usage_row(p1, pickup_event_id="E2",
                             occurred_at="2026-04-17T14:00:00Z",
                             consumed_g=20.0,
                             kind="in_flight_ttl_expired"),
        )
        storage_repo.write_usage_log(
            conn, _usage_row(p2, pickup_event_id="E3",
                             occurred_at="2026-04-18T09:00:00Z",
                             consumed_g=50.0),
        )
        return p1, p2

    def test_filter_by_product(self):
        conn = init_db(":memory:")
        p1, p2 = self._seed(conn)
        rows = storage_repo.list_usage_log(conn, product_id=p1.product_id)
        assert len(rows) == 2
        assert all(r.product_id == p1.product_id for r in rows)

    def test_filter_by_date_range(self):
        conn = init_db(":memory:")
        self._seed(conn)
        rows = storage_repo.list_usage_log(
            conn,
            since="2026-04-17T12:00:00Z",
            until="2026-04-17T23:59:59Z",
        )
        assert len(rows) == 1
        assert rows[0].occurred_at == "2026-04-17T14:00:00Z"

    def test_filter_by_kind(self):
        conn = init_db(":memory:")
        self._seed(conn)
        rows = storage_repo.list_usage_log(
            conn, kinds=["in_flight_ttl_expired"]
        )
        assert len(rows) == 1
        assert rows[0].kind == "in_flight_ttl_expired"

    def test_order_is_newest_first(self):
        conn = init_db(":memory:")
        self._seed(conn)
        rows = storage_repo.list_usage_log(conn)
        assert [r.occurred_at for r in rows] == [
            "2026-04-18T09:00:00Z",
            "2026-04-17T14:00:00Z",
            "2026-04-17T10:00:00Z",
        ]

    def test_pagination_limit_offset(self):
        conn = init_db(":memory:")
        self._seed(conn)
        page1 = storage_repo.list_usage_log(conn, limit=2, offset=0)
        page2 = storage_repo.list_usage_log(conn, limit=2, offset=2)
        assert len(page1) == 2
        assert len(page2) == 1
        assert page1[0].occurred_at > page1[1].occurred_at
        assert {r.usage_id for r in page1}.isdisjoint(
            {r.usage_id for r in page2}
        )


# ---------------------------------------------------------------------------
# count + summary
# ---------------------------------------------------------------------------


def test_count_usage_log_respects_filters():
    conn = init_db(":memory:")
    p1 = _setup_product(conn)
    p2 = _setup_product(conn, name="Cheese")
    storage_repo.write_usage_log(
        conn, _usage_row(p1, pickup_event_id="a"),
    )
    storage_repo.write_usage_log(
        conn, _usage_row(p2, pickup_event_id="b"),
    )
    assert storage_repo.count_usage_log(conn) == 2
    assert storage_repo.count_usage_log(conn, product_id=p1.product_id) == 1


# ---------------------------------------------------------------------------
# Backfill (USAGE_LOG_PLAN.md §7)
# ---------------------------------------------------------------------------


def test_backfill_synthesizes_usage_log_from_existing_resolutions():
    """Fresh DB → seed historical in_flight resolutions → reapply
    migrations → expect usage_log rows to materialise."""
    from server.storage.migrations import apply_migrations, _backfill_usage_log
    conn = init_db(":memory:")

    product = _setup_product(conn, name="Historical Yogurt")
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="out",
              current_weight_g=150.0, initial_weight_g=200.0,
              last_out_at="2026-04-16T18:00:00Z"),
    )
    session = storage_repo.open_session(
        conn, "2026-04-16T17:50:00Z", initial_weight_g=200.0,
    )
    # Seed scale events so the resolutions can reference real event_ids —
    # the backfill's idempotency is per-row via the unique partial index
    # on ``usage_log(pickup_event_id)``, which only indexes non-NULL
    # values. Using real remove_event_id values here exercises the
    # dedup path on re-run.
    ev_return = storage_repo.record_scale_event(
        conn,
        __import__("server.storage.models", fromlist=["ScaleEventIn"]).ScaleEventIn(
            ts="2026-04-16T18:00:00Z",
            delta_g=50.0, before_weight_g=150.0, after_weight_g=200.0,
            direction="add", session_id=session.session_id,
        ),
    )
    ev_use = storage_repo.record_scale_event(
        conn,
        __import__("server.storage.models", fromlist=["ScaleEventIn"]).ScaleEventIn(
            ts="2026-04-16T18:01:00Z",
            delta_g=25.0, before_weight_g=175.0, after_weight_g=200.0,
            direction="add", session_id=session.session_id,
        ),
    )
    # Historical in_flight_return resolution (pattern pre-dates this feature).
    storage_repo.write_resolution(
        conn,
        __import__("server.storage.models", fromlist=["SessionResolutionIn"]).SessionResolutionIn(
            session_id=session.session_id,
            pattern="in_flight_return",
            lot_id=lot.lot_id,
            consumed_g=50.0,
            add_event_id=None,
            remove_event_id=ev_return.event_id,
        ),
    )
    # Also a use_return_consumed from pre-in-flight reconciler days.
    storage_repo.write_resolution(
        conn,
        __import__("server.storage.models", fromlist=["SessionResolutionIn"]).SessionResolutionIn(
            session_id=session.session_id,
            pattern="use_return_consumed",
            lot_id=lot.lot_id,
            consumed_g=25.0,
            remove_event_id=ev_use.event_id,
        ),
    )

    # No usage_log rows yet (in-memory DB started empty).
    assert storage_repo.count_usage_log(conn) == 0

    # Run the backfill directly.
    inserted = _backfill_usage_log(conn)
    assert inserted >= 2
    rows = storage_repo.list_usage_log(conn)
    kinds = sorted(r.kind for r in rows)
    assert "in_flight_return" in kinds
    assert "reconciler_use_return" in kinds

    # Idempotent — second call on a DB with all resolutions already
    # backfilled is a no-op because the unique partial index on
    # ``usage_log(pickup_event_id)`` absorbs every row. The old
    # "empty-table fast-exit" guard was removed so that a DB with some
    # live usage_log rows but missing historical backfill can still
    # catch up; correctness is delegated to the per-row index.
    inserted2 = _backfill_usage_log(conn)
    assert inserted2 == 0
    assert storage_repo.count_usage_log(conn) == len(rows)


def test_backfill_still_runs_when_usage_log_has_live_rows():
    """Regression (audit H1): previously the backfill short-circuited on
    ``SELECT COUNT(*) FROM usage_log > 0``. That meant a DB where live
    emission had already written its first row would NEVER pick up any
    historical session_resolutions — the history was permanently
    invisible to the aggregate. The guard is gone; per-row dedup via
    the unique partial index on ``pickup_event_id`` handles repeats.
    """
    from server.storage.migrations import _backfill_usage_log
    from server.storage.models import ScaleEventIn, SessionResolutionIn

    conn = init_db(":memory:")
    product = _setup_product(conn, name="Live-vs-Historical Yogurt")
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="out",
              current_weight_g=150.0, initial_weight_g=200.0,
              last_out_at="2026-04-16T18:00:00Z"),
    )
    session = storage_repo.open_session(
        conn, "2026-04-16T17:50:00Z", initial_weight_g=200.0,
    )

    # 1. Seed a LIVE usage_log row first — simulates the post-upgrade
    #    moment where emission has started but backfill hasn't run.
    live_row = storage_repo.write_usage_log(
        conn,
        _usage_row(product, lot_id=lot.lot_id, consumed_g=30.0,
                   pickup_event_id="E-live-1",
                   occurred_at="2026-04-17T09:00:00Z"),
    )
    assert live_row is not None
    assert storage_repo.count_usage_log(conn) == 1

    # 2. Seed a historical session_resolution that should get synthesised.
    ev_historical = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-16T18:00:00Z",
            delta_g=50.0, before_weight_g=150.0, after_weight_g=200.0,
            direction="add", session_id=session.session_id,
        ),
    )
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session.session_id,
            pattern="in_flight_return",
            lot_id=lot.lot_id,
            consumed_g=50.0,
            remove_event_id=ev_historical.event_id,
        ),
    )

    # 3. Run backfill — with the fast-exit gone, the historical row
    #    should be synthesised even though a live row already exists.
    inserted = _backfill_usage_log(conn)
    assert inserted == 1, (
        "backfill must synthesise historical rows even when live "
        f"emission has already written to usage_log; got inserted={inserted}"
    )

    # 4. Both the live and historical rows are present; they are
    #    distinct (different pickup_event_ids) so the dedup index
    #    lets both coexist.
    rows = storage_repo.list_usage_log(conn)
    pickup_ids = {r.pickup_event_id for r in rows}
    assert "E-live-1" in pickup_ids
    assert ev_historical.event_id in pickup_ids
    assert storage_repo.count_usage_log(conn) == 2


# ---------------------------------------------------------------------------
# delete_usage_log
# ---------------------------------------------------------------------------


def test_delete_usage_log_reverts_consumption_and_removes_row():
    conn = init_db(":memory:")
    product = _setup_product(conn, name="Ketchup")
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=180.0, initial_weight_g=200.0,
              total_consumed_g=20.0),
    )
    row = storage_repo.write_usage_log(
        conn,
        _usage_row(product, lot_id=lot.lot_id, consumed_g=20.0,
                   pickup_event_id="E-del-1"),
    )

    result = storage_repo.delete_usage_log(conn, row.usage_id)
    assert result["deleted"] == 1
    assert result["reverted_g"] == 20.0
    assert result["lot_id"] == lot.lot_id

    # Row is gone.
    assert storage_repo.count_usage_log(conn) == 0
    # Lot total consumed is back to 0.
    assert storage_repo.get_lot(conn, lot.lot_id).total_consumed_g == 0.0


def test_delete_usage_log_missing_id_is_noop():
    conn = init_db(":memory:")
    result = storage_repo.delete_usage_log(conn, "does-not-exist")
    assert result["deleted"] == 0
    assert result["reverted_g"] == 0.0


def test_delete_usage_log_negative_consumption_leaves_lot_total_alone():
    """Topup (negative consumed_g) was never added to total_consumed_g,
    so deleting it must not subtract from it either."""
    conn = init_db(":memory:")
    product = _setup_product(conn, name="Yogurt")
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=220.0, initial_weight_g=200.0,
              total_consumed_g=50.0),
    )
    row = storage_repo.write_usage_log(
        conn,
        _usage_row(product, lot_id=lot.lot_id, consumed_g=-20.0,
                   pickup_event_id="E-del-2"),
    )
    storage_repo.delete_usage_log(conn, row.usage_id)
    assert storage_repo.get_lot(conn, lot.lot_id).total_consumed_g == 50.0


def test_delete_usage_log_clamps_revert_at_zero():
    """If the lot total is somehow already lower than the consumed_g
    we're reverting (e.g., concurrent mutation), the clamp prevents a
    negative lifetime total."""
    conn = init_db(":memory:")
    product = _setup_product(conn, name="Cheese")
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=100.0, initial_weight_g=100.0,
              total_consumed_g=5.0),   # less than we'll try to revert
    )
    row = storage_repo.write_usage_log(
        conn,
        _usage_row(product, lot_id=lot.lot_id, consumed_g=50.0,
                   pickup_event_id="E-del-3"),
    )
    storage_repo.delete_usage_log(conn, row.usage_id)
    assert storage_repo.get_lot(conn, lot.lot_id).total_consumed_g == 0.0


def test_sum_usage_log_by_product_aggregates_with_row_count():
    conn = init_db(":memory:")
    p1 = _setup_product(conn)
    p2 = _setup_product(conn, name="Cheese")
    storage_repo.write_usage_log(
        conn, _usage_row(p1, pickup_event_id="a", consumed_g=10.0),
    )
    storage_repo.write_usage_log(
        conn, _usage_row(p1, pickup_event_id="b", consumed_g=15.0),
    )
    # Topup row: negative consumed_g (user refilled the container mid
    # in-flight). Must NOT reduce p1's 7-day total — a refill is not a
    # consumption event, and cancelling real consumption with it would
    # silently understate the aggregate. row_count still counts the row
    # because the raw cardinality is correct.
    storage_repo.write_usage_log(
        conn, _usage_row(p1, pickup_event_id="b-topup", consumed_g=-8.0),
    )
    storage_repo.write_usage_log(
        conn, _usage_row(p2, pickup_event_id="c", consumed_g=50.0),
    )
    summary = storage_repo.sum_usage_log_by_product(conn)
    # Highest total first.
    assert summary[0]["product_id"] == p2.product_id
    assert summary[0]["total_consumed_g"] == 50.0
    assert summary[0]["row_count"] == 1
    assert summary[1]["product_id"] == p1.product_id
    # 10 + 15 + clamp(-8, 0) = 25, NOT 17. row_count = 3 (includes topup).
    assert summary[1]["total_consumed_g"] == 25.0
    assert summary[1]["row_count"] == 3
