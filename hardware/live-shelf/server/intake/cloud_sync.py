"""Cloud → local product cache sync for the Live Shelf Pi.

Implements PROD_MIGRATION_PLAN.md §5 (intake rewrite) and the companion
"sync existing cloud products on boot" helper:

* :func:`upsert_product_from_cloud` — write-through one cloud-shaped
  product dict into the local ``products`` table, using the cloud-minted
  UUID as the local primary key. Called immediately after a successful
  ``POST /intake`` so the Pi has the product cached for subsequent
  classifier lookups without waiting for the next ``fetch_catalog``.
* :func:`sync_products_from_cloud` — pull the full catalog and upsert
  every product row into the local cache. Called at Pi startup when
  ``CLOUD_ENABLED=true`` so a freshly-flashed Pi can populate its
  cache without requiring the user to re-intake everything.

Both helpers bypass :mod:`server.storage.repo.create_product` because
that function mints its own UUID via ``new_id()``. Here the cloud is
the source of truth for the UUID, so we write it directly. The schema
(see ``server/storage/schema.sql``) uses ``product_id TEXT PRIMARY KEY``
and ``barcode TEXT UNIQUE``, so this module uses
``INSERT … ON CONFLICT`` on both keys to handle the two realistic
collision paths:

1. Same ``product_id`` already cached — the row is updated (the cloud
   is authoritative).
2. Same ``barcode`` cached under a different local UUID — the row is
   updated by barcode and the stored ``product_id`` is rewritten to
   match the cloud. This covers the migration-day scenario where the
   Pi has old locally-minted UUIDs and the user re-intakes a product
   that the cloud already knows about.

The module is deliberately side-effect-light: no logging beyond warnings
on bad input, no schema migrations, no transaction wrapping beyond what
each helper owns. The caller supplies the connection + lock.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional, Union

from ..cloud import CloudError
from ..cloud.catalog import fetch_catalog
from ..tools.locks import NullLock as _NullLock

log = logging.getLogger(__name__)


# Columns written by the upsert. Kept as a module-level tuple so tests
# can introspect the exact shape without reaching into the SQL string.
#
# Pass-2 audit finding #2: the previous tuple dropped macro + description
# fields that the cloud /intake edge fn returns, silently losing them on
# the Pi's cache write-through. The full set below mirrors the cloud
# ``chefbyte.products`` shape 1:1 (certified is still the last column
# that ``ON CONFLICT DO UPDATE`` doesn't bump via excluded — it's also
# echoed verbatim).
_PRODUCT_COLUMNS: tuple[str, ...] = (
    "product_id",
    "barcode",
    "name",
    "brand",
    "variant",
    "net_weight_g",
    "gross_weight_g",
    "tare_weight_g",
    "serving_weight_g",
    "servings_per_container",
    "unit_type",
    "density_g_per_ml",
    "container_type",
    "calories_per_serving",
    "carbs_per_serving",
    "protein_per_serving",
    "fat_per_serving",
    "description",
    "certified",
)

# Valid unit_type values on the Pi's local CHECK constraint. The cloud
# side has no CHECK and may send values like 'volume' or future enum
# additions. An unmapped value would break the local INSERT, so
# ``upsert_product_from_cloud`` coerces unknowns to NULL + logs a
# WARNING — finding #3 in the pass-2 audit.
_LOCAL_UNIT_TYPES: frozenset[str] = frozenset({
    "liquid", "solid", "count", "mixed",
})


def _resolve_lock(lock: Optional[threading.Lock]) -> Any:
    return lock if lock is not None else _NullLock()


def _extract(product: dict, key: str) -> Any:
    """Pull ``key`` from a cloud-shaped product dict tolerating variations.

    The cloud's ``chefbyte.products`` row uses snake_case column names
    that match the Pi's local schema 1:1 for the fields we care about.
    We accept either the bare key or its lowercase alias so a future
    camelCase JSON variant doesn't break the cache path silently.
    """
    if key in product:
        return product[key]
    # Accept camelCase for belt-and-suspenders tolerance.
    # e.g. "netWeightG" → "net_weight_g"
    camel = _to_camel(key)
    return product.get(camel)


def _to_camel(snake: str) -> str:
    head, *tail = snake.split("_")
    return head + "".join(part.title() for part in tail)


def upsert_product_from_cloud(
    conn: sqlite3.Connection,
    product: dict,
    *,
    db_lock: Optional[threading.Lock] = None,
) -> Optional[str]:
    """Write-through one cloud product dict into the local ``products`` cache.

    Parameters
    ----------
    conn:
        Live SQLite connection to the Pi's local DB.
    product:
        Cloud-shaped product row, as returned by ``GET /catalog`` or
        ``POST /intake``. Must contain at minimum ``product_id`` (str)
        and ``name`` (str). All other fields are optional and are
        mapped directly onto the local column of the same name.
    db_lock:
        Optional shared DB lock (see :mod:`server.adapters.intake_repo`
        for why this exists). Pass the orchestrator's lock when writing
        from the Flask request thread.

    Returns
    -------
    The product_id that ended up in the local row (same as the cloud's
    UUID), or ``None`` if the input was malformed and skipped.
    """

    if not isinstance(product, dict):
        log.warning("upsert_product_from_cloud: not a dict: %r", type(product))
        return None

    product_id = _extract(product, "product_id")
    name = _extract(product, "name")

    if not isinstance(product_id, str) or not product_id.strip():
        log.warning(
            "upsert_product_from_cloud: missing/invalid product_id; skipped"
        )
        return None
    if not isinstance(name, str) or not name.strip():
        log.warning(
            "upsert_product_from_cloud: missing/invalid name for %s; skipped",
            product_id,
        )
        return None

    barcode = _extract(product, "barcode")
    brand = _extract(product, "brand")
    variant = _extract(product, "variant")
    net_weight_g = _extract(product, "net_weight_g")
    gross_weight_g = _extract(product, "gross_weight_g")
    tare_weight_g = _extract(product, "tare_weight_g")
    serving_weight_g = _extract(product, "serving_weight_g")
    servings_per_container = _extract(product, "servings_per_container")
    unit_type_raw = _extract(product, "unit_type")
    density_g_per_ml = _extract(product, "density_g_per_ml")
    container_type = _extract(product, "container_type")
    calories_per_serving = _extract(product, "calories_per_serving")
    carbs_per_serving = _extract(product, "carbs_per_serving")
    protein_per_serving = _extract(product, "protein_per_serving")
    fat_per_serving = _extract(product, "fat_per_serving")
    description = _extract(product, "description")
    certified_raw = _extract(product, "certified")

    # Finding #3: the cloud's unit_type has no CHECK — integration tests
    # have already pushed 'volume' through. The Pi's CHECK constraint
    # rejects unknown values, which would make this INSERT fail silently
    # under ``with conn:``. Map unknowns to NULL + WARN so operators see
    # the drift without the cache write blowing up.
    unit_type: Optional[str]
    if unit_type_raw is None:
        unit_type = None
    elif isinstance(unit_type_raw, str) and unit_type_raw in _LOCAL_UNIT_TYPES:
        unit_type = unit_type_raw
    else:
        log.warning(
            "upsert_product_from_cloud: unknown unit_type=%r for "
            "product_id=%s; mapping to NULL (valid values: %s)",
            unit_type_raw, product_id, sorted(_LOCAL_UNIT_TYPES),
        )
        unit_type = None
    # The cloud's column is BOOLEAN; local is INTEGER 0/1. Coerce.
    # When the cloud payload omits the flag entirely, default to 0 — cloud
    # products not explicitly marked certified should NOT auto-certify on
    # the Pi. Users certify via the intake flow (or the cloud upstream
    # does it explicitly). Defaulting to 1 here silently promoted every
    # cache write-through into a "certified" state.
    if isinstance(certified_raw, bool):
        certified = 1 if certified_raw else 0
    elif certified_raw is None:
        certified = 0
    else:
        try:
            certified = 1 if int(certified_raw) else 0
        except (TypeError, ValueError):
            certified = 0

    lock = _resolve_lock(db_lock)

    # Two UPSERTs in a transaction:
    #   1. Primary path — INSERT … ON CONFLICT(product_id) DO UPDATE SET …
    #      Handles "same id, row may or may not exist".
    #   2. Reconciliation path — if a *different* local row already holds
    #      this barcode (legacy local-UUID migration), delete the old row
    #      first so the barcode UNIQUE constraint doesn't reject our
    #      insert. Losing the old row's local-only columns is acceptable
    #      — the cloud is authoritative now.
    with lock:
        with conn:
            if barcode:
                conn.execute(
                    """
                    DELETE FROM products
                     WHERE barcode = ?
                       AND product_id != ?
                    """,
                    (barcode, product_id),
                )
            placeholders = ", ".join(["?"] * len(_PRODUCT_COLUMNS))
            conn.execute(
                f"""
                INSERT INTO products (
                    {", ".join(_PRODUCT_COLUMNS)}
                ) VALUES ({placeholders})
                ON CONFLICT(product_id) DO UPDATE SET
                    barcode = excluded.barcode,
                    name = excluded.name,
                    brand = excluded.brand,
                    variant = excluded.variant,
                    net_weight_g = excluded.net_weight_g,
                    gross_weight_g = excluded.gross_weight_g,
                    tare_weight_g = excluded.tare_weight_g,
                    serving_weight_g = excluded.serving_weight_g,
                    servings_per_container = excluded.servings_per_container,
                    unit_type = excluded.unit_type,
                    density_g_per_ml = excluded.density_g_per_ml,
                    container_type = excluded.container_type,
                    calories_per_serving = excluded.calories_per_serving,
                    carbs_per_serving = excluded.carbs_per_serving,
                    protein_per_serving = excluded.protein_per_serving,
                    fat_per_serving = excluded.fat_per_serving,
                    description = excluded.description,
                    certified = excluded.certified,
                    updated_at = datetime('now')
                """,
                (
                    product_id,
                    barcode,
                    name,
                    brand,
                    variant,
                    net_weight_g,
                    gross_weight_g,
                    tare_weight_g,
                    serving_weight_g,
                    servings_per_container,
                    unit_type,
                    density_g_per_ml,
                    container_type,
                    calories_per_serving,
                    carbs_per_serving,
                    protein_per_serving,
                    fat_per_serving,
                    description,
                    certified,
                ),
            )

    return product_id


def sync_products_from_cloud(
    client: Any,
    conn: sqlite3.Connection,
    *,
    db_lock: Optional[threading.Lock] = None,
    refs_root: Optional[Union[str, Path]] = None,
) -> int:
    """Pull the cloud catalog and upsert every product into the local cache.

    Idempotent — safe to call at every Pi boot. Intended to be invoked
    once from the orchestrator when ``CLOUD_ENABLED=true``; the separate
    ``app.py`` agent wires the actual call site.

    Parameters
    ----------
    client:
        A :class:`~server.cloud.client.CloudClient` (or any object with
        the same ``.get`` contract). Duck-typed to keep unit tests light.
    conn:
        Live SQLite connection to the Pi's local DB.
    db_lock:
        Optional shared DB lock, same semantics as
        :func:`upsert_product_from_cloud`.
    refs_root:
        Optional filesystem root holding per-product reference photo
        directories (``<refs_root>/<product_id>/``). When supplied, we
        scan for products that have cloud rows but no local
        ``<refs_root>/<product_id>/`` directory and log WARNING per
        orphan so the operator can re-run intake. We do NOT auto-create
        directories or re-fetch photos — recovery is manual. Finding
        #11 from the deep audit.

    Returns
    -------
    int
        The number of rows successfully upserted. On a cloud-side error
        the exception propagates (callers decide whether to log + skip or
        treat as fatal at boot).
    """

    catalog = fetch_catalog(client)
    count = 0
    product_ids: list[str] = []
    for product in catalog.products:
        result = upsert_product_from_cloud(conn, product, db_lock=db_lock)
        if result is not None:
            count += 1
            product_ids.append(result)
    log.info("sync_products_from_cloud: upserted %d product(s)", count)

    # Finding #11: orphan ref-photo detection. Cloud is authoritative
    # for the product catalog; ref photos stay local. If a product
    # came over the wire but its ref-photo directory is missing, the
    # operator needs to re-capture photos via intake — otherwise the
    # classifier prompt will be photo-less for that product.
    if refs_root is not None and product_ids:
        try:
            refs_path = Path(refs_root)
            orphans: list[str] = []
            for pid in product_ids:
                product_dir = refs_path / pid
                if not product_dir.is_dir():
                    orphans.append(pid)
            if orphans:
                log.warning(
                    "sync_products_from_cloud: %d product(s) have no "
                    "local reference-photo directory under %s — "
                    "classifier prompts will be photo-less for these; "
                    "re-run intake to capture ref photos. Orphans: %s",
                    len(orphans),
                    refs_path,
                    ", ".join(orphans[:10]) + (
                        f" ...({len(orphans) - 10} more)" if len(orphans) > 10 else ""
                    ),
                )
        except Exception:  # noqa: BLE001 - observability must not raise
            log.warning(
                "sync_products_from_cloud: orphan-ref scan failed",
                exc_info=True,
            )

    return count


__all__ = [
    "CloudError",
    "sync_products_from_cloud",
    "upsert_product_from_cloud",
]
