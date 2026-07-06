"""Storage-layer tests for the Live Shelf demo (Bundle A).

Every public function in `server.storage.repo` must be exercised here. We use
an in-memory SQLite DB per test via a module-level fixture.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from datetime import datetime, timezone

import pytest

from server.storage import init_db
from server.storage.migrations import apply_migrations
from server.storage.models import (
    CLEAR_SENTINEL,
    AppStatePatch,
    LotIn,
    ProductIn,
    ProductReferenceImageIn,
    ReviewQueueIn,
    ScaleEventIn,
    SessionResolutionIn,
    coerce_ts,
)
from server.storage import repo

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB per test with migrations applied."""
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


def _make_product(conn: sqlite3.Connection, **overrides) -> "Product":  # type: ignore[name-defined]
    """Helper to create a product with sane defaults."""
    defaults = dict(
        name="Heinz Ketchup",
        brand="Heinz",
        barcode="0123456789012",
        net_weight_g=340.0,
        gross_weight_g=560.0,
        tare_weight_g=220.0,
        serving_weight_g=17.0,
        servings_per_container=20.0,
        unit_type="liquid",
        density_g_per_ml=1.1,
        container_type="bottle",
        certified=1,
    )
    defaults.update(overrides)
    return repo.create_product(conn, ProductIn(**defaults))


def _make_lot(
    conn: sqlite3.Connection,
    product_id: str,
    *,
    status: str = "on_shelf",
    current_weight_g: float = 550.0,
    initial_weight_g: float = 560.0,
    **overrides,
) -> "Lot":  # type: ignore[name-defined]
    payload = dict(
        product_id=product_id,
        status=status,
        current_weight_g=current_weight_g,
        initial_weight_g=initial_weight_g,
    )
    payload.update(overrides)
    return repo.create_lot(conn, LotIn(**payload))


# ---------------------------------------------------------------------------
# Migrations / init_db
# ---------------------------------------------------------------------------


class TestMigrations:
    def test_init_db_creates_all_tables(self, conn):
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        names = {r[0] for r in rows}
        for t in (
            "products",
            "product_reference_images",
            "lots",
            "sessions",
            "scale_events",
            "session_resolutions",
            "review_queue",
            "app_state",
        ):
            assert t in names, f"missing table {t!r}; got {names!r}"

    def test_app_state_singleton_seeded(self, conn):
        row = conn.execute("SELECT * FROM app_state WHERE id = 1").fetchone()
        assert row is not None
        assert row["door_open"] == 0
        assert row["shelf_name"] == "demo shelf"

    def test_apply_migrations_is_idempotent(self, conn):
        # First call happened inside init_db; second should be a no-op.
        result = apply_migrations(conn)
        assert result is False
        # And a third call on the same conn still fine.
        assert apply_migrations(conn) is False
        # Data is untouched.
        rows = conn.execute("SELECT * FROM app_state").fetchall()
        assert len(rows) == 1

    def test_foreign_keys_enabled(self, conn):
        (fk_on,) = conn.execute("PRAGMA foreign_keys").fetchone()
        assert fk_on == 1

    def test_init_db_persists_to_file(self, tmp_path):
        db_path = tmp_path / "shelf.sqlite3"
        c = init_db(str(db_path))
        repo.create_product(c, ProductIn(name="Seed"))
        c.close()
        # Re-open: schema already there, data still present, no duplicate init.
        c2 = init_db(str(db_path))
        products = repo.list_products(c2)
        assert len(products) == 1
        assert products[0].name == "Seed"
        c2.close()


# ---------------------------------------------------------------------------
# Helper: coerce_ts
# ---------------------------------------------------------------------------


class TestCoerceTs:
    def test_none_passes_through(self):
        assert coerce_ts(None) is None

    def test_string_passes_through(self):
        assert coerce_ts("2026-04-15T12:34:56Z") == "2026-04-15T12:34:56Z"

    def test_naive_datetime_treated_as_utc(self):
        dt = datetime(2026, 4, 15, 12, 34, 56)
        out = coerce_ts(dt)
        assert out is not None
        # The normalized form carries a UTC offset.
        assert "+00:00" in out or out.endswith("Z")

    def test_aware_datetime_converted_to_utc(self):
        from datetime import timedelta

        dt = datetime(
            2026, 4, 15, 14, 34, 56,
            tzinfo=timezone(timedelta(hours=2)),
        )
        out = coerce_ts(dt)
        # 14:34 +02:00 == 12:34 UTC
        assert out is not None
        assert "12:34:56" in out

    def test_rejects_garbage_type(self):
        with pytest.raises(TypeError):
            coerce_ts(12345)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Products + reference images
# ---------------------------------------------------------------------------


