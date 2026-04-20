"""Unit tests for ``server.cloud.client.CloudClient``.

We mock ``requests.Session`` at the class boundary because the client
instantiates its own session in ``__init__`` — patching at call-site
would miss the header setup that happens eagerly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Make ``server.*`` importable when pytest runs from the repo root.
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudClient, CloudError, USER_AGENT  # noqa: E402


def _response(
    *,
    ok: bool = True,
    status_code: int = 200,
    json_body: dict | list | None = None,
    text: str = "",
    content: bytes | None = None,
) -> MagicMock:
    """Build a minimal response stand-in matching the subset we consume."""
    resp = MagicMock()
    resp.ok = ok
    resp.status_code = status_code
    resp.text = text or (
        json.dumps(json_body) if json_body is not None else ""
    )
    resp.content = (
        content
        if content is not None
        else (resp.text.encode("utf-8") if resp.text else b"")
    )
    if json_body is None:
        resp.json.side_effect = ValueError("no json body")
    else:
        resp.json.return_value = json_body
    return resp


# ---------------------------------------------------------------------------
# Header / URL construction
# ---------------------------------------------------------------------------


class TestHeadersAndUrl:
    def test_import_key_header_is_sent_on_get(self):
        """Every request must include ``x-api-key`` — the cloud looks it up
        against live_shelf_devices for auth."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(json_body={"ok": True})
            client = CloudClient(
                "https://abc.supabase.co/functions/v1", "import-key-xyz"
            )
            assert session.headers["x-api-key"] == "import-key-xyz"
            assert session.headers["user-agent"] == USER_AGENT

            client.get("/catalog")
            # And headers were installed before any call went out.
            assert session.get.called

    def test_base_url_trailing_slash_tolerated(self):
        """Constructor strips any trailing slash so we never emit ``//path``."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(json_body={})
            client = CloudClient(
                "https://abc.supabase.co/functions/v1/", "k"
            )
            client.get("/catalog")
            called_url = session.get.call_args.args[0]
            assert called_url == "https://abc.supabase.co/functions/v1/catalog"

    def test_path_missing_leading_slash_prepended(self):
        """Callers can omit the leading slash — the client adds it."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(json_body={})
            client = CloudClient("https://x.y/z", "k")
            client.get("catalog")
            called_url = session.get.call_args.args[0]
            assert called_url == "https://x.y/z/catalog"


# ---------------------------------------------------------------------------
# GET semantics
# ---------------------------------------------------------------------------


class TestGet:
    def test_get_returns_parsed_json(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                json_body={"products": [{"id": "p1"}]}
            )
            client = CloudClient("https://x.y/z", "k")
            out = client.get("/catalog")
            assert out == {"products": [{"id": "p1"}]}

    def test_get_forwards_params(self):
        """Query params passthrough — used for future paging/filter calls."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(json_body={})
            client = CloudClient("https://x.y/z", "k")
            client.get("/catalog", params={"since": "2026-04-19"})
            kwargs = session.get.call_args.kwargs
            assert kwargs["params"] == {"since": "2026-04-19"}

    def test_get_uses_timeout(self):
        """Timeout must be forwarded to ``requests`` so a stuck call can't
        hang the worker thread."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(json_body={})
            client = CloudClient("https://x.y/z", "k", timeout_s=3.5)
            client.get("/catalog")
            kwargs = session.get.call_args.kwargs
            assert kwargs["timeout"] == 3.5

    def test_get_raises_cloud_error_on_4xx(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                ok=False, status_code=401, text="unauthorized"
            )
            client = CloudClient("https://x.y/z", "bad-key")
            with pytest.raises(CloudError) as excinfo:
                client.get("/catalog")
            assert excinfo.value.status_code == 401
            assert excinfo.value.body == "unauthorized"

    def test_get_raises_cloud_error_on_5xx(self):
        """Server errors must be distinguishable by ``status_code`` so the
        worker's backoff can treat them as transient."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                ok=False,
                status_code=503,
                text="service unavailable",
            )
            client = CloudClient("https://x.y/z", "k")
            with pytest.raises(CloudError) as excinfo:
                client.get("/catalog")
            assert excinfo.value.status_code == 503
            assert "service unavailable" in excinfo.value.body

    def test_get_empty_body_returns_empty_dict(self):
        """A 2xx with no body (e.g. 204) must return ``{}`` so callers
        don't have to special-case ``None``."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                json_body=None, text="", content=b""
            )
            client = CloudClient("https://x.y/z", "k")
            assert client.get("/ping") == {}


# ---------------------------------------------------------------------------
# POST semantics
# ---------------------------------------------------------------------------


class TestPost:
    def test_post_serializes_body_as_json(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/z", "k")
            client.post("/event", {"foo": "bar", "n": 1})
            kwargs = session.post.call_args.kwargs
            assert kwargs["json"] == {"foo": "bar", "n": 1}
            # Content-type header is explicitly set on per-call basis so
            # the Supabase function resolver parses JSON.
            assert kwargs["headers"]["content-type"] == "application/json"

    def test_post_returns_parsed_json(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(
                json_body={"resolved_stock_id": "s1"}
            )
            client = CloudClient("https://x.y/z", "k")
            out = client.post("/event", {"x": 1})
            assert out == {"resolved_stock_id": "s1"}

    def test_post_raises_cloud_error_with_body_preserved(self):
        """A 4xx body (often HTML from the edge runtime, not JSON) must
        round-trip verbatim via ``CloudError.body``."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(
                ok=False,
                status_code=400,
                text='<html>bad payload: missing "stock_id"</html>',
            )
            client = CloudClient("https://x.y/z", "k")
            with pytest.raises(CloudError) as excinfo:
                client.post("/event", {"x": 1})
            assert excinfo.value.status_code == 400
            assert "bad payload" in excinfo.value.body

    def test_post_raises_on_unparseable_2xx(self):
        """Server returned 2xx with garbage content — treat as error so the
        worker can retry rather than silently accepting."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            # ok=True but .json() raises ValueError + body has content.
            resp = _response(json_body=None, text="not json", content=b"not json")
            resp.ok = True
            resp.status_code = 200
            session.post.return_value = resp
            client = CloudClient("https://x.y/z", "k")
            with pytest.raises(CloudError) as excinfo:
                client.post("/event", {"x": 1})
            assert excinfo.value.status_code == 200
            assert excinfo.value.body == "not json"


# ---------------------------------------------------------------------------
# List-response normalization
# ---------------------------------------------------------------------------


def test_bare_list_response_wrapped_in_dict():
    """The wire protocol is object-valued but we defensively wrap a bare
    list under ``_list`` so signatures stay ``dict``. This keeps static
    typing honest even if the edge function misbehaves."""
    with patch("server.cloud.client.requests.Session") as SessionCls:
        session = SessionCls.return_value
        session.headers = {}
        session.get.return_value = _response(json_body=[{"a": 1}, {"b": 2}])
        client = CloudClient("https://x.y/z", "k")
        out = client.get("/weird")
        assert out == {"_list": [{"a": 1}, {"b": 2}]}
