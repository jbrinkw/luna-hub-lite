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


# ---------------------------------------------------------------------------
# known_pi_event_ids probe (added 2026-04-29 for backfill safety)
# ---------------------------------------------------------------------------


class TestKnownPiEventIds:
    """The probe asks cloud which pi_event_ids in a candidate list are
    already in shelf_event_log. Used by Pi startup back-fill to avoid
    duplicate-emission. Empty input → empty set fast-path. Cloud error
    or transport raise → empty set (caller treats as 'skip back-fill')."""

    def test_empty_input_returns_empty_without_calling_cloud(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            client = CloudClient("https://x.y/shelf-ingest", "k")
            out = client.known_pi_event_ids([])
            assert out == set()
            session.get.assert_not_called()

    def test_returns_set_from_cloud_known_array(self):
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                json_body={"known": ["uuid-a", "uuid-c"]},
            )
            client = CloudClient("https://x.y/shelf-ingest", "k")
            out = client.known_pi_event_ids(["uuid-a", "uuid-b", "uuid-c"])
            assert out == {"uuid-a", "uuid-c"}
            # The probe used GET with the comma-joined ids in params.
            call = session.get.call_args
            assert call.args[0].endswith("/events-by-pi-id")
            assert call.kwargs["params"]["pi_event_ids"] == (
                "uuid-a,uuid-b,uuid-c"
            )

    def test_cloud_error_returns_empty_set_safely(self):
        """A 500 / 404 / etc. on the probe must NOT raise — the caller
        treats empty set as 'skip back-fill', which is the safe default."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.return_value = _response(
                ok=False, status_code=500, text="internal error",
            )
            client = CloudClient("https://x.y/shelf-ingest", "k")
            out = client.known_pi_event_ids(["uuid-a"])
            assert out == set()

    def test_network_exception_returns_empty_set(self):
        """Bare exceptions (DNS / socket / timeout) also collapse to
        empty set — same caller contract."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.get.side_effect = ConnectionError("dns")
            client = CloudClient("https://x.y/shelf-ingest", "k")
            out = client.known_pi_event_ids(["uuid-a"])
            assert out == set()

    def test_batches_at_200_per_request(self):
        """Inputs larger than 200 ids are chunked + the union returned."""
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            # Each call returns the chunk's first id, so the union should
            # contain one id per chunk.
            calls: list[list[str]] = []

            def fake_get(*args, **kwargs):
                params = kwargs.get("params") or {}
                ids = (params.get("pi_event_ids") or "").split(",")
                calls.append(ids)
                return _response(json_body={"known": [ids[0]]})
            session.get.side_effect = fake_get

            client = CloudClient("https://x.y/shelf-ingest", "k")
            input_ids = [f"uuid-{i}" for i in range(450)]
            out = client.known_pi_event_ids(input_ids)
            # 3 chunks (200 + 200 + 50) → 3 calls.
            assert len(calls) == 3
            assert len(calls[0]) == 200
            assert len(calls[1]) == 200
            assert len(calls[2]) == 50
            # Union: first id of each chunk.
            assert out == {"uuid-0", "uuid-200", "uuid-400"}


# ---------------------------------------------------------------------------
# push_product_state wire-name pinning (audit B-HIGH-2, 2026-05-04)
#
# The Pi-side ``CloudClient.push_product_state`` accepts a Python ``tare_g``
# kwarg but the cloud route at ``/shelf-ingest/product-tare`` reads
# ``tare_weight_g`` off the wire body. Other tests in this codebase capture
# only the kwarg names (via a recording stub), so a regression that renames
# the kwarg to match the wire (``tare_weight_g``) — or drops the
# kwarg→body translation entirely — would break production while leaving
# those recording-stub tests green. This block exercises the REAL method
# with a fake ``requests.Session`` and asserts the body shape directly.
# ---------------------------------------------------------------------------