class TestProducts:
    def test_create_and_get(self, conn):
        p = _make_product(conn)
        assert p.product_id
        assert p.name == "Heinz Ketchup"
        assert p.certified == 1
        got = repo.get_product(conn, p.product_id)
        assert got is not None
        assert got.product_id == p.product_id
        assert got.barcode == "0123456789012"

    def test_get_missing_returns_none(self, conn):
        assert repo.get_product(conn, "nope") is None
        assert repo.get_product_by_barcode(conn, "nope") is None

    def test_get_by_barcode(self, conn):
        p = _make_product(conn, barcode="9999888877776")
        got = repo.get_product_by_barcode(conn, "9999888877776")
        assert got is not None
        assert got.product_id == p.product_id

    def test_list_products(self, conn):
        a = _make_product(conn, name="A", barcode="111")
        b = _make_product(conn, name="B", barcode="222")
        got = repo.list_products(conn)
        ids = {p.product_id for p in got}
        assert {a.product_id, b.product_id} <= ids
        assert len(got) == 2

    def test_set_certified_toggle(self, conn):
        p = _make_product(conn, certified=0)
        assert p.certified == 0
        updated = repo.set_product_certified(conn, p.product_id, True)
        assert updated is not None
        assert updated.certified == 1
        updated = repo.set_product_certified(conn, p.product_id, False)
        assert updated is not None
        assert updated.certified == 0

    def test_add_and_list_reference_images(self, conn):
        p = _make_product(conn)
        img1 = repo.add_reference_image(
            conn,
            ProductReferenceImageIn(
                product_id=p.product_id,
                file_path="refs/a/front.jpg",
                angle="front",
            ),
        )
        img2 = repo.add_reference_image(
            conn,
            ProductReferenceImageIn(
                product_id=p.product_id,
                file_path="refs/a/side.jpg",
                angle="side",
            ),
        )
        assert img1.image_id != img2.image_id
        imgs = repo.list_reference_images(conn, p.product_id)
        assert len(imgs) == 2
        paths = {i.file_path for i in imgs}
        assert paths == {"refs/a/front.jpg", "refs/a/side.jpg"}

    def test_reference_image_cascade_on_product_delete(self, conn):
        p = _make_product(conn)
        repo.add_reference_image(
            conn,
            ProductReferenceImageIn(
                product_id=p.product_id, file_path="refs/x.jpg", angle="front"
            ),
        )
        with conn:
            conn.execute(
                "DELETE FROM products WHERE product_id = ?", (p.product_id,)
            )
        rows = conn.execute(
            "SELECT * FROM product_reference_images"
        ).fetchall()
        assert rows == []


# ---------------------------------------------------------------------------
# Lots
# ---------------------------------------------------------------------------


