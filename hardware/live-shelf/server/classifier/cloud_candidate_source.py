"""Cloud-backed :class:`CandidateSource` implementation.

Architecture v3 (PROD_MIGRATION_PLAN.md) switches the Pi's candidate-pool
builder from reading the local SQLite ``products`` / ``lots`` tables to
fetching the user's catalog from Supabase per event. This module is the
classifier's view of that cloud catalog.

Lifecycle:

    1. :meth:`refresh` is called by ``app.py`` BEFORE each classifier
       invocation. It pulls a fresh catalog via
       :func:`server.cloud.catalog.fetch_catalog`.
    2. The four :class:`CandidateSource` protocol methods (``get_on_shelf_lots``
       etc.) serve LotCandidate / ProductCandidate views derived from the
       last-known catalog. They never hit the network themselves — so
       calling all four (as ``candidate_pool.pool_for_add`` does) costs
       one HTTPS round-trip per event, not four.
    3. On :class:`~server.cloud.client.CloudError` or network timeout
       inside :meth:`refresh`: we fall back to the last successful
       catalog *if it's within ``fallback_ttl_s`` seconds old*. Otherwise
       the error is re-raised so the caller (``app.py``) can drop to the
       cold-start guard (see :mod:`server.classifier.classify`).
    4. Cold start (:meth:`has_catalog` returns False) is detected by the
       classifier entrypoint, which short-circuits to an UNKNOWN result
       without calling Anthropic.

Mapping:
    ``Catalog.products`` (cloud rows) → :class:`ProductCandidate`
    ``Catalog.stock``    (cloud rows, filtered to ``qty_containers > 0``,
                          sorted by ``expires_on ASC NULLS LAST``) →
                          :class:`LotCandidate`

The cloud catalog doesn't yet carry an explicit "status" per stock row
— every non-depleted stock row is treated as ``on_shelf``. The "out"
and "in_flight" branches of the classifier's candidate pool are
intentionally empty in cloud mode; the cloud is the source of truth
for what *exists*, and the Pi no longer tracks ephemeral "recently
left the shelf" state across restarts. Callers that need in-flight
tracking must fall back to the legacy local source (see the
``CLOUD_ENABLED=false`` path in ``candidate_pool.py``).

``app.py`` should construct this as::

    from server.classifier.cloud_candidate_source import CloudCandidateSource
    source = CloudCandidateSource(cloud_client)
    # before each classify_event:
    source.refresh()
    ctx = ClassifierContext(source=source, ...)
    classify_event(event, ctx)
"""

from __future__ import annotations

import logging
import time
from typing import Optional, Sequence

from ..cloud.catalog import Catalog, fetch_catalog
from ..cloud.client import CloudClient, CloudError
from .models import LotCandidate, ProductCandidate

log = logging.getLogger(__name__)


def _as_float(value: object) -> Optional[float]:
    """Best-effort float coercion for possibly-None / possibly-str JSON values."""
    if value is None:
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _expires_sort_key(row: dict) -> tuple[int, str]:
    """Return a sort key that puts ``expires_on ASC NULLS LAST``.

    Postgres dates serialise to ISO-8601 strings over JSON; lex ordering
    matches chronological order for that format, so we sort on the raw
    string. NULL / missing ``expires_on`` gets pushed to the back.
    """
    raw = row.get("expires_on")
    if raw is None or raw == "":
        return (1, "")
    return (0, str(raw))


