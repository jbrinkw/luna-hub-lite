"""Flask blueprint for the intake wizard.

Three API routes plus the HTML wizard page:

* ``GET  /intake``                  — wizard HTML (served from the
                                       ``templates/`` dir of the caller;
                                       the blueprint registers the template
                                       folder relative to
                                       :mod:`server.web.templates`)
* ``POST /api/intake/lookup``       — barcode → OFF data
* ``POST /api/intake/capture-ref``  — grab the current camera frame, save as
                                       a reference image on disk
* ``POST /api/intake/save``         — create product + reference images +
                                       initial on-shelf lot

Everything that talks to storage or the camera goes through the
:class:`IntakeRepo` and :class:`CameraSource` protocols so the blueprint
stays testable in isolation.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from flask import Blueprint, Response, current_app, jsonify, render_template, request

from ..storage.models import ProductIn, ProductReferenceImageIn
from . import ai_tare as ai_tare_module
from . import cloud_sync as cloud_sync_module
from . import off_lookup as off_lookup_module
from .ai_tare import (
    AiTareApiError,
    AiTareMalformedOutput,
    AiTareUnavailable,
)
from .models import (
    AiTareProductForm,
    AiTareRequest,
    AiTareResponse,
    CameraSource,
    CaptureRefResponse,
    IntakeForm,
    IntakeRepo,
    LookupResponse,
    OffProduct,
    SaveResponse,
)
from .profile_builder import IntakeValidationError, merge_off_and_form

# Local import guard — ``requests`` is already a transitive dependency of
# ``server.cloud.client`` but this module may be imported in a test
# context where cloud is unavailable. Falling back to a stub sentinel
# keeps the except-clause's type reference valid without forcing an
# import at module load.
try:  # pragma: no cover - import is exercised via the main app path
    import requests as _requests_module
    _RequestException: type[Exception] = _requests_module.exceptions.RequestException
except ImportError:  # pragma: no cover - defensive only
    class _RequestException(Exception):  # type: ignore[no-redef]
        pass

try:
    from ..cloud import CloudError as _CloudError
except ImportError:  # pragma: no cover - defensive only
    class _CloudError(Exception):  # type: ignore[no-redef]
        pass

log = logging.getLogger(__name__)

# Barcodes: 6-14 digits is the real world range (UPC-E, UPC-A, EAN-8/13, ITF-14).
_BARCODE_RE = re.compile(r"^[0-9]{6,14}$")

# temp_id is a server-minted UUID; anything else is rejected to prevent path
# traversal when used as a directory name.
_TEMP_ID_RE = re.compile(r"^[0-9a-f\-]{36}$")


# ---------------------------------------------------------------------------
# Blueprint factory
# ---------------------------------------------------------------------------


def create_blueprint(
    *,
    repo: IntakeRepo,
    camera: CameraSource,
    refs_root: Path | str,
    lookup_fn: Optional[Callable[[str], OffProduct]] = None,
    template_folder: Optional[str] = None,
    ai_tare_fn: Optional[Callable[..., Any]] = None,
    cloud_enabled: bool = False,
    cloud_client: Optional[Any] = None,
    cloud_upsert_fn: Optional[Callable[..., Optional[str]]] = None,
    db_conn: Optional[Any] = None,
    db_lock: Optional[Any] = None,
) -> Blueprint:
    """Build a Flask blueprint with the dependencies baked in.

    Parameters
    ----------
    repo:
        An object satisfying :class:`IntakeRepo`. The three DB writes the
        wizard needs go through this.
    camera:
        An object satisfying :class:`CameraSource`. Used by the
        :code:`capture-ref` route to grab the current frame as JPEG bytes.
    refs_root:
        Filesystem root under which intake reference images are stored.
        Each intake session creates a directory ``<refs_root>/<temp_id>/``
        on first capture and drops numbered files (``1.jpg``, ``2.jpg``, …)
        inside.
    lookup_fn:
        Injectable OpenFoodFacts lookup. Defaults to
        :func:`off_lookup.lookup_barcode`. Tests override this with a stub.
    template_folder:
        Override for the Jinja template path. Defaults to the package's
        sibling ``web/templates`` directory.
    cloud_enabled:
        PROD_MIGRATION_PLAN.md §5 feature flag. When True, the save path
        routes product creation through ``POST /shelf-ingest/intake`` on
        the cloud and caches the result locally. When False (default),
        the save path keeps today's fully-local behavior — writes to the
        Pi's ``products`` table via ``repo.create_product``. A standalone
        Pi with ``CLOUD_ENABLED=false`` sees byte-for-byte identical
        behavior to the pre-cloud build.
    cloud_client:
        A configured :class:`~server.cloud.client.CloudClient` (or
        duck-type equivalent). Required when ``cloud_enabled=True``.
    cloud_upsert_fn:
        Injectable cloud-cache write-through. Defaults to
        :func:`cloud_sync.upsert_product_from_cloud`. Tests override
        with a stub.
    db_conn:
        SQLite connection handed to ``cloud_upsert_fn`` for the local
        cache upsert. Required when ``cloud_enabled=True``.
    db_lock:
        Shared DB lock (see :mod:`server.adapters.intake_repo` for why).
        Optional; ``None`` uses a no-op lock.
    """

    refs_root = Path(refs_root).resolve()
    lookup = lookup_fn or off_lookup_module.lookup_barcode
    ai_tare_estimate = ai_tare_fn or ai_tare_module.estimate
    cloud_upsert = cloud_upsert_fn or cloud_sync_module.upsert_product_from_cloud
    template_dir = template_folder or str(
        Path(__file__).resolve().parent.parent / "web" / "templates"
    )

    # Guardrail: if cloud mode is enabled the caller must supply a
    # client + connection. Failing fast here beats a cryptic NoneType
    # AttributeError on the first save.
    if cloud_enabled and cloud_client is None:
        raise ValueError(
            "create_blueprint: cloud_enabled=True requires a cloud_client"
        )
    if cloud_enabled and db_conn is None:
        raise ValueError(
            "create_blueprint: cloud_enabled=True requires db_conn for "
            "the local products cache write-through"
        )

    bp = Blueprint(
        "intake",
        __name__,
        template_folder=template_dir,
    )

    @bp.get("/intake")
    def intake_page() -> Response:
        # The wizard is a single HTML page; client JS drives the step flow
        # against the three API routes below. A server-minted temp_id tracks
        # this in-progress intake across capture-ref calls.
        temp_id = str(uuid.uuid4())
        return render_template("intake.html", temp_id=temp_id)

    @bp.post("/api/intake/lookup")
    def intake_lookup() -> Response:
        payload = request.get_json(silent=True) or {}
        barcode = str(payload.get("barcode", "")).strip()
        if not _BARCODE_RE.match(barcode):
            return _json_error("barcode must be 6-14 digits", 400)

        off = lookup(barcode)
        resp = LookupResponse(off=off)
        return jsonify(_asdict(resp))

    @bp.get("/api/intake/seeds")
    def intake_seeds() -> Response:
        """List pre-baked demo seed profiles (server/scripts/demo_seeds/*.json).

        Returns an array of {barcode, name, brand, form_suggested, notes} so
        the wizard can pre-fill the form in one click without typing the
        barcode or waiting on an OpenFoodFacts round-trip.
        """
        seeds_dir = (
            Path(__file__).resolve().parent.parent / "scripts" / "demo_seeds"
        )
        seeds: list[dict[str, Any]] = []
        if seeds_dir.is_dir():
            for p in sorted(seeds_dir.glob("*.json")):
                try:
                    data = json.loads(p.read_text())
                except Exception as exc:
                    log.warning("skipping unreadable seed %s: %s", p.name, exc)
                    continue
                # Seeds without a barcode render a dropdown option with
                # value="" which collides with the placeholder — skip them.
                if not data.get("barcode"):
                    log.warning(
                        "skipping seed %s: missing or empty barcode", p.name
                    )
                    continue
                form = data.get("form_suggested") or {}
                seeds.append(
                    {
                        "barcode": data.get("barcode"),
                        "name": form.get("name"),
                        "brand": form.get("brand"),
                        "variant": form.get("variant"),
                        "form_suggested": form,
                        "notes": data.get("_notes") or {},
                    }
                )
        return jsonify({"seeds": seeds})

    @bp.post("/api/intake/capture-ref")
    def intake_capture_ref() -> Response:
        payload = request.get_json(silent=True) or {}
        temp_id = str(payload.get("temp_id", "")).strip()
        if not _TEMP_ID_RE.match(temp_id):
            return _json_error("temp_id must be a UUID", 400)

        try:
            frame = camera.current_frame_jpeg()
        except Exception as exc:  # pragma: no cover — defensive
            log.exception("camera failure during intake capture")
            return _json_error(f"camera unavailable: {exc}", 503)

        if not isinstance(frame, (bytes, bytearray)) or len(frame) == 0:
            return _json_error("camera returned empty frame", 503)

        session_dir = refs_root / temp_id
        session_dir.mkdir(parents=True, exist_ok=True)
        # Use a monotonically increasing integer index — the file count in
        # the directory, plus one. The wizard doesn't care about the exact
        # value, just that it's unique within the session.
        existing = sorted(p for p in session_dir.iterdir() if p.suffix == ".jpg")
        index = len(existing) + 1
        file_path = session_dir / f"{index}.jpg"
        file_path.write_bytes(bytes(frame))

        rel_path = str(file_path.relative_to(refs_root))
        resp = CaptureRefResponse(
            image_id=f"{temp_id}/{index}",
            file_path=rel_path,
            temp_id=temp_id,
            index=index,
        )
        return jsonify(_asdict(resp))

    @bp.post("/api/intake/ai-tare")
    def intake_ai_tare() -> Response:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return _json_error("body must be a JSON object", 400)

        temp_id = str(payload.get("temp_id", "")).strip()
        if not _TEMP_ID_RE.match(temp_id):
            return _json_error("temp_id must be a UUID", 400)

        ref_image_paths_in = payload.get("ref_image_paths") or []
        if not isinstance(ref_image_paths_in, list) or not ref_image_paths_in:
            return _json_error(
                "ref_image_paths must be a non-empty list", 400
            )

        # Normalise each path. Values coming from the wizard are *relative*
        # to refs_root (same as what capture-ref returns). Absolute paths are
        # also accepted for scripting.
        absolute_paths: list[str] = []
        for entry in ref_image_paths_in:
            if not isinstance(entry, str) or not entry.strip():
                return _json_error("ref_image_paths entries must be strings", 400)
            candidate = Path(entry)
            if not candidate.is_absolute():
                candidate = refs_root / candidate
            try:
                resolved = candidate.resolve()
                # Defense in depth — make sure the resolved path is under
                # refs_root so a malicious client can't ask the endpoint to
                # base64-encode /etc/shadow.
                resolved.relative_to(refs_root.resolve())
            except (OSError, ValueError):
                return _json_error(
                    f"ref_image_paths entry is not under refs_root: {entry!r}",
                    400,
                )
            if not resolved.is_file():
                return _json_error(
                    f"ref_image_paths entry does not exist: {entry!r}",
                    400,
                )
            absolute_paths.append(str(resolved))

        product_form_raw = payload.get("product_form") or {}
        if not isinstance(product_form_raw, dict):
            return _json_error("product_form must be an object", 400)
        try:
            product_form = _parse_ai_tare_form(product_form_raw)
        except (TypeError, ValueError) as exc:
            return _json_error(f"invalid product_form: {exc}", 400)

        measured_gross_g_raw = payload.get("measured_gross_g")
        measured_gross_g: Optional[float]
        if measured_gross_g_raw is None or measured_gross_g_raw == "":
            measured_gross_g = None
        else:
            try:
                measured_gross_g = float(measured_gross_g_raw)
            except (TypeError, ValueError):
                return _json_error("measured_gross_g must be a number", 400)

        is_partial = payload.get("is_partial")
        if is_partial is not None and not isinstance(is_partial, bool):
            return _json_error("is_partial must be a boolean", 400)

        # Extended thinking is opt-in via a positive budget. Coerce to int
        # with a safety cap (max 8000); default to 0 when missing/invalid so
        # the cheap Sonnet path stays the default.
        thinking_budget_in = payload.get("thinking_budget_tokens", 0)
        try:
            thinking_budget_req = int(thinking_budget_in)
        except (TypeError, ValueError):
            thinking_budget_req = 0
        if thinking_budget_req < 0:
            thinking_budget_req = 0
        if thinking_budget_req > 8000:
            thinking_budget_req = 8000

        try:
            estimate, model_used, thinking_budget = ai_tare_estimate(
                ref_image_paths=absolute_paths,
                product_form=product_form,
                measured_gross_g=measured_gross_g,
                is_partial=is_partial,
                thinking_budget_tokens=thinking_budget_req,
            )
        except AiTareUnavailable as exc:
            return _json_error(str(exc), 503)
        except AiTareMalformedOutput as exc:
            return _json_error(f"model returned malformed output: {exc}", 502)
        except AiTareApiError as exc:
            return _json_error(str(exc), 502)
        except Exception as exc:  # pragma: no cover — defensive
            log.exception("unexpected failure in AI tare estimation")
            return _json_error(f"unexpected error: {exc}", 500)

        # Only compute derived tare when BOTH values are known — otherwise
        # the deterministic figure isn't meaningful.
        net = product_form.net_weight_g
        derived: Optional[float] = None
        if measured_gross_g is not None and net is not None:
            derived = round(measured_gross_g - net, 3)

        resp = AiTareResponse(
            tare_weight_g=estimate.tare_weight_g,
            confidence=estimate.confidence,
            appears_sealed=estimate.appears_sealed,
            reasoning=estimate.reasoning,
            model=model_used,
            thinking_budget_tokens=thinking_budget,
            derived_tare_g=derived,
        )
        return jsonify(_asdict(resp))

    @bp.post("/api/intake/save")
    def intake_save() -> Response:
        payload = request.get_json(silent=True) or {}
        try:
            form = _parse_form(payload)
        except (TypeError, ValueError, IntakeValidationError) as exc:
            return _json_error(str(exc), 400)

        # Re-fetch OFF only if the form's barcode indicates a lookup happened.
        # The wizard posts full form data, so we *don't* re-query OFF here —
        # the user's entries are the source of truth by this point. Pass
        # ``None`` as the OFF side to keep merging logic trivial.
        try:
            product_in = merge_off_and_form(None, form)
        except IntakeValidationError as exc:
            return _json_error(str(exc), 400)

        # Defence-in-depth: image_paths arrive from the LAN client, so
        # validate every entry resolves under refs_root BEFORE any product
        # write — local or cloud. Mirrors the allowlist pattern in
        # /api/intake/ai-tare above. A malicious client could otherwise
        # store '../../etc/passwd' or an absolute path outside refs_root
        # in product_reference_images, which the reference-image route
        # would then serve. Doing this before the cloud POST also avoids
        # creating a cloud product row on a request we're going to reject.
        refs_root_resolved = refs_root.resolve()
        for rel_path in form.image_paths:
            if not isinstance(rel_path, str) or not rel_path.strip():
                continue
            candidate = Path(rel_path)
            if not candidate.is_absolute():
                candidate = refs_root_resolved / candidate
            try:
                resolved = candidate.resolve()
                resolved.relative_to(refs_root_resolved)
            except (OSError, ValueError):
                return _json_error(
                    f"image_paths entry is not under refs_root: {rel_path!r}",
                    400,
                )

        # Branch: cloud-first vs fully-local (legacy standalone mode).
        # PROD_MIGRATION_PLAN.md §5 — cloud becomes source of truth for
        # products, Pi caches the returned UUID. The rest of the flow
        # (reference images on disk + DB rows) is identical either way.
        if cloud_enabled:
            try:
                cloud_product = _post_intake_to_cloud(
                    cloud_client, product_in
                )
            except _CloudError as exc:
                # 4xx surfaces the user-visible validation error; 5xx is
                # transient. TODO(v2): drop 5xx payloads into a local
                # ``intake_pending`` queue for a background retry worker
                # (PROD_MIGRATION_PLAN.md §5 follow-up). For v1 we just
                # reflect the failure to the user and block the save —
                # the user retries when connectivity returns. No photos
                # are snapped (they'd orphan without a product_id).
                status = exc.status_code if 400 <= exc.status_code < 500 else 503
                log.warning(
                    "cloud /intake returned %s: %s",
                    exc.status_code,
                    exc.body[:200] if exc.body else "",
                )
                return _json_error(
                    f"cloud rejected intake ({exc.status_code}): {exc.body or ''}",
                    status,
                )
            except _RequestException as exc:
                # Network timeout / DNS / TCP reset — always transient.
                # Same v1 policy: surface, don't queue.
                log.warning("cloud /intake network failure: %s", exc)
                return _json_error(
                    f"cloud unreachable during intake: {exc}",
                    503,
                )
            except Exception as exc:  # pragma: no cover — defensive
                log.exception("unexpected failure posting intake to cloud")
                return _json_error(f"unexpected cloud error: {exc}", 500)

            product_id = cloud_product.get("product_id")
            if not isinstance(product_id, str) or not product_id.strip():
                log.error(
                    "cloud /intake returned no product_id: %r", cloud_product
                )
                return _json_error(
                    "cloud response missing product_id", 502
                )

            # Write-through the local cache so classifier lookups and
            # subsequent UI reads see the row immediately. Don't 500 the
            # save if the cache write fails — the cloud succeeded, and
            # the next ``fetch_catalog`` tick will recover. We only log.
            try:
                cloud_upsert(
                    db_conn,
                    cloud_product,
                    db_lock=db_lock,
                )
            except Exception:
                log.exception(
                    "local cache upsert failed for cloud product %s", product_id
                )
        else:
            # Standalone mode: today's behavior — write straight to the
            # local products table and use the local UUID as the product_id
            # for ref images. Byte-for-byte unchanged from pre-cloud Pi.
            try:
                product = repo.create_product(product_in)
            except Exception as exc:  # pragma: no cover — defensive
                log.exception("failed to create product")
                return _json_error(f"could not create product: {exc}", 500)
            product_id = product.product_id

        # Persist each captured reference image row. Paths are stored
        # relative to ``refs_root`` so the DB stays portable across hosts.
        # Reference-image rows are always local — PROD_MIGRATION_PLAN.md
        # §1 explicitly keeps ref photos on the Pi.
        ref_ids: list[str] = []
        for rel_path in form.image_paths:
            if not isinstance(rel_path, str) or not rel_path.strip():
                continue
            ref_in = ProductReferenceImageIn(
                product_id=product_id,
                file_path=rel_path,
                angle=None,
            )
            try:
                ref = repo.create_product_reference_image(ref_in)
            except Exception:
                log.exception("failed to create reference image row")
                continue
            ref_ids.append(ref.image_id)

        # Intake is catalog-only: we register the SKU + reference images +
        # tare weight. The first *lot* is created later, when the scale +
        # classifier pipeline sees a unit actually placed on a live shelf.
        # This makes intake something you can run away from the fridge (just
        # holding the item up to the camera for reference shots) rather than
        # a mandatory "place on the scale" ceremony.

        resp = SaveResponse(
            product_id=product_id,
            lot_id=None,
            reference_image_ids=ref_ids,
        )
        return jsonify(_asdict(resp))

    # Expose the refs_root for tests that inspect it.
    bp.refs_root = refs_root  # type: ignore[attr-defined]
    return bp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json_error(message: str, status: int) -> Response:
    resp = jsonify({"error": message})
    resp.status_code = status
    return resp


def _asdict(obj: Any) -> Any:
    """Recursively convert pydantic dataclasses to plain JSON-safe dicts.

    ``dataclasses.asdict`` works on pydantic's @dataclass, and nested OffProduct
    instances are also pydantic dataclasses, so a single call handles both
    layers without extra code.
    """

    return dataclasses.asdict(obj)


def _parse_ai_tare_form(payload: dict[str, Any]) -> AiTareProductForm:
    """Coerce the product_form subset off an AI-tare request body.

    Unknown keys are dropped; blank strings are turned into ``None`` so the
    prompt renderer shows ``null`` instead of ``""``.
    """

    allowed = {f.name for f in dataclasses.fields(AiTareProductForm)}
    clean: dict[str, Any] = {}
    for key, value in payload.items():
        if key not in allowed:
            continue
        if isinstance(value, str) and not value.strip():
            clean[key] = None
        else:
            clean[key] = value
    return AiTareProductForm(**clean)


def _parse_form(payload: dict[str, Any]) -> IntakeForm:
    """Build an :class:`IntakeForm` from a JSON request body.

    Unknown keys are ignored so the wizard can add hidden fields without
    breaking older server builds. Missing fields default to the dataclass's
    declared defaults (everything optional except ``name``).
    """

    if not isinstance(payload, dict):
        raise IntakeValidationError("body must be a JSON object")

    allowed = {f.name for f in dataclasses.fields(IntakeForm)}
    clean = {k: v for k, v in payload.items() if k in allowed}
    # image_paths default must be a list even when absent.
    if "image_paths" in clean and clean["image_paths"] is None:
        clean["image_paths"] = []

    # Coerce blank strings → None for optional fields; keeps the pydantic
    # dataclass happy without forcing the frontend to omit empty inputs.
    for key, value in list(clean.items()):
        if isinstance(value, str) and not value.strip() and key != "name":
            clean[key] = None

    return IntakeForm(**clean)


def _post_intake_to_cloud(client: Any, product_in: ProductIn) -> dict[str, Any]:
    """POST the intake payload to ``shelf-ingest/intake``.

    Builds the JSON body from a :class:`ProductIn` (same merged shape
    the local-save path writes) and returns the parsed response dict.
    The caller is responsible for catching :class:`CloudError` and
    network exceptions.

    The edge function mints the ``product_id`` UUID and echoes back the
    full created row so the Pi can cache it locally without a follow-up
    fetch. That's why we return the raw dict rather than just the id.
    """

    body = {
        "barcode": product_in.barcode,
        "name": product_in.name,
        "brand": product_in.brand,
        "variant": product_in.variant,
        "net_weight_g": product_in.net_weight_g,
        "gross_weight_g": product_in.gross_weight_g,
        "tare_weight_g": product_in.tare_weight_g,
        "serving_weight_g": product_in.serving_weight_g,
        "servings_per_container": product_in.servings_per_container,
        "unit_type": product_in.unit_type,
        "density_g_per_ml": product_in.density_g_per_ml,
        "container_type": product_in.container_type,
        # Macro + description fields — the cloud's /intake edge fn
        # stores these on chefbyte.products. Previously dropped on the
        # floor here, which meant the Pi never forwarded user-captured
        # macros to the cloud even when the wizard collected them.
        "calories_per_serving": product_in.calories_per_serving,
        "carbs_per_serving": product_in.carbs_per_serving,
        "protein_per_serving": product_in.protein_per_serving,
        "fat_per_serving": product_in.fat_per_serving,
        "description": product_in.description,
        "certified": bool(product_in.certified),
    }
    # Drop None-valued keys so the cloud doesn't see a flood of nulls and
    # we don't overwrite its defaults with literal NULL for fields the
    # user left blank.
    clean = {k: v for k, v in body.items() if v is not None}
    return client.post("/intake", clean)


# Re-export ``current_app`` so the module works if Flask's import graph
# shifts without needing the app shim (defensive — silences some lint).
_ = current_app