class TestPushProductStateBodyShape:
    """Wire-shape tests for :meth:`CloudClient.push_product_state`.

    These pin the kwarg → body field translation. The body field names
    are the contract with the cloud edge function; the kwarg names are
    the contract with the Pi callers. They differ on purpose:
    ``tare_g`` → ``tare_weight_g``. Drift on either side is a bug.
    """

    def test_pushes_tare_weight_g_field_on_wire_when_tare_g_kwarg_passed(
        self,
    ):
        """Kwarg ``tare_g`` lands as wire body field ``tare_weight_g``.

        Mutation guard: renaming the kwarg to ``tare_weight_g`` (matching
        the wire) — or removing the explicit assignment to the wire
        ``tare_weight_g`` key — flips this assertion.
        """
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-abc",
                tare_g=42.5,
            )
            kwargs = session.post.call_args.kwargs
            body = kwargs["json"]
            assert body["product_id"] == "prod-abc"
            # The wire field MUST be ``tare_weight_g``, not ``tare_g``.
            assert body["tare_weight_g"] == pytest.approx(42.5), (
                "wire body field must be ``tare_weight_g`` — the cloud "
                "edge function reads that key off the request body"
            )
            assert "tare_g" not in body, (
                "kwarg name must not leak through to the wire body — the "
                "cloud route does not recognise ``tare_g``"
            )
            # ``measured_full_at`` and ``certified`` were NOT passed —
            # they MUST NOT appear on the wire (set-once: omitting a
            # field is the only way to leave the cloud row unchanged).
            assert "measured_full_at" not in body
            assert "certified" not in body

    def test_pushes_measured_full_at_when_passed(self):
        """``measured_full_at`` kwarg lands on the wire under the same
        name (no rename).
        """
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-full",
                measured_full_at="2026-05-04T18:00:00.000Z",
            )
            body = session.post.call_args.kwargs["json"]
            assert body["product_id"] == "prod-full"
            assert body["measured_full_at"] == "2026-05-04T18:00:00.000Z"
            assert "tare_weight_g" not in body
            assert "certified" not in body

    def test_pushes_certified_only_when_explicitly_true(self):
        """``certified=True`` lands on the wire as ``certified: true``.
        ``certified=False`` and ``certified=None`` MUST be omitted from
        the body — the Pi never UNcertifies a product, and ``False``
        is documented as a no-op (matches the docstring contract).
        """
        # certified=True → present.
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-cert",
                tare_g=10.0,
                certified=True,
            )
            body = session.post.call_args.kwargs["json"]
            assert body["certified"] is True
            assert body["tare_weight_g"] == pytest.approx(10.0)

        # certified=False → omitted (and the call still goes out because
        # ``tare_g`` carries it).
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-cert",
                tare_g=10.0,
                certified=False,
            )
            body = session.post.call_args.kwargs["json"]
            assert "certified" not in body, (
                "``certified=False`` is documented as a no-op for the "
                "certify field — must not land on the wire"
            )

        # certified=None → omitted (default).
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-cert",
                tare_g=10.0,
                certified=None,
            )
            body = session.post.call_args.kwargs["json"]
            assert "certified" not in body

    def test_no_unexpected_keys_on_full_payload(self):
        """When all three optional fields are passed, the body carries
        EXACTLY ``{product_id, tare_weight_g, measured_full_at, certified}``
        — nothing else. A regression that adds spurious fields (e.g. a
        cleartext ``api_key`` echo, an internal ``user_id``) would fail
        this assertion immediately.
        """
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            session.post.return_value = _response(json_body={"ok": True})
            client = CloudClient("https://x.y/shelf-ingest", "k")
            client.push_product_state(
                product_id="prod-all",
                tare_g=25.0,
                measured_full_at="2026-05-04T18:00:00.000Z",
                certified=True,
            )
            body = session.post.call_args.kwargs["json"]
            assert set(body.keys()) == {
                "product_id",
                "tare_weight_g",
                "measured_full_at",
                "certified",
            }
            # And the route is /product-tare on the same shelf-ingest
            # base URL — the catch-all auto-import block depends on
            # this routing.
            called_url = session.post.call_args.args[0]
            assert called_url.endswith("/product-tare")

    def test_no_round_trip_when_all_optional_fields_omitted(self):
        """``push_product_state(product_id=...)`` with no other kwargs
        is a caller bug; the client must short-circuit instead of
        spending a useless network call.
        """
        with patch("server.cloud.client.requests.Session") as SessionCls:
            session = SessionCls.return_value
            session.headers = {}
            client = CloudClient("https://x.y/shelf-ingest", "k")
            out = client.push_product_state(product_id="prod-empty")
            assert out == {}
            session.post.assert_not_called()