class TestLots:
    def test_create_and_get(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        assert lot.lot_id
        assert lot.product_id == p.product_id
        assert lot.status == "on_shelf"
        assert lot.total_consumed_g == 0.0
        assert lot.placed_at  # default-populated
        got = repo.get_lot(conn, lot.lot_id)
        assert got is not None
        assert got.lot_id == lot.lot_id

    def test_get_lot_preserves_single_item_shelf_id(self, conn):
        """Audit C3-01: ``_row_to_lot`` must NOT silently rewrite a
        ``shelf_id='single_item'`` row to ``'live_shelf'`` on read.

        ``single_item`` is a first-class shelf discriminator — it's in the
        ``lots.shelf_id`` CHECK whitelist (schema.sql) and the ``ShelfId``
        Literal (models.py). A lot stored with it must round-trip
        unchanged; rewriting it to 'live_shelf' is set-once corruption
        that mis-routes the lot to the wrong shelf's logic.
        """
        p = _make_product(conn)
        lot_id = repo.new_id()
        # Insert directly so the stored value is unambiguous (the schema
        # CHECK accepts 'single_item'; this is a legitimate persisted row).
        conn.execute(
            "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
            "                  initial_weight_g, shelf_id) "
            "VALUES (?, ?, 'on_shelf', 300.0, 320.0, 'single_item')",
            (lot_id, p.product_id),
        )
        conn.commit()

        # Sanity: the value really is 'single_item' at the SQL layer.
        raw = conn.execute(
            "SELECT shelf_id FROM lots WHERE lot_id = ?", (lot_id,)
        ).fetchone()[0]
        assert raw == "single_item"

        # Read back through the repo (→ _row_to_lot). It must round-trip.
        got = repo.get_lot(conn, lot_id)
        assert got is not None
        assert got.shelf_id == "single_item", (
            f"_row_to_lot rewrote shelf_id to {got.shelf_id!r}; "
            "'single_item' must round-trip unchanged"
        )

    def test_create_lot_with_explicit_timestamps(self, conn):
        p = _make_product(conn)
        lot = _make_lot(
            conn,
            p.product_id,
            placed_at="2026-04-15T10:00:00+00:00",
            last_seen_at="2026-04-15T10:05:00+00:00",
        )
        assert lot.placed_at == "2026-04-15T10:00:00+00:00"
        assert lot.last_seen_at == "2026-04-15T10:05:00+00:00"

    def test_update_partial_fields_only(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        original_seen = lot.last_seen_at
        updated = repo.update_lot(
            conn, lot.lot_id, current_weight_g=520.0, notes="half full"
        )
        assert updated is not None
        assert updated.current_weight_g == 520.0
        assert updated.notes == "half full"
        # Unchanged fields stay put.
        assert updated.status == "on_shelf"
        assert updated.last_seen_at == original_seen

    def test_update_status_and_last_out_at(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        updated = repo.update_lot(
            conn,
            lot.lot_id,
            status="out",
            last_out_at=datetime(2026, 4, 15, 11, 0, 0, tzinfo=timezone.utc),
            total_consumed_g=35.0,
        )
        assert updated is not None
        assert updated.status == "out"
        assert updated.total_consumed_g == 35.0
        assert updated.last_out_at is not None
        assert "2026-04-15" in updated.last_out_at

    def test_update_with_no_fields_returns_current(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        same = repo.update_lot(conn, lot.lot_id)
        assert same is not None
        assert same.lot_id == lot.lot_id
        assert same.status == lot.status

    def test_update_lot_accepts_zero_current_weight(self, conn):
        """Regression: `current_weight_g=0.0` must commit a 0, not be skipped.

        Before the sentinel refactor, the guard was ``is not None`` which
        treated 0.0 as "no update" because ``0.0 is not None`` is True but
        the zero value was also a legitimate, intended write.
        """
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id, current_weight_g=540.0)
        assert lot.current_weight_g == 540.0
        updated = repo.update_lot(conn, lot.lot_id, current_weight_g=0.0)
        assert updated is not None
        assert updated.current_weight_g == 0.0
        # Re-read to confirm the 0 was actually persisted.
        reread = repo.get_lot(conn, lot.lot_id)
        assert reread is not None
        assert reread.current_weight_g == 0.0

    def test_update_lot_accepts_zero_total_consumed(self, conn):
        """Same pattern for total_consumed_g — 0.0 must commit."""
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        # First set it to a non-zero so we can tell the difference.
        repo.update_lot(conn, lot.lot_id, total_consumed_g=42.0)
        mid = repo.get_lot(conn, lot.lot_id)
        assert mid is not None and mid.total_consumed_g == 42.0
        # Now clear back to 0.
        updated = repo.update_lot(conn, lot.lot_id, total_consumed_g=0.0)
        assert updated is not None
        assert updated.total_consumed_g == 0.0

    def test_list_by_status(self, conn):
        p = _make_product(conn)
        a = _make_lot(conn, p.product_id, status="on_shelf")
        b = _make_lot(conn, p.product_id, status="out")
        c = _make_lot(conn, p.product_id, status="depleted")
        on_shelf = repo.list_lots_by_status(conn, "on_shelf")
        assert [l.lot_id for l in on_shelf] == [a.lot_id]
        out = repo.list_lots_by_status(conn, "out")
        assert [l.lot_id for l in out] == [b.lot_id]
        depl = repo.list_lots_by_status(conn, "depleted")
        assert [l.lot_id for l in depl] == [c.lot_id]


# ---------------------------------------------------------------------------
# View queries: get_shelf_registry / get_recently_out_lots /
# get_products_certified_not_on_shelf
# ---------------------------------------------------------------------------


class TestViewQueries:
    def test_get_shelf_registry_basic(self, conn):
        p1 = _make_product(conn, name="Ketchup", barcode="1")
        p2 = _make_product(conn, name="Mustard", barcode="2")
        _make_lot(conn, p1.product_id, status="on_shelf")
        _make_lot(conn, p2.product_id, status="on_shelf")
        # Off-shelf lot should NOT appear.
        _make_lot(conn, p1.product_id, status="out")
        registry = repo.get_shelf_registry(conn)
        assert len(registry) == 2
        names = {lp.product.name for lp in registry}
        assert names == {"Ketchup", "Mustard"}
        for lp in registry:
            assert lp.lot.status == "on_shelf"
            assert lp.product.product_id == lp.lot.product_id

    def test_get_shelf_registry_empty(self, conn):
        assert repo.get_shelf_registry(conn) == []

    def test_get_recently_out_lots_window(self, conn):
        p = _make_product(conn)
        lot_fresh = _make_lot(conn, p.product_id, status="on_shelf")
        lot_stale = _make_lot(conn, p.product_id, status="on_shelf")
        # Fresh: last_out_at = now; Stale: last_out_at 10 minutes ago.
        repo.update_lot(
            conn, lot_fresh.lot_id, status="out", last_out_at="now"
        )
        # Overwrite the timestamp directly — easier than mocking `now`.
        # Production stores last_out_at in ISO-8601 T/Z format and the
        # window query uses strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-N seconds'),
        # so the fixture has to write the same format for the lexicographic
        # comparison to behave.
        with conn:
            conn.execute(
                "UPDATE lots SET status='out', "
                "last_out_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE lot_id = ?",
                (lot_fresh.lot_id,),
            )
            conn.execute(
                "UPDATE lots SET status='out', "
                "last_out_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', "
                "'-10 minutes') "
                "WHERE lot_id = ?",
                (lot_stale.lot_id,),
            )

        # 60s window: only the fresh lot.
        recent = repo.get_recently_out_lots(conn, 60)
        assert [lp.lot.lot_id for lp in recent] == [lot_fresh.lot_id]

        # Large window: both.
        recent = repo.get_recently_out_lots(conn, 3600)
        ids = {lp.lot.lot_id for lp in recent}
        assert ids == {lot_fresh.lot_id, lot_stale.lot_id}

    def test_get_recently_out_ignores_non_out_lots(self, conn):
        p = _make_product(conn)
        _make_lot(conn, p.product_id, status="on_shelf")
        assert repo.get_recently_out_lots(conn, 60) == []

    def test_products_certified_not_on_shelf(self, conn):
        on_shelf_product = _make_product(conn, name="A", barcode="a")
        off_shelf_product = _make_product(conn, name="B", barcode="b")
        uncertified_product = _make_product(
            conn, name="C", barcode="c", certified=0
        )
        # Lot on shelf for A
        _make_lot(conn, on_shelf_product.product_id, status="on_shelf")
        # Lot OUT for B — still counts as "not on shelf"
        _make_lot(conn, off_shelf_product.product_id, status="out")

        certified = repo.get_products_certified_not_on_shelf(conn)
        returned_ids = {p.product_id for p in certified}
        assert off_shelf_product.product_id in returned_ids
        # Uncertified must be excluded.
        assert uncertified_product.product_id not in returned_ids
        # On-shelf must be excluded.
        assert on_shelf_product.product_id not in returned_ids


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


class TestSessions:
    def test_open_session_updates_app_state(self, conn):
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0
        )
        assert s.session_id
        assert s.started_at == "2026-04-15T10:00:00Z"
        assert s.initial_shelf_weight_g == 1500.0
        assert s.ended_at is None
        state = repo.get_app_state(conn)
        assert state.current_session_id == s.session_id
        assert state.door_open == 1

    def test_close_session_clears_app_state(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0)
        closed = repo.close_session(
            conn,
            s.session_id,
            ts=datetime(2026, 4, 15, 10, 5, tzinfo=timezone.utc),
            final_weight_g=1150.0,
        )
        assert closed.ended_at is not None
        assert "2026-04-15" in closed.ended_at
        assert closed.final_shelf_weight_g == 1150.0
        state = repo.get_app_state(conn)
        assert state.current_session_id is None
        assert state.door_open == 0

    def test_close_session_unknown_raises(self, conn):
        with pytest.raises(LookupError):
            repo.close_session(
                conn, "not-a-real-id", ts="2026-04-15T10:05:00Z",
                final_weight_g=0.0,
            )

    def test_mark_session_reconciled_default_ts(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0)
        repo.close_session(conn, s.session_id, ts="2026-04-15T10:05:00Z", final_weight_g=1150.0)
        rec = repo.mark_session_reconciled(conn, s.session_id)
        assert rec is not None
        assert rec.reconciled == 1
        assert rec.reconciled_at is not None

    def test_mark_session_reconciled_explicit_ts(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0)
        repo.close_session(conn, s.session_id, ts="2026-04-15T10:05:00Z", final_weight_g=1150.0)
        rec = repo.mark_session_reconciled(
            conn, s.session_id, ts="2026-04-15T10:06:00Z"
        )
        assert rec is not None
        assert rec.reconciled_at == "2026-04-15T10:06:00Z"

    def test_list_sessions_orders_desc(self, conn):
        s1 = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        repo.close_session(conn, s1.session_id, ts="2026-04-15T10:01:00Z", final_weight_g=990.0)
        s2 = repo.open_session(conn, ts="2026-04-15T11:00:00Z", initial_weight_g=1000.0)
        listed = repo.list_sessions(conn, limit=10)
        assert [s.session_id for s in listed] == [s2.session_id, s1.session_id]

    def test_get_session_missing_returns_none(self, conn):
        assert repo.get_session(conn, "nope") is None


# ---------------------------------------------------------------------------
# Scale events
# ---------------------------------------------------------------------------


class TestScaleEvents:
    def test_record_and_get(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        evt = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts="2026-04-15T10:00:05Z",
                delta_g=-340.0,
                before_weight_g=1000.0,
                after_weight_g=660.0,
                direction="remove",
                classifier_status="pending",
            ),
        )
        assert evt.event_id
        assert evt.direction == "remove"
        assert evt.delta_g == -340.0
        got = repo.get_event(conn, evt.event_id)
        assert got is not None
        assert got.session_id == s.session_id

    def test_get_event_missing_returns_none(self, conn):
        assert repo.get_event(conn, "nope") is None

    def test_list_events_for_session_ordered_by_ts(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        # Insert out-of-order; expect ASC by ts on read.
        e2 = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts="2026-04-15T10:00:10Z",
                delta_g=+340.0,
                before_weight_g=660.0,
                after_weight_g=1000.0,
                direction="add",
            ),
        )
        e1 = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts="2026-04-15T10:00:05Z",
                delta_g=-340.0,
                before_weight_g=1000.0,
                after_weight_g=660.0,
                direction="remove",
            ),
        )
        listed = repo.list_events_for_session(conn, s.session_id)
        assert [e.event_id for e in listed] == [e1.event_id, e2.event_id]

    def test_record_event_accepts_datetime(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        evt = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts=datetime(
                    2026, 4, 15, 10, 0, 7, tzinfo=timezone.utc
                ).isoformat(),
                delta_g=0.0,
                before_weight_g=1000.0,
                after_weight_g=1000.0,
                direction="noise",
            ),
        )
        assert "2026-04-15" in evt.ts
        assert evt.direction == "noise"

    def test_update_event_classification(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        evt = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts="2026-04-15T10:00:05Z",
                delta_g=-340.0,
                before_weight_g=1000.0,
                after_weight_g=660.0,
                direction="remove",
                classifier_status="pending",
            ),
        )
        payload = json.dumps({"item_id": "lot-x", "confidence": 0.92})
        updated = repo.update_event_classification(
            conn,
            evt.event_id,
            classification=payload,
            classifier_status="classified",
        )
        assert updated is not None
        assert updated.classification == payload
        assert updated.classifier_status == "classified"

    def test_update_event_classification_noop(self, conn):
        s = repo.open_session(conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0)
        evt = repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=s.session_id,
                ts="2026-04-15T10:00:05Z",
                delta_g=-10.0,
                before_weight_g=1000.0,
                after_weight_g=990.0,
                direction="remove",
            ),
        )
        same = repo.update_event_classification(conn, evt.event_id)
        assert same is not None
        assert same.event_id == evt.event_id


