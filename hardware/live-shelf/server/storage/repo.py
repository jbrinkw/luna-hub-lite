"""Typed repo: raw sqlite3 under typed Pydantic dataclasses.

Design rules:
  * Every public function takes `conn: sqlite3.Connection` as the first
    argument — no module-level singletons.
  * Writes use `with conn:` (implicit transaction commit).
  * All timestamps flow through `coerce_ts()` on the way in.
  * IDs are generated via `new_id()` — uses `uuid.uuid7()` when available
    (Python 3.14+) so rows sort naturally by creation time, otherwise
    `uuid.uuid4()`.
  * Row -> model conversion goes through `_row_to_*` helpers so every SELECT
    returns a typed object.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Optional, Sequence

from .migrations import init_db as _init_db
from .models import (
    CLEAR_SENTINEL,
    AppState,
    AppStatePatch,
    Lot,
    LotIn,
    LotWithProduct,
    Product,
    ProductIn,
    ProductReferenceImage,
    ProductReferenceImageIn,
    ReviewQueueIn,
    ReviewQueueItem,
    ScaleEvent,
    ScaleEventIn,
    Session,
    SessionResolution,
    SessionResolutionIn,
    TareArm,
    UsageLog,
    UsageLogIn,
    coerce_ts,
)

log = logging.getLogger(__name__)

# Re-export so callers can `from .repo import init_db`.
init_db = _init_db


# Module-level "not supplied" sentinel used by partial-update helpers so that
# passing ``None`` can be distinguished from "skip this field." Callers should
# not import this directly; rely on the default value of the parameter.
_UNSET: Any = object()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def new_id() -> str:
    """Generate a time-sortable UUID string.

    `uuid.uuid7()` was added in Python 3.14. On 3.13 we fall back to
    `uuid.uuid4()` — good enough for a single-node demo where strict time
    ordering isn't required.
    """
    factory = getattr(uuid, "uuid7", None)
    if factory is None:
        return str(uuid.uuid4())
    return str(factory())


def _row_to_product(row: sqlite3.Row) -> Product:
    return Product(
        product_id=row["product_id"],
        name=row["name"],
        certified=row["certified"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        barcode=row["barcode"],
        brand=row["brand"],
        variant=row["variant"],
        net_weight_g=row["net_weight_g"],
        gross_weight_g=row["gross_weight_g"],
        tare_weight_g=row["tare_weight_g"],
        serving_weight_g=row["serving_weight_g"],
        servings_per_container=row["servings_per_container"],
        unit_type=row["unit_type"],
        density_g_per_ml=row["density_g_per_ml"],
        container_type=row["container_type"],
    )


def _row_to_reference_image(row: sqlite3.Row) -> ProductReferenceImage:
    return ProductReferenceImage(
        image_id=row["image_id"],
        product_id=row["product_id"],
        file_path=row["file_path"],
        captured_at=row["captured_at"],
        angle=row["angle"],
    )


def _row_to_lot(row: sqlite3.Row) -> Lot:
    # Old rows (pre-migration) may not have the in-flight columns yet even
    # though migrations.py runs _apply_column_additions on every open — use
    # dict().get() so older query callers without those columns still work.
    keys = set(row.keys()) if hasattr(row, "keys") else set()
    # Shelf discriminator: present on every post-migration row (NOT NULL
    # DEFAULT 'live_shelf'), but fall back defensively for ultra-legacy
    # selects that may not include the column in the projection.
    shelf_raw = row["shelf_id"] if "shelf_id" in keys else None
    return Lot(
        lot_id=row["lot_id"],
        product_id=row["product_id"],
        status=row["status"],
        total_consumed_g=row["total_consumed_g"],
        placed_at=row["placed_at"],
        last_seen_at=row["last_seen_at"],
        current_weight_g=row["current_weight_g"],
        initial_weight_g=row["initial_weight_g"],
        last_out_at=row["last_out_at"],
        notes=row["notes"],
        in_flight_since=row["in_flight_since"] if "in_flight_since" in keys else None,
        pickup_weight_g=row["pickup_weight_g"] if "pickup_weight_g" in keys else None,
        pickup_event_id=row["pickup_event_id"] if "pickup_event_id" in keys else None,
        pickup_session_id=row["pickup_session_id"] if "pickup_session_id" in keys else None,
        shelf_id=shelf_raw if shelf_raw in ("live_shelf", "catch_all") else "live_shelf",
    )


def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(
        session_id=row["session_id"],
        started_at=row["started_at"],
        reconciled=row["reconciled"],
        ended_at=row["ended_at"],
        initial_shelf_weight_g=row["initial_shelf_weight_g"],
        final_shelf_weight_g=row["final_shelf_weight_g"],
        reconciled_at=row["reconciled_at"],
    )


def _row_to_scale_event(row: sqlite3.Row) -> ScaleEvent:
    return ScaleEvent(
        event_id=row["event_id"],
        ts=row["ts"],
        delta_g=row["delta_g"],
        before_weight_g=row["before_weight_g"],
        after_weight_g=row["after_weight_g"],
        direction=row["direction"],
        created_at=row["created_at"],
        session_id=row["session_id"],
        before_frame_path=row["before_frame_path"],
        after_frame_path=row["after_frame_path"],
        classification=row["classification"],
        classifier_status=row["classifier_status"],
    )


def _row_to_resolution(row: sqlite3.Row) -> SessionResolution:
    return SessionResolution(
        resolution_id=row["resolution_id"],
        session_id=row["session_id"],
        pattern=row["pattern"],
        created_at=row["created_at"],
        lot_id=row["lot_id"],
        consumed_g=row["consumed_g"],
        confidence=row["confidence"],
        add_event_id=row["add_event_id"],
        remove_event_id=row["remove_event_id"],
    )


def _row_to_review(row: sqlite3.Row) -> ReviewQueueItem:
    return ReviewQueueItem(
        review_id=row["review_id"],
        kind=row["kind"],
        status=row["status"],
        created_at=row["created_at"],
        session_id=row["session_id"],
        event_id=row["event_id"],
        resolution_id=row["resolution_id"],
        proposed=row["proposed"],
        images=row["images"],
        resolved_at=row["resolved_at"],
        user_response=row["user_response"],
    )


def _row_to_app_state(row: sqlite3.Row) -> AppState:
    # ``current_catch_all_session_id`` was added by the catch-all tracker
    # migration (CATCH_ALL_SCALE_PLAN.md §4.2). Long-lived test fixtures
    # that predate the column won't have it in the projection, so probe
    # row.keys() defensively and fall back to None.
    keys = set(row.keys()) if hasattr(row, "keys") else set()
    return AppState(
        id=row["id"],
        current_session_id=row["current_session_id"],
        last_scale_weight_g=row["last_scale_weight_g"],
        last_scale_event_ts=row["last_scale_event_ts"],
        door_open=row["door_open"],
        shelf_name=row["shelf_name"],
        camera_locked_json=row["camera_locked_json"],
        updated_at=row["updated_at"],
        current_catch_all_session_id=(
            row["current_catch_all_session_id"]
            if "current_catch_all_session_id" in keys
            else None
        ),
    )


# ---------------------------------------------------------------------------
# products
# ---------------------------------------------------------------------------


def create_product(conn: sqlite3.Connection, p: ProductIn) -> Product:
    product_id = new_id()
    with conn:
        conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, brand, variant,
                net_weight_g, gross_weight_g, tare_weight_g,
                serving_weight_g, servings_per_container,
                unit_type, density_g_per_ml, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                product_id,
                p.barcode,
                p.name,
                p.brand,
                p.variant,
                p.net_weight_g,
                p.gross_weight_g,
                p.tare_weight_g,
                p.serving_weight_g,
                p.servings_per_container,
                p.unit_type,
                p.density_g_per_ml,
                p.container_type,
                p.certified,
            ),
        )
    got = get_product(conn, product_id)
    assert got is not None
    return got


def get_product(conn: sqlite3.Connection, product_id: str) -> Optional[Product]:
    row = conn.execute(
        "SELECT * FROM products WHERE product_id = ?", (product_id,)
    ).fetchone()
    return _row_to_product(row) if row else None


def get_product_by_barcode(
    conn: sqlite3.Connection, barcode: str
) -> Optional[Product]:
    row = conn.execute(
        "SELECT * FROM products WHERE barcode = ?", (barcode,)
    ).fetchone()
    return _row_to_product(row) if row else None


def list_products(conn: sqlite3.Connection) -> list[Product]:
    # Filter soft-deleted rows so the classifier's candidate pool + the
    # /inventory UI don't surface products the cloud has tombstoned. We
    # keep the rows in the local DB (rather than hard-deleting) because
    # lots.product_id references products with no cascade — dropping the
    # row would orphan historical lots. Match by ``deleted_at IS NULL``
    # because SQLite TEXT compares lexicographically and any non-null
    # string (even empty) means "deleted on cloud".
    rows = conn.execute(
        "SELECT * FROM products WHERE deleted_at IS NULL "
        "ORDER BY created_at ASC"
    ).fetchall()
    return [_row_to_product(r) for r in rows]


def get_products_by_ids(
    conn: sqlite3.Connection, product_ids: Sequence[str]
) -> dict[str, Product]:
    """Batch-fetch products by id → ``{product_id: Product}``.

    Used by candidate-source adapters to avoid an N+1 pattern when
    hydrating a list of lots — one SELECT for every unique product_id
    across the batch, versus one SELECT per lot under the held DB lock.
    Returns only products that exist; missing ids are simply absent
    from the dict. An empty ``product_ids`` is a no-op (no query).
    """
    # Dedupe while preserving deterministic ordering for tests.
    unique_ids: list[str] = []
    seen: set[str] = set()
    for pid in product_ids:
        if pid in seen:
            continue
        seen.add(pid)
        unique_ids.append(pid)
    if not unique_ids:
        return {}
    placeholders = ",".join("?" * len(unique_ids))
    rows = conn.execute(
        f"SELECT * FROM products WHERE product_id IN ({placeholders})",
        unique_ids,
    ).fetchall()
    return {row["product_id"]: _row_to_product(row) for row in rows}


def set_product_certified(
    conn: sqlite3.Connection, product_id: str, certified: bool
) -> Optional[Product]:
    with conn:
        conn.execute(
            """
            UPDATE products
               SET certified = ?, updated_at = datetime('now')
             WHERE product_id = ?
            """,
            (1 if certified else 0, product_id),
        )
    return get_product(conn, product_id)


def set_product_tare(
    conn: sqlite3.Connection, product_id: str, tare_g: float
) -> Optional[Product]:
    """Overwrite ``products.tare_weight_g`` for a single product row.

    Isolated from :func:`consume_tare_arm` so the api-route arm-status
    endpoint (and future manual tare edits) can reuse the same helper
    without coupling to the arm-row delete.
    """
    with conn:
        conn.execute(
            """
            UPDATE products
               SET tare_weight_g = ?, updated_at = datetime('now')
             WHERE product_id = ?
            """,
            (float(tare_g), product_id),
        )
    return get_product(conn, product_id)


def delete_lot(conn: sqlite3.Connection, lot_id: str) -> dict[str, int]:
    """Remove a single lot.

    Only deletes the ``lots`` row. The underlying ``products`` row and its
    reference images are preserved — the catalog is intact so the user
    can place a new instance of the same product later. ``scale_events``
    rows that reference this lot are also preserved; they keep their
    classification text pointing at the (now-deleted) lot_id, which is
    fine for historical / audit purposes.

    ``session_resolutions.lot_id`` has a NOT-CASCADE foreign key to
    ``lots``, so we NULL it out first — that column is already declared
    nullable for "unknown" resolutions, so dropping the pointer is
    schema-legal and preserves the resolution row's history.

    ``usage_log.lot_id`` is also a nullable NOT-CASCADE FK to lots, so
    we NULL those pointers too. Unlike session_resolutions, the usage_log
    history itself is preserved — renaming a product later shouldn't
    change history, and the denormalised product_id + product_name
    columns keep the row meaningful without a live lot pointer.
    """
    counts = {
        "session_resolutions_unlinked": 0,
        "usage_log_unlinked": 0,
        "lots": 0,
    }
    with conn:
        cur = conn.execute(
            "UPDATE session_resolutions SET lot_id = NULL WHERE lot_id = ?",
            (lot_id,),
        )
        counts["session_resolutions_unlinked"] = cur.rowcount or 0
        cur = conn.execute(
            "UPDATE usage_log SET lot_id = NULL WHERE lot_id = ?",
            (lot_id,),
        )
        counts["usage_log_unlinked"] = cur.rowcount or 0
        cur = conn.execute("DELETE FROM lots WHERE lot_id = ?", (lot_id,))
        counts["lots"] = cur.rowcount or 0
    return counts


def delete_product(
    conn: sqlite3.Connection, product_id: str
) -> dict[str, int]:
    """Remove a product + all rows that reference it.

    The schema cascades ``product_reference_images`` on product delete, but
    ``lots`` uses a plain ``REFERENCES products(product_id)`` (no cascade),
    so we delete lots first inside the same transaction. Sessions / events
    / review_queue rows are not touched — they reference lots/sessions
    (and in some cases products transitively via the classifier blob), not
    the product row itself, so they'd either orphan or outlive the product
    anyway. The filesystem (``data/refs/<product_id>/``) is cleaned up by
    the caller.

    Returns a small dict with per-table delete counts so the caller can
    include them in the response payload.
    """
    counts = {
        "session_resolutions_unlinked": 0,
        "usage_log": 0,
        "lots": 0,
        "product_reference_images": 0,
        "products": 0,
    }
    with conn:
        # session_resolutions.lot_id → lots(lot_id) has no cascade, so
        # NULL out references to any of this product's lots before we
        # delete the lot rows themselves.
        cur = conn.execute(
            """
            UPDATE session_resolutions
               SET lot_id = NULL
             WHERE lot_id IN (
                SELECT lot_id FROM lots WHERE product_id = ?
             )
            """,
            (product_id,),
        )
        counts["session_resolutions_unlinked"] = cur.rowcount or 0
        # usage_log.product_id is NOT NULL (history is denormalised so
        # product_name survives renames), so we can't NULL it out — the
        # rows must be deleted outright. Those rows reference lots via
        # lot_id (nullable) too, and both FKs are plain / non-cascading,
        # so a plain DELETE here before the lot delete keeps both happy.
        cur = conn.execute(
            "DELETE FROM usage_log WHERE product_id = ?", (product_id,)
        )
        counts["usage_log"] = cur.rowcount or 0
        cur = conn.execute(
            "DELETE FROM lots WHERE product_id = ?", (product_id,)
        )
        counts["lots"] = cur.rowcount or 0
        cur = conn.execute(
            "DELETE FROM product_reference_images WHERE product_id = ?",
            (product_id,),
        )
        counts["product_reference_images"] = cur.rowcount or 0
        cur = conn.execute(
            "DELETE FROM products WHERE product_id = ?", (product_id,)
        )
        counts["products"] = cur.rowcount or 0
    return counts


# ---------------------------------------------------------------------------
# product_reference_images
# ---------------------------------------------------------------------------


def add_reference_image(
    conn: sqlite3.Connection, img: ProductReferenceImageIn
) -> ProductReferenceImage:
    image_id = new_id()
    with conn:
        conn.execute(
            """
            INSERT INTO product_reference_images (
                image_id, product_id, file_path, angle
            ) VALUES (?, ?, ?, ?)
            """,
            (image_id, img.product_id, img.file_path, img.angle),
        )
    row = conn.execute(
        "SELECT * FROM product_reference_images WHERE image_id = ?",
        (image_id,),
    ).fetchone()
    return _row_to_reference_image(row)


def list_reference_images(
    conn: sqlite3.Connection, product_id: str
) -> list[ProductReferenceImage]:
    rows = conn.execute(
        """
        SELECT * FROM product_reference_images
         WHERE product_id = ?
         ORDER BY captured_at ASC
        """,
        (product_id,),
    ).fetchall()
    return [_row_to_reference_image(r) for r in rows]


# ---------------------------------------------------------------------------
# lots
# ---------------------------------------------------------------------------


def create_lot(conn: sqlite3.Connection, lot: LotIn) -> Lot:
    lot_id = new_id()
    placed = coerce_ts(lot.placed_at)
    last_seen = coerce_ts(lot.last_seen_at)
    last_out = coerce_ts(lot.last_out_at)
    # Shelf discriminator — LotIn defaults to 'live_shelf', so explicit
    # listing in the INSERT preserves the existing behavior for every
    # pre-catch-all callsite while letting new callsites pass
    # shelf_id='catch_all'. CHECK constraint in schema.sql validates the
    # enum value; we just pass through.
    shelf_id = lot.shelf_id or "live_shelf"
    # SQLite defaults only fire when the column isn't listed; we list them all
    # but pass NULL for placed_at/last_seen_at to trigger `datetime('now')`.
    # The four in-flight columns are passed through unchanged; the paired
    # CHECK in schema.sql (status='in_flight' iff in_flight_since IS NOT NULL)
    # means callers asking for ``status='in_flight'`` MUST supply a non-NULL
    # ``in_flight_since`` (and typically pickup_weight_g/pickup_event_id)
    # or the DB will reject the INSERT with a confusing CHECK-constraint
    # error. Omitting them here previously caused silent column drops.
    with conn:
        if placed is None and last_seen is None:
            conn.execute(
                """
                INSERT INTO lots (
                    lot_id, product_id, status, current_weight_g,
                    initial_weight_g, total_consumed_g, last_out_at, notes,
                    in_flight_since, pickup_weight_g, pickup_event_id,
                    pickup_session_id,
                    shelf_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lot_id,
                    lot.product_id,
                    lot.status,
                    lot.current_weight_g,
                    lot.initial_weight_g,
                    lot.total_consumed_g,
                    last_out,
                    lot.notes,
                    lot.in_flight_since,
                    lot.pickup_weight_g,
                    lot.pickup_event_id,
                    lot.pickup_session_id,
                    shelf_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO lots (
                    lot_id, product_id, status, current_weight_g,
                    initial_weight_g, total_consumed_g,
                    placed_at, last_seen_at, last_out_at, notes,
                    in_flight_since, pickup_weight_g, pickup_event_id,
                    pickup_session_id,
                    shelf_id
                ) VALUES (?, ?, ?, ?, ?, ?,
                          COALESCE(?, datetime('now')),
                          COALESCE(?, datetime('now')),
                          ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lot_id,
                    lot.product_id,
                    lot.status,
                    lot.current_weight_g,
                    lot.initial_weight_g,
                    lot.total_consumed_g,
                    placed,
                    last_seen,
                    last_out,
                    lot.notes,
                    lot.in_flight_since,
                    lot.pickup_weight_g,
                    lot.pickup_event_id,
                    lot.pickup_session_id,
                    shelf_id,
                ),
            )
    got = get_lot(conn, lot_id)
    assert got is not None
    return got


