"""Background thread that mirrors cloud ``chefbyte.stock_lots`` onto the Pi.

The Pi's ``ProductSyncPoller`` already pulls product deltas + tombstones
from the cloud (``GET /shelf-ingest/catalog?updated_since=...``). There
was no counterpart for lot state: if the Pi and cloud diverged on
``stock_lots`` because of a network outage, a dropped
``POST /shelf-ingest/event``, or a manual cloud-side edit via the chef
UI, there was no recovery mechanism. The local ``lots`` table is keyed
by Pi-minted UUIDs and carries physical-shelf semantics (on_shelf /
in_flight / current_weight_g), so we can't just overwrite it with cloud
state. Instead we mirror cloud into a dedicated ``cloud_lots`` SQLite
table, keyed by cloud lot_id, that acts as the Pi's authoritative view
of cloud state. Other subsystems (the reconciler, the event viewer)
can join on product_id to reconcile lot quantities on demand.

Design mirrors :mod:`~server.cloud.product_sync_poller`:

  * Tick cadence: 60s on the happy path (one order of magnitude slower
    than product-sync; lot state changes are less frequent than
    product-catalog edits, and the event-drain path already pushes
    scale events into cloud in real time — this is strictly the
    drift-recovery channel).
  * Exponential backoff on cloud errors (1s → 30s cap).
  * Tracks the last-known ``updated_at`` high-watermark in
    ``<data_root>/last_lot_sync.json``.
  * First boot (no state file): sends ``updated_since=None`` and pulls
    the full live-lot set (cloud filters out tombstones on a full pull).
  * Subsequent ticks: send the cached watermark so the cloud returns
    only rows touched since — live or tombstoned.

Apply semantics (conflict resolution: cloud wins):
  * Cloud has row, Pi has row, rows differ → UPSERT (cloud values).
  * Cloud has row, Pi doesn't → INSERT.
  * Cloud has row with deleted_at set → DELETE from Pi's ``cloud_lots``.
    (We hard-delete locally rather than mirroring the tombstone — the
    table is a derived cache, the cloud side retains the audit trail.
    Matches product_sync tombstone semantics one level up: the row
    becomes invisible to lookups on the Pi. Keeping the tombstone would
    only matter for a multi-tier cache; cloud_lots is the only cache.)
  * Pi has row, cloud doesn't return it → LEAVE ALONE. This is the
    "freshly-minted, outbox will drain it" case from the task brief.
    The poller's delta window won't include rows older than the
    watermark, so we can't distinguish "cloud deleted this long ago"
    from "cloud never had it" without a full pull. The existing
    tombstone-on-delete path (cloud soft-delete → trigger bumps
    updated_at → delta window) covers the deliberate-delete case.
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
from .settings_cache import ClassifierSettings, ClassifierSettingsCache

log = logging.getLogger(__name__)


# Poll cadences (seconds). Module-level so tests can pin tiny values
# without monkey-patching the class.
POLL_INTERVAL_S = 60.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0

# State file schema version — bumped if we ever reshape the payload.
_STATE_SCHEMA_VERSION = 1

# Columns we write through from the cloud response into ``cloud_lots``.
# Kept as a module-level tuple so tests can introspect the exact shape
# without reaching into the SQL string.
_CLOUD_LOT_COLUMNS: tuple[str, ...] = (
    "lot_id",
    "product_id",
    "location_id",
    "qty_containers",
    "expires_on",
    "in_flight_since",
    "pickup_event_id",
    "updated_at",
    "deleted_at",
)


def _default_fetch_lot_snapshot(
    client: Any, *, updated_since: Optional[str] = None,
) -> dict:
    """Thin wrapper around ``CloudClient.get('/lot-snapshot', ...)``.

    Extracted so tests can stub the HTTP layer without touching the
    CloudClient itself.
    """
    if updated_since:
        return client.get("/lot-snapshot", params={"updated_since": updated_since})
    return client.get("/lot-snapshot")


def _default_fetch_settings(client: Any) -> dict:
    """Thin wrapper around ``CloudClient.get('/settings')``.

    Returns ``{ chefbyte_classifier_fallback_enabled: bool, ... }`` from
    the shelf-ingest edge function. Extracted so tests can stub it
    without monkey-patching the HTTP layer.
    """
    return client.get("/settings")


@dataclass
class _SyncState:
    """On-disk state for the lot-snapshot poller (high-watermark only)."""

    high_watermark: Optional[str]  # ISO-8601 of max(updated_at) seen

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
        """Load from ``path`` or return an empty state.

        Any read / JSON / schema error degrades to a "full re-sync"
        state (``high_watermark=None``). Same tolerance as
        ProductSyncPoller — a corrupt file is better handled by
        re-pulling everything than by refusing to start.
        """
        if not path.exists():
            return cls(high_watermark=None)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning(
                "lot_snapshot: state file %s unreadable (%s); "
                "falling back to full re-sync",
                path, exc,
            )
            return cls(high_watermark=None)
        if not isinstance(raw, dict) or raw.get("version") != _STATE_SCHEMA_VERSION:
            log.warning(
                "lot_snapshot: state file %s has unexpected shape; "
                "falling back to full re-sync",
                path,
            )
            return cls(high_watermark=None)
        hwm = raw.get("high_watermark")
        if hwm is not None and not isinstance(hwm, str):
            return cls(high_watermark=None)
        return cls(high_watermark=hwm)

    def write(self, path: Path) -> None:
        """Atomic write — rename-over-temp so a crash mid-write can't
        leave a truncated file that the next boot refuses to parse."""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(self.to_json(), encoding="utf-8")
        tmp.replace(path)


class _NullLock:
    """Context-manager no-op — matches threading.Lock's `with` interface.

    Duplicated (rather than imported from event_overrides_poller) to
    keep this module's imports self-contained — the null-lock pattern
    is trivial and matching the product_sync_poller's strategy.
    """

    def __enter__(self) -> "_NullLock":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def acquire(self, *_: Any, **__: Any) -> bool:
        return True

    def release(self) -> None:
        return None


class LotSnapshotPoller(threading.Thread):
    """Pull cloud stock_lots deltas every ``POLL_INTERVAL_S`` seconds.

    Parameters mirror :class:`~server.cloud.product_sync_poller.ProductSyncPoller`
    1:1 so the two pollers can be wired into ``app.py`` from the same
    boilerplate.
    """

    name = "lot-snapshot-poller"

    def __init__(
        self,
        client: Any,
        conn: sqlite3.Connection,
        state_path: Union[str, Path],
        *,
        db_lock: Optional[threading.Lock] = None,
        poll_interval_s: float = POLL_INTERVAL_S,
        shutdown_event: Optional[threading.Event] = None,
        fetch_snapshot_fn: Optional[Callable[..., Any]] = None,
        settings_cache: Optional[ClassifierSettingsCache] = None,
        fetch_settings_fn: Optional[Callable[..., Any]] = None,
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn = conn
        self._state_path = Path(state_path)
        self._db_lock = db_lock
        self._poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        self._fetch_snapshot = fetch_snapshot_fn or _default_fetch_lot_snapshot
        self._backoff_s: float = INITIAL_BACKOFF_S
        self._state = _SyncState.from_file(self._state_path)
        # Per-user classifier toggles (fallback flag, etc.). The cache is
        # refreshed on each tick alongside the lot-snapshot pull — same
        # cadence, same cloud round-trip pattern. ``None`` disables the
        # settings-pull side entirely (kept for tests + back-compat with
        # callers that don't wire the cache).
        self._settings_cache = settings_cache
        self._fetch_settings = fetch_settings_fn or _default_fetch_settings

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def high_watermark(self) -> Optional[str]:
        return self._state.high_watermark

    def tick_once(self) -> int:
        """Run exactly one sync cycle. Returns number of Pi rows mutated.

        A "mutation" is any INSERT / UPDATE / DELETE on cloud_lots. The
        count is primarily for tests + observability — production code
        reads the log line rather than the return value.

        Error handling: swallows :class:`CloudError` and bare
        :class:`Exception` so a transient cloud outage doesn't kill the
        thread. Each failure advances the backoff counter so the run
        loop sleeps longer on the next tick.
        """
        try:
            payload = self._fetch_snapshot(
                self._client, updated_since=self._state.high_watermark,
            )
        except CloudError as err:
            log.warning(
                "lot_snapshot: fetch failed HTTP %d %s — next backoff %.1fs",
                err.status_code, str(err.body)[:200], self._next_backoff(),
            )
            return 0
        except Exception:  # noqa: BLE001 - defensive: never kill the thread
            log.warning(
                "lot_snapshot: fetch raised unexpectedly — next backoff %.1fs",
                self._next_backoff(),
                exc_info=True,
            )
            return 0

        if not isinstance(payload, dict):
            log.warning(
                "lot_snapshot: unexpected payload type %s — skipping",
                type(payload).__name__,
            )
            self._backoff_s = INITIAL_BACKOFF_S
            return 0

        lots_raw = payload.get("lots")
        lots = lots_raw if isinstance(lots_raw, list) else []

        # Apply deltas + track max(updated_at) across ALL returned rows
        # (including tombstones — a deleted row still carries the bumped
        # updated_at and must advance the watermark so we don't re-fetch
        # it forever). An empty delta leaves the watermark untouched.
        max_updated_at: Optional[str] = self._state.high_watermark
        applied = 0
        for lot in lots:
            if not isinstance(lot, dict):
                continue
            row_ts = lot.get("updated_at")
            if isinstance(row_ts, str) and row_ts:
                if max_updated_at is None or row_ts > max_updated_at:
                    max_updated_at = row_ts
            try:
                if self._apply_one(lot):
                    applied += 1
            except sqlite3.Error:
                # Single-row failure must not poison the batch. Log + skip.
                log.warning(
                    "lot_snapshot: apply failed for lot_id=%r",
                    lot.get("lot_id"),
                    exc_info=True,
                )
                continue

        # Success = reset backoff. Persist the watermark only if it
        # advanced; an empty delta leaves the file untouched to avoid
        # disk churn. Matches ProductSyncPoller's write semantics.
        self._backoff_s = INITIAL_BACKOFF_S
        if max_updated_at != self._state.high_watermark:
            self._state = _SyncState(high_watermark=max_updated_at)
            try:
                self._state.write(self._state_path)
            except OSError:
                log.warning(
                    "lot_snapshot: failed to persist state to %s; "
                    "next boot will re-sync from prior watermark",
                    self._state_path,
                    exc_info=True,
                )

        log.info(
            "lot_snapshot: synced %d lot(s), %d mutation(s) "
            "(Δ since %s, watermark now %s)",
            len(lots), applied,
            self._state.high_watermark or "boot",
            max_updated_at or "<none>",
        )

        # Pull classifier settings on the same cadence. Best-effort: a
        # failure here MUST NOT impact the lot-snapshot result the
        # caller cares about (the watermark + mutation count). Log +
        # continue. The cache stays at its previous value (or default
        # FALSE on cold start) so the classifier sees a stable view.
        if self._settings_cache is not None:
            try:
                payload_s = self._fetch_settings(self._client)
                if isinstance(payload_s, dict):
                    self._settings_cache.update(
                        ClassifierSettings(
                            chefbyte_classifier_fallback_enabled=bool(
                                payload_s.get(
                                    "chefbyte_classifier_fallback_enabled",
                                    False,
                                )
                            ),
                        )
                    )
                else:
                    log.warning(
                        "lot_snapshot: settings payload type %s — keeping cache",
                        type(payload_s).__name__,
                    )
            except CloudError as err:
                log.warning(
                    "lot_snapshot: /settings fetch failed HTTP %d %s — "
                    "keeping previous cache",
                    err.status_code, str(err.body)[:200],
                )
            except Exception:  # noqa: BLE001 - never kill the thread
                log.warning(
                    "lot_snapshot: /settings fetch raised — keeping previous cache",
                    exc_info=True,
                )

        return applied

    # ------------------------------------------------------------------
    # Apply helper
    # ------------------------------------------------------------------

    def _apply_one(self, lot: dict) -> bool:
        """Apply one cloud lot row to the Pi's ``cloud_lots`` table.

        Returns True if any SQLite row was inserted / updated / deleted.
        Validates minimal shape (lot_id + product_id + updated_at are
        the required keys) and coerces types as needed — cloud values
        may arrive as str / int / float / None mixes that SQLite
        tolerates natively, so we only sanity-check the identifiers.

        Conflict resolution: cloud wins. INSERT OR REPLACE semantics
        via ON CONFLICT(lot_id) DO UPDATE so every column is rewritten
        on conflict. Tombstoned rows (deleted_at IS NOT NULL) are
        DELETEd locally rather than kept — the cloud retains the audit
        history; the Pi's mirror only needs the current state.
        """
        lot_id = lot.get("lot_id")
        product_id = lot.get("product_id")
        updated_at = lot.get("updated_at")
        if not isinstance(lot_id, str) or not lot_id.strip():
            log.warning("lot_snapshot: missing/invalid lot_id; skipped")
            return False
        if not isinstance(product_id, str) or not product_id.strip():
            log.warning(
                "lot_snapshot: missing/invalid product_id for lot %s; skipped",
                lot_id,
            )
            return False
        if not isinstance(updated_at, str) or not updated_at.strip():
            log.warning(
                "lot_snapshot: missing/invalid updated_at for lot %s; skipped",
                lot_id,
            )
            return False

        deleted_at = lot.get("deleted_at")
        is_tombstone = (
            isinstance(deleted_at, str) and deleted_at.strip()
        )

        lock = self._db_lock if self._db_lock is not None else _NullLock()
        with lock:
            with self._conn:
                if is_tombstone:
                    cur = self._conn.execute(
                        "DELETE FROM cloud_lots WHERE lot_id = ?",
                        (lot_id,),
                    )
                    return cur.rowcount > 0

                # Coerce qty_containers to a float if numeric; leave
                # other optional fields verbatim (SQLite tolerates None
                # / str / numeric natively on these columns).
                qty_raw = lot.get("qty_containers")
                try:
                    qty_f = float(qty_raw) if qty_raw is not None else 0.0
                except (TypeError, ValueError):
                    qty_f = 0.0

                values = (
                    lot_id,
                    product_id,
                    lot.get("location_id"),
                    qty_f,
                    lot.get("expires_on"),
                    lot.get("in_flight_since"),
                    lot.get("pickup_event_id"),
                    updated_at,
                    None,  # deleted_at — we never persist tombstones locally
                )
                placeholders = ", ".join(["?"] * len(_CLOUD_LOT_COLUMNS))
                self._conn.execute(
                    f"""
                    INSERT INTO cloud_lots (
                        {", ".join(_CLOUD_LOT_COLUMNS)}
                    ) VALUES ({placeholders})
                    ON CONFLICT(lot_id) DO UPDATE SET
                        product_id = excluded.product_id,
                        location_id = excluded.location_id,
                        qty_containers = excluded.qty_containers,
                        expires_on = excluded.expires_on,
                        in_flight_since = excluded.in_flight_since,
                        pickup_event_id = excluded.pickup_event_id,
                        updated_at = excluded.updated_at,
                        deleted_at = excluded.deleted_at,
                        synced_at = datetime('now')
                    """,
                    values,
                )
                return True

    def _next_backoff(self) -> float:
        """Return + advance the backoff duration for an errored tick.

        Each failed tick doubles the interval up to ``MAX_BACKOFF_S``.
        Matches ProductSyncPoller's _next_backoff 1:1 — the run loop
        uses the returned value (pre-increment) as its sleep, so the
        first failure sleeps INITIAL_BACKOFF_S, the second sleeps 2x,
        etc.
        """
        nxt = min(self._backoff_s * 2.0, MAX_BACKOFF_S)
        current = self._backoff_s
        self._backoff_s = nxt
        return current

    # ------------------------------------------------------------------
    # Thread entrypoint
    # ------------------------------------------------------------------

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "lot-snapshot-poller: starting (interval=%.1fs, state=%s, "
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
        log.info("lot-snapshot-poller: shutdown complete")


__all__ = ["POLL_INTERVAL_S", "LotSnapshotPoller"]