# ---------------------------------------------------------------------------
# Session resolutions (pass-through)
# ---------------------------------------------------------------------------


class TestSessionResolutions:
    def test_write_and_get(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        r = repo.write_resolution(
            conn,
            SessionResolutionIn(
                session_id=s.session_id,
                lot_id=lot.lot_id,
                pattern="consumed_or_removed",
                consumed_g=45.5,
                confidence=0.92,
            ),
        )
        assert r.resolution_id
        assert r.pattern == "consumed_or_removed"
        assert r.consumed_g == 45.5
        got = repo.get_resolution(conn, r.resolution_id)
        assert got is not None
        assert got.resolution_id == r.resolution_id

    def test_write_resolution_null_lot_allowed(self, conn):
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        r = repo.write_resolution(
            conn,
            SessionResolutionIn(
                session_id=s.session_id, pattern="unknown"
            ),
        )
        assert r.lot_id is None
        assert r.pattern == "unknown"

    def test_list_resolutions_for_session(self, conn):
        p = _make_product(conn)
        lot = _make_lot(conn, p.product_id)
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        # 10 unique patterns exercised; ordering is by created_at ASC.
        patterns = [
            "use_return_no_consumption",
            "use_return_consumed",
            "topped_up",
            "consumed_or_removed",
            "new_arrival",
            "swap_out",
            "swap_in",
            "relocation",
            "unknown",
            "no_op",
        ]
        written = []
        for pat in patterns:
            written.append(
                repo.write_resolution(
                    conn,
                    SessionResolutionIn(
                        session_id=s.session_id,
                        lot_id=lot.lot_id,
                        pattern=pat,
                    ),
                )
            )
        listed = repo.list_resolutions_for_session(conn, s.session_id)
        assert [r.resolution_id for r in listed] == [
            r.resolution_id for r in written
        ]
        assert [r.pattern for r in listed] == patterns


# ---------------------------------------------------------------------------
# Review queue (pass-through)
# ---------------------------------------------------------------------------


class TestReviewQueue:
    def test_enqueue_and_get(self, conn):
        item = repo.enqueue_review(
            conn,
            ReviewQueueIn(
                kind="unknown_item_add",
                proposed=json.dumps({"guess": "unknown"}),
                images=json.dumps(["a.jpg", "b.jpg"]),
            ),
        )
        assert item.review_id
        assert item.kind == "unknown_item_add"
        assert item.status == "pending"
        got = repo.get_review(conn, item.review_id)
        assert got is not None
        assert got.review_id == item.review_id
        assert got.images == json.dumps(["a.jpg", "b.jpg"])

    def test_list_pending_excludes_resolved(self, conn):
        a = repo.enqueue_review(conn, ReviewQueueIn(kind="unknown_item_add"))
        b = repo.enqueue_review(conn, ReviewQueueIn(kind="low_confidence"))
        repo.resolve_review(
            conn,
            b.review_id,
            status="resolved",
            user_response=json.dumps({"choice": "ok"}),
        )
        pending = repo.list_pending_reviews(conn)
        ids = [p.review_id for p in pending]
        assert a.review_id in ids
        assert b.review_id not in ids

    def test_resolve_review_dismissed(self, conn):
        item = repo.enqueue_review(conn, ReviewQueueIn(kind="sensor_anomaly"))
        resolved = repo.resolve_review(
            conn, item.review_id, status="dismissed"
        )
        assert resolved is not None
        assert resolved.status == "dismissed"
        assert resolved.resolved_at is not None

    def test_resolve_review_invalid_status(self, conn):
        item = repo.enqueue_review(conn, ReviewQueueIn(kind="multi_match"))
        with pytest.raises(ValueError):
            repo.resolve_review(conn, item.review_id, status="garbage")

    def test_resolve_review_explicit_ts(self, conn):
        item = repo.enqueue_review(conn, ReviewQueueIn(kind="weight_mismatch"))
        resolved = repo.resolve_review(
            conn,
            item.review_id,
            status="resolved",
            user_response=None,
            resolved_at="2026-04-15T12:00:00Z",
        )
        assert resolved is not None
        assert resolved.resolved_at == "2026-04-15T12:00:00Z"

    def test_get_review_missing(self, conn):
        assert repo.get_review(conn, "nope") is None


# ---------------------------------------------------------------------------
# App state (pass-through singleton)
# ---------------------------------------------------------------------------


class TestAppState:
    def test_initial_state(self, conn):
        st = repo.get_app_state(conn)
        assert st.id == 1
        assert st.door_open == 0
        assert st.shelf_name == "demo shelf"
        assert st.current_session_id is None

    def test_update_single_field(self, conn):
        updated = repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=1234.5)
        )
        assert updated.last_scale_weight_g == 1234.5
        # Unchanged fields preserved.
        assert updated.shelf_name == "demo shelf"

    def test_update_multiple_fields(self, conn):
        updated = repo.update_app_state(
            conn,
            AppStatePatch(
                shelf_name="pantry-1",
                door_open=1,
                last_scale_event_ts="2026-04-15T10:00:00Z",
                camera_locked_json=json.dumps({"exposure": 250}),
            ),
        )
        assert updated.shelf_name == "pantry-1"
        assert updated.door_open == 1
        assert updated.last_scale_event_ts == "2026-04-15T10:00:00Z"
        assert updated.camera_locked_json == json.dumps({"exposure": 250})

    def test_update_noop_returns_current(self, conn):
        st = repo.update_app_state(conn, AppStatePatch())
        # Nothing actually changed; core state is unchanged.
        assert st.shelf_name == "demo shelf"
        assert st.door_open == 0

    def test_updated_at_advances_on_mutation(self, conn):
        before = repo.get_app_state(conn).updated_at
        # SQLite datetime('now') only has second resolution — ensure a tick.
        time.sleep(1.05)
        after = repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=99.0)
        ).updated_at
        assert before is not None and after is not None
        assert after >= before  # monotonic ascending in ISO-8601 order
        assert after != before

    def test_update_app_state_none_skips_current_session_id(self, conn):
        """Default (None) must leave ``current_session_id`` untouched."""
        # Seed a known value so we can tell the difference.
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        assert repo.get_app_state(conn).current_session_id == s.session_id
        # Patch a different field; current_session_id should survive.
        updated = repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=111.1)
        )
        assert updated.current_session_id == s.session_id
        assert updated.last_scale_weight_g == 111.1

    def test_update_app_state_clear_sentinel_sets_null(self, conn):
        """Passing ``CLEAR_SENTINEL`` must explicitly null ``current_session_id``."""
        s = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        assert repo.get_app_state(conn).current_session_id == s.session_id
        updated = repo.update_app_state(
            conn, AppStatePatch(current_session_id=CLEAR_SENTINEL)
        )
        assert updated.current_session_id is None
        # Re-read to confirm persistence.
        assert repo.get_app_state(conn).current_session_id is None


