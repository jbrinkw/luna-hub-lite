"""Merge OpenFoodFacts data with user form input into a :class:`ProductIn`.

The wizard pre-populates the form from :class:`OffProduct` but the user is
free to override any field before tapping Finalize. Anything the user set
wins; anything they left blank falls back to whatever OFF provided; anything
neither has is left None (SQLite NULL). The result is the canonical shape
the storage layer wants for :code:`create_product`.
"""

from __future__ import annotations

from typing import Optional, get_args

from ..storage.models import ProductIn, UnitType
from .models import IntakeForm, OffProduct

VALID_UNIT_TYPES = set(get_args(UnitType))


class IntakeValidationError(ValueError):
    """Raised when the merged profile fails basic sanity checks."""


def merge_off_and_form(off: Optional[OffProduct], form: IntakeForm) -> ProductIn:
    """Produce a :class:`ProductIn` ready to hand to the storage layer.

    Merge rules (in order of precedence, highest first):
      1. Explicit form values — anything the user typed or confirmed
      2. OFF-provided values — used when the form field is None/blank
      3. None — the DB stores NULL

    Additional derivations:
      * ``tare_weight_g = gross_weight_g - net_weight_g`` when both are known
        and neither was supplied explicitly.
      * ``container_type`` defaults to a best-effort guess from
        :attr:`OffProduct.packaging_info` when the form doesn't set it.
      * ``certified = 1`` — the intake flow is the only path by which a
        product enters the demo, and completing the wizard means the user
        has vouched for the profile.
    """

    if not isinstance(form, IntakeForm):
        raise IntakeValidationError("form must be an IntakeForm")

    # -- Strings -----------------------------------------------------------
    name = _pick_str(form.name, off.product_name if off else None)
    if not name:
        raise IntakeValidationError("name is required")

    barcode = _pick_str(form.barcode, off.barcode if off and off.found else None)
    brand = _pick_str(form.brand, off.brands if off else None)
    variant = _pick_str(form.variant, None)

    # -- Numbers -----------------------------------------------------------
    net_weight_g = _pick_num(form.net_weight_g, off.product_quantity_g if off else None)
    serving_weight_g = _pick_num(
        form.serving_weight_g, off.serving_quantity_g if off else None
    )
    servings_per_container = _pick_num(form.servings_per_container, None)
    gross_weight_g = _pick_num(form.gross_weight_g, None)
    density_g_per_ml = _pick_num(form.density_g_per_ml, None)

    # -- Tare derivation ---------------------------------------------------
    tare_weight_g = form.tare_weight_g
    if tare_weight_g is None and gross_weight_g is not None and net_weight_g is not None:
        derived = gross_weight_g - net_weight_g
        # A negative tare is nonsense; refuse rather than silently storing it
        # (happens when the user enters a gross_weight smaller than the label
        # net weight — probably a typo or a partially-empty container).
        if derived < 0:
            raise IntakeValidationError(
                "gross_weight_g < net_weight_g — check scale reading or label"
            )
        tare_weight_g = derived

    # -- Unit type ---------------------------------------------------------
    unit_type: Optional[UnitType] = None
    if form.unit_type is not None:
        if form.unit_type not in VALID_UNIT_TYPES:
            raise IntakeValidationError(
                f"unit_type must be one of {sorted(VALID_UNIT_TYPES)}; got {form.unit_type!r}"
            )
        unit_type = form.unit_type

    # -- Container type ----------------------------------------------------
    container_type = _pick_str(
        form.container_type,
        _guess_container(off.packaging_info) if off and off.packaging_info else None,
    )

    # -- Servings-per-container convenience derivation ---------------------
    if (
        servings_per_container is None
        and net_weight_g is not None
        and serving_weight_g is not None
        and serving_weight_g > 0
    ):
        # Only derive when the label and serving weights agree on sign.
        # Avoids wildly wrong values from broken OFF data.
        servings_per_container = round(net_weight_g / serving_weight_g, 3)

    # -- Macro + description -----------------------------------------------
    # Passed through verbatim from the form; the wizard collects these
    # either manually or from the AI-assisted OFF normaliser. OFF doesn't
    # structure macros consistently enough to pick from here — the cloud's
    # ``/intake`` edge function is the one that normalises OFF nutrients
    # into per-serving figures. So we only surface what the user posted.
    calories_per_serving = _pick_num(form.calories_per_serving, None)
    carbs_per_serving = _pick_num(form.carbs_per_serving, None)
    protein_per_serving = _pick_num(form.protein_per_serving, None)
    fat_per_serving = _pick_num(form.fat_per_serving, None)
    description = _pick_str(form.description, None)

    return ProductIn(
        name=name,
        barcode=barcode,
        brand=brand,
        variant=variant,
        net_weight_g=net_weight_g,
        gross_weight_g=gross_weight_g,
        tare_weight_g=tare_weight_g,
        serving_weight_g=serving_weight_g,
        servings_per_container=servings_per_container,
        unit_type=unit_type,
        density_g_per_ml=density_g_per_ml,
        container_type=container_type,
        calories_per_serving=calories_per_serving,
        carbs_per_serving=carbs_per_serving,
        protein_per_serving=protein_per_serving,
        fat_per_serving=fat_per_serving,
        description=description,
        certified=1,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pick_str(form_value: Optional[str], off_value: Optional[str]) -> Optional[str]:
    if isinstance(form_value, str):
        stripped = form_value.strip()
        if stripped:
            return stripped
    if isinstance(off_value, str):
        stripped = off_value.strip()
        if stripped:
            return stripped
    return None


def _pick_num(form_value: Optional[float], off_value: Optional[float]) -> Optional[float]:
    if form_value is not None:
        try:
            return float(form_value)
        except (TypeError, ValueError):
            pass
    if off_value is not None:
        try:
            return float(off_value)
        except (TypeError, ValueError):
            pass
    return None


_CONTAINER_KEYWORDS: tuple[tuple[str, str], ...] = (
    # Ordered by specificity — 'bottle' must win over 'plastic'.
    ("bottle", "bottle"),
    ("jar", "jar"),
    ("can", "can"),
    ("carton", "carton"),
    ("tray", "tray"),
    ("pouch", "bag"),
    ("bag", "bag"),
    ("box", "box"),
    ("tub", "jar"),
)


def _guess_container(packaging_info: str) -> Optional[str]:
    """Best-effort mapping of free-text OFF packaging info → container enum.

    Returns one of the canonical :code:`container_type` values the intake
    wizard uses, or None when no keyword matches. Case-insensitive.
    """

    lower = packaging_info.lower()
    for needle, canonical in _CONTAINER_KEYWORDS:
        if needle in lower:
            return canonical
    return None
