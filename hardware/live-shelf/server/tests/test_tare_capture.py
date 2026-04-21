"""Catch-all tare-capture interception tests (CATCH_ALL_TARE_CAPTURE_PLAN.md §7).

Every test constructs a handler with ``_NullCandidateSource`` + a real
in-memory SQLite DB, arms a tare, fires a synthetic scale event via
:meth:`ScaleHandler.handle_scale_event`, and asserts on ``products``
and ``tare_arm`` DB state plus the response shape.

``scale_events`` table is checked too — a successful capture MUST NOT
record a scale_events row (the tare path short-circuits before the
normal pipeline), an implausible reading MUST also not record one
(handler still short-circuits with ``tare_captured=False``), and a
live-shelf / noise event that falls through MUST record one.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402


class _NullCandidateSource:
    """Minimal CandidateSource stub — tare-capture tests exercise the
    interceptor branch, not classifier logic."""

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


class _RecordingCloudClient:
    """Stub CloudClient capturing ``post_product_tare`` calls.

    Used by test_cloud_push_on_successful_capture to assert the handler
    forwards a successful capture to the cloud WITHOUT blocking on the
    network or raising when the cloud misbehaves.
    """

    def __init__(self, *, raise_on_call: bool = False) -> None:
        self.calls: list[dict] = []
        self.raise_on_call = raise_on_call

    def post_product_tare(self, *, product_id: str, tare_g: float) -> dict:
        self.calls.append({"product_id": product_id, "tare_g": tare_g})
        if self.raise_on_call:
            raise RuntimeError("cloud down")
        return {"ok": True, "product_id": product_id, "tare_weight_g": tare_g}


def _make_handler(conn, tmp_path, *, cloud_client=None):
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=registry,
        cloud_client=cloud_client,
    )


def _make_certified_product(conn, *, name="Mason Jar", barcode="mj-1"):
    return storage_repo.create_product(
        conn,
        ProductIn(
            name=name,
            barcode=barcode,
            net_weight_g=500.0,
            gross_weight_g=500.0,
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )


def _scale_row_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]


# ---------------------------------------------------------------------------
# §7.1 — the happy path
# ---------------------------------------------------------------------------


def test_arm_intercepts_next_catch_all_event(tmp_path):
    """ADD event while armed writes tare_weight_g, deletes arm row, and
    does NOT record a scale_events row. Response shape matches the plan
    (``tare_captured=True``, product_id + tare_g echoed)."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 300.0,
        "before_weight_g": 0.0,
        "after_weight_g": 300.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("tare_captured") is True
    assert resp["product_id"] == product.product_id
    assert resp["tare_g"] == pytest.approx(300.0)

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g == pytest.approx(300.0)

    # Arm row deleted.
    assert storage_repo.get_active_tare_arm(conn) is None
    # No scale_events row recorded — the tare branch short-circuits.
    assert _scale_row_count(conn) == 0


def test_arm_intercepts_remove_direction_uses_before_weight(tmp_path):
    """REMOVE events use ``before_weight_g`` — the settled plateau from
    when the container was ON the scale. Confirms owner resolution #4.
    """
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id)

    # Operator placed the container first, clicked Tare, then lifted it.
    # before=300 (container sat there), after=5 (tiny residual).
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": -295.0,
        "before_weight_g": 300.0,
        "after_weight_g": 5.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("tare_captured") is True
    assert resp["direction"] == "remove"
    assert resp["tare_g"] == pytest.approx(300.0)

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g == pytest.approx(300.0)


# ---------------------------------------------------------------------------
# §7.2 — re-arm replaces prior target
# ---------------------------------------------------------------------------


def test_rearm_replaces_prior_arm(tmp_path):
    """Arming product B after arming product A overwrites A (id=1
    singleton). The next catch-all event tares B, leaving A untouched
    and tare_arm empty afterwards."""
    conn = init_db(":memory:")
    a = _make_certified_product(conn, name="A", barcode="a-1")
    b = _make_certified_product(conn, name="B", barcode="b-1")
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, a.product_id)
    storage_repo.arm_tare(conn, b.product_id)  # replaces A

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:01:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 200.0,
        "before_weight_g": 0.0,
        "after_weight_g": 200.0,
    })

    assert status == 200
    assert resp["product_id"] == b.product_id

    got_a = storage_repo.get_product(conn, a.product_id)
    got_b = storage_repo.get_product(conn, b.product_id)
    assert got_a.tare_weight_g is None, "A must NOT be tared"
    assert got_b.tare_weight_g == pytest.approx(200.0)

    assert storage_repo.get_active_tare_arm(conn) is None


# ---------------------------------------------------------------------------
# §7.3 — expired arm doesn't intercept
# ---------------------------------------------------------------------------


def test_arm_expired_does_not_intercept_legit_event(tmp_path):
    """Arm with ttl=1s, sleep past it, fire a catch-all event. The arm
    is NOT consumed; the event goes through the normal pipeline (records
    a scale_events row) and ``products.tare_weight_g`` stays NULL."""
    import time

    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id, ttl_s=1)
    time.sleep(1.1)

    # Expired arm is invisible to the interceptor (expires_at <= now).
    assert storage_repo.get_active_tare_arm(conn) is None

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:02:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })

    assert status == 200
    # Falls through to normal pipeline — tare NOT captured, event_id set.
    assert resp.get("tare_captured") is not True
    assert "event_id" in resp

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g is None

    # Normal pipeline recorded the scale_events row.
    assert _scale_row_count(conn) == 1


