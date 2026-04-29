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
  2. For each override, pick the matching ``lots[]`` entry by
     ``resolved_lot_id`` (cloud lot UUID). Map cloud lot_id → Pi lot_id
     via ``cloud_lots.pickup_event_id`` ↔ ``lots.pickup_event_id``
     (the catch-all in-flight link populated by the lot-snapshot
     poller). Fall back to the legacy "most-recently-used Pi lot for
     product" heuristic only when ``resolved_lot_id`` is missing OR
     the cloud_lots mirror hasn't picked it up yet.
  3. Set Pi ``lots.current_weight_g`` to
     ``qty_containers * net_weight_g``. Propagate the cloud's
     ``in_flight_since`` / status flip when the override carries it.
     Skip + log when product has no ``net_weight_g``.
  4. Advance the watermark over the prefix of consecutively-applied
     overrides (chronological order). The first SKIP freezes the
     watermark so the next tick re-applies the failed override.
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

        # Apply each cloud lot state to the Pi's local lots table. Returns
        # ``(count, status_map)`` where status_map[override_key] is True
        # iff the override was successfully applied. Used below to advance
        # the watermark only over the prefix of consecutively-applied
        # overrides (audit finding #4).
        applied, applied_status = self._apply_lot_states(lots, overrides)

        # Advance the watermark over the prefix of consecutively-applied
        # overrides in chronological order. The first SKIP (missing
        # product, zero net_weight_g, no Pi lot, no matching cloud lot in
        # payload) freezes the watermark at the override immediately
        # before it. The next tick re-fetches starting from the failed
        # override so a transient Pi-side miss doesn't lose it.
        max_updated_at: Optional[str] = self._state.high_watermark
        sorted_overrides = sorted(
            (o for o in overrides if isinstance(o, dict)),
            key=lambda o: o.get("updated_at") or "",
        )
        for override in sorted_overrides:
            ts = override.get("updated_at")
            if not (isinstance(ts, str) and ts):
                # No timestamp → can't advance even if applied.
                break
            if not applied_status.get(self._override_key(override), False):
                # First non-applied override freezes the watermark.
                break
            if max_updated_at is None or ts > max_updated_at:
                max_updated_at = ts

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

    @staticmethod
    def _override_key(override: dict) -> str:
        """Stable key for tracking per-override apply outcome.

        Prefer ``resolved_lot_id`` (the cloud's authoritative target) so
        the lookup matches what ``_apply_lot_states`` keyed on. Fall back
        to ``product_id`` (legacy payloads where resolved_lot_id is null).
        Last resort: ``override_id``.
        """
        rid = override.get("resolved_lot_id")
        if isinstance(rid, str) and rid:
            return f"lot:{rid}"
        pid = override.get("product_id")
        if isinstance(pid, str) and pid:
            return f"product:{pid}"
        oid = override.get("override_id")
        return f"override:{oid}" if oid else "unknown"

    # ------------------------------------------------------------------
    # Apply helper (extracted for unit-test clarity)
    # ------------------------------------------------------------------

    def _apply_lot_states(
        self,
        lots: list[dict],
        overrides: list[dict],
    ) -> tuple[int, dict[str, bool]]:
        """Write cloud-side lot state into the Pi's ``lots`` table.

        Strategy (audit findings #2 + #9):
          * Each override carries a ``resolved_lot_id`` (cloud lot UUID).
            We use it as the key to pick the matching cloud_lot row from
            the ``lots[]`` array AND to map cloud lot_id → Pi lot_id via
            ``cloud_lots.pickup_event_id`` ↔ ``lots.pickup_event_id``
            (the catch-all in-flight link). This replaces the old
            "most-recently-used Pi lot for product" heuristic, which
            picked the wrong row when multiple lots existed per product
            (per-lot pinning, migration 20260427080000).
          * We convert ``qty_containers`` → grams via the local product's
            ``net_weight_g`` (same math the cloud uses in reverse).
          * We propagate the cloud's ``in_flight_since`` / status flip
            onto the Pi lot. Conservative: only writes the in-flight
            columns when the override's lot row carries
            ``in_flight_since`` (key present). A missing key means the
            override didn't touch the in-flight side and we leave it
            alone.
          * Fallback: when ``resolved_lot_id`` is missing in the override
            payload (legacy edge function) we fall back to the old
            heuristic so old payloads still apply.

        Returns ``(count, status_map)``. ``status_map`` is keyed by
        ``_override_key(override)`` and carries True iff the
        corresponding override was successfully applied — the caller
        uses this to decide which prefix of overrides advances the
        watermark (audit finding #4).
        """
        # Initialize per-override apply status. Default False so any
        # override we never reach (skipped lot, missing key) freezes
        # the watermark at the previous successful row.
        status: dict[str, bool] = {}
        for override in overrides:
            if not isinstance(override, dict):
                continue
            status[self._override_key(override)] = False

        if not lots:
            return 0, status

        # Index cloud lots by resolved_lot_id (preferred direct lookup) and
        # also by product_id (legacy fallback for payloads where the
        # override carries product_id but resolved_lot_id is null).
        by_resolved_lot: dict[str, dict] = {}
        by_product_fallback: dict[str, list[dict]] = {}
        for lot in lots:
            if not isinstance(lot, dict):
                continue
            cloud_lot_id = lot.get("lot_id")
            if isinstance(cloud_lot_id, str) and cloud_lot_id:
                by_resolved_lot[cloud_lot_id] = lot
            pid = lot.get("product_id")
            if isinstance(pid, str) and pid:
                by_product_fallback.setdefault(pid, []).append(lot)

        applied_count = 0
        lock = self._db_lock if self._db_lock is not None else _NullLock()
        with lock:
            with self._conn:
                for override in overrides:
                    if not isinstance(override, dict):
                        continue
                    key = self._override_key(override)
                    resolved_lot_id = override.get("resolved_lot_id")
                    product_id = override.get("product_id")

                    # Pick the cloud lot row for this override.
                    cloud_lot: Optional[dict] = None
                    if isinstance(resolved_lot_id, str) and resolved_lot_id:
                        cloud_lot = by_resolved_lot.get(resolved_lot_id)
                    if cloud_lot is None and isinstance(product_id, str):
                        # Legacy payload: no resolved_lot_id, fall back
                        # to the LAST cloud lot for this product.
                        candidates = by_product_fallback.get(product_id) or []
                        if candidates:
                            cloud_lot = candidates[-1]
                    if cloud_lot is None:
                        log.info(
                            "event_overrides: override %s has no matching "
                            "lot in payload (resolved_lot_id=%s, "
                            "product_id=%s) — skip",
                            override.get("override_id"),
                            resolved_lot_id, product_id,
                        )
                        continue

                    cloud_product_id = (
                        cloud_lot.get("product_id") or product_id
                    )
                    if not isinstance(cloud_product_id, str) or not cloud_product_id:
                        log.warning(
                            "event_overrides: cloud lot %r missing "
                            "product_id — skip",
                            cloud_lot.get("lot_id"),
                        )
                        continue

                    # Pull product net_weight_g for containers→grams math.
                    prod_row = self._conn.execute(
                        "SELECT net_weight_g, deleted_at FROM products "
                        "WHERE product_id = ?",
                        (cloud_product_id,),
                    ).fetchone()
                    if prod_row is None:
                        log.warning(
                            "event_overrides: lot state for unknown "
                            "product_id=%s — skip; next product-sync "
                            "tick should hydrate it",
                            cloud_product_id,
                        )
                        continue
                    net_g = (
                        prod_row["net_weight_g"]
                        if hasattr(prod_row, "__getitem__") else prod_row[0]
                    )
                    try:
                        net_g_f = float(net_g) if net_g is not None else None
                    except (TypeError, ValueError):
                        net_g_f = None
                    if net_g_f is None or net_g_f <= 0:
                        log.warning(
                            "event_overrides: product_id=%s has no/zero "
                            "net_weight_g — cannot convert qty_containers "
                            "to grams; skip",
                            cloud_product_id,
                        )
                        continue

                    # Resolve the Pi lot. Preferred path: cloud_lots row
                    # for resolved_lot_id has a pickup_event_id which
                    # equals the Pi lots row's pickup_event_id (the
                    # catch-all in-flight link). Fallback: most-recently-
                    # used active Pi lot for the product (legacy
                    # heuristic — kept ONLY for the case where
                    # resolved_lot_id is missing or the cloud_lots
                    # mirror hasn't been hydrated yet).
                    pi_lot_id: Optional[str] = None
                    if isinstance(resolved_lot_id, str) and resolved_lot_id:
                        cl_row = self._conn.execute(
                            "SELECT pickup_event_id FROM cloud_lots "
                            " WHERE lot_id = ?",
                            (resolved_lot_id,),
                        ).fetchone()
                        if cl_row is not None:
                            cloud_pickup_event_id = (
                                cl_row["pickup_event_id"]
                                if hasattr(cl_row, "__getitem__") else cl_row[0]
                            )
                            if isinstance(cloud_pickup_event_id, str) and cloud_pickup_event_id:
                                lot_row = self._conn.execute(
                                    "SELECT lot_id FROM lots "
                                    " WHERE pickup_event_id = ? "
                                    "   AND status IN ('on_shelf','in_flight') "
                                    " ORDER BY last_seen_at DESC LIMIT 1",
                                    (cloud_pickup_event_id,),
                                ).fetchone()
                                if lot_row is not None:
                                    pi_lot_id = (
                                        lot_row["lot_id"]
                                        if hasattr(lot_row, "__getitem__")
                                        else lot_row[0]
                                    )
                    if pi_lot_id is None:
                        # Legacy fallback: pick the most-recently-used
                        # active Pi lot for the product.
                        lot_row = self._conn.execute(
                            "SELECT lot_id FROM lots "
                            " WHERE product_id = ? "
                            "   AND status IN ('on_shelf','in_flight') "
                            " ORDER BY last_seen_at DESC LIMIT 1",
                            (cloud_product_id,),
                        ).fetchone()
                        if lot_row is not None:
                            pi_lot_id = (
                                lot_row["lot_id"]
                                if hasattr(lot_row, "__getitem__")
                                else lot_row[0]
                            )
                    if pi_lot_id is None:
                        log.info(
                            "event_overrides: no active Pi lot for "
                            "resolved_lot_id=%s product_id=%s — cloud "
                            "override applies to a lot the Pi never "
                            "saw; skip (state will re-materialize on "
                            "next placement)",
                            resolved_lot_id, cloud_product_id,
                        )
                        continue

                    qty_raw = cloud_lot.get("qty_containers")
                    try:
                        qty_f = float(qty_raw) if qty_raw is not None else None
                    except (TypeError, ValueError):
                        qty_f = None
                    if qty_f is None or qty_f < 0:
                        log.warning(
                            "event_overrides: invalid qty_containers=%r "
                            "for lot %s — skip",
                            qty_raw, pi_lot_id,
                        )
                        continue

                    new_weight_g = qty_f * net_g_f

                    # Audit finding #9: propagate in_flight_since /
                    # status flip from the cloud override. Conservative:
                    # only write when the cloud_lot dict carries
                    # ``in_flight_since`` (key present). A missing key
                    # means the override didn't touch the in-flight
                    # side; leave the Pi columns alone. The lots CHECK
                    # constraint enforces the (status='in_flight') ↔
                    # (in_flight_since IS NOT NULL) invariant, so we
                    # update the pair atomically.
                    update_clauses = [
                        "current_weight_g = ?",
                        "last_seen_at = datetime('now')",
                    ]
                    update_params: list[Any] = [new_weight_g]
                    if "in_flight_since" in cloud_lot:
                        new_ifs = cloud_lot.get("in_flight_since")
                        if isinstance(new_ifs, str) and not new_ifs.strip():
                            new_ifs = None
                        if new_ifs is None:
                            # Cloud cleared in_flight: status flips off.
                            update_clauses.extend([
                                "in_flight_since = NULL",
                                "status = CASE WHEN status = 'in_flight' "
                                "THEN 'on_shelf' ELSE status END",
                            ])
                        else:
                            update_clauses.extend([
                                "in_flight_since = ?",
                                "status = 'in_flight'",
                            ])
                            update_params.append(new_ifs)

                    update_params.append(pi_lot_id)
                    self._conn.execute(
                        f"UPDATE lots SET {', '.join(update_clauses)} "
                        f" WHERE lot_id = ?",
                        update_params,
                    )
                    applied_count += 1
                    status[key] = True
                    log.info(
                        "event_overrides: lot %s (product=%s, "
                        "resolved_lot_id=%s) current_weight_g → %.2fg "
                        "from cloud qty_containers=%.3f",
                        pi_lot_id, cloud_product_id, resolved_lot_id,
                        new_weight_g, qty_f,
                    )

        return applied_count, status

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
