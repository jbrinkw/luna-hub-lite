"""Catalog fetch helper (PROD_MIGRATION_PLAN.md §3).

The Pi calls ``GET /catalog`` before every scale event to pull the
user's current products + non-depleted stock + scale pairings + location
list in one round-trip. The response is parsed into the :class:`Catalog`
dataclass and handed to the classifier's candidate-pool builder.

This module is intentionally cache-free — the caller decides how long
to hold onto a catalog (e.g. "use last successful fetch if network
times out mid-event" is a caller concern, not ours).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .client import CloudClient


@dataclass
class Catalog:
    """User's current catalog as seen from the cloud.

    Fields mirror the JSON returned by ``GET /catalog``. Lists are left
    as raw dicts so the classifier adapter can project whatever subset
    of fields it needs without forcing an extra mapping step here.

    ``fetched_at`` is stamped by :func:`fetch_catalog` at response time
    so stale-fallback logic upstream can log how old the data is.
    """

    products: list[dict] = field(default_factory=list)
    stock: list[dict] = field(default_factory=list)
    pairings: list[dict] = field(default_factory=list)
    locations: list[dict] = field(default_factory=list)
    fetched_at: datetime = field(
        default_factory=lambda: datetime.now(tz=timezone.utc)
    )


def _as_list(raw: Any) -> list[dict]:
    """Coerce an arbitrary JSON field to ``list[dict]``.

    The cloud's ``GET /catalog`` protocol returns a top-level object
    whose ``products``/``stock``/``pairings``/``locations`` fields are
    each a plain JSON list (or missing/None). We tolerate both shapes.

    Earlier revisions also accepted a ``{"_list": [...]}`` wrapper
    because :class:`CloudClient._parse_or_raise` wraps bare-list
    responses into a sentinel dict for uniform typing. That never
    reaches this path in practice — the catalog endpoint always
    returns an object, and the individual fields inside it are plain
    lists. Keeping the wrapper branch silently turned malformed
    responses into "looks-empty" catalogs, which masked real protocol
    drift (the classifier sees an empty pool and short-circuits to
    UNKNOWN with no obvious error). Dropping the branch so an
    unexpected shape raises instead of silently degrading.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    raise TypeError(
        f"catalog field must be list or None; got {type(raw).__name__}"
    )


def fetch_catalog(client: CloudClient) -> Catalog:
    """Fetch the full catalog via ``GET /catalog``.

    Propagates :class:`~server.cloud.client.CloudError` on any non-2xx
    response so the caller can decide whether to fall back to the last
    successful catalog.
    """
    payload = client.get("/catalog")
    return Catalog(
        products=_as_list(payload.get("products")),
        stock=_as_list(payload.get("stock")),
        pairings=_as_list(payload.get("pairings")),
        locations=_as_list(payload.get("locations")),
        fetched_at=datetime.now(tz=timezone.utc),
    )
