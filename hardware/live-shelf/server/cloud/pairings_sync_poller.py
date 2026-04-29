"""Background thread that mirrors cloud ``chefbyte.scale_pairings`` onto the Pi.

The Pi's local ``scale_pairings`` table is what the inventory + dashboard
UIs read to render the per-scale tile (paired product, last heartbeat,
shelf kind). Until 2026-04-28 that table was empty on every boot; commit
``124fb1c`` plugged the obvious hole by INSERT-OR-IGNORE'ing one row per
*static-registry* entry at boot, so the section at least renders with
"(unpaired)". But the static registry only knows ``device_id`` +
``shelf_id``; the cloud-side pairing data (``product_id``, ``lot_id``)
written by the LiveTrack Import wizard never reached the Pi until reboot,
and even then only via the seed path — which left ``product_id`` NULL.

This poller closes that gap. Once a minute it re-pulls
``GET /catalog`` (same endpoint the classifier already drains every
event), extracts the ``pairings`` list — which the edge function
already filters server-side to THIS Pi's ``device_id`` via the x-api-key
auth → ``chefbyte.live_shelf_devices`` lookup — and reconciles the
local table:

  * Cloud row exists, Pi has matching row → UPDATE (cloud values for
    ``shelf_id``/``product_id``/``lot_id``; PRESERVE Pi-local
    ``last_heartbeat_ts`` and ``first_seen_at``).
  * Cloud row exists, Pi missing → INSERT.
  * Pi has row, cloud doesn't → DELETE (cloud is source of truth — if
    the user un-paired in cloud, the Pi must reflect that).

Schema mismatch handled at this boundary
----------------------------------------
* Cloud's ``scale_id`` (TEXT, e.g. ``"scale-01"``) maps to Pi's
  ``device_id`` (TEXT primary key). The literal field-name swap is
  unfortunate but matches the existing translation in
  ``handlers/scale_events.py`` so we stay consistent with the rest of
  the codebase.
* Cloud's ``kind`` ∈ ``{live_shelf, catch_all, live_scale}``. Pi's
  ``shelf_id`` ∈ ``{live_shelf, catch_all, single_item}`` — the legacy
  ``single_item`` term is enforced by the SQLite CHECK constraint on
  the local ``scale_pairings`` table. Translate at the ingress
  boundary, mirroring ``scale_events.py:3279``.

Heartbeat direction
-------------------
Cloud's ``scale_pairings.last_heartbeat_ts`` is stamped by the EDGE
FUNCTION when the Pi posts heartbeats — i.e. the cloud's "last seen"
is the Pi's outbound heartbeat clock. The Pi's local
``last_heartbeat_ts`` tracks something different: the last ESP→Pi LAN
heartbeat (per-scale liveness). Overwriting one with the other
conflates two distinct signals, so we deliberately leave the Pi's
column untouched. The local UI continues to use the Pi-side value;
the cloud-side value remains observable in cloud's chefbyte UI.

Watermark + cadence
-------------------
``/catalog`` returns the full pairing list every call (no
``updated_since`` filter for the pairings field — see
``supabase/functions/shelf-ingest/index.ts`` line ~178). The
"watermark" stored in ``data/last_pairings_sync.json`` is therefore a
liveness marker (``last_synced_at`` ISO timestamp) rather than a delta
cursor. We persist it so ``/healthz`` and operators can tell whether
the poller has run recently, and so a Pi restart doesn't have to log
"first ever sync" — but the next tick after a restart still does a
full reconcile (cheap: 3 rows).

Resilience
----------
Mirrors the ``LotSnapshotPoller`` patterns 1:1:
  * ``CloudError`` + bare ``Exception`` are caught at fetch time so a
    transient cloud outage never kills the thread.
  * Single-row apply failures log + continue (no batch poisoning).
  * Exponential backoff 1s → 30s cap on errors; reset on success.
  * Atomic state-file write (rename-over-temp).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Union

from .catalog import fetch_catalog
from .client import CloudError

log = logging.getLogger(__name__)


# Poll cadences (seconds). Module-level so tests can pin tiny values
# without monkey-patching the class.
POLL_INTERVAL_S = 60.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0

# State file schema version — bumped if we ever reshape the payload.
_STATE_SCHEMA_VERSION = 1

# Cloud → Pi shelf_id translation. Cloud uses the canonical ``live_scale``
# vocabulary; the Pi's local SQLite CHECK constraint still uses the
# legacy ``single_item`` literal. Mirrored from
# ``handlers/scale_events.py:3279`` so changing the mapping in one place
# fixes both ingress paths.
_SHELF_KIND_TRANSLATION = {
    "live_shelf": "live_shelf",
    "catch_all": "catch_all",
    "live_scale": "single_item",
}


@dataclass
class _SyncState:
    """On-disk state for the pairings poller (last-successful-sync marker)."""

    last_synced_at: Optional[str]  # ISO-8601 of the last successful tick

    def to_json(self) -> str:
        return json.dumps(
            {
                "version": _STATE_SCHEMA_VERSION,
                "last_synced_at": self.last_synced_at,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_file(cls, path: Path) -> "_SyncState":
        """Load from ``path`` or return an empty state.

        Any read / JSON / schema error degrades to a "no prior sync"
        state. Same tolerance as ``LotSnapshotPoller`` — a corrupt file
        is better handled by re-syncing than refusing to start.
        """
        if not path.exists():
            return cls(last_synced_at=None)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning(
                "pairings_sync: state file %s unreadable (%s); "
                "falling back to fresh sync",
                path, exc,
            )
            return cls(last_synced_at=None)
        if not isinstance(raw, dict) or raw.get("version") != _STATE_SCHEMA_VERSION:
            log.warning(
                "pairings_sync: state file %s has unexpected shape; "
                "falling back to fresh sync",
                path,
            )
            return cls(last_synced_at=None)
        ts = raw.get("last_synced_at")
        if ts is not None and not isinstance(ts, str):
            return cls(last_synced_at=None)
        return cls(last_synced_at=ts)

    def write(self, path: Path) -> None:
        """Atomic write — rename-over-temp."""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(self.to_json(), encoding="utf-8")
        tmp.replace(path)


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


class PairingsSyncPoller(threading.Thread):
    """Pull cloud ``scale_pairings`` rows for this Pi every ``POLL_INTERVAL_S``.

    Parameters mirror :class:`~server.cloud.lot_snapshot_poller.LotSnapshotPoller`
    so the two pollers can be wired into ``app.py`` from the same
    boilerplate.
    """

    name = "pairings-sync-poller"

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
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn = conn
        self._state_path = Path(state_path)
        self._db_lock = db_lock
        self._poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        # Injectable for tests that want to stub the network.
        self._fetch_catalog = fetch_catalog_fn or fetch_catalog
        self._backoff_s: float = INITIAL_BACKOFF_S
        self._state = _SyncState.from_file(self._state_path)

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def last_synced_at(self) -> Optional[str]:
        return self._state.last_synced_at

    def tick_once(self) -> int:
        """Run exactly one sync cycle. Returns Pi-side rows mutated.

        A "mutation" is any INSERT / UPDATE / DELETE on ``scale_pairings``.
        Returned for tests + observability; production reads the log line.

        Error handling: swallows :class:`CloudError` and bare
        :class:`Exception` so a transient cloud outage doesn't kill the
        thread. Each failure advances the backoff counter.
        """
        try:
            catalog = self._fetch_catalog(self._client)
        except CloudError as err:
            log.warning(
                "pairings_sync: fetch failed HTTP %d %s — next backoff %.1fs",
                err.status_code, str(err.body)[:200], self._next_backoff(),
            )
            return 0
        except Exception:  # noqa: BLE001 - defensive: never kill the thread
            log.warning(
                "pairings_sync: fetch raised unexpectedly — next backoff %.1fs",
                self._next_backoff(),
                exc_info=True,
            )
            return 0

        cloud_pairings_raw = getattr(catalog, "pairings", None)
        if not isinstance(cloud_pairings_raw, list):
            log.warning(
                "pairings_sync: catalog.pairings is not a list (got %s) — skipping",
                type(cloud_pairings_raw).__name__,
            )
            self._backoff_s = INITIAL_BACKOFF_S
            return 0

        # Project the cloud rows into Pi shape, dropping malformed entries
        # rather than poisoning the whole batch.
        cloud_rows: dict[str, dict] = {}
        for entry in cloud_pairings_raw:
            if not isinstance(entry, dict):
                continue
            scale_id = entry.get("scale_id")
            kind = entry.get("kind")
            if not isinstance(scale_id, str) or not scale_id.strip():
                log.warning("pairings_sync: missing/invalid scale_id; skipped")
                continue
            if not isinstance(kind, str) or kind not in _SHELF_KIND_TRANSLATION:
                log.warning(
                    "pairings_sync: unknown/missing kind %r for scale %s; skipped",
                    kind, scale_id,
                )
                continue
            cloud_rows[scale_id] = {
                "device_id": scale_id,  # cloud's scale_id == Pi's device_id
                "shelf_id": _SHELF_KIND_TRANSLATION[kind],
                "product_id": entry.get("product_id") or None,
                "lot_id": entry.get("lot_id") or None,
            }

        applied = self._reconcile(cloud_rows)

        # Success = reset backoff + persist the liveness watermark. We
        # write on every successful tick (even when ``applied == 0``) so
        # operators can see the poller is alive via /healthz; the cost
        # is one tiny rename per minute, negligible.
        self._backoff_s = INITIAL_BACKOFF_S
        now_iso = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
        self._state = _SyncState(last_synced_at=now_iso)
        try:
            self._state.write(self._state_path)
        except OSError:
            log.warning(
                "pairings_sync: failed to persist state to %s",
                self._state_path,
                exc_info=True,
            )

        log.info(
            "pairings_sync: synced %d pairing(s), %d mutation(s) "
            "(last_synced_at=%s)",
            len(cloud_rows), applied, now_iso,
        )
        return applied

    # ------------------------------------------------------------------
    # Reconcile helpers
    # ------------------------------------------------------------------

    def _reconcile(self, cloud_rows: dict[str, dict]) -> int:
        """Diff cloud snapshot against Pi local; emit minimal mutations.

        Returns the number of Pi rows touched (INSERT + UPDATE + DELETE).
        Idempotent: a tick where the cloud + Pi already agree returns 0
        and writes nothing.
        """
        lock = self._db_lock if self._db_lock is not None else _NullLock()
        applied = 0
        with lock:
            with self._conn:
                # Snapshot the existing Pi rows in one read so the diff
                # logic doesn't race against concurrent heartbeat writes
                # within the same transaction.
                pi_existing: dict[str, sqlite3.Row] = {
                    row["device_id"]: row
                    for row in self._conn.execute(
                        "SELECT device_id, shelf_id, product_id, lot_id "
                        "FROM scale_pairings"
                    ).fetchall()
                }

                # UPSERT each cloud row.
                for scale_id, cloud_row in cloud_rows.items():
                    try:
                        if self._upsert_one(cloud_row, pi_existing.get(scale_id)):
                            applied += 1
                    except sqlite3.Error:
                        log.warning(
                            "pairings_sync: upsert failed for scale_id=%r",
                            scale_id,
                            exc_info=True,
                        )
                        continue

                # DELETE Pi rows the cloud no longer has. Cloud is source
                # of truth — un-pair in cloud must reflect on Pi.
                for device_id in pi_existing.keys():
                    if device_id in cloud_rows:
                        continue
                    try:
                        cur = self._conn.execute(
                            "DELETE FROM scale_pairings WHERE device_id = ?",
                            (device_id,),
                        )
                        if cur.rowcount > 0:
                            applied += 1
                            log.info(
                                "pairings_sync: deleted local pairing %r "
                                "(removed in cloud)",
                                device_id,
                            )
                    except sqlite3.Error:
                        log.warning(
                            "pairings_sync: delete failed for device_id=%r",
                            device_id,
                            exc_info=True,
                        )
                        continue

        return applied

    def _upsert_one(
        self,
        cloud_row: dict,
        pi_row: Optional[sqlite3.Row],
    ) -> bool:
        """INSERT or UPDATE one Pi row from one cloud row.

        Returns True iff a row was actually written. The Pi-local
        ``last_heartbeat_ts`` and ``first_seen_at`` columns are NEVER
        touched here — see module docstring.

        Idempotency: if every column we'd write already matches the
        existing Pi row, skip the UPDATE entirely so the (cheap, but
        non-zero) write doesn't churn realtime/wal traffic.
        """
        device_id = cloud_row["device_id"]
        if pi_row is None:
            self._conn.execute(
                "INSERT INTO scale_pairings "
                "  (device_id, shelf_id, product_id, lot_id) "
                "VALUES (?, ?, ?, ?)",
                (
                    device_id,
                    cloud_row["shelf_id"],
                    cloud_row["product_id"],
                    cloud_row["lot_id"],
                ),
            )
            return True

        # Detect drift on the three cloud-authoritative columns.
        if (
            pi_row["shelf_id"] == cloud_row["shelf_id"]
            and pi_row["product_id"] == cloud_row["product_id"]
            and pi_row["lot_id"] == cloud_row["lot_id"]
        ):
            return False

        self._conn.execute(
            "UPDATE scale_pairings "
            "  SET shelf_id = ?, product_id = ?, lot_id = ? "
            "WHERE device_id = ?",
            (
                cloud_row["shelf_id"],
                cloud_row["product_id"],
                cloud_row["lot_id"],
                device_id,
            ),
        )
        return True

    def _next_backoff(self) -> float:
        """Return + advance the backoff duration for an errored tick."""
        nxt = min(self._backoff_s * 2.0, MAX_BACKOFF_S)
        current = self._backoff_s
        self._backoff_s = nxt
        return current

    # ------------------------------------------------------------------
    # Thread entrypoint
    # ------------------------------------------------------------------

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "pairings-sync-poller: starting (interval=%.1fs, state=%s, "
            "last_synced_at=%s)",
            self._poll_interval_s, self._state_path,
            self._state.last_synced_at or "<none>",
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
        log.info("pairings-sync-poller: shutdown complete")


__all__ = ["POLL_INTERVAL_S", "PairingsSyncPoller"]