# ---------------------------------------------------------------------------
# close_session race condition — app_state mismatch is logged, not raised
# ---------------------------------------------------------------------------


class TestCloseSessionRace:
    def test_close_session_logs_warning_on_app_state_mismatch(
        self, conn, caplog
    ):
        """If a newer session was opened before close lands, app_state's
        ``current_session_id`` will no longer match. The session row itself
        still closes correctly — we just log a warning and keep going.

        Note: the partial unique index ``sessions_one_open_per_shelf``
        (schema.sql:102) forbids two simultaneously-open sessions per
        shelf, so we can't simulate the race by calling open_session
        twice. Instead we directly NULL out ``app_state.current_session_id``
        — the same end-state a wedged process or a half-applied close
        would leave behind. The behavior under test (close_session
        detects the mismatch + logs warning + still closes the row +
        leaves app_state alone) is independent of HOW the mismatch
        arose. NULL is the only safe alternative value because the
        column has a FOREIGN KEY to sessions.session_id; setting it to
        a fake UUID would fail the FK check.
        """
        s_old = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1000.0
        )
        # Simulate the post-race app_state state: pointer cleared while
        # s_old is still the only OPEN row. close_session must still
        # close s_old's row, leave app_state alone, and log a warning.
        with conn:
            conn.execute(
                "UPDATE app_state SET current_session_id = NULL WHERE id = 1"
            )
        assert repo.get_app_state(conn).current_session_id is None

        with caplog.at_level(logging.WARNING, logger="server.storage.repo"):
            closed = repo.close_session(
                conn,
                s_old.session_id,
                ts="2026-04-15T10:02:00Z",
                final_weight_g=990.0,
            )
        # Session row itself was closed correctly.
        assert closed.session_id == s_old.session_id
        assert closed.ended_at is not None
        # app_state was NOT touched (still NULL — close_session's
        # ``WHERE current_session_id = ?`` clause matched no rows so
        # the UPDATE was a no-op).
        state = repo.get_app_state(conn)
        assert state.current_session_id is None
        # And a warning was logged with both the closing session_id
        # AND the post-race app_state value (None here).
        warnings = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "close_session" in r.getMessage()
        ]
        assert warnings, "expected a warning about app_state mismatch"
        msg = warnings[-1].getMessage()
        assert s_old.session_id in msg
        # Repr of the post-race app_state value (None) appears in the
        # log payload — proves the warning surfaces the mismatched
        # current_session_id, not just the closing id.
        assert "None" in msg