# ---------------------------------------------------------------------------
# §7.4 — implausible reading keeps arm active
# ---------------------------------------------------------------------------


def test_implausible_reading_keeps_arm_active(tmp_path):
    """Reading above max_weight_g stamps last_error on the arm row and
    returns ``tare_captured=False, reason='implausible_weight'`` without
    writing the tare. The arm row is preserved so the operator can
    re-place the container or cancel."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id)  # max=5000g default

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:03:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 9000.0,
        "before_weight_g": 0.0,
        "after_weight_g": 9000.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("tare_captured") is False
    assert resp.get("reason") == "implausible_weight"

    # Product tare unchanged.
    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g is None

    # Arm row still present with last_error.
    arm = storage_repo.get_active_tare_arm(conn)
    assert arm is not None
    assert arm.product_id == product.product_id
    assert arm.last_error is not None
    assert "implausible" in arm.last_error.lower()

    # Interceptor still short-circuited — no scale_events row.
    assert _scale_row_count(conn) == 0


# ---------------------------------------------------------------------------
# §7.5 — noise events don't consume the arm
# ---------------------------------------------------------------------------


def test_noise_event_does_not_consume_arm(tmp_path):
    """A sub-threshold delta classifies as 'noise'. Noise events never
    intercept — the arm stays active, the product stays un-tared, and
    the normal pipeline still records the scale_events noise row."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id)

    # delta=2g < threshold=5g → direction='noise'
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:04:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 2.0,
        "before_weight_g": 0.0,
        "after_weight_g": 2.0,
    })

    assert status == 200
    assert resp.get("direction") == "noise"
    assert resp.get("tare_captured") is not True

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g is None

    arm = storage_repo.get_active_tare_arm(conn)
    assert arm is not None, "noise must NOT consume the arm"

    # Normal pipeline still recorded the noise row.
    assert _scale_row_count(conn) == 1


# ---------------------------------------------------------------------------
# §7.6 — live-shelf events never trigger the tare branch
# ---------------------------------------------------------------------------


def test_live_shelf_event_does_not_trigger_tare(tmp_path):
    """A scale-01 (live_shelf) ADD must NOT consume the catch-all arm.
    Confirms the ``shelf_id == 'catch_all'`` guard is load-bearing."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    handler = _make_handler(conn, tmp_path)

    storage_repo.arm_tare(conn, product.product_id)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:05:00.000Z",
        "device_id": "scale-01",  # live_shelf
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })

    assert status == 200
    assert resp.get("tare_captured") is not True

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g is None

    arm = storage_repo.get_active_tare_arm(conn)
    assert arm is not None, "live-shelf event MUST NOT consume catch-all arm"

    # Normal pipeline recorded the scale_events row against live_shelf.
    row = conn.execute(
        "SELECT shelf_id FROM scale_events WHERE event_id = ?",
        (resp["event_id"],),
    ).fetchone()
    assert row[0] == "live_shelf"


# ---------------------------------------------------------------------------
# §7.7 — cloud push-back fires on successful capture (owner resolution #1)
# ---------------------------------------------------------------------------


def test_cloud_push_on_successful_capture(tmp_path):
    """A successful catch-all tare capture writes locally AND forwards
    to ``CloudClient.post_product_tare``. The local write is authoritative
    — if the cloud raises, the handler still returns 200 with
    ``tare_captured=True`` and the product row has the new tare."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    cloud = _RecordingCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud)

    storage_repo.arm_tare(conn, product.product_id)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:06:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 250.0,
        "before_weight_g": 0.0,
        "after_weight_g": 250.0,
    })

    assert status == 200
    assert resp.get("tare_captured") is True

    # Local write landed first (authoritative path).
    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g == pytest.approx(250.0)

    # Cloud was called exactly once with the captured values.
    assert len(cloud.calls) == 1
    assert cloud.calls[0] == {
        "product_id": product.product_id,
        "tare_g": 250.0,
    }


def test_cloud_push_failure_does_not_block_capture(tmp_path):
    """When the cloud client raises, the handler swallows the error,
    records a WARNING, and still returns success — the local tare
    is the source of truth per CATCH_ALL_TARE_CAPTURE_PLAN cloud
    resolution (#1)."""
    conn = init_db(":memory:")
    product = _make_certified_product(conn)
    cloud = _RecordingCloudClient(raise_on_call=True)
    handler = _make_handler(conn, tmp_path, cloud_client=cloud)

    storage_repo.arm_tare(conn, product.product_id)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:07:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 80.0,
        "before_weight_g": 0.0,
        "after_weight_g": 80.0,
    })

    assert status == 200
    assert resp.get("tare_captured") is True

    got = storage_repo.get_product(conn, product.product_id)
    assert got.tare_weight_g == pytest.approx(80.0)

    # Cloud was called — and the handler didn't propagate the raise.
    assert len(cloud.calls) == 1
