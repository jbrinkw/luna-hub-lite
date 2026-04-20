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
