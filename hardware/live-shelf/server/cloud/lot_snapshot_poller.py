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
    "in_flight_kind",
    "pickup_event_id",
    "created_at",
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
        products_synced_event: Optional[threading.Event] = None,
        products_synced_wait_s: float = 5.0,
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
        # Gap G10: cold-start ordering. Block our first ``tick_once``
        # for up to ``products_synced_wait_s`` on the shared Event so
        # ``product_sync_poller`` has a chance to mirror products
        # before any incoming lot references them. If the timeout
        # expires we proceed anyway — the apply path is already
        # tolerant of FK gaps (rows with unknown product_id skip
        # cleanly), the wait just keeps the boot-time log noise down.
        self._products_synced = products_synced_event
        self._products_synced_wait_s = float(products_synced_wait_s)
        self._products_synced_wait_done = False
        # Audit C2-05: cumulative count of product-fallback lot lookups
        # that were refused because >1 in_flight Pi lot matched the
        # product (mirrors event_overrides_poller's Gap G3 counter so
        # /healthz can surface the same ambiguity-skip signal).
        self._skipped_ambiguous_count = 0

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def skipped_ambiguous_count(self) -> int:
        """C2-05: how many product-fallback lot lookups were refused
        because more than one in_flight Pi lot matched the product. Read
        by the health endpoint; non-zero means drift the auto-resolver
        deliberately declined to guess at."""
        return self._skipped_ambiguous_count

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
        # Gap G10: on the very first tick, give product_sync a head
        # start so we don't race it on Pi boot. Same shape as in
        # event_overrides_poller.tick_once — wait at most once.
        if (
            self._products_synced is not None
            and not self._products_synced_wait_done
        ):
            if self._products_synced.wait(
                timeout=self._products_synced_wait_s,
            ):
                log.info(
                    "lot_snapshot: products_synced signaled, proceeding",
                )
            else:
                log.warning(
                    "lot_snapshot: products_synced wait expired after "
                    "%.1fs; proceeding anyway",
                    self._products_synced_wait_s,
                )
            self._products_synced_wait_done = True

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

        # Apply deltas + track max(updated_at) across returned rows so we
        # don't re-fetch them forever. A deleted row still carries the
        # bumped updated_at and must advance the watermark too. An empty
        # delta leaves the watermark untouched.
        #
        # Two distinct "row didn't apply" cases — they MUST be treated
        # differently for the watermark:
        #
        #   (a) Malformed row — ``_apply_one`` returns False (bad/missing
        #       lot_id / product_id / updated_at). This is a *permanent*
        #       defect: the cloud will never re-send a corrected row under
        #       the same updated_at, so re-fetching it forever is pure
        #       waste. The watermark SHOULD advance past it.
        #       Pinned by ``test_malformed_rows_do_not_poison_watermark_advance``.
        #
        #   (b) Apply RAISED a ``sqlite3.Error`` — a *transient/recoverable*
        #       DB fault (busy lock, disk I/O, deferred-FK hiccup). The row
        #       is still valid and WILL apply on a later tick. Audit C2-01:
        #       the cloud delta filter is a strict ``updated_at > watermark``,
        #       so if we advance the watermark to/past a raised row, that
        #       row is dropped from every future delta window — permanent
        #       mirror drift / data loss. So we must NOT advance the
        #       watermark to or beyond the earliest raised row; it stays
        #       below that floor and the row is retried next tick.
        #
        # Implementation: ``failed_floor`` = min(updated_at) among rows
        # whose apply raised. The watermark may only advance to the max
        # updated_at of rows strictly older than that floor. Rows at/after
        # the floor (including the failed row itself) are held back.
        max_updated_at: Optional[str] = self._state.high_watermark
        failed_floor: Optional[str] = None
        applied = 0
        pending_ts: list[str] = []
        for lot in lots:
            if not isinstance(lot, dict):
                continue
            row_ts = lot.get("updated_at")
            row_ts_str = row_ts if (isinstance(row_ts, str) and row_ts) else None
            try:
                applied_row = self._apply_one(lot)
            except sqlite3.Error:
                # Transient single-row failure — log, skip, and hold the
                # watermark below this row so the next tick retries it.
                log.warning(
                    "lot_snapshot: apply failed for lot_id=%r — "
                    "holding watermark so it is retried next tick",
                    lot.get("lot_id"),
                    exc_info=True,
                )
                if row_ts_str is not None and (
                    failed_floor is None or row_ts_str < failed_floor
                ):
                    failed_floor = row_ts_str
                continue
            if applied_row:
                applied += 1
            # Applied OR malformed-skip (returned False): both may advance
            # the watermark. Defer the actual max() until we know the
            # failed_floor for the whole batch.
            if row_ts_str is not None:
                pending_ts.append(row_ts_str)

        # Advance the watermark only across rows strictly older than the
        # earliest transient failure. This keeps malformed rows (case a)
        # advancing while pinning recoverable raised rows (case b) inside
        # the next delta window.
        for ts_str in pending_ts:
            if failed_floor is not None and ts_str >= failed_floor:
                continue
            if max_updated_at is None or ts_str > max_updated_at:
                max_updated_at = ts_str

        # Success path: persist watermark BEFORE resetting backoff so
        # that an OSError on _state.write (disk-full, read-only mount,
        # fsync error) leaves the in-memory state at its prior value AND
        # keeps the backoff elevated. Audit gap G4: previously the
        # in-memory state was advanced first, so a failed write left the
        # poller with an advanced watermark that the next tick used to
        # skip the rows the cloud just returned — and on Pi reboot, the
        # on-disk file was stale and the gap became permanent.
        #
        # Order now:
        #   applied → persist (state.write) → reset backoff
        # If persist raises, in-memory state is reverted to prior so the
        # next tick refetches the same range, and backoff stays elevated
        # so the retry cadence remains tight.
        persist_succeeded = True
        if max_updated_at != self._state.high_watermark:
            prior_state = self._state
            self._state = _SyncState(high_watermark=max_updated_at)
            try:
                self._state.write(self._state_path)
            except OSError:
                # Revert in-memory state so the next tick refetches the
                # same range, and leave backoff at its prior elevated
                # value so we retry quickly.
                self._state = prior_state
                persist_succeeded = False
                log.warning(
                    "lot_snapshot: failed to persist state to %s; "
                    "reverting in-memory watermark — next tick will "
                    "re-fetch the same range",
                    self._state_path,
                    exc_info=True,
                )
        if persist_succeeded:
            self._backoff_s = INITIAL_BACKOFF_S

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
                    # Audit finding #3: before hard-deleting the
                    # cloud_lots mirror, find the matching Pi-local
                    # ``lots`` row and flag it to ``lost`` so the local
                    # state machine recovers. Otherwise an in_flight Pi
                    # lot stays in_flight forever while the cloud
                    # considers the lot deleted.
                    pi_lot_id = self._find_pi_lot_for_cloud_lot(lot_id)
                    if pi_lot_id is not None:
                        # Flag the Pi lot to ``lost`` and clear ALL the
                        # in-flight columns to satisfy the (status =
                        # 'in_flight') ↔ (in_flight_since IS NOT NULL)
                        # invariant CHECK. Also clear ``pickup_event_id``
                        # — it's only meaningful while the lot is
                        # mid-pickup; leaving it on a ``lost`` row poisons
                        # downstream joins (event_overrides_poller uses
                        # pickup_event_id to resolve "which Pi lot does
                        # this cloud event refer to" and would match the
                        # stale 'lost' row).
                        self._conn.execute(
                            "UPDATE lots "
                            "   SET status = 'lost', "
                            "       in_flight_since = NULL, "
                            "       pickup_event_id = NULL, "
                            "       last_seen_at = datetime('now') "
                            " WHERE lot_id = ?",
                            (pi_lot_id,),
                        )
                        log.info(
                            "lot_snapshot: tombstone for cloud lot %s "
                            "flagged Pi lot %s as lost (was in_flight "
                            "or on_shelf)",
                            lot_id, pi_lot_id,
                        )

                    cur = self._conn.execute(
                        "DELETE FROM cloud_lots WHERE lot_id = ?",
                        (lot_id,),
                    )
                    return cur.rowcount > 0

                # Audit gap G2: cloud-side `catch_all_in_flight_reaper`
                # clears `in_flight_since / in_flight_kind /
                # pickup_event_id` on stale lots after the 6h TTL. The
                # row is NOT tombstoned — only the markers are cleared
                # and `updated_at` bumps. Detect that transition
                # (existing row has in_flight_since set, incoming row
                # has it NULL) BEFORE the upsert mutates the cloud_lots
                # mirror, and flip the matching Pi `lots` row from
                # 'in_flight' → 'out' (NOT 'lost' — the reaper did not
                # decide it was consumed; 'out' = cleanly resolved
                # off-shelf). Without this, the cloud resolves the lot
                # but the Pi `lots` row stays at 'in_flight' forever
                # (chocolate-milk-stuck-in-flight-for-11-days
                # symptom).
                inbound_in_flight_since = lot.get("in_flight_since")
                if inbound_in_flight_since is None:
                    existing = self._conn.execute(
                        "SELECT in_flight_since FROM cloud_lots "
                        " WHERE lot_id = ?",
                        (lot_id,),
                    ).fetchone()
                    prior_in_flight_since: Optional[str] = None
                    if existing is not None:
                        prior_in_flight_since = (
                            existing["in_flight_since"]
                            if hasattr(existing, "__getitem__") else existing[0]
                        )
                    if (
                        isinstance(prior_in_flight_since, str)
                        and prior_in_flight_since
                    ):
                        # Reaper-signature transition. Look up the
                        # matching Pi `lots` row using the same lookup
                        # the tombstone branch uses, and flip it from
                        # 'in_flight' → 'out'.
                        pi_lot_id = self._find_pi_lot_for_cloud_lot(lot_id)
                        if pi_lot_id is not None:
                            self._conn.execute(
                                "UPDATE lots "
                                "   SET status = 'out', "
                                "       in_flight_since = NULL, "
                                "       pickup_event_id = NULL, "
                                "       last_seen_at = datetime('now'), "
                                "       last_out_at = datetime('now') "
                                " WHERE lot_id = ? "
                                "   AND status = 'in_flight'",
                                (pi_lot_id,),
                            )
                            log.info(
                                "lot_snapshot: cloud in_flight cleared "
                                "for lot %s (prior in_flight_since=%s) "
                                "— flipped Pi lot %s 'in_flight' → 'out'",
                                lot_id, prior_in_flight_since, pi_lot_id,
                            )
                        else:
                            log.debug(
                                "lot_snapshot: cloud in_flight cleared "
                                "for lot %s but no matching Pi lots row "
                                "found (already cleaned up?)",
                                lot_id,
                            )

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
                    lot.get("in_flight_kind"),
                    lot.get("pickup_event_id"),
                    lot.get("created_at"),
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
                        in_flight_kind = excluded.in_flight_kind,
                        pickup_event_id = excluded.pickup_event_id,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at,
                        deleted_at = excluded.deleted_at,
                        synced_at = datetime('now')
                    """,
                    values,
                )
                return True

    def _find_pi_lot_for_cloud_lot(self, lot_id: str) -> Optional[str]:
        """Find the Pi-local ``lots.lot_id`` that maps to a cloud lot.

        Shared by the tombstone branch (cloud row hard-deleted → flag
        Pi 'lost') and the in_flight-clear branch (cloud reaper cleared
        markers → flip Pi 'in_flight' → 'out'). The mirror row is read
        BEFORE the upsert overwrites it, so ``cloud_lots`` still has
        the prior pickup_event_id / product_id when this is called.

        Mapping order (preferred first):
          1. ``cloud_lots.pickup_event_id`` ↔ ``lots.pickup_event_id`` —
             exact link for catch-all in-flight lots.
          2. Fallback by (product_id, status='in_flight') — covers the
             case where the pickup_event_id link is missing on legacy
             live-shelf lots. Audit C2-05: this fallback is UNSAFE when
             >1 in_flight lot matches the product (the cloud row doesn't
             say which one it meant); in that case we DEFER — return None
             and bump ``skipped_ambiguous_count`` — rather than flipping
             an arbitrary lot.

        Returns the Pi ``lots.lot_id`` if found, ``None`` if not found OR
        if the product fallback is ambiguous (>1 in_flight match).
        Callers must hold ``self._db_lock`` if one is configured.
        """
        cl_row = self._conn.execute(
            "SELECT pickup_event_id, product_id "
            "  FROM cloud_lots WHERE lot_id = ?",
            (lot_id,),
        ).fetchone()
        if cl_row is None:
            return None
        cl_pickup_event_id = (
            cl_row["pickup_event_id"]
            if hasattr(cl_row, "__getitem__") else cl_row[0]
        )
        cl_product_id = (
            cl_row["product_id"]
            if hasattr(cl_row, "__getitem__") else cl_row[1]
        )

        if isinstance(cl_pickup_event_id, str) and cl_pickup_event_id:
            pi_row = self._conn.execute(
                "SELECT lot_id FROM lots "
                " WHERE pickup_event_id = ? "
                "   AND status IN ('on_shelf','in_flight') "
                " ORDER BY last_seen_at DESC LIMIT 1",
                (cl_pickup_event_id,),
            ).fetchone()
            if pi_row is not None:
                return (
                    pi_row["lot_id"]
                    if hasattr(pi_row, "__getitem__") else pi_row[0]
                )

        if isinstance(cl_product_id, str) and cl_product_id:
            # Heuristic fallback: in_flight Pi lot for the product.
            # Narrowed to in_flight — the dangerous state — an on_shelf
            # lot that the cloud thinks is gone is a separate drift
            # symptom and shouldn't be auto-flagged from this path.
            #
            # Audit C2-05: BEFORE picking the most-recent in_flight lot,
            # count how many in_flight Pi lots exist for this product. If
            # >1, ``ORDER BY in_flight_since DESC LIMIT 1`` would flip an
            # ARBITRARY one — and the cloud row that triggered this (a
            # tombstone, or a reaper in_flight-clear) does not tell us
            # WHICH of the duplicates it referred to. Flipping the wrong
            # lot to 'lost'/'out' is silent data corruption. Mirrors the
            # G3 guard in event_overrides_poller: refuse, log, and DEFER
            # (return None → caller leaves all candidates untouched). The
            # exact-link path above (pickup_event_id) is unambiguous and
            # still resolves the common case; this guard only fires on the
            # legacy/fallback heuristic where >1 lot genuinely competes.
            ambiguous_count_row = self._conn.execute(
                "SELECT COUNT(*) FROM lots "
                " WHERE product_id = ? "
                "   AND status = 'in_flight'",
                (cl_product_id,),
            ).fetchone()
            ambiguous_count = (
                ambiguous_count_row[0]
                if ambiguous_count_row is not None else 0
            )
            if ambiguous_count > 1:
                self._skipped_ambiguous_count += 1
                log.warning(
                    "lot_snapshot: AMBIGUOUS product-fallback for cloud "
                    "lot %s product_id=%s — %d in_flight Pi lots match "
                    "and the cloud row's pickup_event_id linked to none; "
                    "refusing to flip an arbitrary lot — deferring (no "
                    "mutation). A real per-lot event must disambiguate.",
                    lot_id, cl_product_id, ambiguous_count,
                )
                return None
            pi_row = self._conn.execute(
                "SELECT lot_id FROM lots "
                " WHERE product_id = ? "
                "   AND status = 'in_flight' "
                " ORDER BY in_flight_since DESC LIMIT 1",
                (cl_product_id,),
            ).fetchone()
            if pi_row is not None:
                return (
                    pi_row["lot_id"]
                    if hasattr(pi_row, "__getitem__") else pi_row[0]
                )

        return None

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
