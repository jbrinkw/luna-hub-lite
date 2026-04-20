"""Integration tests for the intake Flask blueprint.

Uses Flask's test client against a tiny fake :class:`IntakeRepo` and a
stub :class:`CameraSource`. No real filesystem writes outside the tmp_path
fixture, and no real HTTP calls thanks to the ``lookup_fn`` dependency.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

import pytest
from flask import Flask

from server.intake.ai_tare import (
    AiTareApiError,
    AiTareMalformedOutput,
    AiTareUnavailable,
)
from server.intake.models import AiTareProductForm, IntakeRepo, OffProduct, TareEstimate
from server.intake.routes import create_blueprint
from server.storage.models import (
    Lot,
    LotIn,
    Product,
    ProductIn,
    ProductReferenceImage,
    ProductReferenceImageIn,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class FakeRepo:
    """Minimal in-memory repo implementing the :class:`IntakeRepo` protocol."""

    products_created: List[ProductIn] = field(default_factory=list)
    ref_images_created: List[ProductReferenceImageIn] = field(default_factory=list)
    lots_created: List[LotIn] = field(default_factory=list)
    next_product_id: str = "prod-001"
    next_lot_id: str = "lot-001"
    next_image_id_seq: int = 0

    def create_product(self, data: ProductIn) -> Product:
        self.products_created.append(data)
        return Product(
            product_id=self.next_product_id,
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

    def create_product_reference_image(
        self, data: ProductReferenceImageIn
    ) -> ProductReferenceImage:
        self.ref_images_created.append(data)
        self.next_image_id_seq += 1
        return ProductReferenceImage(
            image_id=f"img-{self.next_image_id_seq:03d}",
            product_id=data.product_id,
            file_path=data.file_path,
            captured_at="2026-04-15T12:00:00Z",
            angle=data.angle,
        )

    def create_lot(self, data: LotIn) -> Lot:
        self.lots_created.append(data)
        return Lot(
            lot_id=self.next_lot_id,
            product_id=data.product_id,
            status=data.status,
            total_consumed_g=data.total_consumed_g,
            placed_at="2026-04-15T12:00:00Z",
            last_seen_at="2026-04-15T12:00:00Z",
            current_weight_g=data.current_weight_g,
            initial_weight_g=data.initial_weight_g,
            last_out_at=data.last_out_at,
            notes=data.notes,
        )


class FakeCamera:
    """Stub satisfying the :class:`CameraSource` protocol."""

    def __init__(self, frame: bytes = b"\xff\xd8\xff\xe0fake-jpeg-bytes"):
        self._frame = frame
        self.calls = 0

    def current_frame_jpeg(self) -> bytes:
        self.calls += 1
        return self._frame


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_repo() -> FakeRepo:
    return FakeRepo()


@pytest.fixture
def fake_camera() -> FakeCamera:
    return FakeCamera()


@pytest.fixture
def refs_root(tmp_path) -> Path:
    return tmp_path / "refs"


@pytest.fixture
def lookup_stub():
    calls: List[str] = []

    def _fn(barcode: str) -> OffProduct:
        calls.append(barcode)
        if barcode == "0000000000000":
            return OffProduct(barcode=barcode, found=False)
        return OffProduct(
            barcode=barcode,
            product_name="Mocked Ketchup",
            brands="MockBrand",
            product_quantity_g=340.0,
            serving_quantity_g=17.0,
            packaging_info="Plastic bottle",
            found=True,
        )

    _fn.calls = calls  # type: ignore[attr-defined]
    return _fn


@pytest.fixture
def ai_tare_stub():
    """Returns a callable matching :func:`ai_tare.estimate` plus a call log.

    Tests set ``stub.behavior = <callable>`` to override per-case behavior
    (e.g. raise AiTareUnavailable, return a different estimate).
    """

    class _Stub:
        def __init__(self) -> None:
            self.calls: List[dict] = []
            # Default behavior: return a canned TareEstimate.
            self.behavior = self._default

        def _default(
            self,
            *,
            ref_image_paths,
            product_form,
            measured_gross_g=None,
            is_partial=None,
            thinking_budget_tokens=0,
        ):
            return (
                TareEstimate(
                    tare_weight_g=175.0,
                    confidence="medium",
                    appears_sealed=True,
                    reasoning="Standard glass jar with metal lid.",
                ),
                "claude-opus-4-6",
                3000,
            )

        def __call__(self, **kwargs):
            self.calls.append(kwargs)
            return self.behavior(**kwargs)

    return _Stub()


@pytest.fixture
def app(fake_repo, fake_camera, refs_root, lookup_stub, ai_tare_stub) -> Flask:
    app = Flask(__name__)
    bp = create_blueprint(
        repo=fake_repo,
        camera=fake_camera,
        refs_root=refs_root,
        lookup_fn=lookup_stub,
        ai_tare_fn=ai_tare_stub,
    )
    app.register_blueprint(bp)
    app.testing = True
    return app


@pytest.fixture
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# /intake HTML
# ---------------------------------------------------------------------------


def test_intake_page_renders_with_temp_id(client):
    resp = client.get("/intake")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "product intake" in html
    # The HTML embeds the temp_id in a JS binding; just confirm a UUID
    # literal made it into the page. Declaration switched from const to
    # let so resetIntakeForm() can reassign after a successful save
    # (multi-item intake workflow).
    assert 'let TEMP_ID = "' in html


# ---------------------------------------------------------------------------
# /api/intake/lookup
# ---------------------------------------------------------------------------


def test_lookup_valid_barcode_returns_off_payload(client, lookup_stub):
    resp = client.post(
        "/api/intake/lookup",
        json={"barcode": "3017620422003"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["off"]["found"] is True
    assert body["off"]["product_name"] == "Mocked Ketchup"
    assert body["off"]["brands"] == "MockBrand"
    assert lookup_stub.calls == ["3017620422003"]


def test_lookup_404_returns_not_found_off(client):
    resp = client.post("/api/intake/lookup", json={"barcode": "0000000000000"})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["off"]["found"] is False
    assert body["off"]["barcode"] == "0000000000000"


def test_lookup_rejects_short_barcode(client):
    resp = client.post("/api/intake/lookup", json={"barcode": "123"})
    assert resp.status_code == 400
    assert "6-14 digits" in resp.get_json()["error"]


def test_lookup_rejects_alphabetic_barcode(client):
    resp = client.post("/api/intake/lookup", json={"barcode": "abc123def"})
    assert resp.status_code == 400


def test_lookup_rejects_missing_body(client):
    resp = client.post("/api/intake/lookup", data="")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /api/intake/capture-ref
# ---------------------------------------------------------------------------


def test_capture_ref_saves_frame_to_disk(
    client, fake_camera, refs_root
):
    temp_id = str(uuid.uuid4())
    resp = client.post("/api/intake/capture-ref", json={"temp_id": temp_id})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["temp_id"] == temp_id
    assert body["index"] == 1
    assert body["image_id"] == f"{temp_id}/1"

    saved = refs_root / temp_id / "1.jpg"
    assert saved.exists()
    assert saved.read_bytes() == fake_camera._frame
    assert fake_camera.calls == 1


def test_capture_ref_increments_index_per_session(client):
    temp_id = str(uuid.uuid4())
    for expected_idx in (1, 2, 3):
        resp = client.post("/api/intake/capture-ref", json={"temp_id": temp_id})
        assert resp.status_code == 200
        assert resp.get_json()["index"] == expected_idx


def test_capture_ref_isolates_sessions_by_temp_id(client, refs_root):
    a = str(uuid.uuid4())
    b = str(uuid.uuid4())
    client.post("/api/intake/capture-ref", json={"temp_id": a})
    client.post("/api/intake/capture-ref", json={"temp_id": a})
    client.post("/api/intake/capture-ref", json={"temp_id": b})

    assert (refs_root / a).exists()
    assert (refs_root / b).exists()
    assert len(list((refs_root / a).iterdir())) == 2
    assert len(list((refs_root / b).iterdir())) == 1


def test_capture_ref_rejects_bad_temp_id(client):
    resp = client.post("/api/intake/capture-ref", json={"temp_id": "not-a-uuid"})
    assert resp.status_code == 400
    assert "UUID" in resp.get_json()["error"]


def test_capture_ref_rejects_path_traversal_as_bad_temp_id(client, refs_root):
    # A relative-path style value must be refused — defense in depth
    resp = client.post(
        "/api/intake/capture-ref", json={"temp_id": "../../etc"}
    )
    assert resp.status_code == 400
    # No directories created outside the refs_root
    assert not (refs_root / "..").exists() or refs_root.parent.exists()


def test_capture_ref_handles_empty_frame(client, app, fake_camera):
    fake_camera._frame = b""
    resp = client.post(
        "/api/intake/capture-ref", json={"temp_id": str(uuid.uuid4())}
    )
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# /api/intake/save
# ---------------------------------------------------------------------------


def test_save_creates_product_and_references_no_lot(
    client, fake_repo, refs_root
):
    """Intake is catalog-level: product + reference images only.

    Lots are created later by the scale + classifier pipeline when a unit
    is actually placed on a live shelf.
    """
    temp_id = str(uuid.uuid4())
    # Capture two images first
    r1 = client.post("/api/intake/capture-ref", json={"temp_id": temp_id})
    r2 = client.post("/api/intake/capture-ref", json={"temp_id": temp_id})
    paths = [r1.get_json()["file_path"], r2.get_json()["file_path"]]

    payload = {
        "name": "Heinz Ketchup",
        "barcode": "3017620422003",
        "brand": "Heinz",
        "variant": "classic",
        "net_weight_g": 340.0,
        "gross_weight_g": 380.0,
        "serving_weight_g": 17.0,
        "unit_type": "liquid",
        "container_type": "bottle",
        "temp_id": temp_id,
        "image_paths": paths,
    }
    resp = client.post("/api/intake/save", json=payload)
    assert resp.status_code == 200
    body = resp.get_json()

    assert body["product_id"] == "prod-001"
    assert body["lot_id"] is None  # no lot created at intake
    assert len(body["reference_image_ids"]) == 2

    # Product row created once with merged values
    assert len(fake_repo.products_created) == 1
    p = fake_repo.products_created[0]
    assert p.name == "Heinz Ketchup"
    assert p.net_weight_g == pytest.approx(340.0)
    assert p.gross_weight_g == pytest.approx(380.0)
    assert p.tare_weight_g == pytest.approx(40.0)  # derived
    assert p.unit_type == "liquid"
    assert p.container_type == "bottle"
    assert p.certified == 1

    # Reference images: one per captured path
    assert len(fake_repo.ref_images_created) == 2
    assert fake_repo.ref_images_created[0].product_id == "prod-001"
    assert fake_repo.ref_images_created[0].file_path in paths

    # NO lot created — that's now the scale pipeline's job.
    assert len(fake_repo.lots_created) == 0


def test_save_rejects_missing_name(client):
    resp = client.post("/api/intake/save", json={"name": ""})
    assert resp.status_code == 400
    assert "name is required" in resp.get_json()["error"]


def test_save_rejects_bad_unit_type(client):
    resp = client.post(
        "/api/intake/save", json={"name": "X", "unit_type": "plasma"}
    )
    assert resp.status_code == 400


def test_save_rejects_gross_less_than_net(client):
    resp = client.post(
        "/api/intake/save",
        json={"name": "X", "net_weight_g": 500, "gross_weight_g": 300},
    )
    assert resp.status_code == 400


def test_save_accepts_no_images(client, fake_repo):
    resp = client.post(
        "/api/intake/save",
        json={"name": "Custom thing", "gross_weight_g": 150.0, "image_paths": []},
    )
    assert resp.status_code == 200
    assert fake_repo.ref_images_created == []
    # No lot created at intake — it's catalog-only now.
    assert len(fake_repo.lots_created) == 0


def test_save_ignores_unknown_keys(client, fake_repo):
    resp = client.post(
        "/api/intake/save",
        json={
            "name": "X",
            "not_a_field": "whatever",
            "gross_weight_g": 100.0,
        },
    )
    assert resp.status_code == 200
    # Product still created with the known fields
    assert fake_repo.products_created[0].name == "X"
    assert fake_repo.products_created[0].gross_weight_g == pytest.approx(100.0)


def test_save_non_object_body_rejected(client):
    resp = client.post(
        "/api/intake/save",
        data=json.dumps([1, 2, 3]),
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_save_blank_optional_strings_treated_as_none(client, fake_repo):
    resp = client.post(
        "/api/intake/save",
        json={
            "name": "X",
            "brand": "   ",  # whitespace
            "variant": "",
            "gross_weight_g": 100.0,
        },
    )
    assert resp.status_code == 200
    p = fake_repo.products_created[0]
    assert p.brand is None
    assert p.variant is None


# ---------------------------------------------------------------------------
# /api/intake/ai-tare
# ---------------------------------------------------------------------------


def _seed_ref_images(client, temp_id: str, n: int = 2) -> list[str]:
    """Capture ``n`` reference images for the given temp_id.

    Returns the list of relative paths reported by the capture endpoint.
    """

    paths: list[str] = []
    for _ in range(n):
        resp = client.post("/api/intake/capture-ref", json={"temp_id": temp_id})
        assert resp.status_code == 200
        paths.append(resp.get_json()["file_path"])
    return paths


def test_ai_tare_happy_path_returns_estimate_and_derived(
    client, ai_tare_stub
):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=2)

    payload = {
        "temp_id": temp_id,
        "ref_image_paths": paths,
        "product_form": {
            "name": "Heinz Ketchup",
            "brand": "Heinz",
            "net_weight_g": 340,
            "serving_weight_g": 17,
            "unit_type": "liquid",
            "container_type": "bottle",
        },
        "measured_gross_g": 510.5,
        "is_partial": False,
    }
    resp = client.post("/api/intake/ai-tare", json=payload)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["tare_weight_g"] == 175.0
    assert body["confidence"] == "medium"
    assert body["appears_sealed"] is True
    assert body["model"] == "claude-opus-4-6"
    assert body["thinking_budget_tokens"] == 3000
    assert body["reasoning"].startswith("Standard glass jar")
    # derived = gross - net
    assert body["derived_tare_g"] == pytest.approx(170.5)

    # Stub was called with parsed form + resolved absolute image paths
    assert len(ai_tare_stub.calls) == 1
    call = ai_tare_stub.calls[0]
    assert isinstance(call["product_form"], AiTareProductForm)
    assert call["product_form"].name == "Heinz Ketchup"
    assert call["product_form"].net_weight_g == 340
    assert call["measured_gross_g"] == 510.5
    assert call["is_partial"] is False
    assert len(call["ref_image_paths"]) == 2
    # Paths resolved to absolute under refs_root
    for path in call["ref_image_paths"]:
        assert Path(path).is_absolute()
        assert Path(path).is_file()


def test_ai_tare_omits_derived_when_gross_missing(client, ai_tare_stub):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {"name": "Thing", "net_weight_g": 100},
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["derived_tare_g"] is None


def test_ai_tare_omits_derived_when_net_missing(client, ai_tare_stub):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {"name": "Thing"},
            "measured_gross_g": 200.0,
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["derived_tare_g"] is None


def test_ai_tare_rejects_bad_temp_id(client):
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": "nope", "ref_image_paths": ["x"]},
    )
    assert resp.status_code == 400
    assert "UUID" in resp.get_json()["error"]


def test_ai_tare_rejects_missing_ref_images(client):
    temp_id = str(uuid.uuid4())
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": temp_id, "ref_image_paths": []},
    )
    assert resp.status_code == 400


def test_ai_tare_rejects_non_string_ref_paths(client):
    temp_id = str(uuid.uuid4())
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": temp_id, "ref_image_paths": [123]},
    )
    assert resp.status_code == 400


def test_ai_tare_rejects_path_traversal(client, refs_root):
    temp_id = str(uuid.uuid4())
    # Create the refs_root so resolve() succeeds, then try to escape it.
    refs_root.mkdir(parents=True, exist_ok=True)
    outside = refs_root.parent / "outside.jpg"
    outside.write_bytes(b"x")
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": [str(outside)],
        },
    )
    assert resp.status_code == 400
    assert "refs_root" in resp.get_json()["error"]


def test_ai_tare_rejects_missing_file(client):
    temp_id = str(uuid.uuid4())
    # Looks legitimate (relative to refs_root) but not actually captured.
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": [f"{temp_id}/99.jpg"],
        },
    )
    assert resp.status_code == 400
    assert "does not exist" in resp.get_json()["error"]


def test_ai_tare_rejects_non_object_body(client):
    resp = client.post(
        "/api/intake/ai-tare",
        data=json.dumps([1, 2]),
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_ai_tare_rejects_bad_measured_gross(client):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "measured_gross_g": "oops",
        },
    )
    assert resp.status_code == 400


def test_ai_tare_rejects_bad_is_partial(client):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "is_partial": "yes",
        },
    )
    assert resp.status_code == 400


def test_ai_tare_unavailable_returns_503(client, ai_tare_stub):
    def _boom(**kwargs):
        raise AiTareUnavailable("ANTHROPIC_API_KEY is not set")

    ai_tare_stub.behavior = _boom
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": temp_id, "ref_image_paths": paths},
    )
    assert resp.status_code == 503
    assert "ANTHROPIC_API_KEY" in resp.get_json()["error"]


def test_ai_tare_malformed_returns_502(client, ai_tare_stub):
    def _boom(**kwargs):
        raise AiTareMalformedOutput("Invalid JSON: unexpected token")

    ai_tare_stub.behavior = _boom
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": temp_id, "ref_image_paths": paths},
    )
    assert resp.status_code == 502
    assert "malformed" in resp.get_json()["error"].lower()


def test_ai_tare_api_error_returns_502(client, ai_tare_stub):
    def _boom(**kwargs):
        raise AiTareApiError("Anthropic API error: RateLimit: slow down")

    ai_tare_stub.behavior = _boom
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={"temp_id": temp_id, "ref_image_paths": paths},
    )
    assert resp.status_code == 502


def test_ai_tare_ignores_unknown_form_keys(client, ai_tare_stub):
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {
                "name": "Custom",
                "not_a_field": "ignored",
            },
        },
    )
    assert resp.status_code == 200
    form_sent = ai_tare_stub.calls[0]["product_form"]
    assert form_sent.name == "Custom"


def test_ai_tare_forwards_thinking_budget_tokens(client, ai_tare_stub):
    """Opus+thinking path must be reachable via the HTTP route."""
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {"name": "Thing"},
            "thinking_budget_tokens": 3000,
        },
    )
    assert resp.status_code == 200
    assert ai_tare_stub.calls[0]["thinking_budget_tokens"] == 3000


def test_ai_tare_caps_thinking_budget_tokens(client, ai_tare_stub):
    """Values above the 8000 safety cap are clamped."""
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {"name": "Thing"},
            "thinking_budget_tokens": 999999,
        },
    )
    assert resp.status_code == 200
    assert ai_tare_stub.calls[0]["thinking_budget_tokens"] == 8000


def test_ai_tare_invalid_thinking_budget_defaults_to_zero(client, ai_tare_stub):
    """Garbage values coerce to the safe default of 0 (Sonnet, no thinking)."""
    temp_id = str(uuid.uuid4())
    paths = _seed_ref_images(client, temp_id, n=1)
    resp = client.post(
        "/api/intake/ai-tare",
        json={
            "temp_id": temp_id,
            "ref_image_paths": paths,
            "product_form": {"name": "Thing"},
            "thinking_budget_tokens": "not-a-number",
        },
    )
    assert resp.status_code == 200
    assert ai_tare_stub.calls[0]["thinking_budget_tokens"] == 0


# ---------------------------------------------------------------------------
# /api/intake/seeds
# ---------------------------------------------------------------------------


@pytest.fixture
def seeds_dir_override(monkeypatch, tmp_path):
    """Point the seeds endpoint at an isolated tmp directory.

    The route computes ``seeds_dir`` as ``Path(__file__).resolve().parent.parent
    / "scripts" / "demo_seeds"``. We monkeypatch the module's ``__file__``
    to a path whose grandparent is ``tmp_path`` so ``seeds_dir`` lands under
    ``tmp_path/scripts/demo_seeds`` — no production seeds involved.
    """

    from server.intake import routes as routes_module

    fake_pkg = tmp_path / "pkg" / "intake"
    fake_pkg.mkdir(parents=True)
    fake_module_file = fake_pkg / "routes.py"
    fake_module_file.write_text("")
    seeds_dir = tmp_path / "pkg" / "scripts" / "demo_seeds"
    seeds_dir.mkdir(parents=True)

    monkeypatch.setattr(routes_module, "__file__", str(fake_module_file))
    return seeds_dir


def test_seeds_excludes_entries_without_barcode(client, seeds_dir_override, caplog):
    """Seeds with missing/empty barcode are filtered — dropdown value="" clash."""
    good = {
        "barcode": "012345678905",
        "form_suggested": {"name": "Good Seed", "brand": "B"},
    }
    missing = {
        "form_suggested": {"name": "No Barcode"},
    }
    empty = {
        "barcode": "",
        "form_suggested": {"name": "Empty Barcode"},
    }
    null_bc = {
        "barcode": None,
        "form_suggested": {"name": "Null Barcode"},
    }
    (seeds_dir_override / "good.json").write_text(json.dumps(good))
    (seeds_dir_override / "missing.json").write_text(json.dumps(missing))
    (seeds_dir_override / "empty.json").write_text(json.dumps(empty))
    (seeds_dir_override / "null.json").write_text(json.dumps(null_bc))

    import logging

    with caplog.at_level(logging.WARNING, logger="server.intake.routes"):
        resp = client.get("/api/intake/seeds")

    assert resp.status_code == 200
    seeds = resp.get_json()["seeds"]
    barcodes = [s["barcode"] for s in seeds]
    assert barcodes == ["012345678905"]
    # All three malformed entries were logged.
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("missing or empty barcode" in m for m in warnings)


# ---------------------------------------------------------------------------
# Protocol conformance
# ---------------------------------------------------------------------------


def test_fakerepo_satisfies_intakerepo_protocol():
    # Protocol is runtime_checkable — sanity-check that the fake conforms.
    assert isinstance(FakeRepo(), IntakeRepo)


def test_fakecamera_satisfies_camerasource_protocol():
    from server.intake.models import CameraSource

    assert isinstance(FakeCamera(), CameraSource)


# ---------------------------------------------------------------------------
# Cloud-mode intake (PROD_MIGRATION_PLAN.md §5)
# ---------------------------------------------------------------------------


class FakeCloudClient:
    """Stub that mimics :class:`server.cloud.client.CloudClient`'s surface.

    Tests set ``post_behavior`` to return a dict, raise a CloudError, or
    raise a requests exception. ``post_calls`` captures every invocation
    as (path, body) tuples for assertions.
    """

    def __init__(self) -> None:
        self.post_calls: list[tuple[str, dict]] = []
        self.post_behavior = self._default_ok

    def _default_ok(self, path: str, body: dict) -> dict:  # noqa: ARG002
        return {
            "product_id": "cloud-uuid-7777",
            "name": body.get("name"),
            "barcode": body.get("barcode"),
            "brand": body.get("brand"),
            "variant": body.get("variant"),
            "net_weight_g": body.get("net_weight_g"),
            "gross_weight_g": body.get("gross_weight_g"),
            "tare_weight_g": body.get("tare_weight_g"),
            "serving_weight_g": body.get("serving_weight_g"),
            "servings_per_container": body.get("servings_per_container"),
            "unit_type": body.get("unit_type"),
            "density_g_per_ml": body.get("density_g_per_ml"),
            "container_type": body.get("container_type"),
            "certified": True,
        }

    def post(self, path: str, body: dict) -> dict:
        self.post_calls.append((path, dict(body)))
        return self.post_behavior(path, body)

    def get(self, path: str, params=None) -> dict:  # pragma: no cover
        raise AssertionError("intake flow should not call GET")


@pytest.fixture
def fake_cloud_client() -> FakeCloudClient:
    return FakeCloudClient()


@pytest.fixture
def cloud_upsert_spy():
    """Captures calls to the cloud → local cache write-through."""

    calls: list[dict] = []

    def _fn(conn, product: dict, *, db_lock=None):  # noqa: ARG001
        calls.append(dict(product))
        return product.get("product_id")

    _fn.calls = calls  # type: ignore[attr-defined]
    return _fn


@pytest.fixture
def cloud_app(
    fake_repo, fake_camera, refs_root, lookup_stub, ai_tare_stub,
    fake_cloud_client, cloud_upsert_spy,
) -> Flask:
    app = Flask(__name__)
    bp = create_blueprint(
        repo=fake_repo,
        camera=fake_camera,
        refs_root=refs_root,
        lookup_fn=lookup_stub,
        ai_tare_fn=ai_tare_stub,
        cloud_enabled=True,
        cloud_client=fake_cloud_client,
        cloud_upsert_fn=cloud_upsert_spy,
        db_conn=object(),  # sentinel — the upsert stub ignores it
    )
    app.register_blueprint(bp)
    app.testing = True
    return app


@pytest.fixture
def cloud_client_http(cloud_app):
    return cloud_app.test_client()


def test_save_cloud_mode_posts_to_cloud_and_caches_locally(
    cloud_client_http, fake_repo, fake_cloud_client, cloud_upsert_spy
):
    """Happy path: cloud returns UUID, Pi caches it, ref images use it.

    When CLOUD_ENABLED=true the local ``repo.create_product`` must NOT
    fire — the cloud is source of truth and the write-through
    ``cloud_upsert_fn`` populates the local cache instead.
    """
    temp_id = str(uuid.uuid4())
    r1 = cloud_client_http.post(
        "/api/intake/capture-ref", json={"temp_id": temp_id}
    )
    paths = [r1.get_json()["file_path"]]

    payload = {
        "name": "Mustard",
        "barcode": "3017620422010",
        "brand": "Dijon",
        "net_weight_g": 250.0,
        "unit_type": "liquid",
        "container_type": "jar",
        "temp_id": temp_id,
        "image_paths": paths,
    }
    resp = cloud_client_http.post("/api/intake/save", json=payload)
    assert resp.status_code == 200, resp.get_json()
    body = resp.get_json()

    # Response carries the CLOUD-minted UUID, not a Pi-local one.
    assert body["product_id"] == "cloud-uuid-7777"
    assert body["lot_id"] is None
    assert len(body["reference_image_ids"]) == 1

    # Exactly one POST to /intake with the right body.
    assert len(fake_cloud_client.post_calls) == 1
    path, sent_body = fake_cloud_client.post_calls[0]
    assert path == "/intake"
    assert sent_body["name"] == "Mustard"
    assert sent_body["barcode"] == "3017620422010"
    assert sent_body["unit_type"] == "liquid"
    # None-valued fields were stripped before sending.
    assert "density_g_per_ml" not in sent_body

    # Local products table was NOT written via the repo in cloud mode —
    # the cache path goes through cloud_upsert_fn instead.
    assert fake_repo.products_created == []

    # The write-through cache received the full cloud row.
    assert len(cloud_upsert_spy.calls) == 1
    assert cloud_upsert_spy.calls[0]["product_id"] == "cloud-uuid-7777"
    assert cloud_upsert_spy.calls[0]["name"] == "Mustard"

    # Reference image row created under the cloud UUID, not some local one.
    assert len(fake_repo.ref_images_created) == 1
    assert fake_repo.ref_images_created[0].product_id == "cloud-uuid-7777"


def test_save_cloud_mode_forwards_macro_fields_to_cloud(
    cloud_client_http, fake_cloud_client
):
    """Regression: the Pi must forward user-captured macros to the cloud.

    Previously the _post_intake_to_cloud payload dropped
    calories_per_serving / carbs_per_serving / protein_per_serving /
    fat_per_serving on the floor — meaning intake flows that asked the
    user for macros silently lost them once cloud mode was enabled.
    This test asserts all four macro fields end up in the POST body
    exactly as captured.
    """
    temp_id = str(uuid.uuid4())
    r1 = cloud_client_http.post(
        "/api/intake/capture-ref", json={"temp_id": temp_id}
    )
    paths = [r1.get_json()["file_path"]]

    payload = {
        "name": "Peanut Butter",
        "barcode": "0051500255551",
        "brand": "Jif",
        "net_weight_g": 454.0,
        "unit_type": "solid",
        "container_type": "jar",
        "servings_per_container": 14,
        "serving_weight_g": 32.0,
        "calories_per_serving": 190.0,
        "carbs_per_serving": 8.0,
        "protein_per_serving": 7.0,
        "fat_per_serving": 16.0,
        "description": "Creamy peanut butter.",
        "temp_id": temp_id,
        "image_paths": paths,
    }
    resp = cloud_client_http.post("/api/intake/save", json=payload)
    assert resp.status_code == 200, resp.get_json()

    assert len(fake_cloud_client.post_calls) == 1
    path, sent_body = fake_cloud_client.post_calls[0]
    assert path == "/intake"

    # All four macro fields must be present AND carry the exact values
    # the user captured — otherwise the cloud row silently lands
    # with null macros.
    assert sent_body.get("calories_per_serving") == 190.0
    assert sent_body.get("carbs_per_serving") == 8.0
    assert sent_body.get("protein_per_serving") == 7.0
    assert sent_body.get("fat_per_serving") == 16.0
    assert sent_body.get("description") == "Creamy peanut butter."
    # Mutation-testing gap: ``certified`` was previously un-asserted in
    # the cloud POST body. Dropping it silently would ship every
    # user-captured intake with certified=NULL on the cloud — losing
    # the "user confirmed this" signal that the intake flow was
    # designed to produce (profile_builder sets certified=1).
    assert sent_body.get("certified") is True, (
        "intake flow sets certified=1 in profile_builder; the POST "
        "body must forward that flag (as bool True) or the cloud "
        "stores a null-certified row"
    )


def test_save_cloud_mode_returns_503_on_cloud_error_5xx(
    cloud_client_http, fake_repo, fake_cloud_client, cloud_upsert_spy, refs_root
):
    """Cloud 5xx → user-facing 503, no local write, no ref images."""
    from server.cloud.client import CloudError

    def _boom(path, body):  # noqa: ARG001
        raise CloudError(503, "supabase edge timeout")

    fake_cloud_client.post_behavior = _boom

    temp_id = str(uuid.uuid4())
    r1 = cloud_client_http.post(
        "/api/intake/capture-ref", json={"temp_id": temp_id}
    )
    paths = [r1.get_json()["file_path"]]
    resp = cloud_client_http.post(
        "/api/intake/save",
        json={
            "name": "Thing",
            "net_weight_g": 100.0,
            "temp_id": temp_id,
            "image_paths": paths,
        },
    )
    assert resp.status_code == 503
    assert "cloud" in resp.get_json()["error"].lower()

    # No product was cached, no ref image row was written.
    assert fake_repo.products_created == []
    assert fake_repo.ref_images_created == []
    assert cloud_upsert_spy.calls == []

    # The ref image files on disk from capture-ref are still there —
    # that's intentional (they were captured before save). We only verify
    # the DB side didn't write.


def test_save_cloud_mode_returns_400_on_cloud_error_4xx(
    cloud_client_http, fake_repo, fake_cloud_client, cloud_upsert_spy
):
    """Cloud 4xx (user-visible validation error) → surface as 4xx.

    4xx means the user's input was rejected (e.g. duplicate barcode on
    cloud side). Unlike 5xx we don't promote to 503, we forward the
    original status so the UI can show "fix your input".
    """
    from server.cloud.client import CloudError

    def _boom(path, body):  # noqa: ARG001
        raise CloudError(409, "barcode already exists")

    fake_cloud_client.post_behavior = _boom

    resp = cloud_client_http.post(
        "/api/intake/save",
        json={"name": "Thing", "barcode": "111111111111"},
    )
    assert resp.status_code == 409
    assert fake_repo.products_created == []
    assert cloud_upsert_spy.calls == []


def test_save_cloud_mode_returns_503_on_network_error(
    cloud_client_http, fake_repo, fake_cloud_client, cloud_upsert_spy
):
    """Network failure (timeout, DNS, TCP reset) → 503.

    The route must catch ``requests.exceptions.RequestException`` in
    addition to ``CloudError`` — the client only translates non-2xx
    HTTP responses, network failures bubble as raw requests exceptions.
    """
    import requests

    def _boom(path, body):  # noqa: ARG001
        raise requests.exceptions.ConnectTimeout("wifi went down")

    fake_cloud_client.post_behavior = _boom

    resp = cloud_client_http.post(
        "/api/intake/save",
        json={"name": "Thing"},
    )
    assert resp.status_code == 503
    assert "unreachable" in resp.get_json()["error"].lower()
    assert fake_repo.products_created == []
    assert cloud_upsert_spy.calls == []


def test_save_cloud_mode_502_when_response_missing_product_id(
    cloud_client_http, fake_repo, fake_cloud_client
):
    """Malformed cloud response (no product_id) is a server-side bug,
    not a user error — surface as 502 Bad Gateway."""
    fake_cloud_client.post_behavior = lambda path, body: {"name": "Thing"}

    resp = cloud_client_http.post(
        "/api/intake/save",
        json={"name": "Thing"},
    )
    assert resp.status_code == 502
    assert "product_id" in resp.get_json()["error"]
    assert fake_repo.products_created == []


def test_save_cloud_mode_survives_cache_upsert_failure(
    fake_repo, fake_cloud_client, tmp_path
):
    """Local cache failure must NOT fail the user's intake.

    The cloud already has the source of truth; a failed cache write is
    self-healing on the next ``fetch_catalog``. We log and move on.
    """
    def _boom(conn, product, *, db_lock=None):  # noqa: ARG001
        raise RuntimeError("disk full")

    app = Flask(__name__)
    bp = create_blueprint(
        repo=fake_repo,
        camera=FakeCamera(),
        refs_root=tmp_path / "refs",
        lookup_fn=lambda bc: OffProduct(barcode=bc, found=False),
        ai_tare_fn=lambda **k: None,  # noqa: ARG005
        cloud_enabled=True,
        cloud_client=fake_cloud_client,
        cloud_upsert_fn=_boom,
        db_conn=object(),
    )
    app.register_blueprint(bp)
    app.testing = True
    c = app.test_client()

    resp = c.post("/api/intake/save", json={"name": "Thing"})
    assert resp.status_code == 200
    assert resp.get_json()["product_id"] == "cloud-uuid-7777"


def test_save_cloud_mode_rejects_bad_image_paths_before_posting(
    cloud_client_http, fake_cloud_client, fake_repo, refs_root
):
    """Path-traversal in image_paths must be caught BEFORE the cloud POST.

    Otherwise we'd create a cloud product row for a request we're going
    to reject — ending with orphan rows on the cloud side.
    """
    refs_root.mkdir(parents=True, exist_ok=True)
    outside = refs_root.parent / "escape.jpg"
    outside.write_bytes(b"x")

    resp = cloud_client_http.post(
        "/api/intake/save",
        json={"name": "Thing", "image_paths": [str(outside)]},
    )
    assert resp.status_code == 400
    # Cloud NEVER saw this request.
    assert fake_cloud_client.post_calls == []
    assert fake_repo.products_created == []


def test_save_local_mode_unchanged_when_cloud_disabled(
    client, fake_repo, lookup_stub
):
    """Regression: CLOUD_ENABLED=false → today's byte-for-byte behavior.

    This is the same test as ``test_save_creates_product_and_references_no_lot``
    but framed as a cloud-off regression — it guards against any of the
    cloud-mode refactor accidentally leaking into the default path.
    """
    payload = {
        "name": "Ketchup",
        "barcode": "1234567890123",
        "net_weight_g": 340.0,
        "unit_type": "liquid",
    }
    resp = client.post("/api/intake/save", json=payload)
    assert resp.status_code == 200
    body = resp.get_json()
    # Local UUID, not a cloud one.
    assert body["product_id"] == "prod-001"
    # Direct repo call happened.
    assert len(fake_repo.products_created) == 1
    assert fake_repo.products_created[0].name == "Ketchup"


def test_create_blueprint_rejects_cloud_without_client():
    """Misconfiguration guard — cloud_enabled=True + no client = raise."""
    with pytest.raises(ValueError, match="cloud_client"):
        create_blueprint(
            repo=FakeRepo(),
            camera=FakeCamera(),
            refs_root="/tmp/refs",
            cloud_enabled=True,
        )


def test_create_blueprint_rejects_cloud_without_db_conn():
    """Misconfiguration guard — cloud_enabled=True + no db_conn = raise."""
    with pytest.raises(ValueError, match="db_conn"):
        create_blueprint(
            repo=FakeRepo(),
            camera=FakeCamera(),
            refs_root="/tmp/refs",
            cloud_enabled=True,
            cloud_client=FakeCloudClient(),
        )