def get_lot(conn: sqlite3.Connection, lot_id: str) -> Optional[Lot]:
    row = conn.execute(
        "SELECT * FROM lots WHERE lot_id = ?", (lot_id,)
    ).fetchone()
    return _row_to_lot(row) if row else None


def update_lot(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    status: str | object = _UNSET,
    current_weight_g: float | object = _UNSET,
    total_consumed_g: float | object = _UNSET,
    last_seen_at: str | datetime | object = _UNSET,
    last_out_at: str | datetime | object = _UNSET,
    notes: str | object = _UNSET,
) -> Optional[Lot]:
    """Partial update — only fields explicitly supplied are written.

    Each parameter defaults to the module-level ``_UNSET`` sentinel so that
    callers can legitimately write a zero value (e.g. ``current_weight_g=0.0``)
    or an explicit ``None`` without it being interpreted as "skip this field."
    """
    fields: list[str] = []
    values: list[Any] = []
    if status is not _UNSET:
        fields.append("status = ?")
        values.append(status)
    if current_weight_g is not _UNSET:
        fields.append("current_weight_g = ?")
        values.append(current_weight_g)
    if total_consumed_g is not _UNSET:
        fields.append("total_consumed_g = ?")
        values.append(total_consumed_g)
    if last_seen_at is not _UNSET:
        fields.append("last_seen_at = ?")
        values.append(coerce_ts(last_seen_at))  # type: ignore[arg-type]
    if last_out_at is not _UNSET:
        fields.append("last_out_at = ?")
        values.append(coerce_ts(last_out_at))  # type: ignore[arg-type]
    if notes is not _UNSET:
        fields.append("notes = ?")
        values.append(notes)
    if not fields:
        return get_lot(conn, lot_id)
    values.append(lot_id)
    with conn:
        conn.execute(
            f"UPDATE lots SET {', '.join(fields)} WHERE lot_id = ?",
            values,
        )
    return get_lot(conn, lot_id)


