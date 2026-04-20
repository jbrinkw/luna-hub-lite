"""Unit tests for ``server.intake.cloud_sync``.

The module has two public entry points:

* :func:`upsert_product_from_cloud` — single-row write-through.
* :func:`sync_products_from_cloud` — bulk pull from ``GET /catalog``
  followed by an upsert per row.

Tests use a real in-memory SQLite DB (via the project's migration helper)
so the ON CONFLICT clauses and UNIQUE(barcode) constraint are exercised
end-to-end, not just mocked.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.intake.cloud_sync import (  # noqa: E402
    sync_products_from_cloud,
    upsert_product_from_cloud,
)
from server.storage.migrations import apply_migrations  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB with the live-shelf schema applied."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


# ---------------------------------------------------------------------------
# upsert_product_from_cloud
# ---------------------------------------------------------------------------


def test_upsert_inserts_new_row_with_cloud_uuid(conn):
    """Primary path: a brand-new cloud product gets inserted with the
    cloud-minted UUID as the local primary key."""
    cloud = {
        "product_id": "cloud-uuid-0001",
        "name": "Heinz Ketchup",
        "barcode": "3017620422003",
        "brand": "Heinz",
        "net_weight_g": 340.0,
        "unit_type": "liquid",
        "certified": True,
    }
    returned_id = upsert_product_from_cloud(conn, cloud)
    assert returned_id == "cloud-uuid-0001"

    row = conn.execute(
        "SELECT * FROM products WHERE product_id = ?", ("cloud-uuid-0001",)
    ).fetchone()
    assert row is not None
    assert row["name"] == "Heinz Ketchup"
    assert row["barcode"] == "3017620422003"
    assert row["brand"] == "Heinz"
    assert row["net_weight_g"] == 340.0
    assert row["unit_type"] == "liquid"
    assert row["certified"] == 1


def test_upsert_updates_existing_row_by_product_id(conn):
    """Re-upsert with the same product_id patches the row — cloud is
    authoritative, local updates happen on every sync."""
    conn.execute(
        "INSERT INTO products (product_id, name, brand, certified) "
        "VALUES (?, ?, ?, ?)",
        ("cloud-uuid-0002", "Old Name", "OldBrand", 1),
    )
    conn.commit()

    upsert_product_from_cloud(
        conn,
        {
            "product_id": "cloud-uuid-0002",
            "name": "New Name",
            "brand": "NewBrand",
            "certified": True,
        },
    )
    row = conn.execute(
        "SELECT name, brand FROM products WHERE product_id = ?",
        ("cloud-uuid-0002",),
    ).fetchone()
    assert row["name"] == "New Name"
    assert row["brand"] == "NewBrand"


def test_upsert_reconciles_legacy_local_uuid_by_barcode(conn):
    """Migration-day scenario: a row exists under an old local UUID with
    the same barcode the cloud now reports. The old row is replaced so
    the UNIQUE(barcode) constraint doesn't block the insert."""
    conn.execute(
        "INSERT INTO products (product_id, name, barcode, certified) "
        "VALUES (?, ?, ?, ?)",
        ("local-old-uuid", "Ketchup", "3017620422003", 1),
    )
    conn.commit()

    upsert_product_from_cloud(
        conn,
        {
            "product_id": "cloud-uuid-NEW",
            "name": "Heinz Ketchup",
            "barcode": "3017620422003",
            "certified": True,
        },
    )

    # Old local row is gone.
    old = conn.execute(
        "SELECT * FROM products WHERE product_id = 'local-old-uuid'"
    ).fetchone()
    assert old is None

    # Cloud row is in.
    new = conn.execute(
        "SELECT * FROM products WHERE product_id = 'cloud-uuid-NEW'"
    ).fetchone()
    assert new is not None
    assert new["barcode"] == "3017620422003"

    # Only one row with that barcode.
    all_rows = conn.execute(
        "SELECT COUNT(*) AS c FROM products WHERE barcode = '3017620422003'"
    ).fetchone()
    assert all_rows["c"] == 1


def test_upsert_is_idempotent(conn):
    """Calling upsert twice with the same payload produces exactly one row."""
    payload = {
        "product_id": "cloud-uuid-0003",
        "name": "Custom Thing",
        "barcode": "9991234567890",
    }
    upsert_product_from_cloud(conn, payload)
    upsert_product_from_cloud(conn, payload)
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM products"
    ).fetchone()["c"]
    assert count == 1


def test_upsert_returns_none_on_missing_product_id(conn):
    """Malformed input → skip + log, don't write."""
    result = upsert_product_from_cloud(conn, {"name": "x"})
    assert result is None
    assert conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"] == 0


