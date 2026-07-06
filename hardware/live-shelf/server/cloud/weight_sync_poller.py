"""Background thread that streams per-lot live weights to the cloud.

The catch-all scale already streams its current lot weight to the cloud
between formal pickup/return events via the
``catch_all_first_measurement`` / ``_second_measurement`` event pair (see
``handlers/scale_events.py`` and migrations
``20260427120000_catch_all_delta_capture_model.sql`` /
``20260427130000_catch_all_delta_apply.sql``). Live_shelf and live_scale
lots only sync at event boundaries — between events the cloud's view of
qty is correct but the physical weight on the scale right now is
invisible.

This poller closes that gap. Every ``WEIGHT_SYNC_INTERVAL_S`` it scans
the Pi's ``lots`` table for live_shelf + single_item rows whose
``current_weight_g`` has materially changed since the last successful
emit (or whose TTL has elapsed) and enqueues a ``live_weight_sync``
cloud event via :class:`CloudEventEmitter.emit_live_weight_sync`. The
cloud handler updates ONLY ``stock_lots.last_observed_weight_g`` +
``last_observed_at`` (qty stays event-driven, no food_logs).

Cadence + throttle policy
-------------------------
Two gates decide whether a row gets emitted on a given tick:

1. **Significant-change** — ``abs(current - last_emitted) >= MIN_DELTA_G``.
   Sensors typically have ~1-2g noise; ``MIN_DELTA_G = 5g`` keeps the
   queue from flooding on quiescent shelves while catching real
   physical changes.
2. **TTL re-emit** — ``now - last_emitted_at >= TTL_S``. Even when the
   weight hasn't drifted, we re-emit every ``TTL_S = 300s`` so the
   cloud's ``last_observed_at`` stays warm. Without this, a stable lot
   would render as "last seen N hours ago" in the cloud UI even
   though the Pi is observing it continuously.

Either gate triggers an emit; both gates being false skips the row.

State (last_emitted_weight_g + last_emitted_at) is kept in-memory only
— a Pi restart re-emits everything on the next tick (which the cloud
handler dedupes via ``shelf_event_log`` UNIQUE(user_id, client_event_id)
on identical client_event_ids; here we generate a fresh UUID per emit
so post-reboot the cloud still updates with the latest reading).

Scope
-----
Only ``shelf_id IN ('live_shelf', 'single_item')`` lots are polled.
Catch-all lots are intentionally excluded — they have their own
delta-capture stream and we must not duplicate events for them.
Lots without a ``current_weight_g`` (``NULL``) are skipped (no
observation to emit). Lots that haven't been seen in a long time
(``status='out'`` or ``'depleted'``) are skipped — the qty is already
known to the cloud and the live weight reading isn't meaningful.

Failure handling
----------------
Mirrors :class:`LotSnapshotPoller` — exceptions in the tick swallow
into log lines so a transient sqlite hiccup or a single bad row
doesn't kill the thread. The :class:`CloudEventEmitter` itself is
already best-effort (queues into the outbox, drained by
:class:`CloudWorker`); enqueue failures are absorbed at that layer.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

from ._kind_translate import (
    CLOUD_LIVE_SCALE,
    CLOUD_LIVE_SHELF,
    PI_LIVE_SHELF,
    PI_SINGLE_ITEM,
    pi_to_cloud,
)
from .integration import CloudEventEmitter
from ..types_branded import CloudLotId, InvalidIdError, parse_cloud_lot_id

log = logging.getLogger(__name__)

# Callable that returns ``{device_id: {"weight_g": float, ...}}`` for
# every actively-heartbeating ESP scale. Implemented in production by
# ``server.handlers.scale_events.get_scale_runtime_state_snapshot`` (which
# wraps ``_SCALE_RUNTIME_STATE`` with TTL freshness gating). Stubbed in
# tests so the poller stays decoupled from the Flask handler module.
RuntimeStateProvider = Callable[[], Mapping[str, Mapping[str, object]]]


# Default cadence — every 30s the thread wakes and scans the lots
# table. The work per tick is cheap (one indexed SELECT, in-memory
# diff), so 30s is comfortable; we don't need to push faster because
# the cloud UI itself polls / reuses TanStack Query at minute-scale
# anyway. Configurable via constructor for tests.
WEIGHT_SYNC_INTERVAL_S: float = 30.0

# Significant-change threshold. HX711 load cells in this hardware
# typically settle to within ~0.5-2g of a stable reading; 5g leaves
# headroom for sensor noise without missing real placements /
# removals (a fingertip touch is usually 20g+).
DEFAULT_MIN_DELTA_G: float = 5.0

# TTL re-emit interval. A stable lot whose weight hasn't drifted past
# the threshold still needs the cloud's ``last_observed_at`` refreshed
# so the cloud UI shows a recent freshness signal. 5 minutes balances
# UI freshness against queue volume.
DEFAULT_TTL_S: float = 300.0


@dataclass
class _EmitMemory:
    """In-memory record of the last successful emit for one lot.

    Used by the throttle gates to decide whether the next tick should
    emit again. Non-persistent — a Pi reboot resets the memory and
    every lot re-emits on the first tick (cloud dedup on
    ``client_event_id`` makes the re-emit idempotent at the wire-format
    level, but with fresh UUIDs we always update the cloud's
    ``last_observed_at`` to reflect the post-reboot reality).
    """

    weight_g: float
    at_monotonic: float


class WeightSyncPoller(threading.Thread):
    """Periodic per-lot live-weight emitter for live_shelf + live_scale.

    See module docstring for cadence / throttle / scope details.
    """

    name = "weight-sync-poller"

    def __init__(
        self,
        emitter: CloudEventEmitter,
        conn: sqlite3.Connection,
        *,
        db_lock: Optional[threading.RLock] = None,
        interval_s: float = WEIGHT_SYNC_INTERVAL_S,
        min_delta_g: float = DEFAULT_MIN_DELTA_G,
        ttl_s: float = DEFAULT_TTL_S,
        live_shelf_scale_id: str = "scale-01",
        live_scale_scale_id: str = "scale-single",
        runtime_state_provider: Optional[RuntimeStateProvider] = None,
        shutdown_event: Optional[threading.Event] = None,
        clock: Optional[object] = None,
    ) -> None:
        """Construct the poller.

        Parameters
        ----------
        emitter:
            :class:`CloudEventEmitter` used to enqueue events. The poller
            short-circuits when ``emitter.enabled`` is false so callers
            can wire it unconditionally.
        conn:
            Shared sqlite connection — same handle used by the rest of
            the app. The poller only reads (``SELECT`` from ``lots``
            and ``scale_pairings``); it never writes.
        db_lock:
            Optional shared :class:`threading.RLock`. Held only across
            the SELECT phase so we never block writers for longer than
            it takes to read a few dozen rows.
        interval_s:
            Tick interval in seconds. Defaults to
            :data:`WEIGHT_SYNC_INTERVAL_S`.
        min_delta_g:
            Significant-change threshold in grams. See module docstring.
        ttl_s:
            TTL re-emit interval in seconds. See module docstring.
        live_shelf_scale_id, live_scale_scale_id:
            Scale ID strings stamped onto outbox payloads. Defaults
            mirror :meth:`ScaleHandler._scale_id_for_shelf`.
        runtime_state_provider:
            Callable returning ``{device_id: {"weight_g": float, ...}}``
            for actively-heartbeating ESP scales. Required for live_scale
            (single_item) lots: those lots are NOT mirrored into the Pi's
            ``lots`` table (the live_scale event handler emits cloud
            consumption events directly without lifecycle), so the only
            source of their current weight is the in-memory heartbeat
            state. ``None`` (default) disables live_scale streaming and
            falls back to live_shelf-only behavior.
        shutdown_event:
            Optional :class:`threading.Event` shared with the rest of
            the app's background-thread shutdown machinery.
        clock:
            Optional source of monotonic time for tests. Must expose a
            ``monotonic()`` callable. Defaults to :func:`time.monotonic`.
        """
        super().__init__(daemon=True, name=self.name)
        self._emitter = emitter
        self._conn = conn
        self._db_lock = db_lock
        self._interval_s = float(interval_s)
        self._min_delta_g = float(min_delta_g)
        self._ttl_s = float(ttl_s)
        self._live_shelf_scale_id = live_shelf_scale_id
        self._live_scale_scale_id = live_scale_scale_id
        self._runtime_state_provider = runtime_state_provider
        self._shutdown = shutdown_event or threading.Event()
        self._clock_monotonic = (
            clock.monotonic if clock is not None else time.monotonic
        )
        # Per-lot last-emit memory. Keyed by lot_id string.
        #
        # Note on stale keys after ambiguity collapse: when a product's
        # cloud_lots set collapses from 2→1 (e.g. one is consumed +
        # tombstoned), any throttle-memory entry keyed by the dropped
        # cloud_lot_id becomes stale. We deliberately don't GC it —
        # entries naturally fall out as new emissions overwrite or as
        # the process restarts. The memory cost (one float + one float
        # per dead lot_id) is negligible.
        self._memory: dict[str, _EmitMemory] = {}

        # Last-tick observability counters, surfaced via :attr:`last_tick_stats`
        # for /healthz. ``skipped_ambiguous_count`` counts PRODUCTS (not
        # Pi lots) skipped because >1 active cloud_lots matched on a given
        # tick (G5 fix, 2026-05-15) — operator action required: consolidate
        # the cloud lots, pair them to separate scales, or accept degraded
        # live-weight tracking for that product. ``skipped_collapsed_count``
        # counts CLOUD LOTS (C2-03 fix, 2026-06-15) skipped because >1 Pi
        # `lots` row collapsed onto the SAME cloud_lot_id (the inverse of
        # G5: one cloud lot, many Pi lots) — emitting both would thrash
        # ``last_observed_weight_g`` with conflicting weights every tick.
        self._last_tick_stats: dict[str, int] = {
            "candidates": 0,
            "emitted": 0,
            "skipped_ambiguous_count": 0,
            "skipped_collapsed_count": 0,
        }

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def last_tick_stats(self) -> Mapping[str, int]:
        """Read-only view of the last tick's counters (for /healthz).

        Keys:
          * ``candidates`` — number of rows returned from the candidate fetch
            (after ambiguity-skip + collapse-skip + dedup, before throttle
            gates).
          * ``emitted`` — number of events actually emitted on the last tick.
          * ``skipped_ambiguous_count`` — number of PRODUCTS (not lots)
            skipped because >1 active cloud_lots matched. See G5 (2026-05-15).
          * ``skipped_collapsed_count`` — number of CLOUD LOTS skipped
            because >1 Pi `lots` row collapsed onto the same cloud_lot_id
            (the inverse of G5). See C2-03 (2026-06-15).
        """
        return dict(self._last_tick_stats)

    def tick_once(self) -> int:
        """Run one scan pass. Returns the number of events emitted.

        Idempotent under exceptions — a sqlite error mid-scan logs and
        returns the partial count. Safe to call from tests.
        """
        # Reset tick counters at the top so callers (and /healthz) see
        # the latest tick in isolation. We always set these even on the
        # short-circuit path so a disabled emitter doesn't leave stale
        # numbers visible.
        self._last_tick_stats = {
            "candidates": 0,
            "emitted": 0,
            "skipped_ambiguous_count": 0,
            "skipped_collapsed_count": 0,
        }
        if not self._emitter.enabled:
            return 0
        try:
            rows = self._fetch_candidates()
        except sqlite3.Error:
            log.warning(
                "weight_sync: candidate fetch failed", exc_info=True,
            )
            return 0
        self._last_tick_stats["candidates"] = len(rows)
        emitted = 0
        now_mono = float(self._clock_monotonic())
        for row in rows:
            try:
                if self._maybe_emit(row, now_mono=now_mono):
                    emitted += 1
            except Exception:  # noqa: BLE001 - defensive: per-row isolation
                log.warning(
                    "weight_sync: emit failed for lot %s",
                    row.get("lot_id"), exc_info=True,
                )
        self._last_tick_stats["emitted"] = emitted
        return emitted

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_candidates(self) -> list[dict]:
        """Return one dict per candidate lot.

        Two distinct candidate sources, unioned:

        1. **live_shelf lots** — ``shelf_id='live_shelf'`` rows in the
           Pi's ``lots`` table (mirrored from cloud_lots + lifecycle
           managed by the live_shelf handler). The Pi-local ``lots.lot_id``
           is a DIFFERENT UUID from the cloud's ``stock_lots.lot_id`` for
           the same physical lot — so we MUST resolve the cloud lot_id
           via the ``cloud_lots`` mirror (joined on ``product_id``) before
           emitting. The emitted ``pi_lot_id`` field is, despite its name,
           the cloud-side ``stock_lots.lot_id`` (the cloud's
           ``apply_live_weight_sync`` function looks it up directly there).
           Filters: ``current_weight_g IS NOT NULL``,
           ``status IN ('on_shelf', 'in_flight')``. ``out`` /
           ``depleted`` / ``relocated`` / ``lost`` are excluded — qty
           is known to be zero or stale. live_shelf lots may also be
           seeded with ``shelf_id='single_item'`` in tests (legacy
           seeding) — those continue to flow through this branch when
           ``current_weight_g`` is non-null.
           Lot resolution rule: the JOIN against ``cloud_lots`` requires
           ``deleted_at IS NULL`` and orders by
           ``qty_containers DESC, created_at DESC`` to pick the freshest
           live-stock cloud lot for the product. If no cloud_lots row
           matches, the row is SKIPPED (we don't emit a payload guaranteed
           to fail at the cloud's lot_id lookup).

        2. **live_scale lots** — ``shelf_id='single_item'`` rows in
           ``scale_pairings`` (NOT in ``lots``: the live_scale event
           handler in ``handlers/scale_events.py`` emits cloud
           consumption events directly and never inserts into the Pi's
           ``lots`` table). The current weight comes from the in-memory
           runtime state populated by ``/api/scale-heartbeat`` keyed by
           device_id. Requires ``runtime_state_provider`` to be wired;
           when not wired, live_scale streaming is disabled and only
           live_shelf is emitted.
           ``scale_pairings.lot_id`` is ALREADY the cloud-side
           ``stock_lots.lot_id`` (the FK to local ``lots(lot_id)`` was
           dropped in migration 20260429... specifically because of this),
           so this branch passes it through unchanged.
           A pairing must have a non-null ``lot_id`` (the operator has
           assigned a product lot to the scale via the pairings UI) and
           a fresh runtime weight reading (the heartbeat-state TTL gate
           handles staleness, so we honor whatever it returns). Pairings
           whose ``lot_id`` is already covered by a ``lots`` row (legacy
           test seeding path) are deduped out so we don't emit twice
           for the same lot.

        Catch-all is INTENTIONALLY excluded (Phase 1 audit finding
        L1/HIGH; AUDIT_FINDINGS_PHASE1.md):
        catch-all lots stream weight via the delta-capture pair (the
        ``catch_all_first_measurement`` + ``catch_all_second_measurement``
        events) during an active session, and outside of an active session
        catch-all lots have no continuous weight signal to broadcast.
        ``stock_lots.last_observed_weight_g`` is therefore deliberately
        NULL for catch-all rows — the cloud-UI freshness indicator on
        those rows reflects pickup_weight_g instead.
        """
        # The live_shelf branch JOINs cloud_lots on product_id to resolve
        # the cloud-side stock_lots.lot_id. The Pi-local lots.lot_id is a
        # DIFFERENT UUID space than the cloud's stock_lots.lot_id, so
        # emitting lots.lot_id would always miss in the cloud handler
        # (root-cause of the 'lot_id not found' applied=false bug).
        # Resolution rule: prefer the cloud lot with the largest current
        # qty_containers, breaking ties by most recent created_at — this
        # picks the live "current" stock lot for the product. If no
        # cloud_lots row matches the product, we DROP the row from the
        # candidate list (skipping the emit is strictly better than
        # firing a payload that's guaranteed to fail).
        live_shelf_sql = """
            SELECT l.lot_id AS pi_local_lot_id,
                   l.product_id,
                   cl.lot_id AS cloud_lot_id,
                   l.shelf_id,
                   l.current_weight_g,
                   sp.device_id
              FROM lots l
              JOIN cloud_lots cl
                ON cl.product_id = l.product_id
               AND cl.deleted_at IS NULL
               AND cl.lot_id = (
                 SELECT inner_cl.lot_id
                   FROM cloud_lots inner_cl
                  WHERE inner_cl.product_id = l.product_id
                    AND inner_cl.deleted_at IS NULL
                  ORDER BY inner_cl.qty_containers DESC,
                           inner_cl.created_at DESC
                  LIMIT 1
               )
              LEFT JOIN scale_pairings sp ON sp.lot_id = cl.lot_id
             WHERE l.shelf_id IN ('live_shelf', 'single_item')
               AND l.current_weight_g IS NOT NULL
               AND l.status IN ('on_shelf', 'in_flight')
        """
        # G5 (MED, 2026-05-15): the live_shelf branch collapses multiple
        # Pi `lots` rows for the same product onto a single cloud_lot_id
        # (the LIMIT 1 in the inner subquery). When there are >1 active
        # cloud_lots for a product, every Pi lot's row collapses onto
        # the SAME cloud_lot_id — throttle memory holds one slot per
        # cloud_lot_id, so emissions thrash unpredictably between the
        # cartons and `last_observed_weight_g` flaps. We can't tell
        # which physical carton owns which weight, so the safe move is
        # to skip ALL Pi lots for an ambiguous product and surface the
        # condition (operator must consolidate the lots, pair them to
        # separate scales, or accept degraded weight tracking).
        ambiguous_sql = """
            SELECT product_id, COUNT(*) AS n
              FROM cloud_lots
             WHERE deleted_at IS NULL
               AND qty_containers > 0
             GROUP BY product_id
            HAVING COUNT(*) > 1
        """
        # New branch: live_scale lots that ONLY exist in scale_pairings
        # (the production case — live_scale lifecycle never creates a
        # lots row). Joined with runtime heartbeat state in Python.
        # ``product_id`` is included so the G5 ambiguity-skip filter
        # below can evaluate this branch too.
        live_scale_sql = """
            SELECT sp.lot_id, sp.product_id, 'single_item' AS shelf_id,
                   NULL AS current_weight_g, sp.device_id
              FROM scale_pairings sp
             WHERE sp.shelf_id = 'single_item'
               AND sp.lot_id IS NOT NULL
        """
        if self._db_lock is not None:
            with self._db_lock:
                shelf_raw = [
                    dict(r) for r in self._conn.execute(live_shelf_sql).fetchall()
                ]
                scale_rows = [
                    dict(r) for r in self._conn.execute(live_scale_sql).fetchall()
                ]
                ambiguous_rows = [
                    dict(r) for r in self._conn.execute(ambiguous_sql).fetchall()
                ]
        else:
            shelf_raw = [
                dict(r) for r in self._conn.execute(live_shelf_sql).fetchall()
            ]
            scale_rows = [
                dict(r) for r in self._conn.execute(live_scale_sql).fetchall()
            ]
            ambiguous_rows = [
                dict(r) for r in self._conn.execute(ambiguous_sql).fetchall()
            ]

        # Build the ambiguous-product set + per-product cloud_lots count
        # for the warning. Tracks PRODUCTS not lots — operator's mental
        # model is per-product.
        ambiguous_products: dict[str, int] = {}
        for r in ambiguous_rows:
            pid = r.get("product_id")
            n = r.get("n")
            if isinstance(pid, str) and pid and isinstance(n, int):
                ambiguous_products[pid] = n

        # Skip + log ambiguous products. Group the Pi lot_ids that
        # WOULD have been collapsed under each product, so the WARNING
        # gives operators a concrete list to consolidate.
        if ambiguous_products:
            ambiguous_pi_lots: dict[str, list[str]] = {}
            kept_shelf: list[dict] = []
            for r in shelf_raw:
                product_id = r.get("product_id")
                if isinstance(product_id, str) and product_id in ambiguous_products:
                    pi_local = r.get("pi_local_lot_id")
                    if isinstance(pi_local, str) and pi_local:
                        ambiguous_pi_lots.setdefault(product_id, []).append(
                            pi_local,
                        )
                    continue
                kept_shelf.append(r)
            shelf_raw = kept_shelf
            for product_id, pi_lots in ambiguous_pi_lots.items():
                log.warning(
                    "weight_sync: skipping product_id=%s — %d active "
                    "cloud_lots match; Pi lot_ids that would collapse: %s. "
                    "Operator action: consolidate cloud lots, pair to "
                    "separate scales, or accept degraded weight tracking.",
                    product_id,
                    ambiguous_products[product_id],
                    pi_lots,
                )
            # Also skip live_scale pairings whose product is in the
            # ambiguous set. (The pairings branch doesn't itself collapse
            # — pairings.lot_id is already the cloud_lot_id — but
            # emitting weight for a product where the cloud's lot
            # identity is ambiguous would be inconsistent with the
            # shelf-branch decision and equally misleading.) Only log
            # an additional WARNING if this is a scale-only ambiguous
            # product (no shelf rows already named it) to avoid noise.
            if scale_rows:
                kept_scale: list[dict] = []
                ambig_scale_pi_lots: dict[str, list[str]] = {}
                for r in scale_rows:
                    sp_pid = r.get("product_id")
                    if isinstance(sp_pid, str) and sp_pid in ambiguous_products:
                        lot_id = r.get("lot_id")
                        if isinstance(lot_id, str) and lot_id:
                            ambig_scale_pi_lots.setdefault(sp_pid, []).append(
                                lot_id,
                            )
                        continue
                    kept_scale.append(r)
                scale_rows = kept_scale
                for product_id, lot_ids in ambig_scale_pi_lots.items():
                    if product_id not in ambiguous_pi_lots:
                        log.warning(
                            "weight_sync: skipping pairing(s) for "
                            "product_id=%s — %d active cloud_lots match; "
                            "lot_ids: %s.",
                            product_id,
                            ambiguous_products[product_id],
                            lot_ids,
                        )
            # Count one tick stat per ambiguous PRODUCT (not per lot).
            self._last_tick_stats["skipped_ambiguous_count"] = len(
                ambiguous_products,
            )

        # Normalize the shelf branch: the SQL returns the cloud lot_id
        # under ``cloud_lot_id`` (resolved via cloud_lots JOIN). Promote
        # it to ``lot_id`` for downstream code so the throttle memory
        # and emit path key off the cloud UUID — the same UUID that
        # cloud's apply_live_weight_sync looks up in stock_lots.
        shelf_rows: list[dict] = []
        for r in shelf_raw:
            cloud_lot_id = r.get("cloud_lot_id")
            if not isinstance(cloud_lot_id, str) or not cloud_lot_id:
                # Defense-in-depth: the JOIN already excludes rows
                # without a matching cloud_lots row, but if a NULL
                # somehow arrives just drop it.
                continue
            r["lot_id"] = cloud_lot_id
            shelf_rows.append(r)

        # C2-03 (2026-06-15): collapse guard on the Pi-lot dimension —
        # the inverse of G5. G5 catches >1 cloud_lots for one product;
        # this catches >1 Pi `lots` rows that resolve to the SAME
        # cloud_lot_id (which happens whenever a product has exactly one
        # active cloud lot but more than one live Pi lot — G5's HAVING
        # COUNT(*) > 1 on cloud_lots does NOT fire here). Each such Pi
        # row carries its own ``current_weight_g``; left unguarded they
        # all flow into the emit loop keyed by the shared cloud_lot_id,
        # so every tick emits multiple ``live_weight_sync`` events with
        # CONFLICTING weights for the same cloud lot and the cloud's
        # ``last_observed_weight_g`` flaps permanently. We can't tell
        # which physical Pi lot owns the cloud lot's weight, so — exactly
        # like G5 — we skip ALL Pi rows that share a cloud_lot_id, log a
        # WARNING naming the cloud_lot_id + the colliding Pi lot_ids, and
        # bump ``skipped_collapsed_count`` so /healthz surfaces the
        # operator-action condition (consolidate the Pi lots or pair them
        # to separate scales).
        if shelf_rows:
            rows_by_cloud_lot: dict[str, list[dict]] = {}
            for r in shelf_rows:
                cloud_lot_id = r.get("lot_id")
                if isinstance(cloud_lot_id, str) and cloud_lot_id:
                    rows_by_cloud_lot.setdefault(cloud_lot_id, []).append(r)
            collapsed_cloud_lots = {
                clid: rs
                for clid, rs in rows_by_cloud_lot.items()
                if len(rs) > 1
            }
            if collapsed_cloud_lots:
                shelf_rows = [
                    r
                    for r in shelf_rows
                    if r.get("lot_id") not in collapsed_cloud_lots
                ]
                for clid, rs in collapsed_cloud_lots.items():
                    pi_lot_ids = [
                        r.get("pi_local_lot_id")
                        for r in rs
                        if isinstance(r.get("pi_local_lot_id"), str)
                        and r.get("pi_local_lot_id")
                    ]
                    log.warning(
                        "weight_sync: skipping cloud_lot_id=%s — %d Pi "
                        "lots collapse onto it with conflicting weights; "
                        "Pi lot_ids: %s. Operator action: consolidate the "
                        "Pi lots, pair them to separate scales, or accept "
                        "degraded weight tracking.",
                        clid,
                        len(rs),
                        pi_lot_ids,
                    )
                # Count one tick stat per collapsed CLOUD LOT (the unit
                # the operator must consolidate), not per Pi lot.
                self._last_tick_stats["skipped_collapsed_count"] = len(
                    collapsed_cloud_lots,
                )

        # Dedup: a lot may appear in both branches when a test seeds
        # both a `lots` row and a `scale_pairings` row with the same
        # lot_id. The live_shelf branch already produced an emit with a
        # current_weight_g from `lots`; drop the duplicate from
        # scale_rows so we don't emit twice for the same lot in one tick.
        shelf_lot_ids = {r.get("lot_id") for r in shelf_rows}
        if scale_rows and shelf_lot_ids:
            scale_rows = [
                r for r in scale_rows if r.get("lot_id") not in shelf_lot_ids
            ]

        # Splice the heartbeat weight onto each remaining live_scale
        # candidate. Without a runtime provider we can't observe
        # live_scale weights, so drop those rows (caller still gets
        # live_shelf candidates).
        if scale_rows:
            if self._runtime_state_provider is None:
                scale_rows = []
            else:
                try:
                    snapshot = self._runtime_state_provider() or {}
                except Exception:  # noqa: BLE001 - defensive: never kill the tick
                    log.warning(
                        "weight_sync: runtime_state_provider raised; "
                        "live_scale candidates skipped this tick",
                        exc_info=True,
                    )
                    snapshot = {}
                kept: list[dict] = []
                for row in scale_rows:
                    device_id = row.get("device_id")
                    if not isinstance(device_id, str) or not device_id:
                        continue
                    entry = snapshot.get(device_id) or {}
                    weight_g = (
                        entry.get("weight_g")
                        if isinstance(entry, Mapping)
                        else None
                    )
                    if weight_g is None:
                        # No fresh heartbeat for this device — skip.
                        # When the ESP starts heartbeating again the
                        # next tick will pick it up (no state to clear).
                        continue
                    row["current_weight_g"] = weight_g
                    kept.append(row)
                scale_rows = kept

        return shelf_rows + scale_rows

    def _should_emit(
        self,
        *,
        lot_id: str,
        weight_g: float,
        now_mono: float,
    ) -> bool:
        """Apply the throttle gates. Returns True iff this row should emit.

        Significant-change OR TTL → emit. Both gates false → skip.
        """
        prev = self._memory.get(lot_id)
        if prev is None:
            # First observation since process start — always emit so the
            # cloud sees the current reading.
            return True
        delta = abs(weight_g - prev.weight_g)
        if delta >= self._min_delta_g:
            return True
        elapsed = now_mono - prev.at_monotonic
        if elapsed >= self._ttl_s:
            return True
        return False

    def _maybe_emit(self, row: dict, *, now_mono: float) -> bool:
        """Conditionally emit one row. Returns True iff an emit fired."""
        raw_lot_id = row.get("lot_id")
        weight_g = row.get("current_weight_g")
        shelf_id = row.get("shelf_id")
        if not isinstance(raw_lot_id, str) or not raw_lot_id:
            return False
        if weight_g is None:
            return False
        try:
            weight_f = float(weight_g)
        except (TypeError, ValueError):
            return False
        if weight_f < 0:
            # Negative reading — sensor glitch / unsettled tare. Skip
            # rather than emit something the cloud's >= 0 check would
            # bounce.
            return False

        # Validate that raw_lot_id belongs to the cloud namespace by
        # verifying it in the cloud_lots mirror. This is the critical
        # boundary: a Pi-local lot_id (from lots.lot_id) would pass a UUID
        # format check but fail in the cloud apply_live_weight_sync
        # handler (root cause of the 'lot_id not found' applied=false
        # bug). InvalidIdError → log + skip (same isolation as the outer
        # tick_once exception handler, but we absorb here so the log
        # message names the lot).
        #
        # C2-07 (2026-06-15): this used to be ``CloudLotId(raw_lot_id)``,
        # a NewType identity cast that can NEVER raise, wrapped in a dead
        # try/except whose comment falsely claimed "verification". The
        # cast did nothing — a leaked Pi-local lot_id sailed straight
        # through. We now run the REAL namespace check via
        # ``parse_cloud_lot_id`` (verifies presence in the cloud_lots
        # mirror) for shelf-JOIN rows, where ``cloud_lot_id`` was set by
        # the _fetch_candidates JOIN and is therefore the right contract
        # to assert. The live_scale pass-through branch
        # (scale_pairings.lot_id) carries NO ``cloud_lot_id`` key and is
        # deliberately NOT mirrored in cloud_lots (the FK to local lots
        # was dropped in migration 20260429 — pairings.lot_id is set to
        # the cloud stock_lots.lot_id directly), so re-querying cloud_lots
        # would wrongly reject every live_scale emit; for that branch we
        # keep the documented identity promotion.
        if "cloud_lot_id" in row:
            try:
                cloud_lot_id = parse_cloud_lot_id(raw_lot_id, self._conn)
            except InvalidIdError:
                log.warning(
                    "weight_sync: lot_id %r not found in cloud_lots "
                    "(namespace mismatch — likely a leaked Pi-local "
                    "lot_id); skipping",
                    raw_lot_id,
                    exc_info=True,
                )
                return False
        else:
            # live_scale pass-through: scale_pairings.lot_id is already
            # the cloud stock_lots.lot_id (FK dropped, migration
            # 20260429), and is intentionally absent from the cloud_lots
            # mirror — promote without a cloud_lots re-query.
            cloud_lot_id = CloudLotId(raw_lot_id)

        if not self._should_emit(
            lot_id=raw_lot_id, weight_g=weight_f, now_mono=now_mono,
        ):
            return False

        # Map shelf_id to the cloud ``kind`` discriminator + scale_id.
        # 'live_shelf' → kind='live_shelf', scale_id='scale-01'.
        # 'single_item' → kind='live_scale', scale_id from pairing or
        # the configured default. Translation table lives in
        # ``cloud/_kind_translate.py`` per Phase 1 audit (L10/HIGH).
        if shelf_id == PI_LIVE_SHELF:
            cloud_kind = pi_to_cloud(shelf_id)
            assert cloud_kind == CLOUD_LIVE_SHELF, (
                "kind translation drift: PI_LIVE_SHELF must map to CLOUD_LIVE_SHELF"
            )
            scale_id = self._live_shelf_scale_id
        elif shelf_id == PI_SINGLE_ITEM:
            cloud_kind = pi_to_cloud(shelf_id)
            assert cloud_kind == CLOUD_LIVE_SCALE, (
                "kind translation drift: PI_SINGLE_ITEM must map to CLOUD_LIVE_SCALE"
            )
            device_id = row.get("device_id")
            scale_id = (
                str(device_id)
                if isinstance(device_id, str) and device_id
                else self._live_scale_scale_id
            )
        else:
            # Defense-in-depth: SQL filter already excludes other shelf_ids,
            # but if the row arrives anyway just skip it.
            return False

        client_event_id = self._emitter.emit_live_weight_sync(
            scale_id=scale_id,
            kind=cloud_kind,
            pi_lot_id=cloud_lot_id,
            observed_weight_g=weight_f,
        )
        if not client_event_id:
            # Emitter dropped the event (disabled, pre-NTP ts, or
            # outbox insert raised). Don't update the memory — next
            # tick will retry.
            return False
        self._memory[raw_lot_id] = _EmitMemory(
            weight_g=weight_f, at_monotonic=now_mono,
        )
        return True

    # ------------------------------------------------------------------
    # Thread entrypoint
    # ------------------------------------------------------------------

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "weight-sync-poller: starting (interval=%.1fs, "
            "min_delta=%.1fg, ttl=%.1fs)",
            self._interval_s, self._min_delta_g, self._ttl_s,
        )
        while not self._shutdown.is_set():
            try:
                emitted = self.tick_once()
                if emitted:
                    log.debug(
                        "weight-sync-poller: emitted %d event(s)", emitted,
                    )
            except Exception:  # noqa: BLE001 - never kill the thread
                log.exception("weight-sync-poller: tick raised unexpectedly")
            if self._shutdown.wait(self._interval_s):
                break
        log.info("weight-sync-poller: shutdown complete")


__all__ = [
    "WEIGHT_SYNC_INTERVAL_S",
    "DEFAULT_MIN_DELTA_G",
    "DEFAULT_TTL_S",
    "WeightSyncPoller",
]
