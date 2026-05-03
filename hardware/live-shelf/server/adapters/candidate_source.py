"""`CandidateSource` protocol → Bundle A repo adapter.

Produces `LotCandidate` / `ProductCandidate` tuples for the classifier's
pool assembly. Reference image file paths are absolute filesystem paths
so the classifier's prompt module (which does base64 loads) can open
them directly.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional, Sequence

from ..classifier.models import LotCandidate, ProductCandidate
from ..storage import repo as storage_repo
from ..tools.locks import NullLock as _NullLock


class RepoCandidateSource:
    """Concrete :class:`classifier.models.CandidateSource` implementation.

    The classifier invokes this from within one classify_event() call, so
    every method returns a freshly-queried snapshot — no caching at this
    layer.

    Parameters
    ----------
    conn:
        Open ``sqlite3.Connection`` used for read-side queries.
    refs_root:
        Absolute path under which reference images live. File paths stored
        in ``product_reference_images`` are relative to this root.
    db_lock:
        Shared lock protecting the single sqlite3 connection from
        concurrent use across threads. The classifier dispatches on a
        background thread while heartbeats, sweepers, and Flask request
        handlers can all hit the same connection — without this lock
        reads here race with concurrent writes and SQLite surfaces the
        cryptic ``InterfaceError: bad parameter or other API misuse``.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        refs_root: Path,
        db_lock: Optional[threading.Lock] = None,
    ) -> None:
        self._conn = conn
        self._refs_root = Path(refs_root)
        self._db_lock: Any = db_lock if db_lock is not None else _NullLock()

    # ---------------------------------------------------------------- helpers

    def _absolute_refs(self, product_id: str) -> tuple[str, ...]:
        """Resolve every reference image path for a product to absolute disk.

        Caller MUST hold ``self._db_lock`` — this is a helper for the
        query methods below, not a public entrypoint.
        """
        rows = storage_repo.list_reference_images(self._conn, product_id)
        paths: list[str] = []
        for row in rows:
            rel = row.file_path or ""
            if not rel:
                continue
            p = self._refs_root / rel
            paths.append(str(p))
        return tuple(paths)

    # -------------------------------------------------------- protocol surface

    def get_on_shelf_lots(
        self, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        with self._db_lock:
            registry = storage_repo.get_shelf_registry(
                self._conn, shelf_id=shelf_id
            )
            out: list[LotCandidate] = []
            for item in registry:
                lot = item.lot
                product = item.product
                out.append(
                    LotCandidate(
                        lot_id=lot.lot_id,
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        expected_weight_g=lot.current_weight_g,
                        container_type=product.container_type,
                        status="on_shelf",
                        reference_image_paths=self._absolute_refs(product.product_id),
                    )
                )
            return out

    def get_recently_out_lots(
        self, window_seconds: int, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        with self._db_lock:
            rows = storage_repo.get_recently_out_lots(
                self._conn, window_seconds, shelf_id=shelf_id
            )
            out: list[LotCandidate] = []
            for item in rows:
                lot = item.lot
                product = item.product
                out.append(
                    LotCandidate(
                        lot_id=lot.lot_id,
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        # Last known weight for out-lots (container still full
                        # from last placement until we know otherwise).
                        expected_weight_g=lot.current_weight_g
                        or product.gross_weight_g,
                        container_type=product.container_type,
                        status="out",
                        reference_image_paths=self._absolute_refs(product.product_id),
                    )
                )
            return out

    def get_in_flight_lots(
        self,
        max_age_seconds: int | None = None,
        shelf_id: str | None = None,
    ) -> Sequence[LotCandidate]:
        """Return lots with status='in_flight'.

        expected_weight_g is set to ``pickup_weight_g`` so the classifier
        scores against the weight the user took, not the stale shelf reading.
        See IN_FLIGHT_TRACKER_PLAN.md §5.3. ``shelf_id`` optionally scopes
        the query to one physical shelf (CATCH_ALL_SCALE_PLAN.md §5.2).
        """
        with self._db_lock:
            lots = storage_repo.list_in_flight_lots(
                self._conn,
                younger_than_seconds=max_age_seconds,
                shelf_id=shelf_id,
            )
            # Batch-fetch the joined products in ONE SELECT rather than
            # one-per-lot under the held DB lock. For N in-flight lots this
            # collapses N+1 round-trips down to 2 (list_in_flight_lots +
            # get_products_by_ids), regardless of batch size.
            products_by_id = storage_repo.get_products_by_ids(
                self._conn, [lot.product_id for lot in lots]
            )
            out: list[LotCandidate] = []
            for lot in lots:
                product = products_by_id.get(lot.product_id)
                if product is None:
                    continue
                out.append(
                    LotCandidate(
                        lot_id=lot.lot_id,
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        # Pickup weight is what the user is holding — the
                        # weight we expect the ADD delta to match (minus
                        # consumption).
                        expected_weight_g=(
                            lot.pickup_weight_g
                            if lot.pickup_weight_g is not None
                            else lot.current_weight_g
                        ),
                        container_type=product.container_type,
                        status="in_flight",
                        reference_image_paths=self._absolute_refs(product.product_id),
                    )
                )
            return out

    def get_inventory_only_products(
        self, shelf_id: str | None = None
    ) -> Sequence[ProductCandidate]:
        """Products with cloud_lots inventory but no Pi lot on this shelf.

        Closes the regression introduced by commit ``3b99043`` (decision
        #45 / 2026-04-27): the ADD candidate pool was reading the
        Pi-local ``lots`` table only, which is empty until the user has
        physically placed a product on this shelf at least once. The
        intended invariant is "product must be in inventory" — and
        inventory means cloud ``stock_lots`` (mirrored as ``cloud_lots``
        on the Pi), NOT the Pi's physical-shelf ``lots`` table.

        Returns ``ProductCandidate`` rows whose underlying lot is the
        cloud-side stock_lot — there is no Pi ``lot_id`` to attach.
        The apply path handles this case in
        :meth:`scale_events._apply_lot_update_from_classification` by
        minting a Pi-local ``lots`` row to mirror the cloud lot when
        the classifier picks the product.
        """
        with self._db_lock:
            rows = storage_repo.list_inventory_only_products(
                self._conn, shelf_id=shelf_id,
            )
            out: list[ProductCandidate] = []
            for product in rows:
                out.append(
                    ProductCandidate(
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        # Prefer gross weight (full container) over net
                        # — matches get_certified_not_on_shelf's choice.
                        # The classifier uses this only as a tiebreaker
                        # for ranking; weight is no longer a gate
                        # (decision #45).
                        expected_weight_g=product.gross_weight_g
                        or product.net_weight_g,
                        container_type=product.container_type,
                        reference_image_paths=self._absolute_refs(
                            product.product_id
                        ),
                    )
                )
            return out

    def get_certified_not_on_shelf(self) -> Sequence[ProductCandidate]:
        # Fix: query ALL certified products, not just those lacking an
        # on-shelf lot. The method name is kept for protocol compatibility,
        # but the semantic is now "certified products eligible as ADD
        # catalog candidates" — which includes products that already have
        # an on-shelf lot so the classifier can still match a second-unit
        # placement of the same SKU. Dedupe in candidate_pool.py keys on
        # candidate_id (lot_id vs product_id), so a product appearing as
        # both a top-up target and a catalog entry is preserved in both
        # roles without collision. See get_all_certified_products in
        # storage/repo.py for the full rationale.
        with self._db_lock:
            rows = storage_repo.get_all_certified_products(self._conn)
            out: list[ProductCandidate] = []
            for product in rows:
                out.append(
                    ProductCandidate(
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        # Prefer gross weight for "how heavy is a full container";
                        # net_weight alone omits the packaging.
                        expected_weight_g=product.gross_weight_g
                        or product.net_weight_g,
                        container_type=product.container_type,
                        reference_image_paths=self._absolute_refs(product.product_id),
                    )
                )
            return out

    # ----------------------------------------------------------------
    # Catch-all delta-capture pool sources (CATCH_ALL_SCALE_PLAN.md
    # §"Pi catch-all candidate pool builder", 2026-04-27).
    #
    # Both methods serve LotCandidates for the catch-all-only pool —
    # the catch-all flow is lot-level (multiple lots may coexist) so
    # the classifier sees individual lots rather than collapsed
    # products. Apply path then routes by lot_id directly.
    # ----------------------------------------------------------------

    def get_catch_all_in_flight_lots(self) -> Sequence[LotCandidate]:
        """Tier 1 of the catch-all pool — lots mid-measurement.

        Cloud-mirrored ``cloud_lots`` rows with
        ``in_flight_kind='catch_all'``. Each lot's
        ``expected_weight_g`` is its ``pickup_weight_g`` (snapshot at
        first-event time) — but we don't have direct access to the
        snapshot here because cloud_lots doesn't mirror
        pickup_weight_g; the gross_weight_g of the product is the best
        available proxy and is also what the classifier prompt builder
        expects.
        """
        with self._db_lock:
            rows = storage_repo.list_cloud_in_flight_catch_all_lots(self._conn)
            out: list[LotCandidate] = []
            for row in rows:
                (
                    lot_id, product_id, _qty, _ifsince, _pkid, _created,
                    p_name, p_brand, p_net, p_gross, p_container,
                ) = row
                if not product_id or not p_name:
                    # Orphan: cloud_lots has a product_id but products
                    # row is missing locally. Skip — without product
                    # metadata we can't build a usable candidate.
                    continue
                out.append(
                    LotCandidate(
                        lot_id=str(lot_id),
                        product_id=str(product_id),
                        name=str(p_name),
                        brand=p_brand,
                        expected_weight_g=p_gross or p_net,
                        container_type=p_container,
                        # Reuse the existing in_flight status sentinel
                        # so downstream candidate_pool tier-rank logic
                        # treats this branch like the live_shelf
                        # in-flight branch.
                        status="in_flight",
                        reference_image_paths=self._absolute_refs(
                            str(product_id)
                        ),
                    )
                )
            return out

    def get_catch_all_inventory_lots(self) -> Sequence[LotCandidate]:
        """Tier 2 of the catch-all pool — certified lots on no shelf.

        Cloud-mirrored ``cloud_lots`` for certified products that
        aren't currently on any Pi shelf and aren't pinned to a
        LiveTrack scale. FEFO-ordered by ``created_at`` (oldest
        imported lot first) per the user's directive.
        """
        with self._db_lock:
            rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(
                self._conn,
            )
            out: list[LotCandidate] = []
            for row in rows:
                (
                    lot_id, product_id, _qty, _ifsince, _pkid, _created,
                    p_name, p_brand, p_net, p_gross, p_container,
                ) = row
                if not product_id or not p_name:
                    continue
                out.append(
                    LotCandidate(
                        lot_id=str(lot_id),
                        product_id=str(product_id),
                        name=str(p_name),
                        brand=p_brand,
                        expected_weight_g=p_gross or p_net,
                        container_type=p_container,
                        # No "off-shelf certified inventory" status in
                        # the LotCandidate enum — borrow ``out`` as the
                        # closest match (the lot is logically off any
                        # shelf). Tier ranking is driven by why_candidate
                        # set in candidate_pool, not status, so this
                        # is purely cosmetic.
                        status="out",
                        reference_image_paths=self._absolute_refs(
                            str(product_id)
                        ),
                    )
                )
            return out

    def get_catch_all_user_inventory_lots(self) -> Sequence[LotCandidate]:
        """Tier 2 of the catch-all auto-import — every qty>0 lot for the user.

        Widens the legacy :meth:`get_catch_all_inventory_lots` from
        "certified-not-on-any-shelf" to "every cloud_lots row with
        qty>0", regardless of certification status or shelf presence
        (except already-in-flight on catch-all, which is excluded to
        avoid double-counting against Tier 1).

        Used when the user places a product they own — whether it was
        barcode-scanned without a livetrack capture, manually added,
        or fully calibrated — on the catch-all scale. The classifier
        picks from this widened pool; the apply path writes tare from
        the AI estimate IFF the picked product currently has none.

        The legacy ``get_catch_all_inventory_lots`` STAYS — it's still
        used by the certified-only flow. This method is the new entry
        point for the auto-import pool builder (Task 4).
        """
        with self._db_lock:
            rows = storage_repo.list_user_inventory_lots_qty_gt_zero(
                self._conn
            )
            out: list[LotCandidate] = []
            for row in rows:
                # ``p_tare`` (products.tare_weight_g) is unpacked here
                # so the LotCandidate carries it through to the pool
                # builder, which uses it (paired with p_net) to flip
                # ``Candidate.needs_tare_estimate`` for AI tare
                # estimation when the product has no captured tare yet
                # (Task 5, catch-all auto-import).
                (
                    lot_id, product_id, _qty, _ifsince, _pkid, _created,
                    p_name, p_brand, p_net, p_gross, p_container, p_tare,
                ) = row
                if not product_id or not p_name:
                    # Orphan: cloud_lots has a product_id but no products
                    # row is mirrored locally. Skip — without product
                    # metadata we can't build a usable candidate.
                    continue
                out.append(
                    LotCandidate(
                        lot_id=str(lot_id),
                        product_id=str(product_id),
                        name=str(p_name),
                        brand=p_brand,
                        expected_weight_g=p_gross or p_net,
                        container_type=p_container,
                        # No "off-shelf inventory" status in the
                        # LotCandidate enum — borrow ``out`` (closest
                        # match: lot is logically off any shelf). Tier
                        # ranking is driven by why_candidate set in
                        # candidate_pool, not status.
                        status="out",
                        reference_image_paths=self._absolute_refs(
                            str(product_id)
                        ),
                        # Catch-all auto-import (Task 5): thread
                        # tare/net so the pool builder can flag
                        # candidates with no tare captured.
                        tare_weight_g=p_tare,
                        net_weight_g=p_net,
                    )
                )
            return out

    def get_certified_livetrack_tracked(self) -> Sequence[ProductCandidate]:
        """Fallback pool — all certified LiveTrack-tracked products.

        Used by the opt-in classifier fallback pass (see
        :mod:`server.classifier.fallback`). The classifier only consults
        this pool when pass-1 returns UNKNOWN / low confidence AND the
        per-user toggle ``chefbyte_classifier_fallback_enabled`` is on.

        "LiveTrack-tracked" = ``products.tare_weight_g IS NOT NULL``.
        The web UI's "LiveTrack" badge keys off the same predicate.
        """
        with self._db_lock:
            rows = storage_repo.get_certified_livetrack_tracked_products(
                self._conn,
            )
            out: list[ProductCandidate] = []
            for product in rows:
                out.append(
                    ProductCandidate(
                        product_id=product.product_id,
                        name=product.name,
                        brand=product.brand,
                        expected_weight_g=product.gross_weight_g
                        or product.net_weight_g,
                        container_type=product.container_type,
                        reference_image_paths=self._absolute_refs(
                            product.product_id
                        ),
                    )
                )
            return out


__all__ = ["RepoCandidateSource"]