def test_upsert_returns_none_on_missing_name(conn):
    """Malformed input → skip + log, don't write."""
    result = upsert_product_from_cloud(conn, {"product_id": "x"})
    assert result is None
    assert conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"] == 0


def test_upsert_handles_null_barcode(conn):
    """Custom items have no barcode; the SQL must tolerate NULL."""
    result = upsert_product_from_cloud(
        conn,
        {"product_id": "cloud-uuid-nobarcode", "name": "Custom"},
    )
    assert result == "cloud-uuid-nobarcode"
    row = conn.execute(
        "SELECT barcode FROM products WHERE product_id = 'cloud-uuid-nobarcode'"
    ).fetchone()
    assert row["barcode"] is None


def test_upsert_coerces_bool_certified_to_int(conn):
    """Cloud JSON carries ``certified: true/false``; local column is 0/1."""
    upsert_product_from_cloud(
        conn,
        {"product_id": "p1", "name": "x", "certified": False},
    )
    row = conn.execute(
        "SELECT certified FROM products WHERE product_id = 'p1'"
    ).fetchone()
    assert row["certified"] == 0


def test_upsert_defaults_certified_to_zero_when_missing(conn):
    """Cloud products that omit ``certified`` should NOT auto-certify.

    Auto-defaulting to 1 silently promoted every write-through cache row
    to certified, which bypasses the user's intake-flow review. Defaulting
    to 0 forces an explicit certified=true from upstream before the
    classifier treats the row as user-trusted.
    """
    upsert_product_from_cloud(
        conn,
        {"product_id": "p-missing", "name": "No cert flag"},
    )
    row = conn.execute(
        "SELECT certified FROM products WHERE product_id = 'p-missing'"
    ).fetchone()
    assert row["certified"] == 0


def test_upsert_defaults_certified_to_zero_when_garbage(conn):
    """Garbage certified value (not bool/int/None) also defaults to 0.

    Same principle as the missing case — we only opt-in to certified
    when the upstream payload says so explicitly with a truthy value.
    """
    upsert_product_from_cloud(
        conn,
        {"product_id": "p-garbage", "name": "Garbage cert", "certified": "not-a-bool"},
    )
    row = conn.execute(
        "SELECT certified FROM products WHERE product_id = 'p-garbage'"
    ).fetchone()
    assert row["certified"] == 0


def test_upsert_rejects_non_dict_input(conn):
    """Defensive: a list/None slipped through upstream parsing → skip."""
    assert upsert_product_from_cloud(conn, None) is None  # type: ignore[arg-type]
    assert upsert_product_from_cloud(conn, "not-a-dict") is None  # type: ignore[arg-type]
    assert conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"] == 0


# ---------------------------------------------------------------------------
# sync_products_from_cloud
# ---------------------------------------------------------------------------


def test_sync_from_cloud_writes_every_product(conn):
    """Full round-trip: fetch_catalog → per-product upsert.

    The client stub returns a canned catalog; we assert every product
    lands in the local table with its cloud UUID preserved.
    """
    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "cp-1", "name": "A", "barcode": "111"},
            {"product_id": "cp-2", "name": "B", "barcode": "222"},
            {"product_id": "cp-3", "name": "C"},  # no barcode — custom item
        ],
        "stock": [],
        "pairings": [],
        "locations": [],
    }
    count = sync_products_from_cloud(client, conn)
    assert count == 3

    rows = conn.execute(
        "SELECT product_id, name FROM products ORDER BY product_id"
    ).fetchall()
    assert [r["product_id"] for r in rows] == ["cp-1", "cp-2", "cp-3"]


def test_sync_from_cloud_is_idempotent(conn):
    """Running sync twice produces the same row count, not duplicates."""
    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "cp-1", "name": "A", "barcode": "111"},
            {"product_id": "cp-2", "name": "B"},
        ],
        "stock": [],
    }
    sync_products_from_cloud(client, conn)
    sync_products_from_cloud(client, conn)
    count = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"]
    assert count == 2


def test_sync_skips_malformed_products_but_returns_count_of_good_ones(conn):
    """Defensive: a bad product dict in the cloud response doesn't break
    the whole sync — it's logged and the good rows still land."""
    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "cp-1", "name": "A"},
            {"name": "no id here"},          # skipped
            {"product_id": "cp-2"},          # skipped, no name
            {"product_id": "cp-3", "name": "C"},
        ],
    }
    count = sync_products_from_cloud(client, conn)
    assert count == 2
    rows = conn.execute(
        "SELECT product_id FROM products ORDER BY product_id"
    ).fetchall()
    assert [r["product_id"] for r in rows] == ["cp-1", "cp-3"]