def list_lots_by_status(
    conn: sqlite3.Connection, status: str
) -> list[Lot]:
    rows = conn.execute(
        "SELECT * FROM lots WHERE status = ? ORDER BY placed_at ASC",
        (status,),
    ).fetchall()
    return [_row_to_lot(r) for r in rows]


def list_lots_by_shelf_and_status(
    conn: sqlite3.Connection, shelf_id: str, status: str
) -> list[Lot]:
    """Shelf-scoped variant of :func:`list_lots_by_status`.

    Used by catch-all classifier paths that must never consider live-shelf
    lots (and vice versa). The idx_lots_shelf_status composite index makes
    this cheap; the scalar filter matches the same CHECK enum as
    ``lots.shelf_id``.
    """
    rows = conn.execute(
        """
        SELECT * FROM lots
         WHERE shelf_id = ? AND status = ?
         ORDER BY placed_at ASC
        """,
        (shelf_id, status),
    ).fetchall()
    return [_row_to_lot(r) for r in rows]


def list_lots_by_product(
    conn: sqlite3.Connection,
    product_id: str,
    *,
    shelf_id: Optional[str] = None,
) -> list[Lot]:
    """Return every lot for a product, ordered by classifier-relevance.

    Used by ``_pick_best_lot_for_product`` (handlers/scale_events.py) on
    the apply path AFTER the classifier returns a product_id. Ordering:

      1. ``in_flight`` lots first (the user just lifted this — almost
         certainly the same one returning).
      2. ``out`` lots next (recently consumed; place-back means revive).
      3. ``on_shelf`` lots last (already-present; ADD becomes a top-up).

    Within each tier, secondary sort is ``placed_at DESC`` (most-recent
    first) — a proxy for "freshest known instance of this product."

    The ordering is intentionally NOT FEFO (expires_on) because the Pi
    schema has no ``expires_on`` column on ``lots`` (cloud-only field).
    Callers needing FEFO must consult the cloud catalog directly.
    """
    if shelf_id is not None:
        rows = conn.execute(
            """
            SELECT * FROM lots
             WHERE product_id = ? AND shelf_id = ?
             ORDER BY
               CASE status
                 WHEN 'in_flight' THEN 0
                 WHEN 'out'       THEN 1
                 WHEN 'on_shelf'  THEN 2
                 ELSE 3
               END ASC,
               placed_at DESC
            """,
            (product_id, shelf_id),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT * FROM lots
             WHERE product_id = ?
             ORDER BY
               CASE status
                 WHEN 'in_flight' THEN 0
                 WHEN 'out'       THEN 1
                 WHEN 'on_shelf'  THEN 2
                 ELSE 3
               END ASC,
               placed_at DESC
            """,
            (product_id,),
        ).fetchall()
    return [_row_to_lot(r) for r in rows]


# ---------------------------------------------------------------------------
# lots: in-flight tracker helpers (IN_FLIGHT_TRACKER_PLAN.md §6)
# ---------------------------------------------------------------------------


def mark_lot_in_flight(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    pickup_weight_g: float,
    pickup_event_id: Optional[str],
    pickup_session_id: Optional[str],
    in_flight_since: str,
) -> Optional[Lot]:
    """Transition a lot from ``on_shelf`` to ``in_flight``.

    Writes all four in-flight columns and preserves ``current_weight_g``
    (still the last known shelf reading for this lot — useful for the UI).
    ``last_seen_at`` is bumped to the pickup timestamp since the item was
    last observed by the scale at that moment.

    ``pickup_event_id`` is typed ``Optional[str]`` so emission paths that
    haven't recorded a scale event yet (e.g. reconciler retrofits) can
    pass ``None`` — it becomes NULL in SQL. The unique partial dedup
    index on ``usage_log(pickup_event_id)`` only indexes non-NULL values
    so multiple ``NULL`` rows are allowed.
    """
    with conn:
        conn.execute(
            """
            UPDATE lots
               SET status = 'in_flight',
                   in_flight_since = ?,
                   pickup_weight_g = ?,
                   pickup_event_id = ?,
                   pickup_session_id = ?,
                   last_seen_at = ?
             WHERE lot_id = ?
            """,
            (
                in_flight_since,
                pickup_weight_g,
                pickup_event_id,
                pickup_session_id,
                in_flight_since,
                lot_id,
            ),
        )
    return get_lot(conn, lot_id)


def return_lot_from_flight(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    return_weight_g: float,
    consumption_g: float,
    return_ts: str,
) -> Optional[Lot]:
    """Transition an in-flight lot back to ``on_shelf`` with updated weight.

    Adds ``consumption_g`` to ``total_consumed_g`` (clamped at zero so
    negative-consumption topups don't decrement the lifetime total) and
    clears the four in-flight columns.
    """
    consumed = max(0.0, float(consumption_g))
    with conn:
        # ``AND status='in_flight'`` is the race guard: if a concurrent
        # sweeper (TTL reaper) already flipped the lot to ``out`` or a
        # replacement path cleared the in-flight columns, this UPDATE
        # must not silently promote a closed lot back to ``on_shelf``.
        # rowcount=0 is a signal callers can observe (later agent's
        # change); for now the guard just makes the write a no-op.
        conn.execute(
            """
            UPDATE lots
               SET status = 'on_shelf',
                   current_weight_g = ?,
                   total_consumed_g = total_consumed_g + ?,
                   last_seen_at = ?,
                   in_flight_since = NULL,
                   pickup_weight_g = NULL,
                   pickup_event_id = NULL,
                   pickup_session_id = NULL
             WHERE lot_id = ? AND status = 'in_flight'
            """,
            (return_weight_g, consumed, return_ts, lot_id),
        )
    return get_lot(conn, lot_id)


def close_in_flight_lot_as_out(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    last_out_at: str,
) -> Optional[Lot]:
    """Close an in-flight lot as ``status='out'`` without consumption accounting.

    Direct-flip variant kept for rare paths that don't want to update
    total_consumed_g. Prefer ``reap_in_flight_lot_as_consumed`` (sweeper
    TTL reaper) or ``close_in_flight_as_replaced`` (replacement branch),
    both of which also increment ``total_consumed_g`` — losing an item
    is a real consumption event.
    """
    with conn:
        # Race guard: only flip if still in_flight. Stops a double-close
        # (e.g. sweeper + replacement path) from re-stamping last_out_at
        # on an already-closed lot.
        conn.execute(
            """
            UPDATE lots
               SET status = 'out',
                   last_out_at = ?,
                   in_flight_since = NULL,
                   pickup_weight_g = NULL,
                   pickup_event_id = NULL,
                   pickup_session_id = NULL
             WHERE lot_id = ? AND status = 'in_flight'
            """,
            (last_out_at, lot_id),
        )
    return get_lot(conn, lot_id)


def reap_in_flight_lot_as_consumed(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    consumed_g: float,
    last_out_at: str,
) -> Optional[Lot]:
    """TTL reaper close: flip in_flight → out AND record the lost mass.

    ``consumed_g`` is added to ``total_consumed_g`` (clamped at 0). The
    item never returned within TTL — we presume it was consumed or
    discarded off-shelf. Clears the four in-flight columns.
    """
    with conn:
        # Race guard: ``AND status='in_flight'`` so a concurrent return
        # (e.g. a late returning_handler after the sweeper's TTL fired)
        # doesn't get double-counted against total_consumed_g. The
        # replacement-branch helper below delegates here so it inherits
        # the same guard.
        conn.execute(
            """
            UPDATE lots
               SET status = 'out',
                   last_out_at = ?,
                   total_consumed_g = total_consumed_g + ?,
                   in_flight_since = NULL,
                   pickup_weight_g = NULL,
                   pickup_event_id = NULL,
                   pickup_session_id = NULL
             WHERE lot_id = ? AND status = 'in_flight'
            """,
            (last_out_at, max(0.0, float(consumed_g)), lot_id),
        )
    return get_lot(conn, lot_id)


def close_in_flight_as_replaced(
    conn: sqlite3.Connection,
    lot_id: str,
    *,
    consumed_g: float,
    last_out_at: str,
) -> Optional[Lot]:
    """Replacement-branch close: old in_flight lot is gone (user put
    something different in its place).

    Same semantics as the TTL reaper — we presume the old item is gone
    and record ``consumed_g`` (typically the pickup weight) as
    consumption. A separate helper so the call-site reads clearly and
    a future refactor can diverge the two paths (e.g. different
    audit reason codes) without churn.
    """
    return reap_in_flight_lot_as_consumed(
        conn, lot_id,
        consumed_g=consumed_g,
        last_out_at=last_out_at,
    )


def list_in_flight_lots(
    conn: sqlite3.Connection,
    *,
    younger_than_seconds: Optional[int] = None,
    shelf_id: Optional[str] = None,
) -> list[Lot]:
    """Return all lots with ``status='in_flight'`` ordered oldest first.

    ``younger_than_seconds`` filters IN the lots whose
    ``in_flight_since`` is more recent than ``now - N seconds`` — i.e.
    it's a freshness window, NOT a TTL. This is the *complement* of
    the TTL the sweeper reaps on: pass ``IN_FLIGHT_TTL_SECONDS`` to
    :func:`list_expired_in_flight_lots` (which filters by
    ``age > TTL``), NOT here — doing the reverse would keep only the
    lots a sweeper is about to reap instead of the fresh ones the
    classifier should consider.

    ``shelf_id`` optionally scopes the query to a single shelf. When None
    (default), returns in-flight lots across ALL shelves — preserves the
    pre-catch-all behavior for every existing caller (sweeper TTL reaper,
    dashboard registry).
    """
    clauses: list[str] = ["status='in_flight'"]
    params: list[Any] = []
    if younger_than_seconds is not None:
        clauses.append(
            "(julianday('now') - julianday(in_flight_since)) * 86400.0 <= ?"
        )
        params.append(younger_than_seconds)
    if shelf_id is not None:
        clauses.append("shelf_id = ?")
        params.append(shelf_id)
    sql = (
        "SELECT * FROM lots WHERE "
        + " AND ".join(clauses)
        + " ORDER BY in_flight_since ASC"
    )
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_lot(r) for r in rows]


def list_expired_in_flight_lots(
    conn: sqlite3.Connection,
    *,
    ttl_seconds: int,
    limit: int = 50,
) -> list[Lot]:
    """Return in-flight lots whose in_flight_since + ttl_seconds < now.

    Used by the sweeper's TTL reaper (§8) in bounded chunks (default 50)
    so one tick can never monopolize the DB lock.
    """
    rows = conn.execute(
        """
        SELECT * FROM lots
         WHERE status='in_flight'
           AND (julianday('now') - julianday(in_flight_since)) * 86400.0 > ?
         ORDER BY in_flight_since ASC
         LIMIT ?
        """,
        (ttl_seconds, limit),
    ).fetchall()
    return [_row_to_lot(r) for r in rows]


def list_expired_in_flight_lots_for_session(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    ttl_seconds: int,
    limit: int = 50,
) -> list[Lot]:
    """Return in-flight lots from ``session_id`` whose age > ttl_seconds.

    Reconciler Pass-4a (H4) uses this at session-close to reap any
    lots whose ``pickup_session_id == session_id`` AND in-flight age
    already exceeds the TTL — i.e. the session lasted long enough that
    the user picked up an item, took it away from the shelf for >TTL,
    and never returned it. Without H4 these stay stuck in
    ``status='in_flight'`` until the next 5s sweeper tick. The race
    window is small in practice (sweeper tick + reconcile latency)
    but observable on long demos / sessions that close exactly between
    ticks.

    Filtered to the same session so the reconciler doesn't reap
    cross-session lots (that's the global sweeper's job — different
    pickup_session_id means a different session's accounting).
    """
    rows = conn.execute(
        """
        SELECT * FROM lots
         WHERE status='in_flight'
           AND pickup_session_id = ?
           AND (julianday('now') - julianday(in_flight_since)) * 86400.0 > ?
         ORDER BY in_flight_since ASC
         LIMIT ?
        """,
        (session_id, ttl_seconds, limit),
    ).fetchall()
    return [_row_to_lot(r) for r in rows]


# ---------------------------------------------------------------------------
# Joined "view" queries — per §4.4
# ---------------------------------------------------------------------------

_LOTS_JOIN_PRODUCTS_SQL = """
    SELECT lots.*,
           p.name AS p_name,
           p.certified AS p_certified,
           p.created_at AS p_created_at,
           p.updated_at AS p_updated_at,
           p.barcode AS p_barcode,
           p.brand AS p_brand,
           p.variant AS p_variant,
           p.net_weight_g AS p_net_weight_g,
           p.gross_weight_g AS p_gross_weight_g,
           p.tare_weight_g AS p_tare_weight_g,
           p.serving_weight_g AS p_serving_weight_g,
           p.servings_per_container AS p_servings_per_container,
           p.unit_type AS p_unit_type,
           p.density_g_per_ml AS p_density_g_per_ml,
           p.container_type AS p_container_type
      FROM lots
      JOIN products p ON p.product_id = lots.product_id
"""


def _row_to_lot_with_product(row: sqlite3.Row) -> LotWithProduct:
    lot = _row_to_lot(row)
    product = Product(
        product_id=row["product_id"],
        name=row["p_name"],
        certified=row["p_certified"],
        created_at=row["p_created_at"],
        updated_at=row["p_updated_at"],
        barcode=row["p_barcode"],
        brand=row["p_brand"],
        variant=row["p_variant"],
        net_weight_g=row["p_net_weight_g"],
        gross_weight_g=row["p_gross_weight_g"],
        tare_weight_g=row["p_tare_weight_g"],
        serving_weight_g=row["p_serving_weight_g"],
        servings_per_container=row["p_servings_per_container"],
        unit_type=row["p_unit_type"],
        density_g_per_ml=row["p_density_g_per_ml"],
        container_type=row["p_container_type"],
    )
    return LotWithProduct(lot=lot, product=product)


def get_shelf_registry(
    conn: sqlite3.Connection,
    *,
    shelf_id: Optional[str] = None,
) -> list[LotWithProduct]:
    """All lots currently on the shelf, joined to their product row.

    ``shelf_id`` optionally scopes to a single physical shelf
    ('live_shelf' or 'catch_all'). When None (default), returns on-shelf
    lots across both shelves — preserves the pre-catch-all behavior for
    every existing caller (dashboard registry, classifier ADD pool's
    top-up branch).
    """
    if shelf_id is None:
        rows = conn.execute(
            _LOTS_JOIN_PRODUCTS_SQL
            + " WHERE lots.status = 'on_shelf' ORDER BY lots.placed_at ASC"
        ).fetchall()
    else:
        rows = conn.execute(
            _LOTS_JOIN_PRODUCTS_SQL
            + " WHERE lots.status = 'on_shelf' AND lots.shelf_id = ? "
            " ORDER BY lots.placed_at ASC",
            (shelf_id,),
        ).fetchall()
    return [_row_to_lot_with_product(r) for r in rows]


def get_recently_out_lots(
    conn: sqlite3.Connection,
    window_seconds: int,
    *,
    shelf_id: Optional[str] = None,
) -> list[LotWithProduct]:
    """Lots that went `out` within the last `window_seconds` seconds.

    Uses SQLite `datetime('now','-N seconds')` so behavior matches the
    tablet clock. Lots with NULL `last_out_at` are excluded.

    Note: ``window_seconds`` is truncated to int via ``int()``; pass an int
    for predictable behavior (floats lose their fractional part).
    """
    # ``last_out_at`` is stored in ISO-8601 UTC ms format (T-separated,
    # trailing Z). SQLite's ``datetime('now', '-N seconds')`` returns a
    # SPACE-separated format without Z — lexicographic comparison of the
    # two formats always succeeds (because 'T' > ' ' in ASCII), making
    # the window filter a no-op. Use ``strftime`` to emit a matching
    # T-separated UTC string with ms precision.
    seconds = max(0, int(window_seconds))
    if shelf_id is None:
        rows = conn.execute(
            _LOTS_JOIN_PRODUCTS_SQL
            + """
                WHERE lots.status = 'out'
                  AND lots.last_out_at IS NOT NULL
                  AND lots.last_out_at >= strftime(
                        '%Y-%m-%dT%H:%M:%fZ', 'now', ?
                  )
                ORDER BY lots.last_out_at DESC
            """,
            (f"-{seconds} seconds",),
        ).fetchall()
    else:
        rows = conn.execute(
            _LOTS_JOIN_PRODUCTS_SQL
            + """
                WHERE lots.status = 'out'
                  AND lots.shelf_id = ?
                  AND lots.last_out_at IS NOT NULL
                  AND lots.last_out_at >= strftime(
                        '%Y-%m-%dT%H:%M:%fZ', 'now', ?
                  )
                ORDER BY lots.last_out_at DESC
            """,
            (shelf_id, f"-{seconds} seconds"),
        ).fetchall()
    return [_row_to_lot_with_product(r) for r in rows]


def get_products_certified_not_on_shelf(
    conn: sqlite3.Connection,
) -> list[Product]:
    """Certified products that have zero lots currently on the shelf.

    Used by the /inventory page's "catalog" section. NOT used
    by the classifier candidate pool — that uses
    :func:`get_all_certified_products` so a user re-placing a second unit
    of an already-on-shelf SKU still has that product in the pool.
    """
    rows = conn.execute(
        """
        SELECT p.*
          FROM products p
         WHERE p.certified = 1
           AND NOT EXISTS (
                 SELECT 1 FROM lots l
                  WHERE l.product_id = p.product_id
                    AND l.status = 'on_shelf'
               )
         ORDER BY p.created_at ASC
        """
    ).fetchall()
    return [_row_to_product(r) for r in rows]


def get_all_certified_products(
    conn: sqlite3.Connection,
) -> list[Product]:
    """All certified products, regardless of on-shelf status.

    Fix: the ADD candidate pool previously used
    :func:`get_products_certified_not_on_shelf`, which excluded any SKU
    that already had an on-shelf lot. That hid legitimate "user places a
    second unit of the same SKU" placements from the classifier — the
    product was invisible even though the user visibly put it on the
    scale. The top-up branch only covers small refill deltas (< 25% of
    container weight), so a full-unit duplicate placement fell off the
    pool entirely.

    The candidate pool now unions this with recently-out lots + top-up
    targets + dedupe-by-candidate_id. The dedupe key is distinct across
    branches (lot_id vs product_id), so a product appearing as both a
    top-up target (its existing lot_id) and a catalog entry (its
    product_id) is preserved in both roles — the classifier decides
    which interpretation matches the observed weight and visible item.
    """
    rows = conn.execute(
        """
        SELECT p.*
          FROM products p
         WHERE p.certified = 1
         ORDER BY p.created_at ASC
        """
    ).fetchall()
    return [_row_to_product(r) for r in rows]


def get_certified_livetrack_tracked_products(
    conn: sqlite3.Connection,
) -> list[Product]:
    """All certified products that are LiveTrack-tracked (have a tare).

    Used by the classifier's opt-in fallback pass: when the inventory-only
    pass-1 pool returns UNKNOWN / low confidence and the user has flipped
    ``hub.profiles.chefbyte_classifier_fallback_enabled``, we run a
    second pass against this expanded pool.

    Definition of "LiveTrack-tracked" matches the web UI's badge:
    ``products.tare_weight_g IS NOT NULL`` (the LiveTrack Import wizard
    captures container tare and writes this column on success). The
    classifier's prompt builder still keys off ``certified=1`` so we
    never offer non-certified items as fallback candidates.

    Ordering: ``products.created_at ASC`` for a stable test order;
    matches :func:`get_all_certified_products`.
    """
    rows = conn.execute(
        """
        SELECT p.*
          FROM products p
         WHERE p.certified = 1
           AND p.tare_weight_g IS NOT NULL
         ORDER BY p.created_at ASC
        """
    ).fetchall()
    return [_row_to_product(r) for r in rows]


def list_inventory_only_products(
    conn: sqlite3.Connection,
    *,
    shelf_id: Optional[str] = None,
) -> list[Product]:
    """Products with cloud-mirror inventory (qty>0) but no Pi lots on this shelf.

    Joins the Pi's ``cloud_lots`` mirror (populated by the
    LotSnapshotPoller) against the local ``products`` table and excludes
    any product that already has at least one row in ``lots`` for the
    given shelf. The excluded products are surfaced through the other
    candidate-pool branches (``in_flight`` / ``recently_out`` / on-shelf
    top-up); this method covers the gap that decision #45 regressed:
    products that exist in cloud inventory but have never been
    physically placed on this Pi shelf.

    The cloud mirror rows are filtered to ``qty_containers > 0`` —
    empty/tombstoned lots are not inventory. Soft-deleted products
    (``products.deleted_at IS NOT NULL``) are also excluded.

    When ``shelf_id`` is None, the "no Pi lot" filter looks across every
    shelf — useful for tests that don't care about the multi-shelf
    distinction. Production callsites always pass a definite shelf_id.

    Ordering: ``products.created_at ASC`` for a stable test order.
    """
    if shelf_id is not None:
        rows = conn.execute(
            """
            SELECT DISTINCT p.*
              FROM products p
              JOIN cloud_lots cl ON cl.product_id = p.product_id
             WHERE p.deleted_at IS NULL
               AND cl.qty_containers > 0
               AND cl.deleted_at IS NULL
               AND NOT EXISTS (
                     SELECT 1 FROM lots l
                      WHERE l.product_id = p.product_id
                        AND l.shelf_id = ?
                   )
             ORDER BY p.created_at ASC
            """,
            (shelf_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT DISTINCT p.*
              FROM products p
              JOIN cloud_lots cl ON cl.product_id = p.product_id
             WHERE p.deleted_at IS NULL
               AND cl.qty_containers > 0
               AND cl.deleted_at IS NULL
               AND NOT EXISTS (
                     SELECT 1 FROM lots l
                      WHERE l.product_id = p.product_id
                   )
             ORDER BY p.created_at ASC
            """
        ).fetchall()
    return [_row_to_product(r) for r in rows]


# ---------------------------------------------------------------------------
# catch-all delta-capture candidate sources (CATCH_ALL_SCALE_PLAN.md
# §"Pi catch-all candidate pool builder", 2026-04-27).
#
# The catch-all flow is fundamentally lot-level — multiple in-flight
# lots can coexist on the catch-all scale concurrently, and the
# "certified not on any shelf" tier is also lot-level (each lot has
# its own pickup_weight_g / qty / FEFO position). These helpers serve
# the dedicated ``pool_for_catch_all`` builder; they query
# ``cloud_lots`` (cloud-mirrored stock_lots) joined to the local
# ``products`` row for product metadata.
# ---------------------------------------------------------------------------


def list_cloud_in_flight_catch_all_lots(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    """Return cloud_lots rows where ``in_flight_kind='catch_all'``.

    These are the lots currently mid-measurement on the catch-all scale
    (Pi emitted ``catch_all_first_measurement``, cloud stamped
    in_flight_kind='catch_all' + pickup_weight_g + pickup_event_id, and
    the Pi mirrors the resulting state via the lot-snapshot poller).
    The ``pool_for_catch_all`` builder ranks these as Tier 1.

    Returns lightweight tuples ``(lot_id, product_id, qty_containers,
    in_flight_since, pickup_event_id, created_at, p_name, p_brand,
    p_net_weight_g, p_gross_weight_g, p_container_type)`` so the caller
    can build LotCandidate objects without a second query per row.

    Excludes tombstoned (deleted_at) rows.
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id, cl.product_id, cl.qty_containers,
               cl.in_flight_since, cl.pickup_event_id, cl.created_at,
               p.name AS p_name, p.brand AS p_brand,
               p.net_weight_g AS p_net_weight_g,
               p.gross_weight_g AS p_gross_weight_g,
               p.container_type AS p_container_type
          FROM cloud_lots cl
          LEFT JOIN products p ON p.product_id = cl.product_id
         WHERE cl.in_flight_kind = 'catch_all'
           AND cl.deleted_at IS NULL
         ORDER BY cl.in_flight_since ASC
        """
    ).fetchall()
    return [tuple(r) for r in rows]


def list_certified_not_on_shelf_lots_by_oldest_created(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    """Return certified cloud_lots whose product is not on any Pi shelf.

    "Certified-not-on-any-shelf" tier (Tier 2) for the catch-all
    candidate pool. Predicates:

      * ``cloud_lots.qty_containers > 0`` — must have stock.
      * ``cloud_lots.in_flight_kind`` IS NULL.
        **2026-04-28 (Codex finding MEDIUM-5):** Tier 1
        (``list_cloud_in_flight_catch_all_lots``) already returns every
        lot with ``in_flight_kind='catch_all'``; including those rows
        again in Tier 2 produced duplicate candidates that crowded out
        real options after the top-N truncation. Restricting Tier 2 to
        ``in_flight_kind IS NULL`` makes the two tiers strictly
        disjoint at the source — no post-concat dedupe pass is needed.
        live_shelf in-flight rows are still excluded (covered by the
        Pi-local ``lots`` row predicate below — a live-shelf in-flight
        lot has a Pi-local row).
      * Product is certified (``products.certified = 1``) and not soft-
        deleted (``products.deleted_at IS NULL``).
      * The product has no current Pi-local ``lots`` row on any shelf.
        This implicitly covers the "scale_pairings.lot_id reference"
        case: LiveTrack-paired lots ALWAYS have a Pi-local ``lots`` row
        (Pi mints local rows on first heartbeat), and ``scale_pairings.
        lot_id`` REFERENCES ``lots(lot_id)`` so a paired lot is by
        construction also a Pi-local lot. live_shelf-on-shelf lots are
        also Pi-local. Excluding "any Pi-local lots row" therefore
        excludes both LiveTrack-paired AND live_shelf-tracked products.

    Ordering: ``cloud_lots.created_at ASC`` — FEFO on import time, which
    is the user's directive ("oldest imported lot wins"). NULLs (legacy
    rows from before the Pi started persisting created_at on cloud_lots)
    sort last so a proper timestamped row always beats them.

    Returns the same lightweight tuple shape as
    :func:`list_cloud_in_flight_catch_all_lots` for symmetry.
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id, cl.product_id, cl.qty_containers,
               cl.in_flight_since, cl.pickup_event_id, cl.created_at,
               p.name AS p_name, p.brand AS p_brand,
               p.net_weight_g AS p_net_weight_g,
               p.gross_weight_g AS p_gross_weight_g,
               p.container_type AS p_container_type
          FROM cloud_lots cl
          JOIN products p ON p.product_id = cl.product_id
         WHERE cl.qty_containers > 0
           AND cl.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND p.certified = 1
           AND cl.in_flight_kind IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM lots l
                  WHERE l.product_id = cl.product_id
               )
         ORDER BY (cl.created_at IS NULL), cl.created_at ASC
        """
    ).fetchall()
    return [tuple(r) for r in rows]


def list_user_inventory_lots_qty_gt_zero(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    """Return every cloud_lots row with qty>0 NOT in_flight on catch_all.

    Joined with products for name/brand/weight metadata. Ordered FEFO
    (created_at ASC) so the apply path can prefer the oldest lot when
    multiple lots exist for the same product.

    Excludes ``in_flight_kind = 'catch_all'`` rows — those are owned by
    Tier 1 (:func:`list_cloud_in_flight_catch_all_lots`) and must not
    appear in Tier 2 to avoid double-ranking the same lot in the
    catch-all candidate pool.

    Includes lots regardless of ``products.certified`` flag — the
    catch-all auto-import widens the pool from "only certified" to
    "any product in inventory". Set-once tare write later in the apply
    path means uncertified products are first-class candidates for AI
    tare estimation on first measurement.

    Soft-deleted rows (cloud_lots.deleted_at, products.deleted_at) are
    excluded. live_shelf in-flight rows pass through (different state
    machine; the apply path routes correctly via lot_id).

    Returns a tuple shape that extends
    :func:`list_certified_not_on_shelf_lots_by_oldest_created` with one
    extra trailing column — ``products.tare_weight_g`` — so the apply
    path (Task 5) can decide whether the AI prompt should request a
    tare estimate (``needs_tare_estimate = tare IS NULL``). The adapter
    unpack stays parallel; the new column is appended at the end.
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id, cl.product_id, cl.qty_containers,
               cl.in_flight_since, cl.pickup_event_id, cl.created_at,
               p.name AS p_name, p.brand AS p_brand,
               p.net_weight_g AS p_net_weight_g,
               p.gross_weight_g AS p_gross_weight_g,
               p.container_type AS p_container_type,
               p.tare_weight_g AS p_tare_weight_g
          FROM cloud_lots cl
          JOIN products p ON p.product_id = cl.product_id
         WHERE cl.qty_containers > 0
           AND cl.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND (cl.in_flight_kind IS NULL OR cl.in_flight_kind <> 'catch_all')
         ORDER BY (cl.created_at IS NULL), cl.created_at ASC
        """
    ).fetchall()
    return [tuple(r) for r in rows]


def list_user_inventory_lots_qty_gt_zero_certified(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    """Two-pass catch-all classification — pass-1 source.

    Same shape as :func:`list_user_inventory_lots_qty_gt_zero` but
    restricted to lots whose product has ``certified = 1`` — i.e. the
    user has already calibrated this SKU through LiveTrack. Used by
    :func:`pool_for_catch_all_pass1` so the first classification pass
    only matches against trusted, already-tracked inventory.

    See :func:`list_user_inventory_lots_qty_gt_zero` for column shape
    and ordering rationale (FEFO, ``in_flight_kind != 'catch_all'``,
    soft-delete exclusion).
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id, cl.product_id, cl.qty_containers,
               cl.in_flight_since, cl.pickup_event_id, cl.created_at,
               p.name AS p_name, p.brand AS p_brand,
               p.net_weight_g AS p_net_weight_g,
               p.gross_weight_g AS p_gross_weight_g,
               p.container_type AS p_container_type,
               p.tare_weight_g AS p_tare_weight_g
          FROM cloud_lots cl
          JOIN products p ON p.product_id = cl.product_id
         WHERE cl.qty_containers > 0
           AND cl.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND p.certified = 1
           AND (cl.in_flight_kind IS NULL OR cl.in_flight_kind <> 'catch_all')
         ORDER BY (cl.created_at IS NULL), cl.created_at ASC
        """
    ).fetchall()
    return [tuple(r) for r in rows]


def list_user_inventory_lots_qty_gt_zero_uncertified(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    """Two-pass catch-all classification — pass-2 source.

    Same shape as :func:`list_user_inventory_lots_qty_gt_zero` but
    restricted to lots whose product is NOT certified (``certified = 0``
    OR NULL). Used by :func:`pool_for_catch_all_pass2` when pass-1
    against the certified inventory yields UNKNOWN / low confidence,
    so the model can still match against products the user owns but
    hasn't yet promoted via LiveTrack — and the auto-import block in
    the dispatch path can flip ``certified=true`` on a confident pass-2
    win.

    NULL-safe ``p.certified`` predicate matches the legacy default
    ``certified = 0`` from :file:`storage/schema.sql:28` while staying
    correct against future migrations that ever NULL out the column.
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id, cl.product_id, cl.qty_containers,
               cl.in_flight_since, cl.pickup_event_id, cl.created_at,
               p.name AS p_name, p.brand AS p_brand,
               p.net_weight_g AS p_net_weight_g,
               p.gross_weight_g AS p_gross_weight_g,
               p.container_type AS p_container_type,
               p.tare_weight_g AS p_tare_weight_g
          FROM cloud_lots cl
          JOIN products p ON p.product_id = cl.product_id
         WHERE cl.qty_containers > 0
           AND cl.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND (p.certified IS NULL OR p.certified = 0)
           AND (cl.in_flight_kind IS NULL OR cl.in_flight_kind <> 'catch_all')
         ORDER BY (cl.created_at IS NULL), cl.created_at ASC
        """
    ).fetchall()
    return [tuple(r) for r in rows]


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------


def open_session(
    conn: sqlite3.Connection,
    ts: str | datetime,
    initial_weight_g: float,
    *,
    shelf_id: str = "live_shelf",
) -> Session:
    """Insert a ``sessions`` row and update the correct ``app_state`` pointer.

    ``shelf_id`` selects which shelf's open-session pointer to update:

    * ``'live_shelf'`` (default) — writes ``app_state.current_session_id``
      and sets ``door_open=1``. Door-gated semantics (BrightnessHandler
      path). Legacy behavior; omitting the kwarg preserves it.
    * ``'catch_all'`` — writes ``app_state.current_catch_all_session_id``.
      Weight-gated semantics (WeightHandler path,
      CATCH_ALL_SCALE_PLAN.md §4.2). ``door_open`` is NOT touched — it
      belongs to the live shelf's door state machine.
    """
    if shelf_id not in ("live_shelf", "catch_all"):
        raise ValueError(
            f"open_session: shelf_id must be 'live_shelf' or 'catch_all', "
            f"got {shelf_id!r}"
        )
    session_id = new_id()
    started_at = coerce_ts(ts)
    with conn:
        conn.execute(
            """
            INSERT INTO sessions (
                session_id, started_at, initial_shelf_weight_g, shelf_id
            ) VALUES (?, ?, ?, ?)
            """,
            (session_id, started_at, initial_weight_g, shelf_id),
        )
        if shelf_id == "live_shelf":
            conn.execute(
                """
                UPDATE app_state
                   SET current_session_id = ?, door_open = 1,
                       updated_at = datetime('now')
                 WHERE id = 1
                """,
                (session_id,),
            )
        else:  # catch_all
            conn.execute(
                """
                UPDATE app_state
                   SET current_catch_all_session_id = ?,
                       updated_at = datetime('now')
                 WHERE id = 1
                """,
                (session_id,),
            )
    got = get_session(conn, session_id)
    assert got is not None
    return got


def close_session(
    conn: sqlite3.Connection,
    session_id: str,
    ts: str | datetime,
    final_weight_g: float,
    *,
    shelf_id: str = "live_shelf",
) -> Session:
    """Close a session and clear the matching app_state pointer.

    ``shelf_id`` selects which app_state pointer to clear:

    * ``'live_shelf'`` (default) — clears ``current_session_id`` and
      resets ``door_open=0`` (door-gated semantics). Legacy behavior;
      omitting the kwarg preserves it.
    * ``'catch_all'`` — clears ``current_catch_all_session_id``. Does
      NOT touch ``current_session_id`` or ``door_open`` — those belong
      to the live shelf's door state machine, and writing over them
      here would corrupt live-shelf state if a live session was open
      concurrently with the catch-all session being closed.
    """
    if shelf_id not in ("live_shelf", "catch_all"):
        raise ValueError(
            f"close_session: shelf_id must be 'live_shelf' or 'catch_all', "
            f"got {shelf_id!r}"
        )
    ended_at = coerce_ts(ts)
    with conn:
        cur = conn.execute(
            """
            UPDATE sessions
               SET ended_at = ?, final_shelf_weight_g = ?
             WHERE session_id = ?
            """,
            (ended_at, final_weight_g, session_id),
        )
        if cur.rowcount == 0:
            raise LookupError(f"close_session: unknown session_id {session_id!r}")
        if shelf_id == "live_shelf":
            state_cur = conn.execute(
                """
                UPDATE app_state
                   SET current_session_id = NULL, door_open = 0,
                       updated_at = datetime('now')
                 WHERE id = 1 AND current_session_id = ?
                """,
                (session_id,),
            )
            if state_cur.rowcount == 0:
                # Race: a newer session was opened before this close landed. The
                # session row itself closed correctly, so we don't raise — but
                # surface the mismatch for operators. Read app_state inside the
                # same txn for the warning payload.
                current_row = conn.execute(
                    "SELECT current_session_id FROM app_state WHERE id = 1"
                ).fetchone()
                current = current_row["current_session_id"] if current_row else None
                log.warning(
                    "close_session: app_state.current_session_id mismatch; "
                    "closing session_id=%r but app_state.current_session_id=%r",
                    session_id,
                    current,
                )
        else:  # catch_all — don't touch door_open or current_session_id
            state_cur = conn.execute(
                """
                UPDATE app_state
                   SET current_catch_all_session_id = NULL,
                       updated_at = datetime('now')
                 WHERE id = 1 AND current_catch_all_session_id = ?
                """,
                (session_id,),
            )
            if state_cur.rowcount == 0:
                current_row = conn.execute(
                    "SELECT current_catch_all_session_id FROM app_state "
                    "WHERE id = 1"
                ).fetchone()
                current = (
                    current_row["current_catch_all_session_id"]
                    if current_row
                    else None
                )
                log.warning(
                    "close_session: app_state.current_catch_all_session_id "
                    "mismatch; closing session_id=%r but "
                    "app_state.current_catch_all_session_id=%r",
                    session_id,
                    current,
                )
    got = get_session(conn, session_id)
    assert got is not None
    return got


def mark_session_reconciled(
    conn: sqlite3.Connection,
    session_id: str,
    ts: Optional[str | datetime] = None,
) -> Optional[Session]:
    reconciled_at = coerce_ts(ts)
    with conn:
        if reconciled_at is None:
            conn.execute(
                """
                UPDATE sessions
                   SET reconciled = 1, reconciled_at = datetime('now')
                 WHERE session_id = ?
                """,
                (session_id,),
            )
        else:
            conn.execute(
                """
                UPDATE sessions
                   SET reconciled = 1, reconciled_at = ?
                 WHERE session_id = ?
                """,
                (reconciled_at, session_id),
            )
    return get_session(conn, session_id)


def get_session(
    conn: sqlite3.Connection, session_id: str
) -> Optional[Session]:
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
    ).fetchone()
    return _row_to_session(row) if row else None


