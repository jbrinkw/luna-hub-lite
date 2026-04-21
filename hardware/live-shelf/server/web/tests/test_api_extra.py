"""Extra API-route tests flagged by the audit.

Covers:

1. ``/api/camera/auto-exposure`` rejects injected / traversal / empty /
   overlong ``device`` values before reaching subprocess argv.

2. ``/api/diag/dump-session`` caps the number of frames it writes to
   disk at 60 so a LAN client can't DOS the Pi by triggering a dump of
   the entire ring buffer.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Optional

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.web import make_api_bp, make_html_bp  # noqa: E402


# ---------------------------------------------------------------------------
# Minimal FakeRepo — only the methods these routes touch.
# ---------------------------------------------------------------------------


class _FakeRepo:
    def get_app_state(self) -> dict[str, Any]:
        return {
            "door_open": False,
            "current_session_id": None,
            "last_scale_weight_g": 0.0,
            "pending_reviews": 0,
            "total_events": 0,
            "shelf_name": "demo",
            "updated_at": "2026-04-15T12:00:00Z",
        }

    def list_events(self, *, limit: int, offset: int):
        return []

    def count_events(self):
        return 0

    def get_review_item(self, rid):
        return None


@pytest.fixture()
def client(tmp_path: Path):
    app = Flask(__name__)
    app.config["TESTING"] = True
    # Register both blueprints so url_for etc. all resolve.
    html_bp = make_html_bp(_FakeRepo(), data_dir=tmp_path)
    api_bp = make_api_bp(_FakeRepo())
    app.register_blueprint(html_bp)
    app.register_blueprint(api_bp)
    return app.test_client()


# ---------------------------------------------------------------------------
# auto-exposure device regex
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_device",
    [
        "/dev/video0; rm -rf /",       # shell metachars
        "../etc/passwd",               # traversal
        "",                            # empty
        "/dev/video" + ("0" * 50),     # overlong
        "/dev/video",                  # missing digits
        "/dev/videoX",                 # non-digit
    ],
)
def test_auto_exposure_device_regex_rejects_injection(client, bad_device, monkeypatch):
    """Bad ``device`` values must return 400 BEFORE any subprocess runs.
    We also stub set_auto_exposure so even if the route progressed it
    wouldn't touch v4l2-ctl.
    """
    from server.camera import locked_settings

    call_count = {"n": 0}

    def _never_call(*args, **kwargs):
        call_count["n"] += 1
        return True

    monkeypatch.setattr(locked_settings, "set_auto_exposure", _never_call)

    r = client.post(
        "/api/camera/auto-exposure",
        json={"enabled": True, "device": bad_device},
    )
    assert r.status_code == 400, (
        f"expected 400 for device={bad_device!r}; got {r.status_code} "
        f"body={r.get_data(as_text=True)!r}"
    )
    assert call_count["n"] == 0, (
        "set_auto_exposure must NOT be called for invalid device path"
    )


@pytest.mark.parametrize("good_device", ["/dev/video0", "/dev/video99"])
def test_auto_exposure_accepts_valid_device_paths(client, good_device, monkeypatch):
    """Valid /dev/videoN paths must pass the guard and invoke
    set_auto_exposure (stubbed to True).
    """
    from server.camera import locked_settings

    called_with: dict[str, Any] = {}

    def _fake(device, enabled):
        called_with["device"] = device
        called_with["enabled"] = enabled
        return True

    monkeypatch.setattr(locked_settings, "set_auto_exposure", _fake)

    r = client.post(
        "/api/camera/auto-exposure",
        json={"enabled": False, "device": good_device},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert called_with["device"] == good_device


# ---------------------------------------------------------------------------
# /api/diag/dump-session frame cap
# ---------------------------------------------------------------------------


def test_diag_dump_caps_frames_at_60(client, monkeypatch, tmp_path: Path):
    """Stub a daemon whose snapshot_ring returns 500 frames — the diag
    dump must cap on-disk writes at 60. Uses tmp_path as DATA_DIR so the
    real data/diag/ isn't touched.
    """
    import numpy as np

    from server.camera import extract

    class _BigDaemon:
        def snapshot_ring(self):
            # 500 tiny frames, all distinct timestamps.
            return [
                (f"2026-04-15T12:00:{i:02d}.{(i * 7) % 1000:03d}Z",
                 np.full((4, 4, 3), 128, dtype=np.uint8))
                for i in range(500)
            ]

    monkeypatch.setattr(extract, "get_daemon", lambda: _BigDaemon())
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    r = client.post("/api/diag/dump-session", json={})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["frame_count"] <= 60, (
        f"expected frame_count <= 60, got {body['frame_count']}"
    )


# ---------------------------------------------------------------------------
# /api/intake/save refs_root path validation
# ---------------------------------------------------------------------------


def test_intake_save_rejects_image_path_outside_refs_root(tmp_path: Path):
    """Paths outside refs_root (absolute /tmp/..., or ../../etc/...) must
    return 400 with 'refs_root' in the error message. This is the
    defence against a LAN client persisting a dangling image_path in the
    product_reference_images table.
    """
    from dataclasses import dataclass, field
    from server.intake.routes import create_blueprint
    from server.storage.models import Product, ProductReferenceImage

    @dataclass
    class _Repo:
        created_products: list = field(default_factory=list)
        created_refs: list = field(default_factory=list)

        def create_product(self, data) -> Product:
            self.created_products.append(data)
            return Product(
                product_id="prod-001",
                name=data.name,
                certified=data.certified,
                created_at="2026-04-15T12:00:00Z",
                updated_at="2026-04-15T12:00:00Z",
                barcode=data.barcode,
                brand=data.brand,
                variant=data.variant,
                net_weight_g=data.net_weight_g,
                gross_weight_g=data.gross_weight_g,
                tare_weight_g=data.tare_weight_g,
                serving_weight_g=data.serving_weight_g,
                servings_per_container=data.servings_per_container,
                unit_type=data.unit_type,
                density_g_per_ml=data.density_g_per_ml,
                container_type=data.container_type,
            )

        def create_product_reference_image(self, data) -> ProductReferenceImage:
            self.created_refs.append(data)
            return ProductReferenceImage(
                image_id="img-1",
                product_id=data.product_id,
                file_path=data.file_path,
                captured_at="2026-04-15T12:00:00Z",
                angle=data.angle,
            )

        def create_lot(self, data):
            raise AssertionError("lot creation not expected for intake save")

    class _FakeCamera:
        def current_frame_jpeg(self, quality: int = 85):
            return b"\xff\xd8\xff\xd9"

    refs_root = tmp_path / "refs"
    refs_root.mkdir()

    repo = _Repo()
    app = Flask(__name__)
    app.config["TESTING"] = True
    bp = create_blueprint(
        repo=repo,
        camera=_FakeCamera(),
        refs_root=refs_root,
    )
    app.register_blueprint(bp)
    client = app.test_client()

    r = client.post(
        "/api/intake/save",
        json={
            "name": "Test Product",
            "barcode": "1234567",
            "image_paths": ["/tmp/sneaky.jpg"],  # absolute, outside refs_root
        },
    )
    assert r.status_code == 400, (
        f"expected 400 for out-of-refs_root path; got {r.status_code} "
        f"body={r.get_data(as_text=True)!r}"
    )
    body = r.get_json()
    assert "refs_root" in body.get("error", "").lower()


# ---------------------------------------------------------------------------
# Tare-capture API round-trip (CATCH_ALL_TARE_CAPTURE_PLAN.md §7 extra)
#
# Arm → status(armed) → synthetic catch-all event → status(unarmed) +
# product row has new tare. Constructs a real in-memory DB + RepoWebAdapter
# so the end-to-end routing from HTTP → adapter → storage_repo is exercised.
# ---------------------------------------------------------------------------


def _make_taretest_app(tmp_path: Path, *, catch_all_device_id: str = "scale-02"):
    """Factory: a Flask app backed by a real SQLite DB + RepoWebAdapter,
    the api blueprint, and a handler instance sharing the same conn.
    Returns (app, adapter, handler, conn)."""
    import threading
    from server.adapters.web_repo import RepoWebAdapter
    from server.config import AppConfig
    from server.handlers.scale_events import ScaleHandler
    from server.shelves import build_registry_from_config
    from server.storage import init_db
    from server.tests.test_tare_capture import _NullCandidateSource

    conn = init_db(":memory:")
    db_lock = threading.RLock()
    adapter = RepoWebAdapter(
        conn, db_lock=db_lock,
        catch_all_device_id=catch_all_device_id,
    )
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    handler = ScaleHandler(
        conn=conn,
        db_lock=db_lock,
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=registry,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    api_bp = make_api_bp(adapter)
    app.register_blueprint(api_bp)
    return app, adapter, handler, conn


def test_tare_arm_status_event_roundtrip(tmp_path):
    """Full roundtrip: arm via POST /api/product/<id>/tare/arm, confirm
    /api/tare/status.armed=True, fire a synthetic catch-all event via
    the handler (simulating the ESP8266), then confirm status armed=False
    and the product's tare_weight_g reflects the captured reading."""
    from server.storage import repo as storage_repo
    from server.storage.models import ProductIn

    app, adapter, handler, conn = _make_taretest_app(tmp_path)
    client = app.test_client()

    # Seed a certified product.
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Roundtrip Jar",
            barcode="rt-1",
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )

    # 1) Arm.
    r = client.post(f"/api/product/{product.product_id}/tare/arm")
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["ok"] is True
    assert body["product_id"] == product.product_id

    # 2) Status shows armed=True.
    r = client.get("/api/tare/status")
    assert r.status_code == 200
    status = r.get_json()
    assert status["armed"] is True
    assert status["product_id"] == product.product_id
    assert status["product_name"] == "Roundtrip Jar"
    # seconds_remaining positive and <= 60 (default TTL).
    assert 0 < status["seconds_remaining"] <= 60

    # 3) Fire a catch-all ADD event directly through the handler
    # (simulates the real ESP8266 push). Same conn + db_lock as the
    # adapter, so the row the interceptor consumes is visible to the
    # HTTP status endpoint afterwards.
    resp, http_status = handler.handle_scale_event({
        "ts": "2026-04-18T09:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 175.0,
        "before_weight_g": 0.0,
        "after_weight_g": 175.0,
    })
    assert http_status == 200
    assert resp.get("tare_captured") is True

    # 4) Status now unarmed.
    r = client.get("/api/tare/status")
    assert r.status_code == 200
    status = r.get_json()
    assert status["armed"] is False
    assert status["product_id"] is None

    # 5) Product row has the captured tare.
    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g == pytest.approx(175.0)