# NOTE for app.py wiring: construct this class with a ready
# ``CloudClient``. Call :meth:`refresh` once at startup (so the first
# classifier call isn't a cold start) and again before every
# ``classify_event`` so the candidate pool reflects the latest
# server-side catalog. The default ``fallback_ttl_s`` of 5 minutes
# covers typical transient network blips; tune per deployment.
class CloudCandidateSource:
    """Classifier :class:`~server.classifier.models.CandidateSource` served
    from a freshly-fetched cloud :class:`~server.cloud.catalog.Catalog`.

    Parameters
    ----------
    client:
        Authenticated :class:`CloudClient` pointed at the Supabase
        ``shelf-ingest`` edge function.
    fallback_ttl_s:
        How long a previously-successful catalog stays usable after a
        :class:`CloudError` or network timeout on :meth:`refresh`. When
        a later refresh fails and the cached catalog is older than this
        window, the error is re-raised.
    now:
        Injectable clock — tests replace this with a deterministic
        function. Defaults to :func:`time.monotonic`.
    """

    def __init__(
        self,
        client: CloudClient,
        *,
        fallback_ttl_s: float = 300.0,
        now: Optional[object] = None,
    ) -> None:
        self._client = client
        self._fallback_ttl_s = float(fallback_ttl_s)
        self._now = now if callable(now) else time.monotonic  # type: ignore[assignment]
        self._catalog: Optional[Catalog] = None
        # Monotonic-clock stamp of the last *successful* fetch. Used
        # for fallback-TTL bookkeeping, NOT for the HTTP retry policy.
        self._fetched_at_mono: Optional[float] = None

    # -- Catalog lifecycle -------------------------------------------------

    def refresh(self) -> Catalog:
        """Pull a fresh catalog and cache it.

        Returns the newly-cached :class:`Catalog` on success. On
        :class:`CloudError` or any transport-level exception, consult
        the fallback window: reuse the last-successful catalog if it's
        still within ``fallback_ttl_s``; otherwise re-raise so the
        caller can short-circuit to the cold-start / unknown path.
        """
        try:
            catalog = fetch_catalog(self._client)
        except CloudError as exc:
            return self._use_fallback_or_raise(exc)
        except Exception as exc:  # transport-level (DNS / timeout / …)
            # ``requests`` surfaces connect/read timeouts as subclasses of
            # OSError rather than CloudError, so catch broadly and treat
            # them the same way as a CloudError from the caller's POV.
            log.warning(
                "CloudCandidateSource: transport error refreshing catalog: %s",
                exc,
            )
            return self._use_fallback_or_raise(exc)

        self._catalog = catalog
        self._fetched_at_mono = self._now()  # type: ignore[operator]
        return catalog

    def _use_fallback_or_raise(self, exc: BaseException) -> Catalog:
        """Return the cached catalog if it's fresh enough, else re-raise."""
        if self._catalog is None or self._fetched_at_mono is None:
            # Cold start — nothing to fall back to.
            raise exc
        age = self._now() - self._fetched_at_mono  # type: ignore[operator]
        if age > self._fallback_ttl_s:
            log.warning(
                "CloudCandidateSource: fallback catalog expired "
                "(age=%.1fs > ttl=%.1fs); re-raising %s",
                age,
                self._fallback_ttl_s,
                type(exc).__name__,
            )
            raise exc
        log.warning(
            "CloudCandidateSource: refresh failed (%s) — reusing cached "
            "catalog (age=%.1fs)",
            type(exc).__name__,
            age,
        )
        return self._catalog

    def has_catalog(self) -> bool:
        """True once at least one :meth:`refresh` call has succeeded.

        The classifier cold-start guard queries this to decide whether
        to short-circuit with an UNKNOWN result.
        """
        return self._catalog is not None

    @property
    def catalog(self) -> Optional[Catalog]:
        """Expose the cached catalog for callers that want to inspect it."""
        return self._catalog

    # -- CandidateSource protocol surface ---------------------------------

    def get_on_shelf_lots(
        self, shelf_id: Optional[str] = None
    ) -> Sequence[LotCandidate]:
        """Build :class:`LotCandidate`s from the catalog's non-depleted stock.

        Stock rows with ``qty_containers <= 0`` are excluded (the cloud
        already filters depleted rows out of ``/catalog`` — this check
        is defence in depth). Results are ordered nearest-expiration
        first (``expires_on ASC NULLS LAST``).

        ``shelf_id`` is accepted for protocol compatibility but ignored
        — the cloud catalog doesn't yet carry per-shelf stock
        partitioning. Pi-side shelf scoping is a local concept.
        """
        catalog = self._catalog
        if catalog is None:
            return []

        products_by_id: dict[str, dict] = {
            p["product_id"]: p for p in catalog.products if "product_id" in p
        }

        # Filter + sort.
        stock_rows = [
            row
            for row in catalog.stock
            if (_as_float(row.get("qty_containers")) or 0) > 0
        ]
        stock_rows.sort(key=_expires_sort_key)

        out: list[LotCandidate] = []
        for row in stock_rows:
            product = products_by_id.get(row.get("product_id"))
            if product is None:
                # Orphaned stock row (product deleted but stock not cleaned
                # up). Skip — without product metadata we can't build a
                # usable candidate.
                continue
            # Prefer the stock-level id; fall back to a deterministic
            # composite so distinct rows for the same product don't collide
            # after dedup in candidate_pool (which keys on candidate_id).
            lot_id = (
                row.get("lot_id")
                or row.get("stock_id")
                or f"{row.get('product_id')}:{row.get('expires_on','')}"
            )
            out.append(
                LotCandidate(
                    lot_id=str(lot_id),
                    product_id=str(product["product_id"]),
                    name=str(product.get("name", "")),
                    brand=product.get("brand"),
                    # Cloud doesn't track a physical current_weight_g per
                    # stock row yet; fall back to the product-level gross
                    # weight so the classifier still has a target mass.
                    expected_weight_g=_as_float(
                        product.get("gross_weight_g")
                    )
                    or _as_float(product.get("net_weight_g")),
                    container_type=product.get("container_type"),
                    status="on_shelf",
                    reference_image_paths=(),
                )
            )
        return out

    def get_recently_out_lots(
        self,
        window_seconds: int,
        shelf_id: Optional[str] = None,
    ) -> Sequence[LotCandidate]:
        """Cloud catalog has no "out" concept — return empty.

        Rationale: the cloud source-of-truth tracks what *exists*, not
        ephemeral "took it off the shelf 20 minutes ago" state. The
        legacy local candidate source fills this slot when
        ``CLOUD_ENABLED=false``. In cloud mode the ``recently_out``
        branch of the ADD pool is simply empty — the classifier falls
        back to the catalog branch, which covers the same ground for
        a non-depleted product.
        """
        return ()

    def get_in_flight_lots(
        self,
        max_age_seconds: Optional[int] = None,
        shelf_id: Optional[str] = None,
    ) -> Sequence[LotCandidate]:
        """Cloud catalog has no "in-flight" concept — return empty.

        See :meth:`get_recently_out_lots` for the rationale.
        """
        return ()

    def get_certified_not_on_shelf(self) -> Sequence[ProductCandidate]:
        """Every product in the cloud catalog, as a :class:`ProductCandidate`.

        The protocol name preserves compatibility with the legacy source
        (see :mod:`server.classifier.models`); despite the name we
        return ALL catalog products — the candidate-pool dedupe step
        handles any collision with the on-shelf branch via
        ``candidate_id`` (lot_id vs product_id).
        """
        catalog = self._catalog
        if catalog is None:
            return []

        out: list[ProductCandidate] = []
        for product in catalog.products:
            if "product_id" not in product:
                continue
            out.append(
                ProductCandidate(
                    product_id=str(product["product_id"]),
                    name=str(product.get("name", "")),
                    brand=product.get("brand"),
                    expected_weight_g=_as_float(product.get("gross_weight_g"))
                    or _as_float(product.get("net_weight_g")),
                    container_type=product.get("container_type"),
                    reference_image_paths=(),
                )
            )
        return out


__all__ = ["CloudCandidateSource"]