def list_sessions(
    conn: sqlite3.Connection, limit: int = 100
) -> list[Session]:
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    return [_row_to_session(r) for r in rows]


# ---------------------------------------------------------------------------
# scale_events
# ---------------------------------------------------------------------------


def record_scale_event(
    conn: sqlite3.Connection, evt: ScaleEventIn
) -> ScaleEvent:
    event_id = new_id()
    # shelf_id: when the caller threads it (real HTTP ingress after the
    # device→shelf lookup), write explicitly. Omit otherwise so the SQL
    # DEFAULT 'live_shelf' fires — preserves every legacy + test code
    # path that constructed a ``ScaleEventIn`` without the new field.
    with conn:
        if evt.shelf_id is None:
            conn.execute(
                """
                INSERT INTO scale_events (
                    event_id, session_id, ts, delta_g,
                    before_weight_g, after_weight_g, direction,
                    before_frame_path, after_frame_path,
                    classification, classifier_status, pi_received_ts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    evt.session_id,
                    coerce_ts(evt.ts),
                    evt.delta_g,
                    evt.before_weight_g,
                    evt.after_weight_g,
                    evt.direction,
                    evt.before_frame_path,
                    evt.after_frame_path,
                    evt.classification,
                    evt.classifier_status,
                    # pi_received_ts — coerced to canonical ISO format only if
                    # provided. Tests + internal callers may omit it; the
                    # picker falls back to ``ts`` in that case. Real HTTP
                    # ingress passes the value it captured at handler entry.
                    coerce_ts(evt.pi_received_ts) if evt.pi_received_ts else None,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO scale_events (
                    event_id, session_id, ts, delta_g,
                    before_weight_g, after_weight_g, direction,
                    before_frame_path, after_frame_path,
                    classification, classifier_status, pi_received_ts,
                    shelf_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    evt.session_id,
                    coerce_ts(evt.ts),
                    evt.delta_g,
                    evt.before_weight_g,
                    evt.after_weight_g,
                    evt.direction,
                    evt.before_frame_path,
                    evt.after_frame_path,
                    evt.classification,
                    evt.classifier_status,
                    coerce_ts(evt.pi_received_ts) if evt.pi_received_ts else None,
                    evt.shelf_id,
                ),
            )
    got = get_event(conn, event_id)
    assert got is not None
    return got


def get_event(
    conn: sqlite3.Connection, event_id: str
) -> Optional[ScaleEvent]:
    row = conn.execute(
        "SELECT * FROM scale_events WHERE event_id = ?", (event_id,)
    ).fetchone()
    return _row_to_scale_event(row) if row else None


def list_events_for_session(
    conn: sqlite3.Connection, session_id: str
) -> list[ScaleEvent]:
    rows = conn.execute(
        """
        SELECT * FROM scale_events
         WHERE session_id = ?
         ORDER BY ts ASC
        """,
        (session_id,),
    ).fetchall()
    return [_row_to_scale_event(r) for r in rows]


def update_event_classification(
    conn: sqlite3.Connection,
    event_id: str,
    *,
    classification: Optional[str] = None,
    classifier_status: Optional[str] = None,
) -> Optional[ScaleEvent]:
    fields: list[str] = []
    values: list[Any] = []
    if classification is not None:
        fields.append("classification = ?")
        values.append(classification)
    if classifier_status is not None:
        fields.append("classifier_status = ?")
        values.append(classifier_status)
    if not fields:
        return get_event(conn, event_id)
    values.append(event_id)
    with conn:
        conn.execute(
            f"UPDATE scale_events SET {', '.join(fields)} WHERE event_id = ?",
            values,
        )
    return get_event(conn, event_id)


# ---------------------------------------------------------------------------
# session_resolutions (pass-through writer + reader)
# ---------------------------------------------------------------------------


def write_resolution(
    conn: sqlite3.Connection, r: SessionResolutionIn
) -> SessionResolution:
    resolution_id = new_id()
    with conn:
        conn.execute(
            """
            INSERT INTO session_resolutions (
                resolution_id, session_id, lot_id, pattern,
                consumed_g, confidence, add_event_id, remove_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resolution_id,
                r.session_id,
                r.lot_id,
                r.pattern,
                r.consumed_g,
                r.confidence,
                r.add_event_id,
                r.remove_event_id,
            ),
        )
    row = conn.execute(
        "SELECT * FROM session_resolutions WHERE resolution_id = ?",
        (resolution_id,),
    ).fetchone()
    return _row_to_resolution(row)


