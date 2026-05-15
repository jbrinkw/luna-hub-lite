"""Background thread that pulls cloud product-catalog deltas every 30s.

The LiveTrack Import wizard (and the cloud ChefByte Settings page) writes
``chefbyte.products`` directly on Supabase. Without a cloud → Pi pull path,
new or edited products never reach the Pi's local SQLite cache, so the
classifier + intake UI can't see them until the next reboot (which is the
only moment ``sync_products_from_cloud`` runs today).

This poller closes that gap:

  * Tick cadence: 30s on the happy path.
  * Exponential backoff on cloud errors (1s → 30s cap).
  * Tracks the last-known ``updated_at`` high-watermark in a small JSON
    state file so a Pi reboot doesn't refetch the whole catalog.
  * First boot (no state file): sends ``updated_since=None`` and pulls
    the full catalog.
  * Subsequent ticks: send the cached high-watermark so the cloud returns
    only rows touched since.

The heavy lifting (upsert + orphan-photo scan) lives in
:mod:`server.intake.cloud_sync` — this thread is a thin scheduler.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Union

from ..intake.cloud_sync import upsert_product_from_cloud
from .catalog import fetch_catalog
from .client import CloudError

log = logging.getLogger(__name__)


# Poll cadences (seconds). Kept module-level so tests can patch them to
# run faster without monkey-patching the class.
POLL_INTERVAL_S = 30.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0

# State file schema version — bumped if we ever reshape the payload. The
# loader ignores unknown versions and resets to a full re-sync rather than
# carrying forward a payload it can't trust.
_STATE_SCHEMA_VERSION = 1


@dataclass
class _SyncState:
    """On-disk state snapshot for the product poller.

    Kept as a dataclass (not a bare dict) so the JSON codec is explicit
    and adding fields later is a compile-time diff rather than a runtime
    ``.get(..., default)`` mess.
    """

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

        Any read / JSON / schema error degrades to a "full re-sync" state
        (``high_watermark=None``) — safer than carrying forward a value
        we can't validate. The next successful tick rewrites the file.
        """
        if not path.exists():
            return cls(high_watermark=None)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning(
                "product_sync: state file %s unreadable (%s); "
                "falling back to full re-sync",
                path, exc,
            )
            return cls(high_watermark=None)
        if not isinstance(raw, dict) or raw.get("version") != _STATE_SCHEMA_VERSION:
            log.warning(
                "product_sync: state file %s has unexpected shape; "
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


class ProductSyncPoller(threading.Thread):
    """Pull cloud product-catalog deltas every ``POLL_INTERVAL_S`` seconds.

    Parameters
    ----------
    client:
        Configured :class:`~server.cloud.client.CloudClient`.
    conn:
        SQLite connection to the Pi's local DB. Reused across ticks; the
        upsert helper owns its own ``with conn:`` transaction.
    state_path:
        Filesystem location of the JSON state file (e.g.
        ``<data_root>/last_product_sync.json``). Auto-created on first
        successful tick.
    db_lock:
        Shared DB lock passed through to the upsert helper so writes
        interleave correctly with the rest of the app.
    poll_interval_s:
        Override for the 30s cadence — tests can pin a tiny value to
        step the state machine without real sleeps.
    shutdown_event:
        Pre-existing :class:`threading.Event`; if ``None`` the thread
        creates its own and callers must use :meth:`stop` to exit.
    """

    name = "product-sync-poller"

    def __init__(
        self,
        client: Any,
        conn: sqlite3.Connection,
        state_path: Union[str, Path],
        *,
        db_lock: Optional[threading.Lock] = None,
        poll_interval_s: float = POLL_INTERVAL_S,
        shutdown_event: Optional[threading.Event] = None,
        fetch_catalog_fn: Optional[Callable[..., Any]] = None,
        products_synced_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn = conn
        self._state_path = Path(state_path)
        self._db_lock = db_lock
        self._poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        # Injectable for tests that want to stub network calls without
        # monkey-patching the module.
        self._fetch_catalog = fetch_catalog_fn or fetch_catalog
        # Adaptive backoff state. Reset on any successful tick.
        self._backoff_s: float = INITIAL_BACKOFF_S
        # Load existing state eagerly so ``tick_once`` callers (tests)
        # see the correct watermark on the first run.
        self._state = _SyncState.from_file(self._state_path)
        # Gap G10: cross-poller cold-start coordination. Other pollers
        # (event_overrides, lot_snapshot) reference products that this
        # poller mirrors locally. They wait up to ~5s on this Event
        # before their first fetch so we don't race them into
        # "product missing" skips on Pi boot. Set on every successful
        # tick (idempotent — Event.set() is a no-op once latched).
        self._products_synced = products_synced_event

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        """Signal the thread to exit on its next wake."""
        self._shutdown.set()

    @property
    def high_watermark(self) -> Optional[str]:
        """Expose the current high-watermark for tests + /healthz."""
        return self._state.high_watermark

    def tick_once(self) -> int:
        """Run exactly one sync cycle. Returns rows upserted (``0`` on error).

        Exposed for tests so they can drive the state machine
        deterministically without spinning the thread or sleeping.

        Error handling: swallows :class:`CloudError` and bare
        :class:`Exception` so a transient cloud outage doesn't bubble
        out into the thread's ``run`` loop (and so tests can assert on
        the state file + next backoff without try/except).
        """
        try:
            catalog = self._fetch_catalog(
                self._client, updated_since=self._state.high_watermark,
            )
        except CloudError as err:
            log.warning(
                "product_sync: fetch failed HTTP %d %s — next backoff %.1fs",
                err.status_code, str(err.body)[:200], self._next_backoff(),
            )
            return 0
        except Exception:  # noqa: BLE001 - defensive: never kill the thread
            log.warning(
                "product_sync: fetch raised unexpectedly — next backoff %.1fs",
                self._next_backoff(),
                exc_info=True,
            )
            return 0

        count = 0
        max_updated_at: Optional[str] = self._state.high_watermark
        for product in catalog.products:
            if not isinstance(product, dict):
                continue
            try:
                result = upsert_product_from_cloud(
                    self._conn, product, db_lock=self._db_lock,
                )
            except Exception:  # noqa: BLE001 - single-row failure must not poison the whole batch
                log.warning(
                    "product_sync: upsert failed for product_id=%r",
                    product.get("product_id"),
                    exc_info=True,
                )
                continue
            if result is not None:
                count += 1
            # Audit finding #7: advance the watermark over EVERY row
            # the cloud sent us, not just the ones that resulted in an
            # upsert. ``upsert_product_from_cloud`` returns None for
            # malformed rows (missing product_id/name) AND for
            # tombstone deliveries that happen to have no prior local
            # row to soft-delete. Both cases must still advance the
            # watermark — the cloud filters ``> updated_since``, so
            # leaving the cursor stuck on a tombstone-only window means
            # the next tick re-fetches the same window forever.
            # Compare to lot_snapshot_poller's pattern, which advances
            # over the row even on a malformed-skip.
            #
            # Test cross-reference (audit L11 deferred sibling):
            #   * ``test_malformed_product_skipped_without_poisoning_batch``
            #     in tests/test_product_sync_poller.py — mixed batch.
            #   * ``test_all_malformed_batch_still_advances_watermark`` —
            #     all-malformed batch still advances watermark; pins
            #     this behavior so a future regression that gates the
            #     watermark advance on upsert success is caught.
            row_ts = product.get("updated_at")
            if isinstance(row_ts, str) and row_ts:
                if max_updated_at is None or row_ts > max_updated_at:
                    max_updated_at = row_ts

        # Persist the watermark ONLY if it advanced; an empty delta
        # (count==0, max unchanged) leaves the file untouched so we
        # don't churn disk.
        #
        # Audit gap G4: order is `applied → persist → reset backoff`.
        # If state.write raises (disk-full / RO mount / fsync error),
        # revert the in-memory ``self._state`` to its prior value AND
        # keep the backoff at its elevated value. Otherwise:
        #   * The next tick would use the advanced in-memory watermark
        #     and refuse to re-fetch the rows the cloud just returned.
        #   * On Pi reboot, the on-disk file is stale and the gap is
        #     permanent.
        # Saving the prior state to a local before mutating means the
        # OSError path restores both the watermark and the backoff
        # exactly as if this tick had never advanced anything.
        if max_updated_at != self._state.high_watermark:
            prior_state = self._state
            self._state = _SyncState(high_watermark=max_updated_at)
            try:
                self._state.write(self._state_path)
            except OSError:
                # Persistence failed — roll back the in-memory advance
                # so the next tick re-fetches the same window. Leave
                # the backoff untouched (the early-return below skips
                # the reset) so the run loop throttles its retry pace.
                self._state = prior_state
                log.warning(
                    "product_sync: failed to persist state to %s; "
                    "reverting in-memory watermark and keeping backoff "
                    "elevated so the next tick retries the same window",
                    self._state_path,
                    exc_info=True,
                )
                return count

        # Success (or no-op tick): reset backoff. We only reach this
        # after the watermark either didn't move (no rows / empty delta)
        # OR moved AND was successfully persisted to disk.
        self._backoff_s = INITIAL_BACKOFF_S

        # Gap G10: signal cold-start waiters. Set on every successful
        # tick so a later subscriber that started waiting AFTER the
        # first tick already fired still completes immediately. Calling
        # ``set()`` on a latched Event is a cheap no-op.
        if self._products_synced is not None:
            self._products_synced.set()

        log.info(
            "product_sync: synced %d product(s) (Δ since %s)",
            count, self._state.high_watermark or "boot",
        )
        return count

    def _next_backoff(self) -> float:
        """Return + advance the backoff duration for an errored tick.

        Each failed tick doubles the interval up to ``MAX_BACKOFF_S``.
        The run loop uses this to override the normal 30s cadence so a
        transient outage doesn't pound the edge function.
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
            "product-sync-poller: starting (interval=%.1fs, state=%s, watermark=%s)",
            self._poll_interval_s, self._state_path,
            self._state.high_watermark or "<none>",
        )
        # Backoff is consumed when a tick errors; successful ticks sleep
        # the base interval. Track the last backoff separately so a
        # failure's wait time reflects the *current* backoff rather than
        # the value after ``_next_backoff()`` incremented it.
        while not self._shutdown.is_set():
            pre_backoff = self._backoff_s
            self.tick_once()
            if self._backoff_s == INITIAL_BACKOFF_S:
                sleep_s = self._poll_interval_s
            else:
                # Errored tick: use the pre-increment backoff so the
                # first failure sleeps INITIAL_BACKOFF_S, the second
                # sleeps 2x, etc.
                sleep_s = pre_backoff
            if self._shutdown.wait(sleep_s):
                break
        log.info("product-sync-poller: shutdown complete")


__all__ = ["POLL_INTERVAL_S", "ProductSyncPoller"]
