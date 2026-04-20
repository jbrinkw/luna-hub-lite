"""`ReconcilerRepo` protocol → Bundle A repo adapter.

Translates between Bundle E's structural types (`ScaleEventLike`,
`SessionLike`, `LotLike`) and Bundle A's Pydantic dataclasses.

The adapter owns a single ``sqlite3.Connection`` plus the shared
``db_lock`` that guards all writes. Each repo method acquires the lock
for its own operation so the reconciler driver can spend most of its
wall-clock time doing in-memory work — letting the 500ms heartbeat path
interleave writes freely instead of blocking for the full reconcile
duration.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any, Optional

from ..cloud.integration import (
    ADD_SIDE_PATTERNS,
    CloudEventEmitter,
    REMOVE_SIDE_PATTERNS,
    _pick_occurred_at,
    null_emitter,
)
from ..reconciler.models import (
    ClassificationResult,
    LotLike,
    ReviewQueueItem,
    ScaleEventLike,
    SessionLike,
    SessionResolution,
    normalize_classification,
)
from ..storage import repo as storage_repo
from ..storage.models import (
    AppStatePatch,
    LotIn,
    ReviewQueueIn,
    SessionResolutionIn,
    UsageLogIn,
)

log = logging.getLogger(__name__)


@dataclass
class _EventView:
    """Lightweight shape satisfying :class:`ScaleEventLike`.

    Bundle A's ``ScaleEvent`` row stores ``classification`` as a JSON
    string — the reconciler expects a structured object, so we parse
    on the way out.
    """

    event_id: str
    session_id: Optional[str]
    ts: str
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: str
    classification: Any


@dataclass
class _LotView:
    lot_id: str
    product_id: str
    status: str
    current_weight_g: Optional[float]


@dataclass
class _SessionView:
    session_id: str
    started_at: str
    ended_at: Optional[str]
    initial_shelf_weight_g: Optional[float]
    final_shelf_weight_g: Optional[float]
    # Idempotency flag — ``reconcile_session`` checks this to avoid
    # re-writing session_resolutions and double-counting consumption
    # on duplicate close events (hysteresis wobble, manual retry, etc.).
    reconciled: int = 0


def _decode_classification(raw: Optional[str]) -> Any:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return raw
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("reconciler_repo: invalid classification JSON: %r", raw[:120])
        return None


class RepoReconcilerAdapter:
    """Concrete :class:`reconciler.ReconcilerRepo` implementation.

    Fix 1: every method acquires ``db_lock`` for its own short DB op so
    the reconciler driver never holds the lock across dozens of calls.
    Heartbeat writes at 500ms cadence can now interleave between repo
    method invocations instead of waiting for the entire reconcile.

    ``db_lock`` is optional for backwards compatibility with tests that
    construct the adapter without threading; a no-op context manager is
    used in that case.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        db_lock: Optional[threading.Lock] = None,
        *,
        cloud_emitter: Optional[CloudEventEmitter] = None,
        scale_id: str = "scale-01",
        shelf_kind: str = "live_shelf",
    ) -> None:
        self._conn = conn
        # ``contextlib.nullcontext`` is a zero-cost no-op — tests that pass
        # ``None`` behave exactly as before (unlocked single-threaded).
        self._db_lock: Any = db_lock if db_lock is not None else contextlib.nullcontext()
        # Cloud event emitter — no-op by default so tests + legacy
        # callers keep working. ``app.py`` injects a real emitter when
        # CLOUD_ENABLED=true so each reconciler-written resolution also
        # lands an outbox row for the background CloudWorker to drain.
        self._cloud_emitter: CloudEventEmitter = (
            cloud_emitter if cloud_emitter is not None else null_emitter()
        )
        self._scale_id = scale_id
        self._shelf_kind = shelf_kind

    # ---------------------------------------------------------- reads

    def get_session(self, session_id: str) -> SessionLike:
        with self._db_lock:
            row = storage_repo.get_session(self._conn, session_id)
        if row is None:
            raise LookupError(f"session not found: {session_id!r}")
        return _SessionView(
            session_id=row.session_id,
            started_at=row.started_at,
            ended_at=row.ended_at,
            initial_shelf_weight_g=row.initial_shelf_weight_g,
            final_shelf_weight_g=row.final_shelf_weight_g,
            reconciled=int(getattr(row, "reconciled", 0) or 0),
        )

    def get_events_for_session(
        self, session_id: str, include_failed: bool = False
    ) -> list[ScaleEventLike]:
        with self._db_lock:
            rows = storage_repo.list_events_for_session(self._conn, session_id)
        out: list[ScaleEventLike] = []
        # Fix 1: filter out ``failed`` (no usable classification) and
        # ``pending`` (still being processed) events so the reconciler
        # only sees events that have a real classifier decision. Without
        # this, a pending event racing the reconcile would produce an
        # "unknown" resolution that never gets corrected, and a failed
        # event would feed garbage classification data into the pairing
        # logic. Callers can pass include_failed=True to opt out (e.g.
        # audit tooling that wants the full set).
        allowed_statuses = {"classified", "review"}
        for ev in rows:
            if not include_failed:
                status = getattr(ev, "classifier_status", None)
                if status is not None and status not in allowed_statuses:
                    continue
            # Reconciler expects 'add' | 'remove' | 'noise'; we filter
            # 'noise' here to match §8 (noise contributes nothing).
            out.append(
                _EventView(
                    event_id=ev.event_id,
                    session_id=ev.session_id,
                    ts=ev.ts,
                    delta_g=ev.delta_g,
                    before_weight_g=ev.before_weight_g,
                    after_weight_g=ev.after_weight_g,
                    direction=ev.direction,
                    classification=_decode_classification(ev.classification),
                )
            )
        return out

    def get_lot(self, lot_id: str) -> Optional[LotLike]:
        """Resolve an id to a lot. Accepts product_ids too.

        The classifier returns ``item_id`` as a lot_id for lot-backed
        candidates and as a product_id for ``catalog_not_on_shelf``
        picks. If the id doesn't match a lot directly, fall back to
        looking up the product's current on-shelf lot (which the scale
        handler minted inline in §5.3). This keeps the reconciler's
        Pass 3 ``new_arrival`` branch correct: it always writes a real
        ``lot_id`` into ``session_resolutions`` so the FK to ``lots``
        holds.
        """
        with self._db_lock:
            lot = storage_repo.get_lot(self._conn, lot_id)
            if lot is None:
                # Maybe this id is a product_id — look up an on-shelf
                # lot for that product. This is the common case for
                # catalog_not_on_shelf picks once the scale handler has
                # minted the lot inline.
                row = self._conn.execute(
                    """
                    SELECT * FROM lots
                     WHERE product_id = ? AND status = 'on_shelf'
                     ORDER BY placed_at DESC
                     LIMIT 1
                    """,
                    (lot_id,),
                ).fetchone()
                if row is not None:
                    # Re-use the same row->Lot helper the repo uses
                    # internally so we don't drift on column names.
                    from ..storage.repo import _row_to_lot  # type: ignore
                    lot = _row_to_lot(row)
        if lot is None:
            return None
        return _LotView(
            lot_id=lot.lot_id,
            product_id=lot.product_id,
            status=lot.status,
            current_weight_g=lot.current_weight_g,
        )

    def list_existing_resolutions(
        self, session_id: str
    ) -> list[SessionResolution]:
        """Return previously-written session_resolutions (IN_FLIGHT_TRACKER_PLAN.md §7)."""
        with self._db_lock:
            rows = storage_repo.list_resolutions_for_session(self._conn, session_id)
        out: list[SessionResolution] = []
        for r in rows:
            out.append(
                SessionResolution(
                    session_id=r.session_id,
                    pattern=r.pattern,
                    lot_id=r.lot_id,
                    consumed_g=r.consumed_g,
                    confidence=r.confidence,
                    add_event_id=r.add_event_id,
                    remove_event_id=r.remove_event_id,
                )
            )
        return out

    # ---------------------------------------------------------- writes

    def mark_session_reconciled(self, session_id: str) -> None:
        """Flip ``sessions.reconciled = 1`` atomically.

        H3: the reconciler calls this as the FIRST write inside
        ``_reconcile_session_locked`` so a crash or retry after that
        point is short-circuited by the idempotency guard at the top of
        the same function. ``app.py`` keeps its post-reconcile call as
        an extra safety net; the storage function is idempotent (UPDATE
        to same value).
        """
        with self._db_lock:
            storage_repo.mark_session_reconciled(self._conn, session_id)

    def write_resolution(
        self, resolution: SessionResolution
    ) -> Optional[str]:
        with self._db_lock:
            written = storage_repo.write_resolution(
                self._conn,
                SessionResolutionIn(
                    session_id=resolution.session_id,
                    pattern=resolution.pattern,
                    lot_id=resolution.lot_id,
                    consumed_g=resolution.consumed_g,
                    confidence=resolution.confidence,
                    add_event_id=resolution.add_event_id,
                    remove_event_id=resolution.remove_event_id,
                ),
            )
            # Cloud mirror — emit the matching outbox row while still
            # holding db_lock so concurrent writes can't interleave a
            # row between the local resolution commit and the outbox
            # insert. See ``server/cloud/integration.py`` for the full
            # transactional-boundary discussion. Passing the newly-
            # minted resolution_id lets the startup back-fill scan
            # (finding #5) cross-reference outbox rows against
            # session_resolutions.
            self._emit_cloud_for_resolution(
                resolution, resolution_id=written.resolution_id,
            )
        return written.resolution_id

    def _emit_cloud_for_resolution(
        self,
        resolution: SessionResolution,
        *,
        resolution_id: Optional[str] = None,
    ) -> None:
        """Derive + enqueue the cloud event that mirrors ``resolution``.

        Safe to call unconditionally — the emitter is a no-op when
        ``CLOUD_ENABLED=false``. Any derivation failure is logged +
        swallowed; the local resolution has already landed.
        """
        if not self._cloud_emitter.enabled:
            return
        # Resolve product_id from lot_id. Unknown / no_op resolutions
        # have lot_id=None and won't produce a cloud event anyway (the
        # pattern→event_kind map returns None for those).
        if resolution.lot_id is None:
            return
        try:
            product_id: Optional[str] = None
            lot = storage_repo.get_lot(self._conn, resolution.lot_id)
            if lot is not None:
                product_id = lot.product_id
            else:
                # Could be a catalog product_id (catalog_not_on_shelf
                # classifier pick that minted a lot later). Treat the
                # id itself as product_id only if it actually matches a
                # products row — otherwise we'd spam the cloud with 400s.
                product = storage_repo.get_product(
                    self._conn, resolution.lot_id
                )
                if product is not None:
                    product_id = product.product_id
            if not product_id:
                return

            # Derive signed delta_g. Sign convention: negative=stock drop
            # (consumed), positive=stock rise (refilled/added).
            delta_g = self._derive_delta_g_from_resolution(resolution)
            if delta_g == 0.0:
                # No quantity change — nothing meaningful to sync.
                return

            # occurred_at: prefer the triggering event ts (add for
            # add-side patterns, remove for remove-side) so cloud
            # analytics use the wall-clock moment the user acted.
            occurred_at = self._pick_occurred_at(resolution)

            self._cloud_emitter.emit_reconciler_resolution(
                pattern=resolution.pattern,
                product_id=product_id,
                scale_id=self._scale_id,
                kind=self._shelf_kind,
                delta_g=delta_g,
                occurred_at=occurred_at,
                resolution_id=resolution_id,
            )
        except Exception:  # noqa: BLE001 - cloud mirror must not fail callers
            log.warning(
                "cloud emit failed for resolution pattern=%s lot=%s",
                resolution.pattern, resolution.lot_id, exc_info=True,
            )

    def _derive_delta_g_from_resolution(
        self, resolution: SessionResolution
    ) -> float:
        """Compute the signed cloud delta_g for a local resolution.

        Precondition: caller must hold ``db_lock`` — this method reads
        through ``storage_repo.get_event`` for the consumed_or_removed
        fallback and the new_arrival branch.

        * use_return_consumed: consumed_g>0 → delta = -consumed_g
        * topped_up: consumed_g<0 (it's a negative consumption aka an
          addition) → delta = -consumed_g (positive refill amount)
        * consumed_or_removed: consumed_g may be None; fall back to
          |remove_event.delta_g| as the lost mass
        * new_arrival: |add_event.delta_g| (positive)
        * in_flight_ttl_expired / in_flight_return /
          in_flight_replaced_new_item: consumed_g>0 → delta = -consumed_g
        """
        pattern = resolution.pattern
        consumed = resolution.consumed_g
        if pattern in ("use_return_consumed", "topped_up"):
            if consumed is None:
                return 0.0
            if pattern == "topped_up" and float(consumed) == 0.0:
                # Zero-consumption topped_up means the user added and
                # returned the same mass — nothing to mirror. We return
                # 0 here and ``_emit_cloud_for_resolution`` short-circuits
                # on ``delta_g == 0.0``. Log so this isn't silent when
                # debugging a missing cloud event.
                log.debug(
                    "cloud emit: dropping topped_up resolution with "
                    "consumed_g=0 (session=%s, lot=%s)",
                    resolution.session_id, resolution.lot_id,
                )
                return 0.0
            # Finding #15: sign guard. use_return_consumed means the
            # user took the container off, used it, and put it back.
            # consumed_g should be positive (mass dropped). A NEGATIVE
            # consumed_g here would mean the return weighed MORE than
            # the pickup — which can happen from scale noise if the
            # reconciler slipped through the noise floor. Emitting
            # ``-(-X) = +X`` would flip the sign on the cloud and be
            # classified as a "consumed" event with a positive delta
            # (wrong sign → stock goes UP when user ate something).
            # Clamp to zero + log so the correction surfaces.
            if pattern == "use_return_consumed" and float(consumed) < 0:
                log.warning(
                    "reconciler cloud emit: use_return_consumed with "
                    "negative consumed_g=%.3f (session=%s, lot=%s) — "
                    "return heavier than pickup after noise floor; "
                    "skipping cloud event to avoid wrong-sign delta",
                    float(consumed), resolution.session_id,
                    resolution.lot_id,
                )
                return 0.0
            return -float(consumed)
        if pattern in (
            "in_flight_return",
            "in_flight_replaced_new_item",
            "in_flight_ttl_expired",
        ):
            if consumed is None or consumed <= 0:
                return 0.0
            return -float(consumed)
        if pattern == "consumed_or_removed":
            if consumed is not None and consumed > 0:
                return -float(consumed)
            # Fall back to the remove event's magnitude.
            if resolution.remove_event_id:
                ev = storage_repo.get_event(
                    self._conn, resolution.remove_event_id
                )
                if ev is not None:
                    return -abs(float(ev.delta_g or 0.0))
            return 0.0
        if pattern == "new_arrival":
            if resolution.add_event_id:
                ev = storage_repo.get_event(
                    self._conn, resolution.add_event_id
                )
                if ev is not None:
                    return abs(float(ev.delta_g or 0.0))
            return 0.0
        return 0.0

    def _pick_occurred_at(
        self, resolution: SessionResolution
    ) -> Optional[str]:
        """Pick the most-representative event ts for a resolution.

        Precondition: caller must hold ``db_lock`` — this method reads
        through ``storage_repo.get_event``.

        Delegates the side classification to
        :func:`server.cloud.integration._pick_occurred_at` so the
        reconciler + back-fill paths read the same
        :data:`REMOVE_SIDE_PATTERNS` / :data:`ADD_SIDE_PATTERNS` sets.
        Pass-2 audit finding #13 consolidated those sets to
        ``cloud.integration``.

        Returns None if neither side has a real event timestamp — the
        emitter stamps ``datetime.now()`` in that case.
        """
        # Resolve both event ts' eagerly. Either can be None when the
        # resolution is one-sided (e.g. ``new_arrival`` has only an
        # add_event_id; ``consumed_or_removed`` has only a remove).
        add_ts: Optional[str] = None
        remove_ts: Optional[str] = None
        if resolution.add_event_id:
            ev = storage_repo.get_event(self._conn, resolution.add_event_id)
            if ev is not None:
                add_ts = ev.ts
        if resolution.remove_event_id:
            ev = storage_repo.get_event(self._conn, resolution.remove_event_id)
            if ev is not None:
                remove_ts = ev.ts
        # No fallback ts available at this layer — the emitter will
        # stamp ``datetime.now()`` when both sides are None.
        return _pick_occurred_at(
            resolution.pattern, remove_ts, add_ts, fallback_ts=None,
        )

    def enqueue_review(self, item: ReviewQueueItem) -> None:
        proposed_json = (
            json.dumps(item.proposed) if item.proposed is not None else None
        )
        images_json = (
            json.dumps(item.images) if item.images is not None else None
        )
        with self._db_lock:
            storage_repo.enqueue_review(
                self._conn,
                ReviewQueueIn(
                    kind=item.kind,
                    session_id=item.session_id,
                    event_id=item.event_id,
                    resolution_id=item.resolution_id,
                    proposed=proposed_json,
                    images=images_json,
                ),
            )

    def update_lot_on_resolution(
        self,
        resolution: SessionResolution,
        lot: Optional[LotLike],
    ) -> None:
        """Apply a committed resolution's side-effect to the affected lot.

        See docstring in :class:`reconciler.ReconcilerRepo`. We read the
        add event (if present) to refresh the lot's current weight and
        last_seen timestamp, mirroring §5.3 semantics but driven from
        the reconciler.

        Each storage call is individually locked — we never hold the
        lock across the full method, but we do keep reads and the
        follow-up write close together (under a single ``with`` block)
        so a heartbeat can't rewrite fields we just read.

        Special case: ``new_arrival`` resolutions whose ``lot_id`` is
        actually a product_id (catalog_not_on_shelf classifier pick)
        arrive here with ``lot=None``. We mint the lot on the fly so
        the item actually lands on the shelf after reconciliation.
        """
        if resolution.lot_id is None:
            return
        pattern = resolution.pattern

        # Handle new_arrival with a product_id → mint a lot now. The
        # scale handler already does this inline for confident ADDs;
        # this branch covers edge cases where a new_arrival reached the
        # reconciler (e.g., low-confidence ADDs that later got approved
        # out-of-band, or tests that only exercise reconciliation).
        if lot is None and pattern == "new_arrival" and resolution.add_event_id:
            with self._db_lock:
                product = storage_repo.get_product(self._conn, resolution.lot_id)
                ev = storage_repo.get_event(self._conn, resolution.add_event_id)
                if product is not None and ev is not None:
                    # Use the delta (the item's own mass), not the
                    # whole-scale reading. Multi-item shelves have other
                    # items weighing down the scale too.
                    lot_weight = abs(float(ev.delta_g or 0.0))
                    try:
                        storage_repo.create_lot(
                            self._conn,
                            LotIn(
                                product_id=product.product_id,
                                status="on_shelf",
                                current_weight_g=lot_weight,
                                initial_weight_g=lot_weight,
                                total_consumed_g=0.0,
                                placed_at=ev.ts,
                                last_seen_at=ev.ts,
                            ),
                        )
                        log.info(
                            "reconciler: minted lot for product %s via new_arrival",
                            product.product_id,
                        )
                    except Exception:  # pragma: no cover - defensive
                        log.exception(
                            "reconciler: failed to mint lot for product %s",
                            product.product_id,
                        )
            return
        if lot is None:
            return
        if pattern in ("use_return_no_consumption", "use_return_consumed", "topped_up"):
            new_weight: Optional[float] = None
            last_seen_at: Optional[str] = None
            with self._db_lock:
                if resolution.add_event_id:
                    ev = storage_repo.get_event(self._conn, resolution.add_event_id)
                    if ev is not None:
                        # See comment on new_arrival — use the delta, not
                        # the whole-scale reading.
                        new_weight = abs(float(ev.delta_g or 0.0))
                        last_seen_at = ev.ts
                current = lot.current_weight_g or 0.0
                consumed = resolution.consumed_g or 0.0
                # Only add positive consumption to the running total.
                total_consumed_delta = max(0.0, consumed)
                existing = storage_repo.get_lot(self._conn, lot.lot_id)
                total_prev = existing.total_consumed_g if existing else 0.0
                storage_repo.update_lot(
                    self._conn,
                    lot.lot_id,
                    status="on_shelf",
                    current_weight_g=new_weight if new_weight is not None else current,
                    total_consumed_g=total_prev + total_consumed_delta,
                    last_seen_at=last_seen_at,
                )
            # Usage log — reconciler emits one row per use_return_consumed
            # resolution. Best-effort; swallows exceptions. The unique
            # index on pickup_event_id is a secondary guard — if the
            # fast-path already logged this event's pickup, the write
            # returns None silently.
            if pattern == "use_return_consumed" and consumed > 0:
                try:
                    with self._db_lock:
                        product = storage_repo.get_product(
                            self._conn, lot.product_id
                        ) if lot.product_id else None
                        if product is not None:
                            occurred_at = last_seen_at or (
                                existing.last_seen_at if existing else ""
                            )
                            storage_repo.write_usage_log(
                                self._conn,
                                UsageLogIn(
                                    lot_id=lot.lot_id,
                                    product_id=product.product_id,
                                    product_name=product.name,
                                    product_brand=product.brand,
                                    container_type=product.container_type,
                                    consumed_g=float(consumed),
                                    pickup_weight_g=None,
                                    return_weight_g=new_weight,
                                    kind="reconciler_use_return",
                                    session_id=resolution.session_id,
                                    # use the resolution's remove_event_id
                                    # (the pickup half of the pair) so the
                                    # unique dedup index on pickup_event_id
                                    # actually engages. Passing None here
                                    # defeated the guard: repeated reconciler
                                    # runs for the same pair would each land
                                    # a fresh row. classify_pair's caller
                                    # populates remove_event_id for every
                                    # use_return_consumed pair.
                                    pickup_event_id=resolution.remove_event_id,
                                    return_event_id=resolution.add_event_id,
                                    occurred_at=occurred_at,
                                ),
                            )
                except Exception:  # pragma: no cover - defensive
                    log.warning(
                        "reconciler: usage_log write failed for lot %s",
                        lot.lot_id, exc_info=True,
                    )
        elif pattern == "consumed_or_removed":
            # Item is out; §8 says status stays 'out' — no-op here.
            pass
        elif pattern in ("swap_out",):
            # The lot left (we already marked it 'out' at event time).
            pass
        elif pattern == "swap_in":
            # The returning lot is now on-shelf; weight = this item's
            # delta, not the whole-scale reading.
            if resolution.add_event_id:
                with self._db_lock:
                    ev = storage_repo.get_event(self._conn, resolution.add_event_id)
                    if ev is not None:
                        storage_repo.update_lot(
                            self._conn,
                            lot.lot_id,
                            status="on_shelf",
                            current_weight_g=abs(float(ev.delta_g or 0.0)),
                            last_seen_at=ev.ts,
                        )
        elif pattern == "new_arrival":
            if resolution.add_event_id:
                with self._db_lock:
                    ev = storage_repo.get_event(self._conn, resolution.add_event_id)
                    if ev is not None:
                        storage_repo.update_lot(
                            self._conn,
                            lot.lot_id,
                            status="on_shelf",
                            current_weight_g=abs(float(ev.delta_g or 0.0)),
                            last_seen_at=ev.ts,
                        )
        # 'unknown', 'no_op', 'relocation' → nothing to apply.


__all__ = ["RepoReconcilerAdapter"]
