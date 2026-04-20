"""Thin wrapper around OpenFoodFacts API v2.

Usage::

    off = lookup_barcode("3017620422003")
    if off.found:
        print(off.product_name, off.brands)

The wrapper is deliberately small: it fetches a single product, pulls the
handful of fields the intake wizard needs, and returns a structured
:class:`OffProduct`. A missing product, a network error, or a malformed
payload all collapse to an :class:`OffProduct` with just the ``barcode``
field set and ``found=False`` — callers should never need a try/except.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from .models import OffProduct

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://world.openfoodfacts.org/api/v2/product"
DEFAULT_TIMEOUT_S = 3.0
_USER_AGENT = "luna-hub-lite-live-shelf/0.1 (local demo)"


def lookup_barcode(
    barcode: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    client: Optional[httpx.Client] = None,
) -> OffProduct:
    """Fetch ``barcode`` from OpenFoodFacts.

    Parameters
    ----------
    barcode:
        The scanned / typed barcode. Whitespace is stripped. An empty string
        yields an empty :class:`OffProduct` immediately — no HTTP call.
    base_url:
        Override for tests or if OFF moves.
    timeout_s:
        Request timeout. The intake wizard needs to stay snappy even if OFF
        is slow, so the default is aggressive (3s).
    client:
        Optional pre-built :class:`httpx.Client`. Useful in tests with
        :class:`httpx.MockTransport`. If omitted, a one-shot client is
        created and closed for this call.
    """

    clean = (barcode or "").strip()
    if not clean:
        return OffProduct(barcode="", found=False)

    url = f"{base_url.rstrip('/')}/{clean}.json"
    headers = {"User-Agent": _USER_AGENT}

    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=timeout_s, headers=headers)

    try:
        resp = client.get(url)
    except httpx.HTTPError as exc:
        log.warning("OFF request failed for %s: %s", clean, exc)
        return OffProduct(barcode=clean, found=False)
    finally:
        if owns_client:
            client.close()

    if resp.status_code == 404:
        return OffProduct(barcode=clean, found=False)
    if resp.status_code != 200:
        log.warning("OFF returned %s for %s", resp.status_code, clean)
        return OffProduct(barcode=clean, found=False)

    try:
        payload = resp.json()
    except ValueError:
        log.warning("OFF returned non-JSON for %s", clean)
        return OffProduct(barcode=clean, found=False)

    # v2 uses `status` (int, 1 = found) + top-level `product` object.
    status = payload.get("status")
    product = payload.get("product")
    if status != 1 or not isinstance(product, dict):
        return OffProduct(barcode=clean, found=False)

    return _parse_product(clean, product)


def _parse_product(barcode: str, product: dict[str, Any]) -> OffProduct:
    """Extract only the fields the intake wizard cares about."""

    nutriments = product.get("nutriments") or {}
    if not isinstance(nutriments, dict):
        nutriments = {}

    ecoscore = product.get("ecoscore_data") or {}
    if not isinstance(ecoscore, dict):
        ecoscore = {}
    packaging_info = ecoscore.get("packaging_info")
    if not isinstance(packaging_info, str) or not packaging_info.strip():
        # Fall back to top-level `packaging` string if ecoscore unavailable.
        packaging_info = product.get("packaging")
        if not isinstance(packaging_info, str):
            packaging_info = None

    return OffProduct(
        barcode=barcode,
        product_name=_str_or_none(product.get("product_name")),
        brands=_str_or_none(product.get("brands")),
        product_quantity_g=_float_or_none(product.get("product_quantity")),
        serving_quantity_g=_float_or_none(product.get("serving_quantity")),
        serving_size=_str_or_none(product.get("serving_size")),
        energy_kcal_per_serving=_float_or_none(nutriments.get("energy-kcal_serving")),
        packaging_info=_str_or_none(packaging_info),
        image_front_url=_str_or_none(product.get("image_front_url")),
        found=True,
    )


def _str_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    # OFF occasionally returns numbers where strings belong — stringify.
    return str(value)


def _float_or_none(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