def test_sync_propagates_cloud_error(conn):
    """A CloudError from fetch_catalog must surface so the caller can log
    + fall back to a previously-cached catalog. We don't swallow here."""
    client = MagicMock()
    client.get.side_effect = CloudError(401, "bad token")
    with pytest.raises(CloudError):
        sync_products_from_cloud(client, conn)


def test_sync_with_empty_catalog_is_a_noop(conn):
    """Fresh user with no products yet → no writes, return 0."""
    client = MagicMock()
    client.get.return_value = {"products": [], "stock": []}
    assert sync_products_from_cloud(client, conn) == 0
    assert conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"] == 0


# ---------------------------------------------------------------------------
# Orphan ref-photo detection (deep-audit finding #11)
# ---------------------------------------------------------------------------


def test_sync_logs_orphan_warning_for_products_without_ref_dir(
    conn, tmp_path, caplog,
):
    """When refs_root is supplied, every cloud product must have a
    local ``<refs_root>/<product_id>/`` directory. Missing ones get a
    single WARNING listing them up to a cap — the operator re-runs
    intake to recapture photos."""
    import logging
    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    # Seed a ref-photo directory for one of the two cloud products so
    # we can verify the orphan scan correctly identifies only the
    # missing one.
    (refs_root / "cp-1").mkdir()

    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "cp-1", "name": "HasRefs"},
            {"product_id": "cp-2", "name": "MissingRefs"},
        ],
        "stock": [], "pairings": [], "locations": [],
    }
    with caplog.at_level(
        logging.WARNING, logger="server.intake.cloud_sync",
    ):
        count = sync_products_from_cloud(
            client, conn, refs_root=refs_root,
        )
    assert count == 2
    warn_records = [
        r for r in caplog.records
        if r.name == "server.intake.cloud_sync"
        and r.levelname == "WARNING"
        and "local reference-photo directory" in r.message
    ]
    assert len(warn_records) == 1
    # The orphan id must be named in the warning.
    assert "cp-2" in warn_records[0].getMessage()
    # The non-orphan id must NOT be named (false-positive guard).
    assert "cp-1" not in warn_records[0].getMessage()


def test_sync_does_not_warn_when_all_products_have_refs(
    conn, tmp_path, caplog,
):
    """Fully-synced state: no WARNING if every cloud product has a
    matching refs directory."""
    import logging
    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    (refs_root / "cp-1").mkdir()
    (refs_root / "cp-2").mkdir()

    client = MagicMock()
    client.get.return_value = {
        "products": [
            {"product_id": "cp-1", "name": "A"},
            {"product_id": "cp-2", "name": "B"},
        ],
        "stock": [], "pairings": [], "locations": [],
    }
    with caplog.at_level(
        logging.WARNING, logger="server.intake.cloud_sync",
    ):
        sync_products_from_cloud(client, conn, refs_root=refs_root)
    orphan_records = [
        r for r in caplog.records
        if "local reference-photo directory" in r.getMessage()
    ]
    assert orphan_records == []


def test_sync_skips_orphan_scan_when_refs_root_not_supplied(
    conn, caplog,
):
    """refs_root is optional — old call sites pass None and get the
    original behaviour with no scan + no WARNING."""
    import logging
    client = MagicMock()
    client.get.return_value = {
        "products": [{"product_id": "cp-1", "name": "A"}],
        "stock": [], "pairings": [], "locations": [],
    }
    with caplog.at_level(
        logging.WARNING, logger="server.intake.cloud_sync",
    ):
        sync_products_from_cloud(client, conn)  # no refs_root
    orphan_records = [
        r for r in caplog.records
        if "local reference-photo directory" in r.getMessage()
    ]
    assert orphan_records == []


# ---------------------------------------------------------------------------
# Pass-2 audit finding #2: macro + description fields on write-through
# ---------------------------------------------------------------------------


def test_upsert_writes_macro_and_description_fields(conn):
    """A cloud product carrying macros + description must land in the
    local cache verbatim.

    Previously ``_PRODUCT_COLUMNS`` dropped these fields, which meant
    the Pi-side classifier never saw macro context when building its
    review-item summaries even though the cloud faithfully returned
    them on every ``POST /intake`` / ``GET /catalog``.
    """
    payload = {
        "product_id": "macro-1",
        "name": "Cheerios",
        "barcode": "016000275249",
        "brand": "General Mills",
        "calories_per_serving": 100.0,
        "carbs_per_serving": 20.5,
        "protein_per_serving": 3.0,
        "fat_per_serving": 2.0,
        "description": "Whole grain oat cereal.",
    }
    returned_id = upsert_product_from_cloud(conn, payload)
    assert returned_id == "macro-1"

    row = conn.execute(
        "SELECT calories_per_serving, carbs_per_serving, "
        "       protein_per_serving, fat_per_serving, description "
        "  FROM products WHERE product_id = ?",
        ("macro-1",),
    ).fetchone()
    assert row["calories_per_serving"] == 100.0
    assert row["carbs_per_serving"] == 20.5
    assert row["protein_per_serving"] == 3.0
    assert row["fat_per_serving"] == 2.0
    assert row["description"] == "Whole grain oat cereal."


