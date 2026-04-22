"""Background thread that pulls cloud event_overrides deltas every 30s.

When a user edits a shelf event via the cloud's /chef/events UI (or a
similar RPC caller), ``private.apply_event_override`` updates the cloud's
``chefbyte.stock_lots`` + ``chefbyte.food_logs`` to match the new
servings / kind / void-state. The Pi's local ``lots`` table has no way
to know — its ``current_weight_g`` still reflects the pre-override
baseline, so the next scale event on that lot computes ``delta_g``
against the wrong "before" weight.

This poller closes that gap by mirroring cloud's post-reconcile lot
state back to the Pi. Mirrors the design of
:mod:`~server.cloud.product_sync_poller`:

  * Tick cadence: 30s on the happy path.
  * Exponential backoff on cloud errors (1s → 30s cap).
  * Tracks the last-known ``updated_at`` high-watermark in a small JSON
    state file under ``/home/jeremy/live-shelf/data/last_overrides_sync.json``.
  * First boot (no state file): sends ``updated_since=None`` and pulls
    the full override history (not just recent edits) so a freshly-
    flashed Pi sees every override the user has ever made. The per-row
    apply is idempotent — we just rewrite each affected lot's
    ``current_weight_g`` to the cloud's current ``qty_containers`` *
    ``net_weight_g``.
  * Subsequent ticks: send the cached high-watermark so the cloud
    returns only overrides touched since.

Apply semantics on the Pi (narrow by design):
  * For each override row, the cloud returns the resolved_lot_id +
    product_id + the post-reconcile ``lots`` row state.
  * We UPDATE the Pi's ``lots.current_weight_g`` for any lot whose cloud
    stock state changed. No UI surface, no re-classification, no event
    rewrite — the Pi's UI doesn't show overrides today.
  * Missing local lot (cloud has it but Pi doesn't) is skipped with a
    WARNING: the Pi's `lots` table is keyed by Pi-minted UUIDs which
    don't match cloud `stock_lots.lot_id`. A follow-up task can bridge
    via product_id + shelf_id but isn't required for the baseline fix.
  * We do NOT rewrite scale_events rows — those are immutable history.

The per-row cloud response shape (from /overrides):

    {
      "overrides": [
        {
          "override_id": "...",
          "client_event_id": "...",
          "updated_at": "...",
          "stock_qty_override": null | number,
          "event_kind_override": null | "consumed|depleted|added|refilled",
          "is_voided": bool,
          "macro_logging_enabled": bool,
          "resolved_lot_id": "cloud-lot-uuid",
          "product_id": "cloud-product-uuid",
          "pi_event_id": "optional pi event id for image linking"
        }, ...
      ],
      "lots": [
        {
          "lot_id": "cloud-lot-uuid",
          "product_id": "cloud-product-uuid",
          "qty_containers": 1.75,
          "last_update_source": "manual",
          "last_update_ts": "2026-04-21T..."
        }
      ]
    }

A tick:
  1. Call ``GET /overrides?updated_since=<hwm>`` via CloudClient.
  2. For each ``lots[]`` entry, look up the matching Pi row by
     ``product_id`` + whatever is the "active" (non-depleted) local lot
     — the simplest 1:1 mapping that holds for single-product shelves.
  3. Set its ``current_weight_g`` to ``qty_containers * net_weight_g``.
     If product has no ``net_weight_g`` we log + skip — can't translate
     containers back to grams without the conversion constant.
  4. Advance the watermark to max(updated_at) across the overrides.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Union

from .client import CloudError

log = logging.getLogger(__name__)


# Poll cadences (seconds). Module-level so tests can pin tiny values
# without monkey-patching the class.
POLL_INTERVAL_S = 30.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0

# State file schema version — bumped if we ever reshape the payload.
_STATE_SCHEMA_VERSION = 1


def _default_fetch_overrides(
    client: Any, *, updated_since: Optional[str] = None,
) -> dict:
    """Thin wrapper so ProductSyncPoller's patching pattern works here too.

    Extracted so tests can stub the HTTP layer without touching CloudClient.
    """
    if updated_since:
        return client.get("/overrides", params={"updated_since": updated_since})
    return client.get("/overrides")


@dataclass
class _SyncState:
    high_watermark: Optional[str]

    def to_json(self) -> str:
        return json.dumps(
            {
                "version": _STATE_SCHEMA_VERSION,
                "high_watermark": self.high_watermark,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_file(cls, path: Path) -> "_SyncState":
        if not path.exists():
            return cls(high_watermark=None)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning(
                "event_overrides: state file %s unreadable (%s); "
                "falling back to full re-sync",
                path, exc,
            )
            return cls(high_watermark=None)
        if not isinstance(raw, dict) or raw.get("version") != _STATE_SCHEMA_VERSION:
            log.warning(
                "event_overrides: state file %s has unexpected shape; "
                "falling back to full re-sync",
                path,
            )
            return cls(high_watermark=None)
        hwm = raw.get("high_watermark")
        if hwm is not None and not isinstance(hwm, str):
            return cls(high_watermark=None)
        return cls(high_watermark=hwm)

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(self.to_json(), encoding="utf-8")
        tmp.replace(path)


class EventOverridesPoller(threading.Thread):
    """Pull cloud event_overrides deltas every ``POLL_INTERVAL_S`` seconds.

    Parameters
    ----------
    client:
        Configured :class:`~server.cloud.client.CloudClient`.
    conn:
        SQLite connection to the Pi's local DB. The apply step opens its
        own ``with conn:`` transaction per tick.
    state_path:
        Filesystem location of the JSON state file (e.g.
        ``<data_root>/last_overrides_sync.json``). Auto-created on first
        successful tick.
    db_lock:
        Shared DB lock — held while writing ``lots.current_weight_g`` so
        concurrent scale-event handlers don't step on us.
    poll_interval_s:
        Override for the 30s cadence — tests can pin tiny values.
    shutdown_event:
        Optional externally-provided event. If absent, the thread creates
        its own and callers must use :meth:`stop` to exit.
    fetch_overrides_fn:
        Injectable for tests. Signature:
        ``(client, *, updated_since) -> dict``.
    """

    name = "event-overrides-poller"

    def __init__(
        self,
        client: Any,
        conn: sqlite3.Connection,
        state_path: Union[str, Path],
        *,
        db_lock: Optional[threading.Lock] = None,
        poll_interval_s: float = POLL_INTERVAL_S,
        shutdown_event: Optional[threading.Event] = None,
        fetch_overrides_fn: Optional[Callable[..., Any]] = None,
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn = conn
        self._state_path = Path(state_path)
        self._db_lock = db_lock
        self._poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        self._fetch_overrides = fetch_overrides_fn or _default_fetch_overrides
        self._backoff_s: float = INITIAL_BACKOFF_S
        self._state = _SyncState.from_file(self._state_path)

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def high_watermark(self) -> Optional[str]:
        return self._state.high_watermark

    def tick_once(self) -> int:
        """Run exactly one sync cycle.

        Returns the number of lot rows successfully updated. On cloud /
        apply errors we log + bump backoff and return 0 — the next tick
        retries the same watermark.
        """
        try:
            payload = self._fetch_overrides(
                self._client, updated_since=self._state.high_watermark,
            )
        except CloudError as err:
            log.warning(
                "event_overrides: fetch failed HTTP %d %s — next backoff %.1fs",
                err.status_code, str(err.body)[:200], self._next_backoff(),
            )
            return 0
        except Exception:  # noqa: BLE001 - defensive: never kill the thread
            log.warning(
                "event_overrides: fetch raised unexpectedly — "
                "next backoff %.1fs",
                self._next_backoff(), exc_info=True,
            )
            return 0

        if not isinstance(payload, dict):
            log.warning(
                "event_overrides: unexpected payload type %s — skipping",
                type(payload).__name__,
            )
            self._backoff_s = INITIAL_BACKOFF_S
            return 0

        overrides_raw = payload.get("overrides")
        lots_raw = payload.get("lots")
        overrides = overrides_raw if isinstance(overrides_raw, list) else []
        lots = lots_raw if isinstance(lots_raw, list) else []

        # Advance the watermark to max(updated_at) across ALL returned
        # override rows (even ones we failed to apply locally — the cloud
        # is the source of truth, and a stuck watermark just means
        # re-fetching the same rows forever). An empty delta leaves the
        # watermark untouched.
        max_updated_at: Optional[str] = self._state.high_watermark
        for override in overrides:
            if not isinstance(override, dict):
                continue
            ts = override.get("updated_at")
            if isinstance(ts, str) and ts:
                if max_updated_at is None or ts > max_updated_at:
                    max_updated_at = ts

        # Apply each cloud lot state to the Pi's local lots table.
        applied = self._apply_lot_states(lots, overrides)

        self._backoff_s = INITIAL_BACKOFF_S
        if max_updated_at != self._state.high_watermark:
            self._state = _SyncState(high_watermark=max_updated_at)
            try:
                self._state.write(self._state_path)
            except OSError:
                log.warning(
                    "event_overrides: failed to persist state to %s; "
                    "next boot will re-sync from prior watermark",
                    self._state_path, exc_info=True,
                )

        log.info(
            "event_overrides: synced %d override(s), updated %d lot(s) "
            "(Δ since %s)",
            len(overrides), applied,
            self._state.high_watermark or "boot",
        )
        return applied

    # ------------------------------------------------------------------
    # Apply helper (extracted for unit-test clarity)
    # ------------------------------------------------------------------

    def _apply_lot_states(
        self,
        lots: list[dict],
        overrides: list[dict],
    ) -> int:
        """Write cloud-side lot state into the Pi's ``lots`` table.

        Strategy:
          * Cloud sends ``{lot_id, product_id, qty_containers, ...}`` for
            each affected lot.
          * We convert ``qty_containers`` → grams via the local product's
            ``net_weight_g`` (same math the cloud uses in reverse).
          * We update the Pi's most-recently-used lot for that product_id
            (on_shelf OR in_flight — the ones whose ``current_weight_g``
            the reconciler actually reads). If nothing matches, skip +
            warn: cloud drift should be observed, not silently papered.

        Returns the count of Pi lot rows touched.
        """
        if not lots:
            return 0

        # Build product_id → list[dict] so duplicate lots per product
        # (shouldn't happen for event_overrides but defensive) still land.
        by_product: dict[str, list[dict]] = {}
        for lot in lots:
            if not isinstance(lot, dict):
                continue
            pid = lot.get("product_id")
            if not isinstance(pid, str) or not pid:
                continue
            by_product.setdefault(pid, []).append(lot)

        if not by_product:
            return 0

        applied_count = 0
        lock = self._db_lock if self._db_lock is not None else _NullLock()
        with lock:
            with self._conn:
                for product_id, cloud_lots in by_product.items():
                    # Pull the Pi's net_weight_g + active lot for this
                    # product. Active = status in ('on_shelf','in_flight')
                    # so reconciler-frozen lots don't silently get bumped.
                    prod_row = self._conn.execute(
                        "SELECT net_weight_g, deleted_at FROM products "
                        "WHERE product_id = ?",
                        (product_id,),
                    ).fetchone()
                    if prod_row is None:
                        log.warning(
                            "event_overrides: lot state for unknown "
                            "product_id=%s — skip; next product-sync "
                            "tick should hydrate it",
                            product_id,
                        )
                        continue
                    net_g = prod_row["net_weight_g"] if hasattr(prod_row, "__getitem__") else prod_row[0]
                    try:
                        net_g_f = float(net_g) if net_g is not None else None
                    except (TypeError, ValueError):
                        net_g_f = None
                    if net_g_f is None or net_g_f <= 0:
                        log.warning(
                            "event_overrides: product_id=%s has no/zero "
                            "net_weight_g — cannot convert qty_containers "
                            "to grams; skip",
                            product_id,
                        )
                        continue

                    # Single active lot for this product on the Pi.
                    # Future-ready for multi-lot: if cloud sends more
                    # than one lot per product (it can — user may have
                    # two batches), we apply each in order but all land
                    # on the same Pi row because the Pi's lot model
                    # collapses to one active lot per product. That's
                    # an acceptable approximation for the MVP.
                    lot_row = self._conn.execute(
                        "SELECT lot_id FROM lots "
                        " WHERE product_id = ? "
                        "   AND status IN ('on_shelf','in_flight') "
                        " ORDER BY last_seen_at DESC LIMIT 1",
                        (product_id,),
                    ).fetchone()
                    if lot_row is None:
                        log.info(
                            "event_overrides: no active Pi lot for "
                            "product_id=%s — cloud override applies to "
                            "a lot the Pi never saw; skip (state will "
                            "re-materialize on next placement)",
                            product_id,
                        )
                        continue
                    lot_id = lot_row["lot_id"] if hasattr(lot_row, "__getitem__") else lot_row[0]

                    # The LAST cloud lot wins if more than one was sent —
                    # shouldn't happen in practice but deterministic.
                    cloud_lot = cloud_lots[-1]
                    qty_raw = cloud_lot.get("qty_containers")
                    try:
                        qty_f = float(qty_raw) if qty_raw is not None else None
                    except (TypeError, ValueError):
                        qty_f = None
                    if qty_f is None or qty_f < 0:
                        log.warning(
                            "event_overrides: invalid qty_containers=%r "
                            "for lot %s — skip",
                            qty_raw, lot_id,
                        )
                        continue

                    new_weight_g = qty_f * net_g_f
                    self._conn.execute(
                        "UPDATE lots "
                        "   SET current_weight_g = ?, "
                        "       last_seen_at = datetime('now') "
                        " WHERE lot_id = ?",
                        (new_weight_g, lot_id),
                    )
                    applied_count += 1
                    log.info(
                        "event_overrides: lot %s (product=%s) "
                        "current_weight_g → %.2fg from cloud "
                        "qty_containers=%.3f",
                        lot_id, product_id, new_weight_g, qty_f,
                    )

        # overrides parameter is reserved for future UI-mark work (e.g.
        # pi-side "this event was overridden" surface). We don't use it
        # today but accept it so the test surface matches the planned
        # final state — adding a UI mark later doesn't change the
        # function signature.
        _ = overrides
        return applied_count

    def _next_backoff(self) -> float:
        nxt = min(self._backoff_s * 2.0, MAX_BACKOFF_S)
        current = self._backoff_s
        self._backoff_s = nxt
        return current

    # ------------------------------------------------------------------
    # Thread entrypoint
    # ------------------------------------------------------------------

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "event-overrides-poller: starting (interval=%.1fs, state=%s, "
            "watermark=%s)",
            self._poll_interval_s, self._state_path,
            self._state.high_watermark or "<none>",
        )
        while not self._shutdown.is_set():
            pre_backoff = self._backoff_s
            self.tick_once()
            if self._backoff_s == INITIAL_BACKOFF_S:
                sleep_s = self._poll_interval_s
            else:
                sleep_s = pre_backoff
            if self._shutdown.wait(sleep_s):
                break
        log.info("event-overrides-poller: shutdown complete")


class _NullLock:
    """Context-manager no-op — matches threading.Lock's `with` interface."""

    def __enter__(self) -> "_NullLock":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def acquire(self, *_: Any, **__: Any) -> bool:
        return True

    def release(self) -> None:
        return None


__all__ = ["POLL_INTERVAL_S", "EventOverridesPoller"]
