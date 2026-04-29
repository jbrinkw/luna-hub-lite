"""Background thread that drains the cloud outbox + sends heartbeats.

Runs on a single thread owned by the orchestrator at boot. Each tick:
  1. POST heartbeat (so the cloud UI shows Pi alive + pending review count).
  2. Drain up to 50 pending outbox rows one-by-one via ``POST /event``.

Backoff policy
--------------
* Per-row: on :class:`~server.cloud.client.CloudError` we bump ``attempts``
  and skip the row for this tick; it stays pending and will be retried
  next tick.
* After 3 failed attempts on the same row we log a WARNING but keep
  retrying — dropping the row would be data loss, and the cloud's own
  dedupe (on ``client_event_id``) makes a later retry safe.
* Per-cycle: when *any* call in a tick errored, the worker doubles its
  poll interval up to a 5-minute cap so a total outage doesn't pound
  the edge function at 5s cadence. The cap resets to
  ``poll_interval_s`` after the next successful tick.

The worker never touches the SQLite DB directly except via the outbox
helpers — the orchestrator supplies a ``conn_factory`` callable so the
worker can pull a connection on whatever threading model the caller
prefers (dedicated-thread conn, connection pool, shared-with-lock, etc.).
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from . import outbox
from .client import CloudClient, CloudError
from .image_uploader import ImageUploader, write_image_urls_to_cloud

log = logging.getLogger(__name__)

MAX_POLL_INTERVAL_S = 300.0  # 5-minute backoff ceiling during total outage
OUTBOX_DRAIN_BATCH = 50
RETRY_WARN_ATTEMPT_THRESHOLD = 3

# Dead-letter threshold — after N consecutive transient failures (5xx,
# auth, network) on the same outbox row, flag it ``status='dead'`` so
# the drainer steps over it and downstream rows can land. Without this
# guarantee, a single poison-pill event (cloud schema drift, rare RPC
# bug) FIFO-blocks every row behind it indefinitely.
#
# 2026-04-29 production outage: outbox 97 racked up 10 consecutive 500s
# (function-overload ambiguity) — rows 98 + 99 were the user's actual
# return chain and were stuck behind it. With this threshold, row 97
# would have been dead-lettered after the 10th attempt and rows 98 + 99
# would have drained normally on the next tick. The operator inspects
# dead rows manually via the /admin/dead-letter UI.
#
# N=10 chosen to balance:
#   * low enough that a single broken event clears the queue within
#     ~100s (10 attempts × ~10s base-poll-interval after backoff
#     ramp-up) instead of multi-day stalls.
#   * high enough that legitimate transient flakes (cloud restart, DNS
#     blip, Pi clock skew briefly tripping the 422 'occurred_at out of
#     range' check) still resolve themselves before the row is dead-
#     lettered. Worst-case cloud-restart lasts ~30s; with the 5-minute
#     backoff cap we get >10 chances spread over ~30 minutes before
#     dead-lettering.
DEAD_LETTER_ATTEMPT_THRESHOLD = 10

# Backlog WARN threshold — above this, a non-empty outbox on every tick
# promotes the "pending=N" log line to WARNING so operators notice a
# sustained outage in the nightly log review.
OUTBOX_BACKLOG_WARN_THRESHOLD = 100

# Persistent auth failure — heartbeat rejected with these codes means
# the device's import key is bad (expired/rotated/typo). Operator MUST
# see an ERROR, not an INFO, because nothing will drain until they fix
# the env var and restart.
HEARTBEAT_AUTH_FAILURE_CODES = {401, 403}

# Auth-failure status codes on an ``/event`` POST. These aren't
# retryable row-level problems — they're a device-level credential
# breakage that will stall every event until the operator fixes
# ``CLOUD_IMPORT_KEY``. Logged with the current outbox pending count so
# operators see how much is queued up behind the failure. Pass-2 audit
# finding #7.
EVENT_AUTH_FAILURE_CODES = {401, 403}

# Non-retryable event-POST failures. A /event POST rejected with these
# codes won't succeed on retry — the payload is malformed, references
# a missing product, or fails a dedupe check.
# Flag the row as ``failed_permanently`` so the drainer moves on to the
# next one instead of beating its head against the same 4xx forever.
#
# NOT in this set (= keep retrying):
#  * 401/403 — auth failure is transient from the row's perspective
#    (operator will rotate the key), not a property of the payload.
#  * 408/429 — timeout / rate-limit; retry is the correct response.
#  * 422    — the edge fn returns this for "occurred_at out of range"
#    (Pi clock drift, reconciler back-fill window shift). Those are
#    transient from the row's POV: a clock correction or an updated
#    back-fill window lets the retry succeed. Pass-2 audit finding #8
#    explicitly moves 422 OUT of the permanent bucket.
#  * 5xx    — cloud problem; retry.
NON_RETRYABLE_EVENT_STATUS_CODES = {400, 404, 409}

# Cloud response's ``reason`` values that mean "applied=false but this
# is expected and safe" — the worker can silently ack these. Anything
# else with ``applied=false`` is surfaced as WARNING so operators notice
# e.g. "product not found" (pointing at catalog desync). Pass-2 audit
# finding #9.
EXPECTED_NOT_APPLIED_REASONS = frozenset({
    "duplicate",
    "stale: manual edit is newer",
})


class CloudWorker(threading.Thread):
    """Background drainer + heartbeat sender.

    Parameters
    ----------
    client:
        Configured :class:`CloudClient` pointing at the shelf-ingest
        edge function.
    conn_factory:
        Zero-arg callable returning a ``sqlite3.Connection``. Called
        once per tick; the worker closes the connection itself at
        shutdown via the standard SQLite ``close`` semantics implicit
        in dropping the reference. Most callers will return the shared
        process-wide connection every time.
    heartbeat_provider:
        Zero-arg callable returning the heartbeat body dict. The
        orchestrator composes this from live Pi state (pending review
        count, scale heartbeats, etc.) so the worker doesn't need to
        know about higher-level tables.
    poll_interval_s:
        Base cadence (seconds) between ticks on the happy path. The
        orchestrator in ``app.py`` must pass ``cfg.cloud_heartbeat_interval_s``
        here (CLOUD_HEARTBEAT_INTERVAL_S env var, default 30s) — the
        5.0s constructor default is for tests only and will otherwise
        silently mask a missing wire-up. Keep this field explicit at
        call sites; positional-only calls obscure which knob is set.
    shutdown_event:
        Pre-existing :class:`threading.Event` to coordinate graceful
        shutdown. If ``None``, the worker creates its own; callers that
        need to stop the worker must use :meth:`stop` in that case.
    """

    name = "cloud-worker"

    def __init__(
        self,
        client: CloudClient,
        conn_factory: Callable[[], "object"],
        heartbeat_provider: Callable[[], dict],
        *,
        poll_interval_s: float = 5.0,
        shutdown_event: threading.Event | None = None,
        image_uploader: "ImageUploader | None" = None,
        supabase_url: str = "",
        service_role_key: str = "",
    ) -> None:
        super().__init__(daemon=True, name=self.name)
        self._client = client
        self._conn_factory = conn_factory
        self._heartbeat_provider = heartbeat_provider
        self._base_poll_interval_s = float(poll_interval_s)
        self._current_poll_interval_s = float(poll_interval_s)
        self._shutdown = shutdown_event or threading.Event()
        self._image_uploader: ImageUploader | None = image_uploader
        self._supabase_url = supabase_url
        self._service_role_key = service_role_key

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def stop(self) -> None:
        """Signal the worker to exit on its next wake."""
        self._shutdown.set()

    # ------------------------------------------------------------------
    # Tick body (public for tests to drive manually)
    # ------------------------------------------------------------------

    def tick(self) -> None:
        """Run exactly one heartbeat + drain cycle.

        Exposed so tests can advance the worker deterministically
        without spinning up the thread or faking time. The cycle as a
        whole doesn't raise — errors are logged and fold into the
        adaptive backoff; the thread never dies mid-shift.

        Heartbeat-failure short-circuit
        -------------------------------
        If the heartbeat POST itself fails (CloudError *or* any generic
        exception like a DNS error), the drain phase is skipped for the
        remainder of this tick. The rationale: a heartbeat failure is
        almost always a symptom of a global network outage — every
        pending row is about to fail the same way. If we pressed on
        with the drain we'd bump ``attempts`` on the first row (then
        the generic-exception short-circuit would break the loop), but
        doing so on every tick while the outage persists quickly maxes
        out row 0's attempt counter against a condition that has
        nothing to do with that specific row. Skipping drain entirely
        during a heartbeat outage keeps the adaptive backoff (below)
        as the single place that throttles retries.

        A provider-raise (the caller's ``heartbeat_provider`` itself
        throwing — e.g. DB contention reading the pending count) is
        *not* a heartbeat network failure: no POST was attempted, so
        the drain still runs this tick.
        """
        had_error = False
        heartbeat_failed = False  # specifically: a TRANSPORT-level POST failure

        # 1. Heartbeat. The body is assembled by the caller's provider
        # so we don't couple to app-state tables here.
        try:
            body = self._heartbeat_provider()
        except Exception:  # noqa: BLE001 — defensive: never kill the thread
            log.warning(
                "cloud-worker: heartbeat_provider raised", exc_info=True
            )
            body = None
        if body is not None:
            try:
                self._client.post("/heartbeat", body)
            except CloudError as exc:
                had_error = True
                # Persistent auth failure (401/403) means the device's
                # import key is broken. Every subsequent event will
                # queue forever with no drainer until an operator
                # rotates/fixes the key. Log at ERROR so this shows up
                # in nightly log review rather than drowning in INFO.
                if exc.status_code in HEARTBEAT_AUTH_FAILURE_CODES:
                    heartbeat_failed = True
                    log.error(
                        "cloud-worker: heartbeat AUTH FAILURE (%s): %s "
                        "— check CLOUD_IMPORT_KEY; events will queue "
                        "locally until resolved",
                        exc.status_code, exc.body[:200],
                    )
                elif exc.status_code < 500:
                    # Other 4xx (e.g. 400 malformed body, 408/429): the
                    # heartbeat BODY is rejected, but the /event endpoint
                    # is reachable and unrelated. Don't block the drain
                    # over a heartbeat-shape problem — the queue would
                    # stall indefinitely if (say) a registry scale kind
                    # is unsupported by the cloud validator.
                    # 2026-04-29 production outage repro: a stale Pi
                    # registry entry with kind='single_item' tripped
                    # cloud's heartbeat validator with 400 'invalid
                    # kind' on every tick → drain was skipped → user's
                    # in_flight_return event sat in the outbox forever.
                    log.warning(
                        "cloud-worker: heartbeat rejected by cloud (%s) "
                        "— continuing with drain: %s",
                        exc.status_code, exc.body[:200],
                    )
                    # heartbeat_failed stays False — drain proceeds.
                else:
                    # 5xx is a cloud-side problem (likely shared with
                    # /event). Skip drain to avoid burning attempts on
                    # rows that will fail too — the adaptive backoff is
                    # the single throttle path during outages.
                    heartbeat_failed = True
                    log.warning(
                        "cloud-worker: heartbeat 5xx from cloud (%s): %s",
                        exc.status_code, exc.body[:200],
                    )
            except Exception:  # noqa: BLE001 — network/DNS/etc.
                had_error = True
                heartbeat_failed = True
                # Bare Exception (ConnectionError, DNS, socket, etc.)
                # Bump to WARNING with a traceback so operators can
                # distinguish "network flaky" from "nothing ever fires".
                log.warning(
                    "cloud-worker: heartbeat raised unexpected error",
                    exc_info=True,
                )

        # 2. Drain. Skipped entirely if the heartbeat POST failed this
        # tick — see the module-level docstring above. One connection
        # per tick keeps transactional scope tight; the factory is free
        # to hand us a shared conn.
        if heartbeat_failed:
            conn = None
        else:
            try:
                conn = self._conn_factory()
            except Exception:  # noqa: BLE001 — DB offline is serious but survivable
                log.warning(
                    "cloud-worker: conn_factory raised — skipping drain",
                    exc_info=True,
                )
                conn = None
        if conn is not None:
            # Backlog logging (finding #4). Count BEFORE we drain so
            # the number reflects the queue the operator actually
            # faces. A zero-backlog tick stays silent to keep the log
            # quiet on the happy path.
            try:
                pending_before = outbox.count_pending(conn)
            except Exception:  # noqa: BLE001 — defensive
                pending_before = 0
            if pending_before > OUTBOX_BACKLOG_WARN_THRESHOLD:
                log.warning(
                    "cloud-worker: outbox pending=%d (exceeds %d)",
                    pending_before, OUTBOX_BACKLOG_WARN_THRESHOLD,
                )
            elif pending_before > 0:
                log.info(
                    "cloud-worker: outbox pending=%d", pending_before,
                )

            pending = outbox.list_pending(conn, limit=OUTBOX_DRAIN_BATCH)
            for row in pending:
                try:
                    # Sync-audit finding #5: review_queue events route to
                    # a dedicated /review-create or /review-resolve cloud
                    # endpoint instead of /event. Discriminator is the
                    # outbox payload's event_kind (set by the emitter).
                    # Older rows without event_kind = review_queue_*
                    # default to /event so legacy outbox entries continue
                    # to drain through the canonical scale-event path.
                    payload_event_kind = row.payload.get("event_kind")
                    if payload_event_kind == "review_queue_create":
                        response = self._client.post("/review-create", row.payload)
                    elif payload_event_kind == "review_queue_resolve":
                        response = self._client.post("/review-resolve", row.payload)
                    else:
                        response = self._client.post("/event", row.payload)
                except CloudError as exc:
                    had_error = True
                    # Non-retryable 4xx (malformed, not-found, dedupe
                    # conflict) — flag as permanent failure so we stop
                    # retrying. 401/403/422 are NOT in this set.
                    if exc.status_code in NON_RETRYABLE_EVENT_STATUS_CODES:
                        outbox.mark_permanent_failure(
                            conn, row.outbox_id,
                            f"{exc.status_code}: {exc.body[:200]}",
                        )
                        log.error(
                            "cloud-worker: outbox %d PERMANENTLY FAILED "
                            "(%s non-retryable): %s",
                            row.outbox_id, exc.status_code, exc.body[:200],
                        )
                    else:
                        # 401/403/408/422/429/5xx and everything else
                        # (other than the non-retryable set) — transient.
                        # Bump attempts and either dead-letter (if past
                        # the threshold) or leave the row pending.
                        attempts = row.attempts + 1
                        if attempts >= DEAD_LETTER_ATTEMPT_THRESHOLD:
                            # Exhausted retry budget — dead-letter so
                            # downstream rows can drain. Operator must
                            # manually inspect via /admin/dead-letter
                            # and either fix-and-retry or accept the
                            # loss.
                            outbox.mark_dead_letter(
                                conn, row.outbox_id,
                                f"{exc.status_code} after "
                                f"{attempts} attempts: {exc.body[:200]}",
                            )
                            log.error(
                                "cloud-worker: outbox %d DEAD-LETTERED "
                                "after %d transient failures (last: "
                                "%s); skipping to next row. Inspect "
                                "via /admin/dead-letter.",
                                row.outbox_id, attempts, exc.status_code,
                            )
                        else:
                            outbox.mark_failed(
                                conn, row.outbox_id,
                                f"{exc.status_code}: {exc.body[:200]}",
                            )
                        # Finding #7: a 401/403 on an /event POST means
                        # the import key is broken and every queued row
                        # will stall until an operator rotates the key.
                        # Log at ERROR with the current outbox pending
                        # count so operators see the backlog size, not
                        # just "another 401". Other codes keep their
                        # prior log level (WARNING).
                        if exc.status_code in EVENT_AUTH_FAILURE_CODES:
                            try:
                                stalled = outbox.count_pending(conn)
                            except Exception:  # noqa: BLE001
                                stalled = -1
                            log.error(
                                "cloud-worker: %s on /event — "
                                "outbox_pending=%d, check "
                                "CLOUD_IMPORT_KEY: %s",
                                exc.status_code, stalled,
                                exc.body[:200],
                            )
                        elif (attempts >= RETRY_WARN_ATTEMPT_THRESHOLD
                              and attempts < DEAD_LETTER_ATTEMPT_THRESHOLD):
                            log.warning(
                                "cloud-worker: outbox %d failed %d times: %s",
                                row.outbox_id, attempts, exc,
                            )
                        elif exc.status_code < 500:
                            # Other transient 4xx (408/422/429, etc.)
                            log.warning(
                                "cloud-worker: /event rejected (%s): %s",
                                exc.status_code, exc.body[:200],
                            )
                    # Don't break — a 4xx on one row doesn't prevent
                    # later rows from succeeding (e.g. malformed event
                    # followed by valid events).
                except Exception as exc:  # noqa: BLE001 — network/unknown
                    had_error = True
                    attempts = row.attempts + 1
                    if attempts >= DEAD_LETTER_ATTEMPT_THRESHOLD:
                        # The row has weathered DEAD_LETTER_ATTEMPT_THRESHOLD
                        # network errors; if the next row fails too the
                        # loop will break before bumping its attempts.
                        # Dead-letter this row so we don't spend another
                        # threshold-window on it.
                        outbox.mark_dead_letter(
                            conn, row.outbox_id,
                            f"network/unknown after {attempts} "
                            f"attempts: {exc!r}"[:240],
                        )
                        log.error(
                            "cloud-worker: outbox %d DEAD-LETTERED after "
                            "%d transient failures (last: %r). Inspect "
                            "via /admin/dead-letter.",
                            row.outbox_id, attempts, exc,
                        )
                    else:
                        outbox.mark_failed(conn, row.outbox_id, repr(exc))
                        log.warning(
                            "cloud-worker: outbox %d raised: %s",
                            row.outbox_id, exc,
                        )
                    # On a network error the next row will almost
                    # certainly fail too — stop draining this tick to
                    # avoid bumping attempts on every row.
                    break
                else:
                    # Finding #9: even on 2xx, inspect ``applied`` +
                    # ``reason``. ``applied=false`` with a non-expected
                    # reason (e.g. ``product not found`` because the
                    # cloud catalog is out of sync with the Pi cache)
                    # should surface as WARNING. The event still gets
                    # marked sent — retrying won't fix the reason.
                    if isinstance(response, dict):
                        applied = response.get("applied")
                        reason = response.get("reason")
                        if applied is False and (
                            not isinstance(reason, str)
                            or reason not in EXPECTED_NOT_APPLIED_REASONS
                        ):
                            log.warning(
                                "cloud-worker: outbox %d ack'd with "
                                "applied=false, reason=%r, response=%r",
                                row.outbox_id, reason, response,
                            )
                    outbox.mark_sent(conn, row.outbox_id)
                    # Image upload (mixed-content fix). Attempt after the
                    # outbox row is marked sent so a failed upload never
                    # blocks the drain or re-queues the event. Only fires
                    # for /event rows that carry a pi_event_id and where the
                    # cloud returned an event_id (the cloud-side UUID for the
                    # shelf_event_log row).
                    self._try_upload_images(row, response)

        # 3. Adapt cadence. Exponential backoff on failures, reset on
        # any successful tick.
        if had_error:
            self._current_poll_interval_s = min(
                self._current_poll_interval_s * 2.0,
                MAX_POLL_INTERVAL_S,
            )
        else:
            self._current_poll_interval_s = self._base_poll_interval_s

    @property
    def current_poll_interval_s(self) -> float:
        """Expose the currently-adapted poll interval for tests/metrics."""
        return self._current_poll_interval_s

    # ------------------------------------------------------------------
    # Image upload (mixed-content fix)
    # ------------------------------------------------------------------

    def _try_upload_images(self, row: "object", response: "object") -> None:
        """Upload before/after JPEGs to Storage after a successful drain.

        Non-fatal: any exception is swallowed so the drain loop continues.
        Skips when:
          * ``_image_uploader`` is None (not configured)
          * outbox payload has no ``pi_event_id``
          * cloud response has no ``event_id`` (can't address the DB row)
          * event_kind is not one that produces event images (review_queue_*)
        """
        if self._image_uploader is None:
            return
        try:
            payload = getattr(row, "payload", None) or {}
            pi_event_id: str | None = payload.get("pi_event_id")
            if not pi_event_id:
                return
            # review_queue_* events don't have classifier images via
            # the /event path — they're handled separately.
            event_kind = payload.get("event_kind", "")
            if event_kind.startswith("review_queue_"):
                return
            # Cloud returns event_id in the /event response for the
            # shelf_event_log row.
            if not isinstance(response, dict):
                return
            cloud_event_id: str | None = response.get("event_id")
            user_id: str | None = response.get("user_id")
            if not cloud_event_id or not user_id:
                return
            before_url, after_url = self._image_uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )
            if not before_url and not after_url:
                return
            write_image_urls_to_cloud(
                supabase_url=self._supabase_url,
                service_role_key=self._service_role_key,
                cloud_event_id=cloud_event_id,
                before_url=before_url,
                after_url=after_url,
            )
        except Exception:  # noqa: BLE001 — image upload must never kill drain
            log.warning(
                "cloud-worker: image upload raised unexpectedly — "
                "skipping (LAN URL fallback still usable)",
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Thread entrypoint
    # ------------------------------------------------------------------

    def run(self) -> None:  # pragma: no cover - exercised via integration
        log.info(
            "cloud-worker: starting (base poll=%.1fs)",
            self._base_poll_interval_s,
        )
        while not self._shutdown.is_set():
            self.tick()
            # ``Event.wait`` returns True if set during the sleep,
            # giving us instant shutdown responsiveness even with a
            # long backoff interval.
            if self._shutdown.wait(self._current_poll_interval_s):
                break
        log.info("cloud-worker: shutdown complete")