def list_resolutions_for_session(
    conn: sqlite3.Connection, session_id: str
) -> list[SessionResolution]:
    rows = conn.execute(
        """
        SELECT * FROM session_resolutions
         WHERE session_id = ?
         ORDER BY created_at ASC
        """,
        (session_id,),
    ).fetchall()
    return [_row_to_resolution(r) for r in rows]


def get_resolution(
    conn: sqlite3.Connection, resolution_id: str
) -> Optional[SessionResolution]:
    row = conn.execute(
        "SELECT * FROM session_resolutions WHERE resolution_id = ?",
        (resolution_id,),
    ).fetchone()
    return _row_to_resolution(row) if row else None


# ---------------------------------------------------------------------------
# usage_log (USAGE_LOG_PLAN.md §5.1)
# ---------------------------------------------------------------------------


def _row_to_usage_log(row: sqlite3.Row) -> UsageLog:
    return UsageLog(
        usage_id=row["usage_id"],
        lot_id=row["lot_id"],
        product_id=row["product_id"],
        product_name=row["product_name"],
        product_brand=row["product_brand"],
        container_type=row["container_type"],
        consumed_g=row["consumed_g"],
        pickup_weight_g=row["pickup_weight_g"],
        return_weight_g=row["return_weight_g"],
        kind=row["kind"],
        session_id=row["session_id"],
        pickup_event_id=row["pickup_event_id"],
        return_event_id=row["return_event_id"],
        occurred_at=row["occurred_at"],
        created_at=row["created_at"],
    )


