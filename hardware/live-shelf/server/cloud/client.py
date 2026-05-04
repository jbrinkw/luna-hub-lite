"""Thin HTTPS client for the Supabase ``shelf-ingest`` edge function.

Handles only auth + serialization + error translation. Retries and
backoff are the worker's job (see ``cloud/worker.py``); this client
fails fast so upstream code can decide how to recover.

Wire protocol: every request carries ``x-api-key: <import-key>`` which
the edge function hashes (SHA-256) and looks up in
``chefbyte.live_shelf_devices``. Content is JSON in both directions.

Clock-drift monitor
-------------------
On every HTTP response, the client compares the cloud-supplied ``Date``
header against the Pi's own UTC clock. If the absolute drift exceeds
:data:`DRIFT_WARN_THRESHOLD_S` the client emits a WARNING, subject to
:data:`DRIFT_LOG_COOLDOWN_S` to prevent log flooding while the Pi's
clock remains out-of-sync. The rationale: cloud is the authoritative
clock for logical_date derivation (see
``20260424060000_logical_date_from_cloud_clock.sql``) but the Pi still
stamps ``occurred_at`` forensically, so operators need a heads-up when
the Pi's own clock drifts on the bench / in the rack. The last-known
drift is exposed via :func:`get_last_drift_s` for ``/api/state``.
"""

from __future__ import annotations

import email.utils
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Optional

import requests

log = logging.getLogger(__name__)

USER_AGENT = "live-shelf-pi/1.0"

# ---------------------------------------------------------------------------
# Clock-drift monitor state (module-level, thread-safe via a lock).
# ---------------------------------------------------------------------------

# Drift above this threshold (seconds) triggers a WARNING log. 60s picks
# the commonly-cited "material wall-clock skew" line — below this,
# ntpd / chrony will usually catch up on their own; above this the
# day-boundary attribution risk becomes real (see the Bug A migration
# header for full rationale).
DRIFT_WARN_THRESHOLD_S = 60.0

# Minimum delay between consecutive WARNING logs for the same drift
# condition. Without this the worker's 5s drain cadence would spam
# hundreds of identical lines per minute during a sustained skew.
DRIFT_LOG_COOLDOWN_S = 600.0  # 10 minutes

_drift_lock = threading.Lock()
_last_drift_s: Optional[float] = None
_last_drift_logged_at: Optional[datetime] = None
_last_drift_observed_at: Optional[datetime] = None


def _now_utc() -> datetime:
    """Wrapper so tests can monkeypatch ``datetime.now`` cleanly."""
    return datetime.now(timezone.utc)


def observe_drift(
    date_header: Optional[str],
    *,
    now_fn=_now_utc,
) -> Optional[float]:
    """Parse an HTTP ``Date`` header, compute drift vs local UTC, log if large.

    Called after every 2xx/4xx/5xx response. Returns the signed drift in
    seconds (``cloud_time - local_time``) on success, or ``None`` when
    the header is missing / malformed. On drift above
    :data:`DRIFT_WARN_THRESHOLD_S` emits a WARNING with
    :data:`DRIFT_LOG_COOLDOWN_S` cooldown. The last-known drift is
    stored in module state for later retrieval by :func:`get_last_drift_s`.

    ``now_fn`` is the callable used to read the local clock — defaulted
    to ``datetime.now(tz=UTC)`` and overridable from tests so a
    deterministic "local clock" can be paired with a synthetic Date
    header.
    """
    global _last_drift_s, _last_drift_logged_at, _last_drift_observed_at

    # Defensive: tests and mocks may feed non-strings through
    # ``resp.headers.get("Date")`` when the headers attr is a MagicMock.
    if not isinstance(date_header, str) or not date_header:
        return None
    try:
        cloud_dt = email.utils.parsedate_to_datetime(date_header)
    except (TypeError, ValueError):
        return None
    if cloud_dt is None:
        return None
    # RFC 2822 parsers return a naive datetime when no tz offset is
    # present; normalize to UTC so the subtraction is well-defined.
    if cloud_dt.tzinfo is None:
        cloud_dt = cloud_dt.replace(tzinfo=timezone.utc)

    local_dt = now_fn()
    if local_dt.tzinfo is None:
        local_dt = local_dt.replace(tzinfo=timezone.utc)

    drift_s = (cloud_dt - local_dt).total_seconds()

    with _drift_lock:
        _last_drift_s = drift_s
        _last_drift_observed_at = local_dt
        if abs(drift_s) > DRIFT_WARN_THRESHOLD_S:
            should_log = True
            if _last_drift_logged_at is not None:
                elapsed = (local_dt - _last_drift_logged_at).total_seconds()
                if elapsed < DRIFT_LOG_COOLDOWN_S:
                    should_log = False
            if should_log:
                _last_drift_logged_at = local_dt
                log.warning(
                    "cloud-client: Pi clock drift %.1fs vs cloud Date "
                    "header (threshold %.0fs); logical_date is derived "
                    "server-side so attribution is unaffected, but the "
                    "Pi's own `occurred_at` stamps are skewed",
                    drift_s, DRIFT_WARN_THRESHOLD_S,
                )
    return drift_s


