"""Tests for :func:`server.intake.profile_builder.merge_off_and_form`."""

from __future__ import annotations

import pytest

from server.intake.models import IntakeForm, OffProduct
from server.intake.profile_builder import (
    IntakeValidationError,
    merge_off_and_form,
)


def test_form_values_win_over_off():
    off = OffProduct(
        barcode="1234",
        product_name="OFF Name",
        brands="OFF Brand",
        product_quantity_g=500.0,
        found=True,
    )
    form = IntakeForm(
        name="User Name",
        brand="User Brand",
        net_weight_g=350.0,
    )

    result = merge_off_and_form(off, form)
    assert result.name == "User Name"
    assert result.brand == "User Brand"
    assert result.net_weight_g == pytest.approx(350.0)


def test_off_values_fill_missing_form_fields():
    off = OffProduct(
        barcode="5678",
        product_name="OFF Name",
        brands="OFF Brand",
        product_quantity_g=500.0,
        serving_quantity_g=25.0,
        found=True,
    )
    form = IntakeForm(name="User Name")  # only name provided

    result = merge_off_and_form(off, form)
    assert result.name == "User Name"
    assert result.brand == "OFF Brand"
    assert result.net_weight_g == pytest.approx(500.0)
    assert result.serving_weight_g == pytest.approx(25.0)


def test_tare_derived_from_gross_minus_net():
    form = IntakeForm(
        name="Ketchup",
        net_weight_g=340.0,
        gross_weight_g=380.0,
    )
    result = merge_off_and_form(None, form)
    assert result.tare_weight_g == pytest.approx(40.0)


def test_tare_derivation_does_not_override_explicit_value():
    form = IntakeForm(
        name="Ketchup",
        net_weight_g=340.0,
        gross_weight_g=380.0,
        tare_weight_g=55.0,  # explicit override
    )
    result = merge_off_and_form(None, form)
    assert result.tare_weight_g == pytest.approx(55.0)


def test_tare_negative_raises():
    form = IntakeForm(
        name="Ketchup",
        net_weight_g=500.0,
        gross_weight_g=300.0,  # less than net — user typo
    )
    with pytest.raises(IntakeValidationError, match="gross_weight_g < net_weight_g"):
        merge_off_and_form(None, form)


def test_tare_skipped_when_gross_missing():
    form = IntakeForm(name="Ketchup", net_weight_g=340.0)
    result = merge_off_and_form(None, form)
    assert result.tare_weight_g is None


def test_unit_type_enum_enforced_by_pydantic():
    # Pydantic enforces the UnitType literal at IntakeForm construction —
    # any downstream merge call never runs. Both paths reject the bad
    # value, which is what we want.
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        IntakeForm(name="X", unit_type="gas")  # type: ignore[arg-type]


def test_unit_type_enum_enforced_by_builder_when_bypassed():
    # Belt-and-suspenders: if somehow a bad unit_type slips past pydantic
    # (e.g., by mutating the field after construction), the builder
    # catches it and raises IntakeValidationError.
    form = IntakeForm(name="X")
    object.__setattr__(form, "unit_type", "gas")
    with pytest.raises(IntakeValidationError, match="unit_type must be one of"):
        merge_off_and_form(None, form)


def test_unit_type_none_allowed():
    result = merge_off_and_form(None, IntakeForm(name="X"))
    assert result.unit_type is None


def test_container_guessed_from_off_packaging_info():
    off = OffProduct(barcode="1", product_name="X", packaging_info="Plastic bottle", found=True)
    form = IntakeForm(name="X")
    result = merge_off_and_form(off, form)
    assert result.container_type == "bottle"


def test_container_form_override_wins():
    off = OffProduct(barcode="1", product_name="X", packaging_info="Plastic bottle", found=True)
    form = IntakeForm(name="X", container_type="jar")
    result = merge_off_and_form(off, form)
    assert result.container_type == "jar"


def test_container_guess_prefers_specific_over_generic():
    off = OffProduct(
        barcode="1",
        product_name="X",
        packaging_info="plastic bottle in a cardboard box",
        found=True,
    )
    result = merge_off_and_form(off, IntakeForm(name="X"))
    assert result.container_type == "bottle"


def test_container_guess_returns_none_on_unknown_keyword():
    off = OffProduct(barcode="1", product_name="X", packaging_info="mystery material", found=True)
    result = merge_off_and_form(off, IntakeForm(name="X"))
    assert result.container_type is None


def test_servings_per_container_derived_from_net_and_serving():
    form = IntakeForm(name="X", net_weight_g=340.0, serving_weight_g=17.0)
    result = merge_off_and_form(None, form)
    # 340 / 17 = 20
    assert result.servings_per_container == pytest.approx(20.0)


def test_servings_per_container_not_derived_when_explicit():
    form = IntakeForm(
        name="X", net_weight_g=340.0, serving_weight_g=17.0, servings_per_container=5.0
    )
    result = merge_off_and_form(None, form)
    assert result.servings_per_container == pytest.approx(5.0)


def test_servings_per_container_not_derived_when_serving_zero():
    form = IntakeForm(name="X", net_weight_g=340.0, serving_weight_g=0.0)
    result = merge_off_and_form(None, form)
    assert result.servings_per_container is None


def test_missing_name_raises():
    form = IntakeForm(name="  ")  # blank-only name
    with pytest.raises(IntakeValidationError, match="name is required"):
        merge_off_and_form(None, form)


def test_missing_name_filled_from_off():
    off = OffProduct(barcode="1", product_name="OFF Name", found=True)
    form = IntakeForm(name="")  # blank name
    result = merge_off_and_form(off, form)
    assert result.name == "OFF Name"


def test_barcode_from_off_when_form_blank():
    off = OffProduct(barcode="1234567", product_name="X", found=True)
    form = IntakeForm(name="X")
    result = merge_off_and_form(off, form)
    assert result.barcode == "1234567"


def test_barcode_from_off_ignored_when_not_found():
    off = OffProduct(barcode="1234567", found=False)
    form = IntakeForm(name="X")
    result = merge_off_and_form(off, form)
    assert result.barcode is None


def test_barcode_form_override_wins():
    off = OffProduct(barcode="1234567", product_name="X", found=True)
    form = IntakeForm(name="X", barcode="9999")
    result = merge_off_and_form(off, form)
    assert result.barcode == "9999"


def test_certified_set_to_one():
    result = merge_off_and_form(None, IntakeForm(name="X"))
    assert result.certified == 1


def test_empty_strings_treated_as_missing():
    off = OffProduct(barcode="1", product_name="OFF Name", brands="OFF Brand", found=True)
    form = IntakeForm(name="User Name", brand="   ")  # whitespace-only brand
    result = merge_off_and_form(off, form)
    assert result.brand == "OFF Brand"


def test_rejects_non_intakeform():
    with pytest.raises(IntakeValidationError, match="form must be an IntakeForm"):
        merge_off_and_form(None, {"name": "X"})  # type: ignore[arg-type]


def test_all_numeric_fields_coerced_to_float():
    form = IntakeForm(
        name="X",
        net_weight_g=100,  # int rather than float
        serving_weight_g=25,
        gross_weight_g=130,
        density_g_per_ml=1.0,
    )
    result = merge_off_and_form(None, form)
    assert isinstance(result.net_weight_g, float)
    assert isinstance(result.serving_weight_g, float)
    assert isinstance(result.tare_weight_g, float)