def test_upsert_updates_macro_fields_on_existing_row(conn):
    """Cloud is authoritative: a re-upsert with new macros overwrites
    the previous values (not additive, not dropped)."""
    upsert_product_from_cloud(
        conn,
        {
            "product_id": "macro-2",
            "name": "Bar",
            "calories_per_serving": 200.0,
            "protein_per_serving": 10.0,
        },
    )
    upsert_product_from_cloud(
        conn,
        {
            "product_id": "macro-2",
            "name": "Bar",
            "calories_per_serving": 180.0,
            "protein_per_serving": 12.0,
            "description": "Updated description",
        },
    )
    row = conn.execute(
        "SELECT calories_per_serving, protein_per_serving, description "
        "  FROM products WHERE product_id = 'macro-2'"
    ).fetchone()
    assert row["calories_per_serving"] == 180.0
    assert row["protein_per_serving"] == 12.0
    assert row["description"] == "Updated description"


# ---------------------------------------------------------------------------
# Pass-2 audit finding #3: unknown unit_type maps to NULL with WARNING
# ---------------------------------------------------------------------------


def test_upsert_maps_unknown_unit_type_to_null(conn, caplog):
    """The cloud has no CHECK on unit_type; the Pi does. Unknown values
    land as NULL + log WARNING rather than crashing the upsert."""
    import logging

    with caplog.at_level(
        logging.WARNING, logger="server.intake.cloud_sync",
    ):
        returned_id = upsert_product_from_cloud(
            conn,
            {
                "product_id": "ut-1",
                "name": "Beverage",
                # 'volume' is valid on the cloud schema but not locally.
                "unit_type": "volume",
            },
        )

    assert returned_id == "ut-1"

    row = conn.execute(
        "SELECT unit_type FROM products WHERE product_id = 'ut-1'"
    ).fetchone()
    assert row["unit_type"] is None

    # Warning must mention the original value + product_id so operators
    # can spot drift between Pi + cloud enum surfaces.
    warning_msgs = [
        r.getMessage() for r in caplog.records
        if r.levelno == logging.WARNING
    ]
    assert any(
        "unknown unit_type" in m and "'volume'" in m and "ut-1" in m
        for m in warning_msgs
    ), warning_msgs


def test_upsert_preserves_valid_unit_type(conn, caplog):
    """Known unit_type values are written verbatim, no WARNING."""
    import logging

    with caplog.at_level(
        logging.WARNING, logger="server.intake.cloud_sync",
    ):
        upsert_product_from_cloud(
            conn,
            {
                "product_id": "ut-ok",
                "name": "Milk",
                "unit_type": "liquid",
            },
        )

    row = conn.execute(
        "SELECT unit_type FROM products WHERE product_id = 'ut-ok'"
    ).fetchone()
    assert row["unit_type"] == "liquid"

    unit_type_warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING
        and "unknown unit_type" in r.getMessage()
    ]
    assert unit_type_warnings == []


def test_upsert_handles_none_unit_type(conn):
    """Cloud payload without unit_type stores NULL (no coerce, no warn)."""
    upsert_product_from_cloud(
        conn,
        {"product_id": "ut-none", "name": "X"},
    )
    row = conn.execute(
        "SELECT unit_type FROM products WHERE product_id = 'ut-none'"
    ).fetchone()
    assert row["unit_type"] is None


def test_product_columns_includes_macros_and_description():
    """``_PRODUCT_COLUMNS`` is the source of truth for the write-through
    schema. Guard that the macro + description fields stay in the tuple
    — a future refactor that drops them would silently bring back the
    pass-2 audit bug this module is named after.
    """
    from server.intake.cloud_sync import _PRODUCT_COLUMNS

    for col in (
        "calories_per_serving",
        "carbs_per_serving",
        "protein_per_serving",
        "fat_per_serving",
        "description",
    ):
        assert col in _PRODUCT_COLUMNS, (
            f"{col!r} dropped from _PRODUCT_COLUMNS; "
            "cloud macros would be silently lost on write-through"
        )