# ---------------------------------------------------------------------------
# close_session shelf_id routing (audit H2)
# ---------------------------------------------------------------------------


class TestCloseSessionShelfRouting:
    def test_close_catch_all_session_leaves_live_shelf_door_open_alone(
        self, conn
    ):
        """Regression (audit H2): a catch-all session close must not
        clobber ``current_session_id`` or ``door_open`` on app_state —
        those belong to the live shelf's door state machine. Before
        the shelf_id kwarg, ``close_session`` unconditionally wrote
        ``current_session_id=NULL, door_open=0`` and corrupted live-
        shelf state whenever the two shelves had concurrent sessions.
        """
        # 1. Open a LIVE session. open_session flips door_open=1 and
        #    stamps current_session_id.
        live = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0,
            shelf_id="live_shelf",
        )
        state_after_live_open = repo.get_app_state(conn)
        assert state_after_live_open.current_session_id == live.session_id
        assert state_after_live_open.door_open == 1

        # 2. Open a CATCH-ALL session concurrently. It stamps
        #    current_catch_all_session_id without touching the live
        #    pointers (open_session already routes by shelf_id).
        catch = repo.open_session(
            conn, ts="2026-04-15T10:01:00Z", initial_weight_g=250.0,
            shelf_id="catch_all",
        )
        state_both_open = repo.get_app_state(conn)
        assert state_both_open.current_session_id == live.session_id
        assert state_both_open.current_catch_all_session_id == catch.session_id
        assert state_both_open.door_open == 1

        # 3. Close the CATCH-ALL session. With the new shelf_id kwarg
        #    the close must touch only current_catch_all_session_id.
        repo.close_session(
            conn, catch.session_id,
            ts="2026-04-15T10:02:00Z",
            final_weight_g=240.0,
            shelf_id="catch_all",
        )

        state_after_catch_close = repo.get_app_state(conn)
        # Catch-all pointer cleared.
        assert state_after_catch_close.current_catch_all_session_id is None
        # Live-shelf pointer + door_open UNTOUCHED — the bug this test
        # guards against would have set both to None / 0.
        assert (
            state_after_catch_close.current_session_id == live.session_id
        ), (
            "live-shelf current_session_id must survive a catch-all "
            "close; got "
            f"{state_after_catch_close.current_session_id!r}"
        )
        assert state_after_catch_close.door_open == 1, (
            "live-shelf door_open must survive a catch-all close"
        )

    def test_close_live_shelf_session_preserves_catch_all_pointer(
        self, conn
    ):
        """Symmetric guard: closing a live session must NOT clear
        current_catch_all_session_id. Default shelf_id='live_shelf'
        preserves legacy behavior (clears live + resets door_open) but
        doesn't reach across to the catch-all pointer.
        """
        live = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0,
            shelf_id="live_shelf",
        )
        catch = repo.open_session(
            conn, ts="2026-04-15T10:01:00Z", initial_weight_g=250.0,
            shelf_id="catch_all",
        )
        repo.close_session(
            conn, live.session_id,
            ts="2026-04-15T10:05:00Z",
            final_weight_g=1480.0,
            # shelf_id defaults to 'live_shelf' — legacy behavior.
        )
        state = repo.get_app_state(conn)
        assert state.current_session_id is None
        assert state.door_open == 0
        # Catch-all pointer still set.
        assert state.current_catch_all_session_id == catch.session_id

    def test_close_session_bad_shelf_id_raises(self, conn):
        live = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z", initial_weight_g=1500.0,
        )
        with pytest.raises(ValueError):
            repo.close_session(
                conn, live.session_id,
                ts="2026-04-15T10:05:00Z",
                final_weight_g=1480.0,
                shelf_id="bogus",
            )