def test_tare_arm_rejects_noncertified_product(tmp_path):
    """POST to /tare/arm for a non-certified product returns 400
    (UI-side the button isn't rendered for non-certified rows, so this
    protects against stale-page submits)."""
    from server.storage import repo as storage_repo
    from server.storage.models import ProductIn

    app, adapter, handler, conn = _make_taretest_app(tmp_path)
    client = app.test_client()

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Not Certified",
            barcode="nc-1",
            unit_type="solid",
            container_type="jar",
            certified=0,
        ),
    )

    r = client.post(f"/api/product/{product.product_id}/tare/arm")
    assert r.status_code == 400, r.get_data(as_text=True)
    body = r.get_json()
    assert "certified" in body.get("error", "").lower()

    # No arm row created.
    assert storage_repo.get_active_tare_arm(conn) is None


def test_tare_cancel_clears_active_arm(tmp_path):
    """POST /api/tare/cancel drops the active arm row. Second call is
    idempotent (returns deleted=0)."""
    from server.storage import repo as storage_repo
    from server.storage.models import ProductIn

    app, adapter, handler, conn = _make_taretest_app(tmp_path)
    client = app.test_client()

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Cancel Me",
            barcode="cm-1",
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )

    client.post(f"/api/product/{product.product_id}/tare/arm")
    assert storage_repo.get_active_tare_arm(conn) is not None

    r = client.post("/api/tare/cancel")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["deleted"] == 1

    assert storage_repo.get_active_tare_arm(conn) is None

    # Idempotent: second cancel is a no-op.
    r = client.post("/api/tare/cancel")
    assert r.status_code == 200
    assert r.get_json()["deleted"] == 0
