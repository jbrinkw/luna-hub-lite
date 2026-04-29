"""Pull cloud review_queue resolutions back to the Pi.

Sync-audit finding #5 (path A): the cloud /chef/reviews UI lets the user
resolve / dismiss reviews. The cloud writes the new status +
``user_response`` to ``chefbyte.review_queue`` and stamps
``resolved_at``. This poller mirrors those resolutions into the Pi's
local ``review_queue`` so the Pi /inventory UI reflects cloud-side
decisions without a manual refresh.

Mirror of :mod:`server.cloud.event_overrides_poller`:

  * Tick cadence: 30s.
  * Exponential backoff on cloud errors (1s → 30s).
  * Watermark tracked in a small JSON state file (
    ``<data_root>/last_review_resolve_sync.json``).
  * Idempotent — applying a resolution to an already-resolved local row
    is a no-op (`storage_repo.resolve_review` UPDATE just rewrites the
    same fields).

The cloud endpoint we hit:
    GET /shelf-ingest/review-resolved-since?updated_since=<iso>

Response shape::

    { "reviews": [
        { "pi_review_id": "<uuid>", "status": "resolved"|"dismissed",
          "resolved_at": "<iso>", "user_response": {...} | null }, ...
      ]
    }

Apply path:
  1. Look up the local ``review_queue`` row by ``review_id == pi_review_id``
     (the cloud's mirror keys ``pi_review_id`` to the Pi's local id, so
     the cloud sends Pi ids back unchanged).
  2. If the local row is already resolved/dismissed, advance the
     watermark and continue (the local row is the leading edge — common
     when the Pi resolved first and then this poller saw the cloud
     mirror of its own emit).
  3. Otherwise, call ``storage_repo.resolve_review`` to flip status +
     persist user_response.

The cloud's ``resolved_at`` is the watermark column; out-of-order
arrivals are fine (apply is idempotent).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Union

from ..storage import repo as storage_repo
from .client import CloudError

log = logging.getLogger(__name__)


POLL_INTERVAL_S = 30.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 30.0
_STATE_SCHEMA_VERSION = 1


def _default_fetch(
    client: Any, *, updated_since: Optional[str] = None,
) -> dict:
    if updated_since:
        return client.get(
            "/review-resolved-since", params={"updated_since": updated_since}
        )
    return client.get("/review-resolved-since")


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
                "review_sync: state file %s unreadable (%s); full re-sync",
                path, exc,
            )
            return cls(high_watermark=None)
        if not isinstance(raw, dict) or raw.get("version") != _STATE_SCHEMA_VERSION:
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


class ReviewSyncPoller(threading.Thread):
    """Pull cloud review_queue resolutions every ``POLL_INTERVAL_S`` s.

    Parameters mirror :class:`~server.cloud.event_overrides_poller.EventOverridesPoller`.
    """

    name = "review-sync-poller"

    def __init__(
        self,
        client: Any,
        conn: sqlite3.Connection,
        state_path: Union[str, Path],
        *,
        db_lock: Optional[threading.Lock] = None,
        poll_interval_s: float = POLL_INTERVAL_S,
        shutdown_event: Optional[threading.Event] = None,
        fetch_fn: Optional[Callable[..., Any]] = None,
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn = conn
        self._state_path = Path(state_path)
        self._db_lock = db_lock
        self._poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        self._fetch = fetch_fn or _default_fetch
        self._backoff_s: float = INITIAL_BACKOFF_S
        self._state = _SyncState.from_file(self._state_path)

    def stop(self) -> None:
        self._shutdown.set()

    @property
    def high_watermark(self) -> Optional[str]:
        return self._state.high_watermark

    def tick_once(self) -> int:
        """Run exactly one sync cycle. Returns rows applied."""
        try:
            payload = self._fetch(self._client, updated_since=self._state.high_watermark)
        except CloudError as err:
            log.warning(
                "review_sync: fetch failed HTTP %d %s — backoff %.1fs",
                err.status_code, str(err.body)[:200], self._next_backoff(),
            )
            return 0
        except Exception:  # noqa: BLE001
            log.warning(
                "review_sync: fetch raised — backoff %.1fs",
                self._next_backoff(), exc_info=True,
            )
            return 0

        if not isinstance(payload, dict):
            self._backoff_s = INITIAL_BACKOFF_S
            return 0

        reviews_raw = payload.get("reviews")
        reviews = reviews_raw if isinstance(reviews_raw, list) else []
        if not reviews:
            self._backoff_s = INITIAL_BACKOFF_S
            return 0

        applied = self._apply(reviews)

        # Advance watermark over the prefix of consecutively-applied
        # rows in chronological order. Sort by resolved_at to be safe;
        # the cloud already orders ascending but a stable client-side
        # sort guards against future endpoint changes.
        sorted_rows = sorted(
            (r for r in reviews if isinstance(r, dict)),
            key=lambda r: r.get("resolved_at") or "",
        )
        max_ts: Optional[str] = self._state.high_watermark
        for r in sorted_rows:
            ts = r.get("resolved_at")
            if not (isinstance(ts, str) and ts):
                break
            if max_ts is None or ts > max_ts:
                max_ts = ts

        self._backoff_s = INITIAL_BACKOFF_S
        if max_ts != self._state.high_watermark:
            self._state = _SyncState(high_watermark=max_ts)
            try:
                self._state.write(self._state_path)
            except OSError:
                log.warning(
                    "review_sync: failed to persist state to %s",
                    self._state_path, exc_info=True,
                )

        log.info(
            "review_sync: synced %d resolution(s), applied %d (Δ since %s)",
            len(reviews), applied, self._state.high_watermark or "boot",
        )
        return applied

    def _apply(self, reviews: list[dict]) -> int:
        """Apply each cloud resolution to the local review_queue row.

        Idempotent: applying a resolution to an already-resolved local
        row rewrites the same fields. Missing local rows are skipped
        with INFO — the cloud knows about a Pi-id we never created
        locally, which means the Pi DB was wiped after the resolution
        was made; nothing to do.
        """
        applied = 0
        lock = self._db_lock if self._db_lock is not None else _NullLock()
        with lock:
            for r in reviews:
                if not isinstance(r, dict):
                    continue
                pi_review_id = r.get("pi_review_id")
                status = r.get("status")
                if not isinstance(pi_review_id, str) or not pi_review_id:
                    continue
                if status not in ("resolved", "dismissed"):
                    log.warning(
                        "review_sync: cloud returned invalid status=%r "
                        "for pi_review_id=%s — skip",
                        status, pi_review_id,
                    )
                    continue
                local = storage_repo.get_review(self._conn, pi_review_id)
                if local is None:
                    log.info(
                        "review_sync: local review_queue row missing for "
                        "pi_review_id=%s — skip (Pi DB wipe?)",
                        pi_review_id,
                    )
                    continue
                if local.status in ("resolved", "dismissed"):
                    # Pi already resolved this (likely the source of the
                    # cloud row). Skip — applying again would be a no-op.
                    continue
                user_response = r.get("user_response")
                user_response_str: Optional[str]
                if user_response is None:
                    user_response_str = None
                elif isinstance(user_response, str):
                    user_response_str = user_response
                else:
                    try:
                        user_response_str = json.dumps(user_response, default=str)
                    except (TypeError, ValueError):
                        user_response_str = None

                resolved_at = r.get("resolved_at")
                storage_repo.resolve_review(
                    self._conn,
                    pi_review_id,
                    status=status,
                    user_response=user_response_str,
                    resolved_at=resolved_at if isinstance(resolved_at, str) else None,
                )
                applied += 1
                log.info(
                    "review_sync: applied cloud resolution for pi_review_id=%s "
                    "(status=%s)",
                    pi_review_id, status,
                )
        return applied

    def _next_backoff(self) -> float:
        nxt = min(self._backoff_s * 2.0, MAX_BACKOFF_S)
        current = self._backoff_s
        self._backoff_s = nxt
        return current

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "review-sync-poller: starting (interval=%.1fs, state=%s, "
            "watermark=%s)",
            self._poll_interval_s, self._state_path,
            self._state.high_watermark or "<none>",
        )
        while not self._shutdown.is_set():
            pre_backoff = self._backoff_s
            self.tick_once()
            sleep_s = self._poll_interval_s if self._backoff_s == INITIAL_BACKOFF_S else pre_backoff
            if self._shutdown.wait(sleep_s):
                break
        log.info("review-sync-poller: shutdown complete")


class _NullLock:
    def __enter__(self) -> "_NullLock":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


__all__ = ["POLL_INTERVAL_S", "ReviewSyncPoller"]
