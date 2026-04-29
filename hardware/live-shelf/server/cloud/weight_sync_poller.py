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
from typing import Optional

from ._kind_translate import (
    CLOUD_LIVE_SCALE,
    CLOUD_LIVE_SHELF,
    PI_LIVE_SHELF,
    PI_SINGLE_ITEM,
    pi_to_cloud,
)
from .integration import CloudEventEmitter

log = logging.getLogger(__name__)


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
        self._shutdown = shutdown_event or threading.Event()
        self._clock_monotonic = (
            clock.monotonic if clock is not None else time.monotonic
        )
        # Per-lot last-emit memory. Keyed by lot_id string.
        self._memory: dict[str, _EmitMemory] = {}

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    def tick_once(self) -> int:
        """Run one scan pass. Returns the number of events emitted.

        Idempotent under exceptions — a sqlite error mid-scan logs and
        returns the partial count. Safe to call from tests.
        """
        if not self._emitter.enabled:
            return 0
        try:
            rows = self._fetch_candidates()
        except sqlite3.Error:
            log.warning(
                "weight_sync: candidate fetch failed", exc_info=True,
            )
            return 0
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
        return emitted

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_candidates(self) -> list[dict]:
        """Return one dict per candidate lot.

        Filters: ``shelf_id IN ('live_shelf', 'single_item')``,
        ``current_weight_g IS NOT NULL`` (we need a weight to report),
        ``status IN ('on_shelf', 'in_flight')`` (in-flight live_shelf
        lots are off-shelf physically but still meaningful — the
        catch-all-style "lot is in flight but has been re-measured"
        flow still wants the observation; ``out`` / ``depleted`` /
        ``relocated`` / ``lost`` are excluded — qty is known to be
        zero or stale).

        For live_scale lots (``shelf_id='single_item'``) we also need
        to know the device_id to stamp scale_id on the emit. Looked
        up via ``scale_pairings`` on the same lot_id (the pairing's
        device_id is the live_scale ESP). When no pairing row exists
        we fall back to the configured default scale-id.

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
        sql = """
            SELECT l.lot_id, l.shelf_id, l.current_weight_g, sp.device_id
              FROM lots l
              LEFT JOIN scale_pairings sp ON sp.lot_id = l.lot_id
             WHERE l.shelf_id IN ('live_shelf', 'single_item')
               AND l.current_weight_g IS NOT NULL
               AND l.status IN ('on_shelf', 'in_flight')
        """
        if self._db_lock is not None:
            with self._db_lock:
                cur = self._conn.execute(sql)
                rows = [dict(r) for r in cur.fetchall()]
        else:
            cur = self._conn.execute(sql)
            rows = [dict(r) for r in cur.fetchall()]
        return rows

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
        lot_id = row.get("lot_id")
        weight_g = row.get("current_weight_g")
        shelf_id = row.get("shelf_id")
        if not isinstance(lot_id, str) or not lot_id:
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
        if not self._should_emit(
            lot_id=lot_id, weight_g=weight_f, now_mono=now_mono,
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
            pi_lot_id=lot_id,
            observed_weight_g=weight_f,
        )
        if not client_event_id:
            # Emitter dropped the event (disabled, pre-NTP ts, or
            # outbox insert raised). Don't update the memory — next
            # tick will retry.
            return False
        self._memory[lot_id] = _EmitMemory(
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