# ---------------------------------------------------------------------------
# create_lot persists in-flight columns (audit H5 companion)
# ---------------------------------------------------------------------------


class TestCreateLotInFlightColumns:
    def test_create_lot_in_flight_persists_all_columns(self, conn):
        """Regression: ``create_lot`` used to omit the four in-flight
        columns from its INSERT. A caller passing ``status='in_flight'``
        with non-None in_flight_since/pickup_weight_g/etc. would see
        those values silently dropped AND the paired CHECK constraint
        (``status='in_flight' iff in_flight_since IS NOT NULL``) would
        reject the row with a confusing error. Now the columns round-
        trip through create_lot.
        """
        product = _make_product(conn)
        lot = repo.create_lot(
            conn,
            LotIn(
                product_id=product.product_id,
                status="in_flight",
                current_weight_g=550.0,
                initial_weight_g=560.0,
                in_flight_since="2026-04-15T10:30:00Z",
                pickup_weight_g=549.0,
                pickup_event_id="E-pick-direct",
                pickup_session_id="S-pick-direct",
            ),
        )
        # Round-trip via get_lot so we read from the DB, not the input.
        round_tripped = repo.get_lot(conn, lot.lot_id)
        assert round_tripped is not None
        assert round_tripped.status == "in_flight"
        assert round_tripped.in_flight_since == "2026-04-15T10:30:00Z"
        assert round_tripped.pickup_weight_g == 549.0
        assert round_tripped.pickup_event_id == "E-pick-direct"
        assert round_tripped.pickup_session_id == "S-pick-direct"

    def test_create_lot_in_flight_explicit_placed_at_persists_columns(
        self, conn
    ):
        """Second INSERT variant (with explicit placed_at/last_seen_at)
        must also carry the in-flight columns through."""
        product = _make_product(conn)
        lot = repo.create_lot(
            conn,
            LotIn(
                product_id=product.product_id,
                status="in_flight",
                current_weight_g=550.0,
                initial_weight_g=560.0,
                placed_at="2026-04-15T09:00:00Z",
                last_seen_at="2026-04-15T10:30:00Z",
                in_flight_since="2026-04-15T10:30:00Z",
                pickup_weight_g=549.0,
                pickup_event_id="E-pick-ts",
                pickup_session_id="S-pick-ts",
            ),
        )
        round_tripped = repo.get_lot(conn, lot.lot_id)
        assert round_tripped is not None
        assert round_tripped.in_flight_since == "2026-04-15T10:30:00Z"
        assert round_tripped.pickup_weight_g == 549.0
        assert round_tripped.pickup_event_id == "E-pick-ts"
        assert round_tripped.pickup_session_id == "S-pick-ts"

    def test_create_lot_on_shelf_leaves_in_flight_columns_null(self, conn):
        """Default on_shelf path should still produce NULL in-flight
        columns. Guards against accidentally writing junk to them.
        """
        product = _make_product(conn)
        lot = repo.create_lot(
            conn,
            LotIn(
                product_id=product.product_id,
                status="on_shelf",
                current_weight_g=550.0,
                initial_weight_g=560.0,
            ),
        )
        round_tripped = repo.get_lot(conn, lot.lot_id)
        assert round_tripped is not None
        assert round_tripped.in_flight_since is None
        assert round_tripped.pickup_weight_g is None
        assert round_tripped.pickup_event_id is None
        assert round_tripped.pickup_session_id is None


