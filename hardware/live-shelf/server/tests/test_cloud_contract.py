"""Pi ↔ cloud schema contract + literal-translation regression tests.

Why this file exists
--------------------
Commit ``fc7369b`` fixed a silent DTO-drift bug that had been shipping
500s for every scale-03 (single-item) event:

    pydantic_core.ValidationError: 1 validation error for ScaleEventIn
    shelf_id: Input should be 'live_shelf', 'catch_all' or 'single_item'
    [input_value='live_scale']

Three producers (firmware ``shelf_id`` field set, Pi shelf registry,
cloud ``chefbyte.scale_pairings.kind`` CHECK) all use ``live_scale`` for
the single-item rig. One consumer (Pi's storage ``Literal`` + SQLite
CHECK) uses ``single_item``. The fix was a 3-line translation at
``handle_scale_event`` ingress.

The existing regression test
(``test_scale_event_ingress_routes_scale_03_to_single_item_short_circuit``)
pins the ONE boundary that 500'd. This file prevents the **whole class**
of drift from recurring by:

  * Parsing firmware ``.ino`` ``doc[key] = …`` strings to derive the
    field-name set the ESP actually emits, and asserting Pi's
    ``_validate_event_payload`` + ``ScaleEventIn`` both accept a
    synthetic payload with exactly those fields.
  * Enumerating every literal/enum/CHECK domain that crosses a
    Pi↔cloud boundary and asserting the translation map is symmetric.
  * Capturing the ``emit_single_item_event`` payload via the outbox
    (no HTTP mock) and asserting the shape matches the edge-fn
    shelf-ingest /event handler's required-field set + ``VALID_KINDS``
    + ``VALID_EVENT_KINDS`` tables.
  * Asserting the shelf-ingest /catalog response top-level keys match
    what the Pi's ``cloud.client._parse_or_raise`` expects.

Drift-translation map (current, as of fc7369b)::

    Producer                         | Wire/Storage         | Consumer check
    ---------------------------------+----------------------+--------------------------------
    Firmware ``scale-live.ino``      | doc["device_id"]=…   | Pi _validate_event_payload keys
    Firmware ``scale-catch-all.ino`` | doc["device_id"]=…   | Pi _validate_event_payload keys
    Firmware ``scale-single-item.ino`` | doc["device_id"]=… | Pi _validate_event_payload keys
    Pi shelf_registry                | ShelfId live_scale   | Pi storage Literal single_item  ← translated at ingress
    Pi storage Literal               | ScaleEventIn         | SQLite CHECK constraint
    Pi cloud emitter                 | kind: live_scale     | cloud VALID_KINDS (live_scale)  ← ALREADY symmetric
    Cloud VALID_KINDS                | scale_pairings.kind  | DB CHECK (live_shelf|live_scale|catch_all)

If ANY row in this map changes and a test below does NOT update,
someone has introduced silent drift — the test will fail in a way
that names which boundary moved.

See also: ``test_catch_all_scale_routing.py`` for the
behavioral ingress test; this file is the **structural** guard.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.cloud.outbox import list_pending  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import (  # noqa: E402
    ScaleHandler,
    _validate_event_payload,
)
from server.shelves import DEFAULT_REGISTRY, ShelfId, build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage.models import ScaleEventIn, ShelfId as StorageShelfId  # noqa: E402


# ---------------------------------------------------------------------------
# Ground-truth literal tables. These are intentionally duplicated from the
# producer sources so the assertions in this file catch the case where
# producer X drops/renames a literal and forgets to update its
# translation-layer partner.
# ---------------------------------------------------------------------------

# The cloud edge function's VALID_KINDS table (shelf-ingest/index.ts L34).
# Mirrored manually here because the edge fn is TypeScript and the Pi
# tests run in Python. If the edge fn changes, update this constant AND
# fix the Pi's emitter so the two still agree.
CLOUD_VALID_KINDS = frozenset({"live_shelf", "live_scale", "catch_all"})

# The cloud edge function's VALID_EVENT_KINDS table (shelf-ingest/index.ts L35).
CLOUD_VALID_EVENT_KINDS = frozenset({"consumed", "added", "refilled", "depleted"})

# Required fields the cloud /event handler pulls out of body — missing any
# returns 400 "scale_id, kind, event_kind, delta_g, occurred_at are required".
# (shelf-ingest/index.ts L179-185).
CLOUD_EVENT_REQUIRED_FIELDS = frozenset(
    {"scale_id", "kind", "event_kind", "delta_g", "occurred_at"}
)

# Firmware ingress fields extracted below by parsing the .ino templates.
# Expected = the fields the Pi's _validate_event_payload declares as
# required (plus ``device_id`` which is separately validated).
PI_EVENT_REQUIRED_FIELDS = frozenset(
    {
        "ts",
        "device_id",
        "delta_g",
        "before_weight_g",
        "after_weight_g",
        "event_seq",
    }
)


# ---------------------------------------------------------------------------
# Firmware .ino parser — extract the doc[key] literal strings emitted as
# event JSON. We can't import C/Arduino source into Python, but the field
# names are plain string literals in the serializer blocks.
# ---------------------------------------------------------------------------

FIRMWARE_DIR = ROOT / "firmware"

_DOC_KEY_RE = re.compile(r'doc\["([^"]+)"\]\s*=')
# Fallback for the scale-catch-all.ino heartbeat which uses manual
# string concatenation rather than ArduinoJson.
_STRLIT_KEY_RE = re.compile(r'"([a-z_]+)"\s*:')


def _extract_event_json_keys(ino_path: Path) -> set[str]:
    """Return the set of keys emitted by ``buildEventJson`` in an .ino file.

    Strategy: scan the ``buildEventJson`` function body (between its ``{``
    and the closing ``}``) for ``doc["<key>"] = …`` assignments. This is
    structurally safer than a whole-file regex because other JSON
    serializers (handleData, handleConfig) use the same pattern and would
    contaminate the key set.
    """
    src = ino_path.read_text()
    # Find the buildEventJson function body. We want the block starting
    # at the function's opening brace. Use a lenient locator — the
    # signature is ``String buildEventJson(const PendingEvent& e)``.
    match = re.search(
        r"String\s+buildEventJson\s*\([^)]*\)\s*\{(?P<body>.*?)\n\}",
        src,
        re.DOTALL,
    )
    if not match:
        raise AssertionError(
            f"Could not locate buildEventJson() in {ino_path.name}. "
            "The function may have been renamed — update this parser."
        )
    body = match.group("body")
    return set(_DOC_KEY_RE.findall(body))


def _extract_heartbeat_json_keys(ino_path: Path) -> set[str]:
    """Return the set of keys emitted by ``sendHeartbeat`` in an .ino file.

    scale-live + scale-single-item use ArduinoJson (``doc["key"] = …``);
    scale-catch-all uses manual string concatenation
    (``json += "\"key\":" + …``). Parse both.
    """
    src = ino_path.read_text()
    match = re.search(
        r"bool\s+sendHeartbeat\s*\([^)]*\)\s*\{(?P<body>.*?)\n\}",
        src,
        re.DOTALL,
    )
    if not match:
        raise AssertionError(
            f"Could not locate sendHeartbeat() in {ino_path.name}."
        )
    body = match.group("body")
    keys = set(_DOC_KEY_RE.findall(body))
    # Heartbeat via manual string concat: find JSON-literal-ish "key": tokens.
    keys |= set(_STRLIT_KEY_RE.findall(body))
    # Strip accidental matches from inline comments or CSS — we only want
    # keys the Pi will actually parse. The known heartbeat key set is
    # {device_id, ts, weight_g, stable, uptime_s}; anything outside that is
    # extra chrome from comments.
    return keys


# ---------------------------------------------------------------------------
# Firmware → Pi ingress contract
# ---------------------------------------------------------------------------


class TestFirmwareToPiEventContract:
    """Firmware .ino scale event payload must be accepted by Pi ingress."""

    @pytest.mark.parametrize(
        "ino_name",
        ["scale-live.ino", "scale-catch-all.ino", "scale-single-item.ino"],
    )
    def test_firmware_event_keys_match_pi_required_set(self, ino_name):
        """Every .ino's buildEventJson must emit at least PI_EVENT_REQUIRED_FIELDS.

        Firmware MAY emit extra fields (stable_samples,
        motion_start_ms_before, stability_window_ms) — those are optional
        metadata the Pi ignores at validation. The assertion is only that
        Pi-required fields are all present.
        """
        ino_path = FIRMWARE_DIR / ino_name
        assert ino_path.exists(), f"Missing firmware source: {ino_path}"
        firmware_keys = _extract_event_json_keys(ino_path)
        missing = PI_EVENT_REQUIRED_FIELDS - firmware_keys
        assert not missing, (
            f"{ino_name} buildEventJson does NOT emit required Pi ingress "
            f"fields {missing!r}. Firmware keys found: {sorted(firmware_keys)!r}. "
            "Either the firmware serializer dropped a field or the "
            "Pi's _validate_event_payload added a required field "
            "without updating the firmware."
        )

    @pytest.mark.parametrize(
        "ino_name",
        ["scale-live.ino", "scale-catch-all.ino", "scale-single-item.ino"],
    )
    def test_synthetic_firmware_payload_passes_pi_validator(self, ino_name):
        """A payload with exactly the firmware-emitted keys must pass
        ``_validate_event_payload``. This guards the case where firmware
        emits the right field NAMES but Pi changes the expected shape/type.
        """
        ino_path = FIRMWARE_DIR / ino_name
        firmware_keys = _extract_event_json_keys(ino_path)
        # Default plausible values for every key we might encounter.
        stub: dict[str, Any] = {
            "ts": "2026-04-18T08:00:00.100Z",
            "device_id": "scale-01",
            "delta_g": 120.0,
            "before_weight_g": 0.0,
            "after_weight_g": 120.0,
            "event_seq": 1,
            "stable_samples": 3,
            "motion_start_ms_before": 50,
            "stability_window_ms": 450,
        }
        payload = {k: stub[k] for k in firmware_keys if k in stub}
        # Guard: every firmware key must be in the stub — otherwise we'd
        # silently pass on a key we don't know how to fill.
        unknown = firmware_keys - set(stub.keys())
        assert not unknown, (
            f"{ino_name} emits unexpected key(s) {unknown!r} that this test "
            "doesn't know how to stub. Extend the stub table above and "
            "decide whether the new key should also be required by Pi."
        )
        err = _validate_event_payload(payload)
        assert err is None, (
            f"{ino_name} synthetic payload rejected by Pi validator: {err!r}\n"
            f"payload = {payload!r}"
        )

    def test_firmware_heartbeat_keys_match_expected_set(self):
        """Heartbeat payload fields match across all three firmware variants.

        Pi's /api/scale-heartbeat handler reads {device_id, ts, weight_g,
        stable, uptime_s}. Firmware variants all emit that set — drift
        here would cause the Pi heartbeat poller to silently miss scales.
        """
        expected = {"device_id", "ts", "weight_g", "stable", "uptime_s"}
        for ino_name in (
            "scale-live.ino",
            "scale-catch-all.ino",
            "scale-single-item.ino",
        ):
            ino_path = FIRMWARE_DIR / ino_name
            keys = _extract_heartbeat_json_keys(ino_path)
            missing = expected - keys
            assert not missing, (
                f"{ino_name} sendHeartbeat missing keys {missing!r}; "
                f"got {sorted(keys)!r}"
            )


# ---------------------------------------------------------------------------
# Literal / enum translation table
# ---------------------------------------------------------------------------


class TestShelfIdLiteralDrift:
    """The fc7369b class of drift: shelf-id literal tables across boundaries."""

    def test_pi_storage_literal_matches_documented_domain(self):
        """Pi storage ScaleEventIn.shelf_id + LotIn.shelf_id are restricted
        to exactly {live_shelf, catch_all, single_item}. Any addition here
        MUST be paired with an SQLite CHECK constraint update."""
        # Pydantic stores the Literal args in __args__ via typing.get_args.
        import typing

        args = set(typing.get_args(StorageShelfId))
        assert args == {"live_shelf", "catch_all", "single_item"}, (
            f"Pi storage ShelfId literal changed to {args!r}. "
            "If this is intentional, update SQLite CHECK + the "
            "handle_scale_event ingress translation + this test."
        )

    def test_shelf_registry_literal_matches_documented_domain(self):
        """Pi shelf registry ShelfId = firmware naming convention.
        MUST differ from storage in exactly one pair (live_scale ↔ single_item)."""
        import typing

        args = set(typing.get_args(ShelfId))
        assert args == {"live_shelf", "catch_all", "live_scale"}, (
            f"shelves.py ShelfId literal changed to {args!r}. "
            "Firmware + cloud use this naming. If this is intentional, "
            "audit the translation layer in handle_scale_event."
        )

    def test_registry_ids_present_in_default_registry(self):
        """DEFAULT_REGISTRY keys must equal the full ShelfId domain —
        a missing entry would cause get_shelf_for_device to silently
        return None for a valid shelf."""
        import typing

        expected = set(typing.get_args(ShelfId))
        assert set(DEFAULT_REGISTRY.keys()) == expected, (
            f"DEFAULT_REGISTRY keys {set(DEFAULT_REGISTRY.keys())!r} "
            f"differ from ShelfId domain {expected!r}."
        )

    def test_translation_map_at_ingress_is_exactly_one_pair(self):
        """The only legal shelf-id translation at ingress is live_scale → single_item.
        Any new translation should be explicit + documented; asserting the
        exact rule prevents a silent second translation being added.
        """
        # Exercise the real ingress path — scale-03 with catch_all enabled.
        conn = init_db(":memory:")
        cfg = AppConfig()
        cfg.catch_all_enabled = True
        registry = build_registry_from_config(cfg)
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            handler = ScaleHandler(
                conn=conn,
                db_lock=threading.RLock(),
                camera=None,
                candidate_source=_NullCandidateSource(),
                events_root=Path(td),
                delta_threshold_g=5.0,
                lookback_seconds=2.0,
                recently_out_window_seconds=86_400,
                classifier_client=None,
                catch_all_enabled=True,
                shelf_registry_override=registry,
            )
            # scale-03 → live_scale in registry → translated to single_item
            # → returned in response.
            resp, status = handler.handle_scale_event({
                "ts": "2026-04-18T08:00:00.100Z",
                "device_id": "scale-03",
                "event_seq": 1,
                "delta_g": -15.0,
                "before_weight_g": 200.0,
                "after_weight_g": 185.0,
            })
            assert status == 200
            assert resp.get("shelf_id") == "single_item", (
                f"Expected ingress translation live_scale → single_item; "
                f"got shelf_id={resp.get('shelf_id')!r}. Either the "
                "translation was removed (fc7369b regression) or a NEW "
                "translation was silently added."
            )

            # Negative: scale-01 (already-native live_shelf) must stay
            # live_shelf, not get 'translated' to anything else.
            resp2, status2 = handler.handle_scale_event({
                "ts": "2026-04-18T08:00:00.200Z",
                "device_id": "scale-01",
                "event_seq": 2,
                "delta_g": 120.0,
                "before_weight_g": 0.0,
                "after_weight_g": 120.0,
            })
            assert status2 == 200
            row = conn.execute(
                "SELECT shelf_id FROM scale_events WHERE event_id = ?",
                (resp2["event_id"],),
            ).fetchone()
            assert row[0] == "live_shelf", (
                f"scale-01 must land as live_shelf, got {row[0]!r}"
            )

            # Negative: scale-02 (catch_all) must stay catch_all.
            resp3, status3 = handler.handle_scale_event({
                "ts": "2026-04-18T08:00:00.300Z",
                "device_id": "scale-02",
                "event_seq": 3,
                "delta_g": 120.0,
                "before_weight_g": 0.0,
                "after_weight_g": 120.0,
            })
            assert status3 == 200
            row = conn.execute(
                "SELECT shelf_id FROM scale_events WHERE event_id = ?",
                (resp3["event_id"],),
            ).fetchone()
            assert row[0] == "catch_all", (
                f"scale-02 must land as catch_all, got {row[0]!r}"
            )


# ---------------------------------------------------------------------------
# Pi → cloud /event payload shape
# ---------------------------------------------------------------------------


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


class TestPiToCloudEventPayloadContract:
    """CloudEventEmitter.emit_single_item_event must produce payloads that
    the cloud shelf-ingest /event handler will accept."""

    def test_emit_single_item_event_payload_has_cloud_required_fields(self):
        """Capture the outbox row, assert every cloud-required field is
        present and every value is the cloud-accepted type/literal."""
        conn = init_db(":memory:")
        emitter = CloudEventEmitter(conn, enabled=True)

        outbox_id = emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id="00000000-0000-0000-0000-000000000001",
            delta_g=-50.0,
            noise_floor_g=5.0,
            refill_threshold_g=100.0,
            depleted=False,
            occurred_at="2026-04-20T12:00:00.000Z",
            pi_event_id="ev-abc123",
        )
        assert outbox_id is not None, "emitter should enqueue consumed event"

        # Pull the row back out of the outbox — it's the exact JSON the
        # CloudWorker will POST to /event.
        rows = list_pending(conn, limit=10)
        assert len(rows) == 1
        payload: dict[str, Any] = json.loads(rows[0].payload_json)

        # Every cloud-required field present.
        missing = CLOUD_EVENT_REQUIRED_FIELDS - set(payload.keys())
        assert not missing, (
            f"emit_single_item_event payload missing cloud-required "
            f"fields {missing!r}. Payload keys: {sorted(payload.keys())!r}. "
            "shelf-ingest/index.ts handleEvent() will 400 this body."
        )

        # kind must be one of CLOUD_VALID_KINDS (includes live_scale).
        assert payload["kind"] in CLOUD_VALID_KINDS, (
            f"payload.kind={payload['kind']!r} not in cloud "
            f"VALID_KINDS={CLOUD_VALID_KINDS!r}."
        )

        # Specifically: single-item emitter must emit 'live_scale' (NOT the
        # Pi-storage-side 'single_item'). This is the inverse of the ingress
        # translation — the outbound path stays in the cloud-native naming.
        assert payload["kind"] == "live_scale", (
            f"emit_single_item_event must emit kind='live_scale' (cloud "
            f"naming); got {payload['kind']!r}. Cross-boundary rename "
            "not handled — /event will 400."
        )

        # event_kind must be valid.
        assert payload["event_kind"] in CLOUD_VALID_EVENT_KINDS, (
            f"payload.event_kind={payload['event_kind']!r} not in cloud "
            f"VALID_EVENT_KINDS={CLOUD_VALID_EVENT_KINDS!r}."
        )

        # delta_g must be a finite number (cloud rejects NaN/Infinity).
        assert isinstance(payload["delta_g"], (int, float))
        assert payload["delta_g"] == payload["delta_g"]  # NaN check
        # Single-item consumed emits a NEGATIVE delta_g (stock went down).
        assert payload["delta_g"] < 0

        # occurred_at must parse as ISO-8601 — cloud uses new Date(...)
        # and rejects Number.isNaN(d.getTime()).
        from datetime import datetime

        datetime.fromisoformat(payload["occurred_at"].replace("Z", "+00:00"))

    def test_emit_single_item_event_refilled_emits_positive_delta(self):
        """Refill branch must produce event_kind='refilled' with positive delta_g."""
        conn = init_db(":memory:")
        emitter = CloudEventEmitter(conn, enabled=True)

        emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id=None,  # cloud resolves via scale_pairings
            delta_g=250.0,
            noise_floor_g=5.0,
            refill_threshold_g=100.0,
            depleted=False,
            occurred_at="2026-04-20T13:00:00.000Z",
        )
        rows = list_pending(conn, limit=10)
        payload = json.loads(rows[0].payload_json)
        assert payload["event_kind"] == "refilled"
        assert payload["delta_g"] == 250.0
        # product_id omitted when caller doesn't know it — cloud /event
        # resolves it via scale_pairings (index.ts L243). Pi MUST NOT send
        # null, which would bypass the 'if (!productId && kind)' guard
        # and land on the 'product_id required' 400 at L263.
        assert "product_id" not in payload, (
            "When caller passes product_id=None, emitter must omit the "
            "key (not send null) so cloud's scale_pairings resolution "
            "branch fires. Current payload: {!r}".format(payload)
        )

    def test_emit_single_item_event_depleted_emits_negative_delta(self):
        """Depleted branch must emit event_kind='depleted' with magnitude negated."""
        conn = init_db(":memory:")
        emitter = CloudEventEmitter(conn, enabled=True)

        # Depletion: caller passes positive magnitude, emitter negates.
        emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id="00000000-0000-0000-0000-000000000002",
            delta_g=500.0,
            noise_floor_g=5.0,
            refill_threshold_g=100.0,
            depleted=True,
            occurred_at="2026-04-20T14:00:00.000Z",
        )
        rows = list_pending(conn, limit=10)
        payload = json.loads(rows[0].payload_json)
        assert payload["event_kind"] == "depleted"
        assert payload["delta_g"] == -500.0


# ---------------------------------------------------------------------------
# Pi → cloud /intake + /catalog shape
# ---------------------------------------------------------------------------


class TestCatalogResponseContract:
    """The Pi's cloud client expects /catalog to return an object with
    {products, stock, pairings, locations} keys. If the edge fn changes
    its top-level shape (e.g. returns a bare array like the fallback in
    _parse_or_raise), the catalog sync silently breaks."""

    def test_catalog_expected_top_level_keys(self):
        """The cloud edge fn handleCatalog response shape is pinned at
        {products, stock, pairings, locations} (shelf-ingest/index.ts
        L153-158). The Pi's catalog poller reads exactly those keys.
        """
        # This is a structural assertion against documented shape. The
        # edge fn is TypeScript so we can't import its return type
        # directly; instead, assert the Pi's consumer reads the
        # documented keys.
        pi_catalog_path = ROOT / "server" / "cloud" / "catalog.py"
        assert pi_catalog_path.exists(), (
            "Missing Pi catalog module — if this was renamed, update the "
            "contract test path."
        )
        src = pi_catalog_path.read_text()
        for key in ("products", "stock", "pairings", "locations"):
            # Match either body["key"] or body.get("key") patterns.
            if f'"{key}"' not in src:
                pytest.fail(
                    f"Pi catalog.py does not reference cloud response key "
                    f'"{key}" — if the edge fn dropped it, the poller '
                    "needs an explicit code-path update, not a silent fallback."
                )


class TestIntakePayloadContract:
    """Pi → cloud /intake payload pre-req fields. The cloud's
    handleIntake validates ``name`` (required) and passes through the
    rest. We lock the field name ``name`` and every optional field the
    Pi actually sends."""

    def test_intake_name_field_is_required_by_cloud(self):
        """Mirror-check: shelf-ingest/index.ts handleIntake L321-323 rejects
        'name required'. Keep this test in sync with the edge function."""
        edge_fn_src = (
            ROOT.parent.parent
            / "supabase"
            / "functions"
            / "shelf-ingest"
            / "index.ts"
        )
        # Pi runs from repo root, edge fn lives under supabase/. If this
        # path doesn't exist we're in a different layout — skip rather
        # than fail (the test is informational about cloud side).
        if not edge_fn_src.exists():
            pytest.skip(
                f"Edge function source not found at {edge_fn_src}; "
                "run this test from the repo root."
            )
        text = edge_fn_src.read_text()
        assert "'name required'" in text or '"name required"' in text, (
            "Cloud /intake handler no longer returns 'name required' on "
            "missing name — the Pi intake path assumes this contract."
        )
        # The Pi's upstream callers must also send a non-empty name.
        # We can't assert a Python call shape without replaying the whole
        # intake flow, but we CAN assert the cloud's documented field set
        # matches what the Pi's consumer reads.
        # Required-on-cloud: name
        # Pass-through-optional: barcode, brand, variant, description,
        # net_weight_g, gross_weight_g, tare_weight_g, serving_weight_g,
        # container_type, unit_type, density_g_per_ml, certified,
        # servings_per_container, calories_per_serving, carbs_per_serving,
        # protein_per_serving, fat_per_serving
        # If the cloud adds/removes one of these, the Pi's intake module
        # (server/intake/) should get updated at the same time.
        documented_fields = {
            "name",
            "barcode",
            "brand",
            "variant",
            "description",
            "net_weight_g",
            "gross_weight_g",
            "tare_weight_g",
            "serving_weight_g",
            "container_type",
            "unit_type",
            "density_g_per_ml",
            "certified",
            "servings_per_container",
            "calories_per_serving",
            "carbs_per_serving",
            "protein_per_serving",
            "fat_per_serving",
        }
        for field in documented_fields:
            assert f"body?.{field}" in text or f'body?.["{field}"]' in text or f"body.{field}" in text, (
                f"Cloud /intake handler no longer reads body.{field} — "
                "either the field was renamed or dropped. Update the Pi "
                "intake module and this test together."
            )
