"""Render-path tests for the /inventory page's "Classifier candidates" section.

The section is a debug affordance: when classification goes sideways
(UNKNOWN-only events, mismatched picks), the operator can open the
inventory page and immediately see what ``pool_for_add`` would consider
for the next ADD event — without having to query SQLite or read the
``session_resolutions`` row.

These tests pin two contracts:

  1. **Happy path**: when ``cloud_lots`` has products the user has
     intaked, the section lists them by name AND does NOT show the
     red "pool empty" banner.
  2. **Smoking gun**: when ``cloud_lots`` is empty (no products with
     ``qty > 0`` for this shelf), only the UNKNOWN sentinel is in the
     pool and the red banner IS shown — the operator immediately knows
     the next ADD will be unmatchable.

Mutation check: comment out the ``classifier_candidates=...`` line in
``server/web/routes.py`` (or stub the provider out in ``app.py``) and
both tests fail. This is the affordance's job — surface the smoking
gun for the user, not just pass silently.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.candidate_source import RepoCandidateSource  # noqa: E402
from server.adapters.web_repo import RepoWebAdapter  # noqa: E402
from server.classifier.candidate_pool import pool_for_add  # noqa: E402
from server.classifier.models import ClassifierContext  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402
from server.web import make_html_bp  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db_conn():
    """Fresh in-memory SQLite with the live-shelf schema applied."""
    conn = init_db(":memory:")
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture()
def db_lock() -> threading.RLock:
    return threading.RLock()


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    """Minimal data dir layout — refs root + events root must exist."""
    (tmp_path / "events").mkdir(exist_ok=True)
    (tmp_path / "refs").mkdir(exist_ok=True)
    return tmp_path


def _seed_product(conn: sqlite3.Connection, *, name: str, barcode: str) -> str:
    """Create a certified product and return its product_id."""
    p = storage_repo.create_product(
        conn,
        ProductIn(
            name=name,
            barcode=barcode,
            net_weight_g=600.0,
            gross_weight_g=620.0,
            tare_weight_g=20.0,
            unit_type="solid",
            container_type="bottle",
            certified=1,
        ),
    )
    return p.product_id


def _seed_cloud_lot(
    conn: sqlite3.Connection,
    *,
    lot_id: str,
    product_id: str,
    qty: float = 1.0,
) -> None:
    """Insert a cloud_lots mirror row (qty>0 → counts as inventory)."""
    conn.execute(
        """
        INSERT INTO cloud_lots (
            lot_id, product_id, location_id, qty_containers,
            expires_on, in_flight_since, pickup_event_id,
            updated_at, deleted_at, synced_at
        ) VALUES (?, ?, 'loc-1', ?, NULL, NULL, NULL,
                  '2026-04-27T20:00:00+00:00', NULL, datetime('now'))
        """,
        (lot_id, product_id, qty),
    )
    conn.commit()


def _build_app(
    db_conn: sqlite3.Connection,
    db_lock: threading.RLock,
    data_dir: Path,
) -> Flask:
    """Wire the same html_bp the production app uses, with a real
    RepoCandidateSource + ClassifierContext for the live_shelf."""
    repo = RepoWebAdapter(db_conn, db_lock=db_lock)
    candidate_source = RepoCandidateSource(
        db_conn, data_dir / "refs", db_lock=db_lock,
    )

    def _provider() -> list[Any]:
        ctx = ClassifierContext(
            source=candidate_source, shelf_id="live_shelf",
        )
        return list(pool_for_add(50.0, ctx))

    bp = make_html_bp(
        repo,
        data_dir=data_dir,
        catch_all_enabled=lambda: False,
        classifier_pool_provider=_provider,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(bp)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestClassifierCandidatesSection:
    def test_lists_seeded_products_and_hides_red_banner(
        self,
        db_conn: sqlite3.Connection,
        db_lock: threading.RLock,
        data_dir: Path,
    ):
        """Two products in cloud_lots → both appear in the candidates
        table; the red "pool empty" banner is NOT shown."""
        gat_id = _seed_product(
            db_conn, name="Gatorade Frost", barcode="bc-gatorade",
        )
        keto_id = _seed_product(
            db_conn, name="Ketchup Heinz", barcode="bc-ketchup",
        )
        _seed_cloud_lot(db_conn, lot_id="cl-gat", product_id=gat_id)
        _seed_cloud_lot(db_conn, lot_id="cl-ket", product_id=keto_id)

        app = _build_app(db_conn, db_lock, data_dir)
        client = app.test_client()

        r = client.get("/inventory")
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_data(as_text=True)

        # Section header rendered.
        assert "Classifier candidates" in body
        # Both seeded products surface in the section.
        assert "Gatorade Frost" in body
        assert "Ketchup Heinz" in body
        # The inventory_only why-tag is the pathway both should hit.
        assert "inventory_only" in body
        # UNKNOWN sentinel is appended last but the section is NOT
        # in the empty-pool red-banner state.
        assert "(UNKNOWN sentinel)" in body
        assert "Pool empty (UNKNOWN-only)" not in body

    def test_empty_cloud_lots_renders_red_smoking_gun_banner(
        self,
        db_conn: sqlite3.Connection,
        db_lock: threading.RLock,
        data_dir: Path,
    ):
        """No cloud_lots rows → pool collapses to UNKNOWN-only and the
        red "Pool empty" banner is shown.

        This is the smoking-gun affordance: if the operator sees this
        and they expected products to be tracked, they know the
        cloud_lots sync is broken without having to query SQLite.
        """
        # Deliberately seed NOTHING — no products, no cloud_lots, no
        # Pi lots. The pool builder should surface UNKNOWN only.

        app = _build_app(db_conn, db_lock, data_dir)
        client = app.test_client()

        r = client.get("/inventory")
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_data(as_text=True)

        # Section + red banner present.
        assert "Classifier candidates" in body
        assert "Pool empty (UNKNOWN-only)" in body
        # Banner explains the likely cause.
        assert "cloud_lots" in body
        # UNKNOWN sentinel is the only entry.
        assert "(UNKNOWN sentinel)" in body
        # No real product names should appear in the candidates table —
        # the seed didn't create any.
        assert "Gatorade Frost" not in body
        assert "Ketchup Heinz" not in body

    def test_section_hidden_when_no_provider_wired(
        self,
        db_conn: sqlite3.Connection,
        db_lock: threading.RLock,
        data_dir: Path,
    ):
        """When the route is wired without a ``classifier_pool_provider``
        (e.g. older test apps that don't care), the section is hidden
        entirely — neither header nor banner appear. Verifies the
        affordance is opt-in and never crashes a callsite that hasn't
        plumbed it through."""
        repo = RepoWebAdapter(db_conn, db_lock=db_lock)
        bp = make_html_bp(
            repo,
            data_dir=data_dir,
            catch_all_enabled=lambda: False,
            # No classifier_pool_provider — section should disappear.
        )
        app = Flask(__name__)
        app.config["TESTING"] = True
        app.register_blueprint(bp)
        client = app.test_client()

        r = client.get("/inventory")
        assert r.status_code == 200
        body = r.get_data(as_text=True)
        assert "Classifier candidates" not in body
        assert "Pool empty (UNKNOWN-only)" not in body
