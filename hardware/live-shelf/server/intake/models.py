"""Request/response shapes + dependency protocols for the intake bundle.

The intake routes take two externally-supplied dependencies:

* :class:`IntakeRepo` — a storage-layer facade with just the three writes the
  intake flow needs. This keeps the blueprint from importing the concrete
  repo module and lets tests stub behavior with a plain class.
* :class:`CameraSource` — an object that can produce the current camera
  frame as a JPEG byte string. Bundle C owns the concrete impl; the intake
  bundle only needs the callable.

Keeping these as :class:`typing.Protocol` means no runtime dependency on the
storage or camera packages — only the :class:`Product`, :class:`Lot`, etc.
types imported via their public module path.
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from pydantic import Field
from pydantic.dataclasses import dataclass

from ..storage.models import (
    Lot,
    LotIn,
    Product,
    ProductIn,
    ProductReferenceImage,
    ProductReferenceImageIn,
    UnitType,
)


# ---------------------------------------------------------------------------
# External dependency protocols
# ---------------------------------------------------------------------------


@runtime_checkable
class IntakeRepo(Protocol):
    """The subset of the storage layer the intake flow needs.

    Concrete implementation lives in :mod:`server.storage.repo` (Bundle A).
    The intake blueprint takes any object satisfying this protocol so tests
    can substitute a hand-rolled fake.
    """

    def create_product(self, data: ProductIn) -> Product:  # pragma: no cover
        ...

    def create_product_reference_image(
        self, data: ProductReferenceImageIn
    ) -> ProductReferenceImage:  # pragma: no cover
        ...

    def create_lot(self, data: LotIn) -> Lot:  # pragma: no cover
        ...


@runtime_checkable
class CameraSource(Protocol):
    """Returns the current live camera frame as a JPEG byte string.

    Concrete implementation lives in :mod:`server.camera` (Bundle C).
    """

    def current_frame_jpeg(self) -> bytes:  # pragma: no cover
        ...


# ---------------------------------------------------------------------------
# OpenFoodFacts response
# ---------------------------------------------------------------------------


@dataclass
class OffProduct:
    """Normalized subset of an OpenFoodFacts v2 product response.

    All fields except ``barcode`` are optional — OFF hits may be sparse, and
    a 404 is represented as an instance with just the barcode set.
    """

    barcode: str
    product_name: Optional[str] = None
    brands: Optional[str] = None
    product_quantity_g: Optional[float] = None
    serving_quantity_g: Optional[float] = None
    serving_size: Optional[str] = None
    energy_kcal_per_serving: Optional[float] = None
    packaging_info: Optional[str] = None
    image_front_url: Optional[str] = None
    found: bool = False


# ---------------------------------------------------------------------------
# API request / response shapes
# ---------------------------------------------------------------------------


@dataclass
class LookupResponse:
    """Response for :code:`POST /api/intake/lookup`."""

    off: OffProduct


@dataclass
class CaptureRefResponse:
    """Response for :code:`POST /api/intake/capture-ref`."""

    image_id: str  # index-based local id (temp_id/<index>)
    file_path: str  # path relative to the configured refs_root
    temp_id: str
    index: int


@dataclass
class IntakeForm:
    """Fields posted by the wizard on :code:`POST /api/intake/save`.

    Only ``name`` is hard-required; everything else is optional so that the
    caller can still save a partial profile (with ``certified=False``) if the
    user bailed before filling out all details. In practice the wizard
    enforces ``net_weight_g`` and ``unit_type`` before enabling the Finalize
    button.
    """

    name: str
    barcode: Optional[str] = None
    brand: Optional[str] = None
    variant: Optional[str] = None
    net_weight_g: Optional[float] = None
    gross_weight_g: Optional[float] = None
    tare_weight_g: Optional[float] = None
    serving_weight_g: Optional[float] = None
    servings_per_container: Optional[float] = None
    unit_type: Optional[UnitType] = None
    density_g_per_ml: Optional[float] = None
    container_type: Optional[str] = None
    # Macro + description fields — flow through to the cloud /intake POST
    # and into the local Pi cache when a cloud product comes back over
    # write-through. Present here so merge_off_and_form returns a
    # ProductIn that carries them end-to-end.
    calories_per_serving: Optional[float] = None
    carbs_per_serving: Optional[float] = None
    protein_per_serving: Optional[float] = None
    fat_per_serving: Optional[float] = None
    description: Optional[str] = None
    temp_id: Optional[str] = None
    image_paths: list[str] = Field(default_factory=list)


@dataclass
class SaveResponse:
    """Response for :code:`POST /api/intake/save`.

    Intake is a catalog-level operation (product + reference images + tare).
    It no longer creates a lot — lots are created at runtime when the
    classifier sees a unit actually placed on a live shelf. `lot_id` is
    retained as an optional field for backward compatibility with callers
    that still read it; modern callers should ignore it.
    """

    product_id: str
    reference_image_ids: list[str]
    lot_id: Optional[str] = None


# ---------------------------------------------------------------------------
# AI tare estimation (§5.1 — partially-used container handling)
# ---------------------------------------------------------------------------


@dataclass
class AiTareProductForm:
    """Subset of the intake form that feeds the AI tare prompt.

    Kept separate from :class:`IntakeForm` because the AI-tare endpoint only
    needs the label/metadata fields — the captured ref paths and temp_id are
    passed alongside.
    """

    name: Optional[str] = None
    brand: Optional[str] = None
    variant: Optional[str] = None
    net_weight_g: Optional[float] = None
    serving_weight_g: Optional[float] = None
    servings_per_container: Optional[float] = None
    unit_type: Optional[UnitType] = None
    container_type: Optional[str] = None


@dataclass
class AiTareRequest:
    """Request body for :code:`POST /api/intake/ai-tare`.

    The wizard sends the current temp_id + the absolute paths of the
    reference images it has already captured, plus whatever form state the
    user has filled in. ``measured_gross_g`` is optional — when the scale
    has a stable reading, pass it in so the model can sanity-check against
    ``gross - net``. ``is_partial`` is an explicit flag the user checks
    when the item was opened before being weighed.
    """

    temp_id: str
    ref_image_paths: list[str] = Field(default_factory=list)
    product_form: AiTareProductForm = Field(default_factory=AiTareProductForm)
    measured_gross_g: Optional[float] = None
    is_partial: Optional[bool] = None


@dataclass
class TareEstimate:
    """Parsed model output — the AI's best guess at the empty-container weight."""

    tare_weight_g: float
    confidence: str  # "low" | "medium" | "high"
    appears_sealed: bool
    reasoning: str


@dataclass
class AiTareResponse:
    """Response body for :code:`POST /api/intake/ai-tare`.

    Carries both the AI estimate and the deterministic ``gross - net``
    figure (when both are available) so the UI can display them side-by-side
    and highlight discrepancies.
    """

    tare_weight_g: float
    confidence: str
    appears_sealed: bool
    reasoning: str
    model: str
    thinking_budget_tokens: int
    derived_tare_g: Optional[float] = None