# ---------------------------------------------------------------------------
# AppStatePatch clears current_catch_all_session_id via CLEAR_SENTINEL (M7)
# ---------------------------------------------------------------------------


class TestAppStatePatchCatchAll:
    def test_app_state_patch_clears_catch_all_session_via_sentinel(
        self, conn
    ):
        """Passing ``CLEAR_SENTINEL`` to ``current_catch_all_session_id``
        must explicitly null the column (mirrors the current_session_id
        sentinel behavior). Plain None still means "don't touch."
        """
        # Seed the pointer.
        catch = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z",
            initial_weight_g=250.0, shelf_id="catch_all",
        )
        state = repo.get_app_state(conn)
        assert state.current_catch_all_session_id == catch.session_id

        # None => unchanged.
        repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=1.0),
        )
        assert (
            repo.get_app_state(conn).current_catch_all_session_id
            == catch.session_id
        )

        # CLEAR_SENTINEL => null.
        repo.update_app_state(
            conn,
            AppStatePatch(current_catch_all_session_id=CLEAR_SENTINEL),
        )
        assert repo.get_app_state(conn).current_catch_all_session_id is None

    def test_app_state_patch_sets_catch_all_session_id_explicit(self, conn):
        """Plain string value writes verbatim (not a sentinel).

        The partial unique index ``sessions_one_open_per_shelf``
        (schema.sql:102) forbids two simultaneously-open sessions per
        shelf — so to open ``catch2`` we must first close ``catch``.
        The close call shifts the app_state pointer to NULL, which is
        the realistic post-close state; then the second open writes the
        new pointer; then the patch API rewrites it again to verify
        plain-string values write verbatim.
        """
        catch = repo.open_session(
            conn, ts="2026-04-15T10:00:00Z",
            initial_weight_g=250.0, shelf_id="catch_all",
        )
        # Close before reopening — required by the partial unique index.
        repo.close_session(
            conn, catch.session_id,
            ts="2026-04-15T10:30:00Z",
            final_weight_g=255.0,
            shelf_id="catch_all",
        )
        catch2 = repo.open_session(
            conn, ts="2026-04-15T11:00:00Z",
            initial_weight_g=260.0, shelf_id="catch_all",
        )
        # open_session already wrote catch2 as the current pointer, so
        # rewriting it through the patch should still yield catch2.
        repo.update_app_state(
            conn,
            AppStatePatch(current_catch_all_session_id=catch2.session_id),
        )
        assert (
            repo.get_app_state(conn).current_catch_all_session_id
            == catch2.session_id
        )
        # And the original pointer (catch) is no longer active.
        assert (
            repo.get_app_state(conn).current_catch_all_session_id
            != catch.session_id
        )


# ---------------------------------------------------------------------------
# ID generation
# ---------------------------------------------------------------------------


def test_new_id_is_string_and_unique():
    ids = {repo.new_id() for _ in range(64)}
    assert len(ids) == 64
    for i in ids:
        assert isinstance(i, str)
        # UUID string length = 36 (8-4-4-4-12 + 4 dashes)
        assert len(i) == 36