def get_last_drift_s() -> Optional[float]:
    """Return the most recently observed cloud-vs-local drift in seconds.

    ``None`` before any response has carried a parseable ``Date`` header
    (e.g. fresh boot, or cloud unreachable). The value is signed:
    positive = cloud is ahead of Pi, negative = Pi is ahead of cloud.
    """
    with _drift_lock:
        return _last_drift_s


def _reset_drift_state_for_tests() -> None:
    """Test hook: wipe module state so tests start from a known baseline."""
    global _last_drift_s, _last_drift_logged_at, _last_drift_observed_at
    with _drift_lock:
        _last_drift_s = None
        _last_drift_logged_at = None
        _last_drift_observed_at = None


class CloudError(Exception):
    """Raised on any non-2xx response from the cloud.

    ``status_code`` is the HTTP status from the response. ``body`` is
    the raw response text (or best-effort decode) so callers can log or
    parse error details. The worker uses the status to decide whether to
    keep retrying (5xx, 408, 429) vs mark a row permanently-failed
    (4xx other than those) — but that policy lives in the worker, not
    here.
    """

    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"cloud returned {status_code}: {body}")
        self.status_code = status_code
        self.body = body


class CloudClient:
    """Minimal HTTPS wrapper around ``requests`` for the shelf-ingest API.

    Parameters
    ----------
    base_url:
        Fully-qualified URL to the edge function root, e.g.
        ``https://abc.supabase.co/functions/v1``. The leading slash on
        the path passed to :meth:`get` / :meth:`post` is optional.
    import_key:
        Per-device import key. Sent as-is in the ``x-api-key`` header.
    timeout_s:
        Per-request timeout in seconds. Defaults to 10s — long enough
        for a typical Supabase edge function cold start but short
        enough that a stuck call can't hang the worker.
    """

    def __init__(
        self,
        base_url: str,
        import_key: str,
        *,
        timeout_s: float = 10.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._import_key = import_key
        self._timeout_s = timeout_s
        self._session = requests.Session()
        self._session.headers.update(
            {
                "x-api-key": import_key,
                "user-agent": USER_AGENT,
                "accept": "application/json",
            }
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        """Join base + path tolerating either leading-slash form."""
        if not path.startswith("/"):
            path = "/" + path
        return f"{self._base_url}{path}"

    @property
    def _functions_root_url(self) -> str:
        """Return the `/functions/v1` prefix (no trailing function name).

        The ``base_url`` is pinned to ``<project>.supabase.co/functions/v1/shelf-ingest``
        in the Pi's env. Most callers stay inside shelf-ingest, but the
        LiveTrack session methods target a different function under the
        same ``/functions/v1`` prefix. Strip the last path segment so we
        can build sibling-function URLs.
        """
        base = self._base_url
        # Strip trailing /<function-name>. The base always ends with a
        # function name (no trailing slash by __init__ normalization).
        last_slash = base.rfind("/")
        return base[:last_slash] if last_slash != -1 else base

    @staticmethod
    def _parse_or_raise(resp: requests.Response) -> dict[str, Any]:
        """Return parsed JSON on success, raise :class:`CloudError` otherwise.

        ``requests.Response.ok`` covers 2xx; anything else is an error.
        Non-JSON error bodies are preserved verbatim in
        :attr:`CloudError.body` so operators can read plain-text errors
        (e.g. Supabase's "Missing authorization header").

        Also feeds the response's ``Date`` header to the module-level
        clock-drift monitor (on success or failure — every cloud round
        trip is equally useful for drift observation).
        """
        # Always observe drift before branching on ``ok`` — even a 500
        # response carries a Date header, so we want that signal too.
        try:
            observe_drift(resp.headers.get("Date"))
        except Exception:  # noqa: BLE001 — drift monitor must never raise
            log.debug("cloud-client: observe_drift failed", exc_info=True)

        if not resp.ok:
            # Prefer the raw text — error bodies are often HTML from
            # the edge runtime, not JSON.
            body = resp.text if resp.text is not None else ""
            raise CloudError(resp.status_code, body)
        # Empty-body success responses (e.g. 204) still need to return
        # a dict so callers can treat the return type uniformly.
        if not resp.content:
            return {}
        try:
            parsed = resp.json()
        except (ValueError, json.JSONDecodeError) as exc:
            # Server returned 2xx but unparseable content — surface as
            # a CloudError so the worker can decide whether to retry.
            raise CloudError(resp.status_code, resp.text) from exc
        # The protocol is object-valued; if a list slipped through
        # (e.g. /catalog returns bare array) wrap it so the signature
        # stays ``dict``. Callers that expect a list can index the
        # single ``_list`` key.
        if isinstance(parsed, list):
            return {"_list": parsed}
        return parsed

    # ------------------------------------------------------------------
    # Public HTTP verbs
    # ------------------------------------------------------------------

    def get(self, path: str, params: dict | None = None) -> dict:
        """GET ``<base_url><path>`` with optional query params.

        Raises :class:`CloudError` on any non-2xx response.
        """
        log.debug("cloud GET %s params=%r", path, params)
        resp = self._session.get(
            self._url(path),
            params=params,
            timeout=self._timeout_s,
        )
        return self._parse_or_raise(resp)

    def post(self, path: str, body: dict) -> dict:
        """POST ``body`` as JSON to ``<base_url><path>``.

        Raises :class:`CloudError` on any non-2xx response.
        """
        log.debug("cloud POST %s body keys=%r", path, list(body.keys()))
        resp = self._session.post(
            self._url(path),
            json=body,
            timeout=self._timeout_s,
            headers={"content-type": "application/json"},
        )
        return self._parse_or_raise(resp)

    def known_pi_event_ids(self, pi_event_ids: list[str]) -> set[str]:
        """Return the subset of ``pi_event_ids`` the cloud already has.

        Used by ``backfill_missing_outbox_events`` on Pi startup so the
        scan only re-emits resolutions whose pi_event_id is genuinely
        missing from cloud — preventing the duplicate-emission bug
        observed in the 2026-04-29 production outage where the back-
        fill re-emitted a resolution the cloud had ALREADY applied,
        producing a stuck poison-pill outbox row that FIFO-blocked the
        user's actual return event.

        Returns an empty set on:
          * empty input list (trivial fast-path)
          * cloud transport / 4xx / 5xx error (caller is expected to
            treat unreachable cloud as "skip backfill" — better to
            under-emit than blast duplicates).

        Batches at 200 ids per request (the cloud endpoint's documented
        cap). Larger inputs are chunked + the union returned.
        """
        if not pi_event_ids:
            return set()
        BATCH = 200
        known: set[str] = set()
        for i in range(0, len(pi_event_ids), BATCH):
            chunk = pi_event_ids[i:i + BATCH]
            try:
                resp = self.get(
                    "/events-by-pi-id",
                    params={"pi_event_ids": ",".join(chunk)},
                )
            except CloudError as exc:
                # Operator-fix or transient — don't fail the whole probe.
                # The caller treats "no signal" as "don't re-emit", which
                # is the safe default.
                log.warning(
                    "cloud-client: known_pi_event_ids probe failed (%s) "
                    "for batch %d-%d: %s",
                    exc.status_code, i, i + len(chunk), exc.body[:200],
                )
                return set()
            except Exception:  # noqa: BLE001 — network/DNS/etc.
                log.warning(
                    "cloud-client: known_pi_event_ids probe raised "
                    "for batch %d-%d", i, i + len(chunk),
                    exc_info=True,
                )
                return set()
            entries = resp.get("known") if isinstance(resp, dict) else None
            if isinstance(entries, list):
                for s in entries:
                    if isinstance(s, str) and s:
                        known.add(s)
        return known

    def get_active_livetrack_session(self) -> dict | None:
        """Poll for the active LiveTrack Import session for this device.

        Legacy single-session form. Returns the newest active session row
        across every scale on this device, or ``None``. Kept for
        backwards compatibility with callers that don't yet honor the
        per-scale scoping. New callers should prefer
        :meth:`get_active_livetrack_sessions`.
        """
        url = f"{self._functions_root_url}/livetrack-session/active"
        resp = self._session.get(url, timeout=self._timeout_s)
        parsed = self._parse_or_raise(resp)
        session = parsed.get("session") if isinstance(parsed, dict) else None
        if not isinstance(session, dict):
            return None
        return session

    def get_active_livetrack_sessions(self) -> list[dict]:
        """Poll for ALL active LiveTrack Import sessions on this device.

        Used by :class:`LiveTrackPoller` to maintain a set of
        ``(device_id, scale_id)`` tuples currently being calibrated by
        the browser wizard. The Pi gates events per-tuple so unrelated
        scales keep flowing while one is being calibrated.

        Returns a list of session dicts (possibly empty) — never raises
        on "no sessions"; only on transport/HTTP errors via the inherited
        :class:`CloudError` path.

        The edge function returns ``{ sessions: [...], session: <newest> }``
        from 2026-04-27. This method tolerates the legacy single-session
        body shape (``{ session: <row> }``) by collapsing it to a 1-item
        list when the new ``sessions`` key is absent.
        """
        url = f"{self._functions_root_url}/livetrack-session/active"
        resp = self._session.get(url, timeout=self._timeout_s)
        parsed = self._parse_or_raise(resp)
        if not isinstance(parsed, dict):
            return []
        sessions = parsed.get("sessions")
        if isinstance(sessions, list):
            return [s for s in sessions if isinstance(s, dict)]
        # Legacy shape — server hasn't been redeployed yet.
        legacy = parsed.get("session")
        return [legacy] if isinstance(legacy, dict) else []

    def post_livetrack_session_update(
        self, session_id: str, **fields: Any,
    ) -> dict:
        """Patch a LiveTrack session with Pi-originated fields.

        Used by the scale-event interceptor (scale reading arrives) and
        by the poller when it completes an AI-tare run. ``fields`` is
        passed through as-is; the edge function filters to an allow-list
        server-side so a misbehaving Pi can't stomp barcode/product_id.

        Returns the updated session row. Raises :class:`CloudError` on
        any non-2xx — callers (scale_events interceptor, poller) are
        expected to swallow and log so a transient cloud outage never
        blocks the HTTP response to the ESP.
        """
        body: dict[str, Any] = {"session_id": session_id}
        body.update(fields)
        url = f"{self._functions_root_url}/livetrack-session/pi-update"
        resp = self._session.post(
            url,
            json=body,
            timeout=self._timeout_s,
            headers={"content-type": "application/json"},
        )
        parsed = self._parse_or_raise(resp)
        session = parsed.get("session") if isinstance(parsed, dict) else None
        if not isinstance(session, dict):
            # Defensive — the edge function always returns a session on
            # 2xx, but don't crash the poller if the contract drifts.
            return parsed if isinstance(parsed, dict) else {}
        return session

    def post_product_tare(
        self, *, product_id: str, tare_g: float,
    ) -> dict:
        """One-shot push-back for a locally-captured tare value.

        Per CATCH_ALL_TARE_CAPTURE_PLAN.md cloud resolution: when the
        catch-all tare interceptor fires, the Pi writes
        ``products.tare_weight_g`` locally AND calls this method to
        propagate the new tare back to cloud's ``chefbyte.products``
        row. Callers treat this as fire-and-forget; a :class:`CloudError`
        means the cloud doesn't know about the new tare (yet) but the
        local row is authoritative.

        Routes to ``POST /product-tare`` — a narrow endpoint on the
        shelf-ingest edge function. If the edge function doesn't yet
        expose that route, the call returns a 404 which propagates as
        :class:`CloudError` and is logged + swallowed by the handler.

        Backwards-compat with the original ARM-driven tare-capture
        callers; new callers (catch-all auto-import, future
        ``measured_full_at`` pushes) should prefer
        :meth:`push_product_state`.
        """
        return self.post(
            "/product-tare",
            {"product_id": product_id, "tare_weight_g": float(tare_g)},
        )

    def post_barcode_scan(
        self,
        *,
        barcode: str,
        pi_event_id: str,
        mode: Optional[str] = None,
        qty: Optional[float] = None,
        unit: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST ``/barcode-scan`` with the user's USB-scanner barcode.

        Forwards a barcode decoded by the Pi's HID listener (Task 7) to
        the cloud's ``shelf-ingest`` edge function which routes it through
        the same idempotent transaction pipeline used by the in-app
        scanner. ``pi_event_id`` is a Pi-generated UUID used as the
        idempotency key — re-posting the same id returns the original
        ``transaction_id`` rather than producing a duplicate row.

        ``mode``, ``qty`` and ``unit`` are optional consume-mode fields
        (e.g. ``mode='consume_macros', qty=1.5, unit='serving'``); they
        are omitted from the payload entirely when unset so the edge
        function's defaults apply.

        Returns the cloud response as a dict (typically
        ``{transaction_id, status, ...}``). Raises :class:`CloudError`
        on any non-2xx — callers (HID worker loop) are expected to log
        and either retry or drop the event per their policy.
        """
        body: dict[str, Any] = {
            "barcode": barcode,
            "pi_event_id": pi_event_id,
        }
        if mode is not None:
            body["mode"] = mode
        if qty is not None:
            body["qty"] = qty
        if unit is not None:
            body["unit"] = unit
        return self.post("/barcode-scan", body)

    def push_product_state(
        self,
        *,
        product_id: str,
        tare_g: Optional[float] = None,
        measured_full_at: Optional[str] = None,
        certified: Optional[bool] = None,
    ) -> dict:
        """Push tare, measured_full_at and/or certified to ``/shelf-ingest/product-tare``.

        All three fields are optional but at least one must be
        provided. The cloud route enforces set-once semantics on its
        side (see Task 2's ``/shelf-ingest/product-tare``
        SELECT-then-conditional-UPDATE): existing non-NULL /
        already-true fields are not overwritten, so retries on
        transient errors are safe.

        ``certified`` semantics:
          * ``True``  — request the cloud flip ``products.certified``
                        from false/NULL → true. Set-once; never reverses.
          * ``False`` / ``None`` — omitted from the body (callers don't
                        UNcertify from the Pi side; the catch-all auto-
                        import is the only certify writer).

        Used by:
          * Catch-all auto-import (Task 8) — sends ``tare_g`` only.
          * In-flight pickup full-cup capture (Task 9 — pending) —
            sends ``measured_full_at`` only.
          * Calibration completion (Task 10 — pending) — may send both
            tare and measured_full_at.
          * Two-pass catch-all classification (2026-05-03) — sends
            ``certified=True`` when pass-2 (uncertified-only) is the
            pass that produced the match.

        Raises :class:`CloudError` on any non-2xx — callers swallow it
        per fire-and-forget semantics. The local row is authoritative;
        the push is best-effort propagation.
        """
        if tare_g is None and measured_full_at is None and certified is not True:
            # Nothing to send — caller bug, but don't make a useless round trip.
            # Note ``certified is not True`` (not ``certified is None``):
            # an explicit ``False`` is also a no-op since we never push
            # uncertify from the Pi.
            return {}
        body: dict[str, Any] = {"product_id": product_id}
        if tare_g is not None:
            body["tare_weight_g"] = float(tare_g)
        if measured_full_at is not None:
            body["measured_full_at"] = measured_full_at
        if certified is True:
            body["certified"] = True
        return self.post("/product-tare", body)
