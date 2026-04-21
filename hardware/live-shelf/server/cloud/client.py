"""Thin HTTPS client for the Supabase ``shelf-ingest`` edge function.

Handles only auth + serialization + error translation. Retries and
backoff are the worker's job (see ``cloud/worker.py``); this client
fails fast so upstream code can decide how to recover.

Wire protocol: every request carries ``x-api-key: <import-key>`` which
the edge function hashes (SHA-256) and looks up in
``chefbyte.live_shelf_devices``. Content is JSON in both directions.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import requests

log = logging.getLogger(__name__)

USER_AGENT = "live-shelf-pi/1.0"


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
        """
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

    def get_active_livetrack_session(self) -> dict | None:
        """Poll for the active LiveTrack Import session for this device.

        Targets the ``livetrack-session`` edge function (sibling to the
        ``shelf-ingest`` base_url) — intentional separation so the
        session-polling path's logs/failures stay distinct from the
        event-drain path's.

        Returns the session row on success, or ``None`` when the cloud
        reports no active session. Raises :class:`CloudError` for any
        non-2xx response so the poller can decide whether to backoff.
        """
        url = f"{self._functions_root_url}/livetrack-session/active"
        resp = self._session.get(url, timeout=self._timeout_s)
        parsed = self._parse_or_raise(resp)
        session = parsed.get("session") if isinstance(parsed, dict) else None
        if not isinstance(session, dict):
            return None
        return session

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
        """
        return self.post(
            "/product-tare",
            {"product_id": product_id, "tare_weight_g": float(tare_g)},
        )