def write_usage_log(
    conn: sqlite3.Connection, u: UsageLogIn
) -> Optional[UsageLog]:
    """Insert a usage_log row. Returns None if the row was rejected by the
    uniqueness guard on ``pickup_event_id`` (double-log attempt).

    All inserts go through ``INSERT OR IGNORE`` so emission sites can be
    defensive without worrying about double-writes — the dedup index
    silently absorbs repeats.
    """
    usage_id = new_id()
    with conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO usage_log (
                usage_id, lot_id, product_id, product_name, product_brand,
                container_type, consumed_g, pickup_weight_g,
                return_weight_g, kind, session_id, pickup_event_id,
                return_event_id, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                usage_id, u.lot_id, u.product_id, u.product_name,
                u.product_brand, u.container_type, u.consumed_g,
                u.pickup_weight_g, u.return_weight_g, u.kind,
                u.session_id, u.pickup_event_id, u.return_event_id,
                u.occurred_at,
            ),
        )
        if cur.rowcount == 0:
            return None  # uniqueness guard fired — row already exists
    row = conn.execute(
        "SELECT * FROM usage_log WHERE usage_id = ?", (usage_id,),
    ).fetchone()
    return _row_to_usage_log(row) if row else None


def list_usage_log(
    conn: sqlite3.Connection,
    *,
    product_id: Optional[str] = None,
    session_id: Optional[str] = None,
    lot_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    kinds: Optional[list[str]] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[UsageLog]:
    clauses: list[str] = []
    params: list[Any] = []
    if product_id:
        clauses.append("product_id = ?")
        params.append(product_id)
    if session_id:
        clauses.append("session_id = ?")
        params.append(session_id)
    if lot_id:
        clauses.append("lot_id = ?")
        params.append(lot_id)
    if since:
        clauses.append("occurred_at >= ?")
        params.append(since)
    if until:
        clauses.append("occurred_at <= ?")
        params.append(until)
    if kinds:
        placeholders = ",".join("?" for _ in kinds)
        clauses.append(f"kind IN ({placeholders})")
        params.extend(kinds)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.extend([int(limit), int(offset)])
    rows = conn.execute(
        f"SELECT * FROM usage_log {where} "
        f"ORDER BY occurred_at DESC LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    return [_row_to_usage_log(r) for r in rows]


def count_usage_log(
    conn: sqlite3.Connection,
    *,
    product_id: Optional[str] = None,
    session_id: Optional[str] = None,
    lot_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    kinds: Optional[list[str]] = None,
) -> int:
    clauses: list[str] = []
    params: list[Any] = []
    if product_id:
        clauses.append("product_id = ?")
        params.append(product_id)
    if session_id:
        clauses.append("session_id = ?")
        params.append(session_id)
    if lot_id:
        clauses.append("lot_id = ?")
        params.append(lot_id)
    if since:
        clauses.append("occurred_at >= ?")
        params.append(since)
    if until:
        clauses.append("occurred_at <= ?")
        params.append(until)
    if kinds:
        placeholders = ",".join("?" for _ in kinds)
        clauses.append(f"kind IN ({placeholders})")
        params.extend(kinds)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    row = conn.execute(
        f"SELECT COUNT(*) AS c FROM usage_log {where}", params,
    ).fetchone()
    return int(row["c"] if row is not None else 0)


def delete_usage_log(
    conn: sqlite3.Connection, usage_id: str
) -> dict[str, Any]:
    """Delete a single usage_log row + revert its consumption on the lot.

    Returns ``{"deleted": int, "reverted_g": float, "lot_id": str|None}``.
    ``deleted`` is 0 if the row did not exist (idempotent delete).

    Reversal is symmetric with how emission sites increment
    ``lots.total_consumed_g``: positive ``consumed_g`` was added via
    ``max(0, consumed_g)``, so we subtract by the same rule (clamped at 0
    on the resulting total so multiple deletes can't drive the counter
    negative). Negative consumed_g (topups) were never added to the
    total, so deleting them is a no-op on the lot.
    """
    with conn:
        row = conn.execute(
            "SELECT lot_id, consumed_g FROM usage_log WHERE usage_id = ?",
            (usage_id,),
        ).fetchone()
        if row is None:
            return {"deleted": 0, "reverted_g": 0.0, "lot_id": None}
        lot_id = row["lot_id"]
        consumed = float(row["consumed_g"] or 0.0)
        reverted = max(0.0, consumed)
        if lot_id and reverted > 0:
            # Clamp at 0 in SQL so the lifetime total never goes negative.
            conn.execute(
                """
                UPDATE lots
                   SET total_consumed_g = MAX(0.0, total_consumed_g - ?)
                 WHERE lot_id = ?
                """,
                (reverted, lot_id),
            )
        cur = conn.execute(
            "DELETE FROM usage_log WHERE usage_id = ?", (usage_id,),
        )
        return {
            "deleted": cur.rowcount or 0,
            "reverted_g": reverted if lot_id else 0.0,
            "lot_id": lot_id,
        }


def delete_usage_log_by_return_event(
    conn: sqlite3.Connection,
    *,
    return_event_id: str,
    lot_id: Optional[str] = None,
    kind: Optional[str] = None,
) -> dict[str, Any]:
    """Delete every usage_log row matching the dedup-group key.

    Mirrors :func:`delete_usage_log` for a multi-row consolidation. Used
    by the inventory page's "delete duplicate group" affordance — the
    per-row × delete only removes one row, leaving the duplicates the
    re-emission backend bug created. See UX_AUDIT R2 F2.

    Reverts consumption on the lot once for the survivor row's
    ``consumed_g`` (the duplicates are byte-identical so each row's
    consumed_g is the same value; reverting once matches what the
    emission path actually added). Clamped at 0 so the lifetime total
    can't go negative.

    Returns ``{"deleted": int, "reverted_g": float, "lot_id": str|None}``.
    """
    clauses = ["return_event_id = ?"]
    params: list[Any] = [return_event_id]
    if lot_id is not None:
        # ``IS`` so a NULL lot_id matches NULL (not '=', which never does).
        clauses.append("lot_id IS ?")
        params.append(lot_id)
    if kind is not None:
        clauses.append("kind = ?")
        params.append(kind)
    where = " AND ".join(clauses)
    with conn:
        rows = conn.execute(
            f"SELECT usage_id, lot_id, consumed_g FROM usage_log WHERE {where}",
            params,
        ).fetchall()
        if not rows:
            return {"deleted": 0, "reverted_g": 0.0, "lot_id": None}
        # All rows in the group are byte-identical (same consumed_g) by
        # construction of the dedup key. Revert the survivor's consumption
        # once so we don't double-revert N times.
        survivor = rows[0]
        survivor_lot = survivor["lot_id"]
        consumed = float(survivor["consumed_g"] or 0.0)
        reverted = max(0.0, consumed)
        if survivor_lot and reverted > 0:
            conn.execute(
                """
                UPDATE lots
                   SET total_consumed_g = MAX(0.0, total_consumed_g - ?)
                 WHERE lot_id = ?
                """,
                (reverted, survivor_lot),
            )
        cur = conn.execute(
            f"DELETE FROM usage_log WHERE {where}", params,
        )
        return {
            "deleted": cur.rowcount or 0,
            "reverted_g": reverted if survivor_lot else 0.0,
            "lot_id": survivor_lot,
        }


def sum_usage_log_by_product(
    conn: sqlite3.Connection,
    *,
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Aggregate consumption by product over an optional date window.

    Returns list of dicts with keys: ``product_id``, ``product_name``,
    ``total_consumed_g``, ``row_count``.
    """
    clauses: list[str] = []
    params: list[Any] = []
    if since:
        clauses.append("occurred_at >= ?")
        params.append(since)
    if until:
        clauses.append("occurred_at <= ?")
        params.append(until)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    # Topup rows (negative consumed_g from in_flight_return where the
    # user refilled the container) must NOT cancel out real consumption
    # in the 7-day aggregate. Clamp-at-zero per row so a negative
    # consumed_g contributes 0 to the sum. row_count still counts every
    # row so callers can see the raw cardinality.
    rows = conn.execute(
        f"""
        SELECT product_id,
               MAX(product_name) AS product_name,
               SUM(CASE WHEN consumed_g > 0 THEN consumed_g ELSE 0 END)
                   AS total_consumed_g,
               COUNT(*) AS row_count
          FROM usage_log {where}
         GROUP BY product_id
         ORDER BY total_consumed_g DESC
        """,
        params,
    ).fetchall()
    return [
        {
            "product_id": r["product_id"],
            "product_name": r["product_name"],
            "total_consumed_g": float(r["total_consumed_g"] or 0.0),
            "row_count": int(r["row_count"] or 0),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# review_queue (pass-through)
# ---------------------------------------------------------------------------


def enqueue_review(
    conn: sqlite3.Connection, r: ReviewQueueIn
) -> ReviewQueueItem:
    review_id = new_id()
    with conn:
        conn.execute(
            """
            INSERT INTO review_queue (
                review_id, kind, status, session_id, event_id,
                resolution_id, proposed, images
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                review_id,
                r.kind,
                r.status,
                r.session_id,
                r.event_id,
                r.resolution_id,
                r.proposed,
                r.images,
            ),
        )
    got = get_review(conn, review_id)
    assert got is not None
    return got


def get_review(
    conn: sqlite3.Connection, review_id: str
) -> Optional[ReviewQueueItem]:
    row = conn.execute(
        "SELECT * FROM review_queue WHERE review_id = ?", (review_id,)
    ).fetchone()
    return _row_to_review(row) if row else None


def list_pending_reviews(
    conn: sqlite3.Connection,
) -> list[ReviewQueueItem]:
    rows = conn.execute(
        """
        SELECT * FROM review_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
        """
    ).fetchall()
    return [_row_to_review(r) for r in rows]


def resolve_review(
    conn: sqlite3.Connection,
    review_id: str,
    *,
    status: str,
    user_response: Optional[str] = None,
    resolved_at: Optional[str | datetime] = None,
) -> Optional[ReviewQueueItem]:
    if status not in ("resolved", "dismissed"):
        raise ValueError(
            f"resolve_review: status must be 'resolved' or 'dismissed', got {status!r}"
        )
    resolved_ts = coerce_ts(resolved_at)
    with conn:
        if resolved_ts is None:
            conn.execute(
                """
                UPDATE review_queue
                   SET status = ?, user_response = ?,
                       resolved_at = datetime('now')
                 WHERE review_id = ?
                """,
                (status, user_response, review_id),
            )
        else:
            conn.execute(
                """
                UPDATE review_queue
                   SET status = ?, user_response = ?, resolved_at = ?
                 WHERE review_id = ?
                """,
                (status, user_response, resolved_ts, review_id),
            )
    return get_review(conn, review_id)


# ---------------------------------------------------------------------------
# app_state (pass-through singleton)
# ---------------------------------------------------------------------------


def get_app_state(conn: sqlite3.Connection) -> AppState:
    row = conn.execute(
        "SELECT * FROM app_state WHERE id = 1"
    ).fetchone()
    if row is None:
        # migrations.py inserts (id=1) on bootstrap; raising here surfaces a
        # broken DB state rather than silently returning an empty model.
        raise RuntimeError("app_state singleton row missing (id=1)")
    return _row_to_app_state(row)


def update_app_state(
    conn: sqlite3.Connection, patch: AppStatePatch
) -> AppState:
    fields: list[str] = []
    values: list[Any] = []
    if patch.current_session_id is not None:
        # CLEAR_SENTINEL is the opt-in way to null out the column. Any other
        # string value is written verbatim.
        if patch.current_session_id == CLEAR_SENTINEL:
            fields.append("current_session_id = NULL")
        else:
            fields.append("current_session_id = ?")
            values.append(patch.current_session_id)
    if patch.last_scale_weight_g is not None:
        fields.append("last_scale_weight_g = ?")
        values.append(patch.last_scale_weight_g)
    if patch.last_scale_event_ts is not None:
        fields.append("last_scale_event_ts = ?")
        values.append(coerce_ts(patch.last_scale_event_ts))
    if patch.door_open is not None:
        fields.append("door_open = ?")
        values.append(patch.door_open)
    if patch.shelf_name is not None:
        fields.append("shelf_name = ?")
        values.append(patch.shelf_name)
    if patch.camera_locked_json is not None:
        fields.append("camera_locked_json = ?")
        values.append(patch.camera_locked_json)
    if patch.current_catch_all_session_id is not None:
        # Mirrors the current_session_id CLEAR_SENTINEL pattern so callers
        # can opt in to explicit NULL without colliding with "don't touch."
        if patch.current_catch_all_session_id == CLEAR_SENTINEL:
            fields.append("current_catch_all_session_id = NULL")
        else:
            fields.append("current_catch_all_session_id = ?")
            values.append(patch.current_catch_all_session_id)
    if not fields:
        return get_app_state(conn)
    fields.append("updated_at = datetime('now')")
    with conn:
        conn.execute(
            f"UPDATE app_state SET {', '.join(fields)} WHERE id = 1",
            values,
        )
    return get_app_state(conn)


# ---------------------------------------------------------------------------
# tare_arm (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.2)
# ---------------------------------------------------------------------------
#
# One-row table keyed on id=1. Armed → tare_arm row present AND
# ``expires_at > now``. Re-arming on a different product is an
# INSERT OR REPLACE at id=1. The scale-event interceptor in
# ``handlers/scale_events.py`` reads ``get_active_tare_arm`` under the
# shared ``_db_lock`` so concurrent ingress events can't double-consume
# a single arm. A successful capture goes through ``consume_tare_arm``,
# which writes ``products.tare_weight_g`` and deletes the arm row in
# the same transaction.


def _row_to_tare_arm(row: sqlite3.Row) -> TareArm:
    keys = set(row.keys()) if hasattr(row, "keys") else set()
    return TareArm(
        id=row["id"],
        product_id=row["product_id"],
        device_id=row["device_id"],
        armed_at=row["armed_at"],
        expires_at=row["expires_at"],
        min_weight_g=row["min_weight_g"],
        max_weight_g=row["max_weight_g"],
        last_error=row["last_error"] if "last_error" in keys else None,
    )


def arm_tare(
    conn: sqlite3.Connection,
    product_id: str,
    *,
    device_id: str = "scale-02",
    ttl_s: int = 60,
    min_weight_g: float = 5.0,
    max_weight_g: float = 5000.0,
) -> TareArm:
    """Arm the tare-capture interceptor for ``product_id``.

    Overwrites any existing arm (owner UX: always one target at a time;
    re-arming on product B cancels an outstanding arm on product A via
    ``INSERT OR REPLACE id=1``). ``ttl_s`` extends the TTL from now in
    seconds; ``min_weight_g`` / ``max_weight_g`` bound plausibility for
    the captured reading.

    ``armed_at`` / ``expires_at`` are computed in SQL so every arm's
    clock is the DB's wall-clock (matches the read-path comparison in
    :func:`get_active_tare_arm`).
    """
    ttl = max(1, int(ttl_s))
    with conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO tare_arm (
                id, product_id, device_id, armed_at, expires_at,
                min_weight_g, max_weight_g, last_error
            ) VALUES (
                1, ?, ?,
                strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                strftime('%Y-%m-%dT%H:%M:%fZ','now', ?),
                ?, ?, NULL
            )
            """,
            (
                product_id,
                device_id,
                f"+{ttl} seconds",
                float(min_weight_g),
                float(max_weight_g),
            ),
        )
    row = conn.execute(
        "SELECT * FROM tare_arm WHERE id = 1"
    ).fetchone()
    assert row is not None
    return _row_to_tare_arm(row)


def get_active_tare_arm(
    conn: sqlite3.Connection,
    *,
    device_id: str = "scale-02",
) -> Optional[TareArm]:
    """Return the tare-arm row if armed for ``device_id`` and not expired.

    Returns None when no row exists, the row's ``device_id`` doesn't
    match, or the row's ``expires_at`` is in the past relative to the
    DB's wall-clock. Rows past expiry are left in the table on purpose
    — the next arm overwrites them via ``INSERT OR REPLACE``, or the
    startup housekeeping pass clears them.
    """
    row = conn.execute(
        """
        SELECT * FROM tare_arm
         WHERE id = 1
           AND device_id = ?
           AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        """,
        (device_id,),
    ).fetchone()
    return _row_to_tare_arm(row) if row is not None else None


def consume_tare_arm(
    conn: sqlite3.Connection,
    *,
    product_id: str,
    tare_g: float,
) -> bool:
    """Write the captured tare + delete the arm row in one transaction.

    Returns True if the products row was updated (i.e. the product still
    exists). The arm row is unconditionally deleted — even if the
    product was deleted between arm and capture, we don't want the next
    catch-all event to be intercepted by a ghost arm pointing at a
    missing id.
    """
    with conn:
        cur = conn.execute(
            """
            UPDATE products
               SET tare_weight_g = ?, updated_at = datetime('now')
             WHERE product_id = ?
            """,
            (float(tare_g), product_id),
        )
        updated = (cur.rowcount or 0) > 0
        conn.execute("DELETE FROM tare_arm WHERE id = 1")
    return updated


def cancel_tare_arm(conn: sqlite3.Connection) -> int:
    """Drop the arm row if present. Idempotent. Returns rows deleted."""
    with conn:
        cur = conn.execute("DELETE FROM tare_arm WHERE id = 1")
    return int(cur.rowcount or 0)


def set_tare_arm_error(
    conn: sqlite3.Connection, error: Optional[str]
) -> None:
    """Stamp ``last_error`` on the arm row. No-op if no row exists.

    Used by the interceptor to record a bounds failure (implausible
    weight) without consuming the arm — the operator can read the
    error, re-place the container, and the next event tries again.
    """
    with conn:
        conn.execute(
            "UPDATE tare_arm SET last_error = ? WHERE id = 1",
            (error,),
        )


def clear_stale_tare_arm(
    conn: sqlite3.Connection,
    *,
    older_than_s: int = 600,
) -> int:
    """Startup housekeeping: drop arm rows older than ``older_than_s``.

    The interceptor already ignores arms whose ``expires_at`` is past,
    so the main function of this sweep is preventing the admin-wipe
    path and the ``/inventory`` banner from rendering an arm row that
    hasn't been touched in 10+ minutes. Returns the rows deleted.
    """
    cutoff = max(1, int(older_than_s))
    with conn:
        cur = conn.execute(
            """
            DELETE FROM tare_arm
             WHERE id = 1
               AND (julianday('now') - julianday(armed_at)) * 86400.0 > ?
            """,
            (cutoff,),
        )
    return int(cur.rowcount or 0)
