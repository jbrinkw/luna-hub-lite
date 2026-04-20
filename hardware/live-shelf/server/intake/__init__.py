"""Intake bundle — one-time product onboarding for the live shelf.

See `docs/plan.md` §5.1 (flow) and §4.6 (API routes).

Public surface:

* :class:`IntakeRepo` — storage protocol the blueprint requires
* :class:`CameraSource` — camera protocol the blueprint requires
* :func:`create_blueprint` — wires a Flask blueprint that exposes the three
  :code:`/api/intake/*` routes plus the :code:`/intake` HTML wizard page
* :mod:`.off_lookup` — OpenFoodFacts wrapper
* :mod:`.profile_builder` — merges OFF data with user form input
* :mod:`.models` — request / response shapes
"""

from __future__ import annotations

from .cloud_sync import sync_products_from_cloud, upsert_product_from_cloud
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
    TareEstimate,
)
from .routes import create_blueprint

__all__ = [
    "AiTareProductForm",
    "AiTareRequest",
    "AiTareResponse",
    "CameraSource",
    "CaptureRefResponse",
    "IntakeForm",
    "IntakeRepo",
    "LookupResponse",
    "OffProduct",
    "SaveResponse",
    "TareEstimate",
    "create_blueprint",
    "sync_products_from_cloud",
    "upsert_product_from_cloud",
]
