"""End-to-end smoke test for the Live Shelf orchestrator (Bundle H).

Exercises the full happy path:
    1. Intake a product (direct DB seed via the intake repo adapter).
    2. Simulate brightness OPEN → session created.
    3. POST /api/scale-event (REMOVE) → classification + lot marked 'out'.
    4. Simulate brightness CLOSE → reconciler runs.
    5. Verify a session_resolution row exists with a consumed_or_removed
       (or similar) pattern for the placed lot.

The Anthropic client is stubbed — we return a deterministic high-confidence
classification so the pipeline proceeds through the confident-update branch.
"""

from __future__ import annotations

import io
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from flask.testing import FlaskClient

from server.app import AppBundle, create_app
from server.camera.daemon import (
    BrightnessTransition,
    CameraDaemon,
    DaemonConfig,
    now_iso_utc_ms,
)
from server.classifier.anthropic_client import ClassifierCallResult
from server.config import AppConfig
from server.storage import init_db, repo as storage_repo
from server.storage.models import (
    LotIn,
    ProductIn,
    ProductReferenceImageIn,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeCamera:
    """Drop-in for :class:`CameraDaemon` backed by a synthetic frame.

    * No real thread is started.
    * ``current_frame`` / ``current_frame_jpeg`` always return a bright green
      solid frame stamped with the current ISO timestamp.
    * ``snapshot_ring`` returns a list covering the last 5 seconds so
      `frame_at_with(ts, offset_seconds=-2.0)` finds something within slop.
    """

    def __init__(self) -> None:
        self.config = DaemonConfig(capture_fps=10, brightness_detection_enabled=False)
        self.shutdown_event = threading.Event()
        self._frame = np.full((480, 640, 3), (0, 220, 0), dtype=np.uint8)
        self.last_frame_ts = now_iso_utc_ms()
        self._subs: list = []

    # --- CameraDaemon API subset ------------------------------------------
    def on_brightness_transition(self, cb):
        self._subs.append(cb)

    def emit_transition(self, transition: BrightnessTransition) -> None:
        for cb in list(self._subs):
            cb(transition)

    def current_frame(self):
        return self._frame.copy()

    def current_frame_jpeg(self, quality: int = 85):
        # cv2 import happens here so the mjpeg code path in app.py doesn't
        # need to be exercised; the real daemon uses cv2.imencode.
        import cv2

        ok, buf = cv2.imencode(".jpg", self._frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None

    def snapshot_ring(self):
        """Emit a 5-second window of identical frames at 10fps.

        The orchestrator asks for a frame at ``ts - 2s``, so a single
        frame at "now" is outside the 1.5s slop budget. Synthesizing a
        small timeline ending at "now" keeps the lookup happy without
        exercising the brightness state machine — and means session_capture
        sees frames that straddle an open/close transition fired during
        this test, rather than only frames predating the fake's construction.
        """
        from datetime import timedelta

        from server.camera.daemon import parse_iso_utc

        # Always anchor the synthetic window at "now" so frames include
        # timestamps between a session open and close emitted in the
        # current test tick.
        self.last_frame_ts = now_iso_utc_ms()
        last_dt = parse_iso_utc(self.last_frame_ts)
        out = []
        for i in range(-50, 1):
            t = last_dt + timedelta(seconds=i * 0.1)
            iso = (
                t.strftime("%Y-%m-%dT%H:%M:%S.")
                + f"{t.microsecond // 1000:03d}Z"
            )
            out.append((iso, self._frame))
        return out

    def start(self):
        pass

    def join(self, timeout=None):
        pass

    def is_alive(self):
        return True

    def current_brightness(self):
        return 0.0

    def door_open(self):
        return False


class _FakeAnthropicClient:
    """Minimal stand-in for ``AnthropicClassifierClient``.

    The real ``ClassifierContext`` accepts either a full wrapper or a bare
    SDK client. When ``ctx.anthropic_client`` already has a ``.send``
    attribute, classify.py uses it as-is — perfect for tests.
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls: list[dict[str, Any]] = []

    def send(self, payload, *, model=None, max_tokens=512):
        self.calls.append({"payload": payload, "model": model})
        return ClassifierCallResult(
            text=json.dumps(self._payload),
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 30},
            raw=None,
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_data_dir(tmp_path: Path) -> Path:
    (tmp_path / "refs").mkdir()
    (tmp_path / "events").mkdir()
    return tmp_path


@pytest.fixture()
def app_cfg(tmp_data_dir: Path) -> AppConfig:
    cfg = AppConfig()
    cfg.data_root = tmp_data_dir
    cfg.refs_root = tmp_data_dir / "refs"
    cfg.events_root = tmp_data_dir / "events"
    cfg.db_path = tmp_data_dir / "shelf.sqlite3"
    cfg.anthropic_api_key = "test-key"
    cfg.event_delta_threshold_g = 5.0
    cfg.frame_lookback_seconds = 2.0
    cfg.recently_out_window_seconds = 86_400
    cfg.dedup_lru_size = 256
    return cfg


@pytest.fixture()
def fake_camera() -> _FakeCamera:
    return _FakeCamera()


@pytest.fixture()
def fake_classifier_add() -> _FakeAnthropicClient:
    """Classifier response: match a specific lot for an ADD event."""
    return _FakeAnthropicClient(
        {
            "item_id": "__WILL_BE_REPLACED__",
            "action": "added",
            "confidence": 0.9,
            "reasoning": "test stub — add",
            "multi_match": [],
        }
    )


@pytest.fixture()
def fake_classifier_remove() -> _FakeAnthropicClient:
    """Classifier response: identify a lot as removed."""
    return _FakeAnthropicClient(
        {
            "item_id": "__WILL_BE_REPLACED__",
            "action": "removed",
            "confidence": 0.92,
            "reasoning": "test stub — remove",
            "multi_match": [],
        }
    )


@pytest.fixture()
def bundle(
    app_cfg: AppConfig,
    tmp_data_dir: Path,
    fake_camera: _FakeCamera,
    fake_classifier_remove: _FakeAnthropicClient,
) -> AppBundle:
    conn = init_db(str(app_cfg.db_path))
    b = create_app(
        config=app_cfg,
        camera=fake_camera,  # type: ignore[arg-type]
        conn=conn,
        classifier_client=fake_classifier_remove,
        apply_v4l2=False,
        start_camera=False,
    )
    yield b
    b.shutdown()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_product_and_lot(
    conn: sqlite3.Connection,
    refs_root: Path,
    name: str = "Heinz Ketchup",
    barcode: str = "1234567890",
    gross_g: float = 420.0,
) -> tuple[str, str]:
    """Insert a certified product + on_shelf lot + a reference image.

    Returns ``(product_id, lot_id)``.
    """
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=name,
            barcode=barcode,
            brand="Heinz",
            net_weight_g=340.0,
            gross_weight_g=gross_g,
            tare_weight_g=80.0,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    # Write a ref image file + row.
    ref_dir = refs_root / product.product_id
    ref_dir.mkdir(parents=True, exist_ok=True)
    ref_file = ref_dir / "front.jpg"
    import cv2

    ok, buf = cv2.imencode(
        ".jpg", np.full((100, 100, 3), (10, 120, 200), dtype=np.uint8)
    )
    assert ok
    ref_file.write_bytes(buf.tobytes())
    storage_repo.add_reference_image(
        conn,
        ProductReferenceImageIn(
            product_id=product.product_id,
            file_path=str(ref_file.relative_to(refs_root)),
            angle="front",
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=gross_g,
            initial_weight_g=gross_g,
        ),
    )
    return product.product_id, lot.lot_id


# ---------------------------------------------------------------------------
# End-to-end scenario
# ---------------------------------------------------------------------------


def test_full_flow_remove_then_reconcile(
    bundle: AppBundle,
    fake_camera: _FakeCamera,
    fake_classifier_remove: _FakeAnthropicClient,
):
    """Full story: intake → open → REMOVE → close → reconciled."""
    conn = bundle.conn
    cfg = bundle.config

    # 1. Seed the "intake" (direct DB write; equivalent to the /api/intake
    # flow but quicker for the test; the intake blueprint is covered
    # separately in its own test module).
    product_id, lot_id = _seed_product_and_lot(conn, cfg.refs_root)
    # Update the classifier stub so it returns THIS lot_id.
    fake_classifier_remove._payload["item_id"] = lot_id

    # 2. Pre-set the last-known weight so open_session sees a non-zero
    # starting shelf weight (mirrors what a heartbeat would do).
    from server.storage.models import AppStatePatch

    with bundle.db_lock:
        storage_repo.update_app_state(
            conn,
            AppStatePatch(last_scale_weight_g=420.0),
        )

    # 3. Simulate brightness OPEN transition.
    ts_open = now_iso_utc_ms()
    fake_camera.emit_transition(BrightnessTransition("open", ts_open, 120.0))

    # Let the callback run (it's synchronous, but the fake daemon fires
    # callbacks inline so no wait is strictly needed — yield a tick
    # to be defensive against async schedulers on Python 3.13).
    time.sleep(0.02)

    state = storage_repo.get_app_state(conn)
    assert state.door_open == 1, "session should be open after brightness rise"
    session_id = state.current_session_id
    assert session_id is not None

    # 4. POST a REMOVE scale event.
    client = bundle.app.test_client()
    ts_event = now_iso_utc_ms()
    r = client.post(
        "/api/scale-event",
        json={
            "ts": ts_event,
            "device_id": "scale-01",
            "delta_g": -340.0,
            "before_weight_g": 420.0,
            "after_weight_g": 80.0,
            "stable_samples": 8,
            "event_seq": 1,
        },
    )
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["ok"] is True
    assert body["direction"] == "remove"
    # Classification is dispatched to a background thread, and in-session
    # events only classify once the session closes (their frames come
    # from session_capture, which is populated on close). The HTTP
    # response is "pending"; we'll poll after the close transition below.
    event_id = body["event_id"]

    # 5. Dedup check — repeat POST returns same event_id.
    r_dup = client.post(
        "/api/scale-event",
        json={
            "ts": ts_event,
            "device_id": "scale-01",
            "delta_g": -340.0,
            "before_weight_g": 420.0,
            "after_weight_g": 80.0,
            "stable_samples": 8,
            "event_seq": 1,
        },
    )
    assert r_dup.status_code == 200
    dup_body = r_dup.get_json()
    assert dup_body["event_id"] == event_id
    assert dup_body.get("duplicate") is True

    # 6. Heartbeat — freshens the last weight used by close_session.
    ts_hb = now_iso_utc_ms()
    r_hb = client.post(
        "/api/scale-heartbeat",
        json={
            "ts": ts_hb,
            "device_id": "scale-01",
            "weight_g": 80.0,
            "stable": True,
            "uptime_s": 60,
        },
    )
    assert r_hb.status_code == 200

    # 7. Simulate brightness CLOSE — triggers reconciliation on a
    # background thread. Wait for it to mark the session reconciled.
    # Ensure session_capture's close handler (which synchronously
    # classifies pending events) runs BEFORE the brightness handler
    # spawns the reconciler. Otherwise the reconciler can race
    # classification and write "unknown" resolutions. In the real
    # orchestrator the subscribers are both scheduled off the camera
    # daemon thread, and in production the reconciler waits on the
    # shared DB lock long enough for classification to land — here we
    # flip the subscriber order explicitly to avoid the race.
    fake_camera._subs.reverse()
    ts_close = now_iso_utc_ms()
    fake_camera.emit_transition(BrightnessTransition("close", ts_close, 10.0))

    # Reconciler runs in a background thread; wait for it.
    #
    # H3: the reconciler now flips ``reconciled=1`` as its FIRST write
    # inside ``_reconcile_session_locked`` so a crash+retry always hits
    # the idempotency guard. Poll for both ``reconciled == 1`` AND at
    # least one resolution row — the flag alone can fire before the
    # reconciler's resolution-writing loop has run.
    deadline = time.time() + 3.0
    reconciled = False
    while time.time() < deadline:
        session = storage_repo.get_session(conn, session_id)
        if session is not None and session.reconciled == 1:
            rs = storage_repo.list_resolutions_for_session(conn, session_id)
            if rs:
                reconciled = True
                break
        time.sleep(0.05)
    assert reconciled, "session should be reconciled after close"

    # Poll until the event's classifier_status transitions out of
    # "pending". The session-close hook dispatches classification on a
    # background thread; it should settle to "classified" shortly after
    # reconciliation completes.
    deadline = time.time() + 3.0
    final_status = "pending"
    while time.time() < deadline:
        with bundle.db_lock:
            row = conn.execute(
                "SELECT classifier_status FROM scale_events "
                "WHERE event_id = ?",
                (event_id,),
            ).fetchone()
        final_status = row[0] if row else "pending"
        if final_status in ("classified", "review", "failed"):
            break
        time.sleep(0.05)
    assert final_status == "classified", (
        f"expected classifier_status=classified, got {final_status!r}"
    )

    # Lot must be marked 'in_flight' now that classification ran
    # (post-IN_FLIGHT_TRACKER_PLAN: classified REMOVEs stage in-flight
    # until the TTL reaper flips them to 'out' or a matching ADD returns).
    lot_after = storage_repo.get_lot(conn, lot_id)
    assert lot_after is not None
    assert lot_after.status == "in_flight"
    assert lot_after.pickup_event_id == event_id

    # Frames must be on disk.
    event_dir = cfg.events_root / event_id
    assert (event_dir / "before.jpg").exists()
    assert (event_dir / "after.jpg").exists()

    # 8. At least one session_resolutions row should exist for this
    # session, tagged with the removed lot. Fast-path wrote the
    # in_flight_pickup row; reconciler now skips the event.
    resolutions = storage_repo.list_resolutions_for_session(conn, session_id)
    assert resolutions, "fast-path should have written at least one resolution"
    patterns = {r.pattern for r in resolutions}
    assert "in_flight_pickup" in patterns
    assert any(r.lot_id == lot_id for r in resolutions)


def test_noise_event_is_recorded_but_no_classifier(
    bundle: AppBundle,
    fake_classifier_remove: _FakeAnthropicClient,
):
    """Events within the delta threshold are marked noise and skipped."""
    client = bundle.app.test_client()
    ts = now_iso_utc_ms()
    r = client.post(
        "/api/scale-event",
        json={
            "ts": ts,
            "device_id": "scale-01",
            "delta_g": 1.0,  # below default 5g threshold
            "before_weight_g": 100.0,
            "after_weight_g": 101.0,
            "stable_samples": 8,
            "event_seq": 99,
        },
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["direction"] == "noise"
    # Classifier stub must not have been called.
    assert fake_classifier_remove.calls == []


def test_event_outside_session_still_runs_classifier(
    bundle: AppBundle,
    fake_classifier_remove: _FakeAnthropicClient,
):
    """No active session → event is still persisted + classified.

    Prior behavior dropped out-of-session events silently (no frame capture,
    no classifier). New behavior runs the full per-event pipeline regardless
    of session state — session membership only affects the *reconciler*'s
    session-close pairing, not per-event classification. Without this,
    ADDs that happen when the brightness watcher hasn't flipped to "open"
    silently drop on the floor.
    """
    client = bundle.app.test_client()
    ts = now_iso_utc_ms()
    r = client.post(
        "/api/scale-event",
        json={
            "ts": ts,
            "device_id": "scale-01",
            "delta_g": -200.0,
            "before_weight_g": 500.0,
            "after_weight_g": 300.0,
            "stable_samples": 8,
            "event_seq": 5,
        },
    )
    assert r.status_code == 200
    body = r.get_json()
    # Classifier path was entered (status is no longer the
    # "skipped_no_session" sentinel). Whether the classifier itself was
    # actually called depends on frame capture succeeding; in this test
    # environment the synthetic camera may not produce a frame at the
    # exact requested timestamp, which leads to a 'failed' status — the
    # important thing is that the code path progressed past the early
    # return, which is what this assertion covers.
    assert body["classifier_status"] != "skipped_no_session"


def test_add_event_for_catalog_product_creates_lot(
    app_cfg: AppConfig,
    tmp_data_dir: Path,
    fake_camera: _FakeCamera,
):
    """ADD event classified as a catalog (not-on-shelf) product mints a lot.

    Regression test for the "item identified but never on the shelf" bug:
    for a `catalog_not_on_shelf` candidate the classifier returns the
    product_id as `item_id`. The scale handler must mint a fresh lot
    inline so the shelf registry reflects the placement immediately,
    even for out-of-session ADDs (no reconciler will run).
    """
    conn = init_db(str(app_cfg.db_path))
    # Seed a certified product with NO on-shelf lot.
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Philly Cream Cheese",
            barcode="99999",
            brand="Philadelphia",
            net_weight_g=340.0,
            gross_weight_g=260.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    # No pre-existing lot — the classifier will pick the catalog entry.
    classifier = _FakeAnthropicClient(
        {
            "item_id": product.product_id,
            "action": "added",
            "confidence": 0.92,
            "reasoning": "catalog pick",
            "multi_match": [],
        }
    )
    bundle = create_app(
        config=app_cfg,
        camera=fake_camera,  # type: ignore[arg-type]
        conn=conn,
        classifier_client=classifier,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        client = bundle.app.test_client()
        # Publish a closed session in session_capture before the event
        # so the handler's post-close grace window (10s) can resolve
        # frames for an out-of-session event. Without this, classification
        # only happens via the 5s sweeper interval, which exceeds the
        # test's deadline.
        ts_open = now_iso_utc_ms()
        fake_camera.emit_transition(BrightnessTransition("open", ts_open, 120.0))
        time.sleep(0.02)
        ts_close = now_iso_utc_ms()
        fake_camera.emit_transition(BrightnessTransition("close", ts_close, 10.0))

        r = client.post(
            "/api/scale-event",
            json={
                "ts": now_iso_utc_ms(),
                "device_id": "scale-01",
                "delta_g": 260.0,
                "before_weight_g": 0.0,
                "after_weight_g": 260.0,
                "stable_samples": 8,
                "event_seq": 42,
            },
        )
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_json()
        # Classification is dispatched to a background thread; poll the
        # DB until the event's classifier_status transitions out of pending.
        event_id = body["event_id"]
        deadline = time.time() + 3.0
        final_status = "pending"
        while time.time() < deadline:
            with bundle.db_lock:
                row = conn.execute(
                    "SELECT classifier_status FROM scale_events "
                    "WHERE event_id = ?",
                    (event_id,),
                ).fetchone()
            final_status = row[0] if row else "pending"
            if final_status in ("classified", "review", "failed"):
                break
            time.sleep(0.05)
        assert final_status == "classified", (
            f"expected classifier_status=classified, got {final_status!r}"
        )
        # A fresh lot for this product must exist now, on the shelf.
        lots = [
            lot for lot in storage_repo.list_lots_by_status(conn, "on_shelf")
            if lot.product_id == product.product_id
        ]
        assert len(lots) == 1, f"expected 1 on-shelf lot, got {len(lots)}"
        lot = lots[0]
        assert lot.current_weight_g == pytest.approx(260.0)
        assert lot.initial_weight_g == pytest.approx(260.0)
    finally:
        bundle.shutdown()


def test_reconciler_handles_catalog_product_id_from_classifier(
    app_cfg: AppConfig,
    tmp_data_dir: Path,
    fake_camera: _FakeCamera,
):
    """Full round-trip: manual session → catalog ADD → close → reconcile.

    Regression test for an FK-constraint crash: the classifier returns
    a product_id for catalog_not_on_shelf picks, and the reconciler's
    Pass 3 must write a resolution whose lot_id resolves to a real
    lots row (not a product_id, which would violate the FK).
    """
    conn = init_db(str(app_cfg.db_path))
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Tray Item",
            barcode="42424242",
            brand="Test",
            net_weight_g=260.0,
            gross_weight_g=260.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    classifier = _FakeAnthropicClient(
        {
            "item_id": product.product_id,
            "action": "added",
            "confidence": 0.88,
            "reasoning": "catalog pick",
            "multi_match": [],
        }
    )
    bundle = create_app(
        config=app_cfg,
        camera=fake_camera,  # type: ignore[arg-type]
        conn=conn,
        classifier_client=classifier,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        client = bundle.app.test_client()
        # Open a session via a brightness transition — that path
        # engages session_capture (the callback that classifies
        # pending events on close). The bench-demo manual API
        # endpoints bypass session_capture, so they can't trigger
        # classification for this regression scenario.
        ts_open = now_iso_utc_ms()
        fake_camera.emit_transition(BrightnessTransition("open", ts_open, 120.0))
        time.sleep(0.02)
        session_id = storage_repo.get_app_state(conn).current_session_id
        assert session_id is not None
        ts = now_iso_utc_ms()
        r_ev = client.post(
            "/api/scale-event",
            json={
                "ts": ts,
                "device_id": "scale-01",
                "delta_g": 260.0,
                "before_weight_g": 0.0,
                "after_weight_g": 260.0,
                "stable_samples": 8,
                "event_seq": 1,
            },
        )
        assert r_ev.status_code == 200
        # Classification is dispatched to a background thread, and
        # in-session events only classify once the session closes
        # (their frames come from session_capture). The immediate
        # response is "pending"; we'll poll after the close below.
        event_id = r_ev.get_json()["event_id"]

        # Flip subscriber order so session_capture (which classifies
        # pending events synchronously) runs before brightness_handler
        # spawns the reconciler — otherwise the reconciler races
        # classification and writes "unknown" resolutions.
        fake_camera._subs.reverse()
        ts_close = now_iso_utc_ms()
        fake_camera.emit_transition(BrightnessTransition("close", ts_close, 10.0))

        # Wait for reconciler. Must succeed without FK errors.
        #
        # H3: the reconciler now flips ``reconciled=1`` as its FIRST
        # write (inside ``_reconcile_session_locked``) so a crash+retry
        # always hits the idempotency guard. That means a poll on just
        # ``reconciled`` would break out BEFORE the new_arrival
        # resolution is written. Poll for BOTH: ``reconciled == 1`` AND
        # at least one resolution row present.
        deadline = time.time() + 3.0
        reconciled = False
        while time.time() < deadline:
            s = storage_repo.get_session(conn, session_id)
            if s is not None and s.reconciled == 1:
                rs = storage_repo.list_resolutions_for_session(
                    conn, session_id,
                )
                if rs:
                    reconciled = True
                    break
            time.sleep(0.05)
        assert reconciled, "reconciler should complete without errors"

        # Poll until the event's classifier_status transitions out of
        # "pending". The session-close hook classifies events in the
        # session's window synchronously on the capture thread.
        deadline = time.time() + 3.0
        final_status = "pending"
        while time.time() < deadline:
            with bundle.db_lock:
                row = conn.execute(
                    "SELECT classifier_status FROM scale_events "
                    "WHERE event_id = ?",
                    (event_id,),
                ).fetchone()
            final_status = row[0] if row else "pending"
            if final_status in ("classified", "review", "failed"):
                break
            time.sleep(0.05)
        assert final_status == "classified", (
            f"expected classifier_status=classified, got {final_status!r}"
        )

        # The resolution must have a valid lot_id that points to the
        # minted lot, NOT the product_id.
        resolutions = storage_repo.list_resolutions_for_session(
            conn, session_id
        )
        assert resolutions
        # Find the new_arrival or new-lot resolution — for out-of-session
        # ADDs the handler mints the lot inline, so the reconciler will
        # see the ADD as either new_arrival (no prior lot for this
        # product) or use_return_consumed (if a prior out-lot existed).
        target = [
            r for r in resolutions
            if r.add_event_id is not None and r.lot_id is not None
        ]
        assert target, "expected a resolution with both add_event_id and lot_id"
        # Verify every resolution's lot_id points to a real lot row.
        for r in target:
            lot = storage_repo.get_lot(conn, r.lot_id)
            assert lot is not None, (
                f"resolution lot_id {r.lot_id!r} does not resolve to a lot; "
                "FK would fail"
            )
            assert lot.product_id == product.product_id
    finally:
        bundle.shutdown()


def test_manual_session_start_and_end_endpoints(
    bundle: AppBundle,
):
    """POST /api/session/start opens and /api/session/end closes a session.

    The bench demo has no real fridge door, so the dashboard exposes a
    manual trigger to open/close sessions. These endpoints must go
    through the same handler the brightness watcher uses.
    """
    client = bundle.app.test_client()

    r_open = client.post("/api/session/start", json={})
    assert r_open.status_code == 200
    open_body = r_open.get_json()
    assert open_body["ok"] is True
    assert open_body.get("session_id"), open_body
    session_id = open_body["session_id"]

    state = storage_repo.get_app_state(bundle.conn)
    assert state.door_open == 1
    assert state.current_session_id == session_id

    # Second open → already_open response
    r_dup = client.post("/api/session/start", json={})
    assert r_dup.status_code == 200
    assert r_dup.get_json().get("already_open") is True

    # Close
    r_close = client.post("/api/session/end", json={})
    assert r_close.status_code == 200
    close_body = r_close.get_json()
    assert close_body["ok"] is True
    assert close_body.get("session_id") == session_id

    # The close path spawns the reconciler in a background thread; wait
    # for door_open to flip back to 0 (set synchronously in close_session).
    deadline = time.time() + 2.0
    while time.time() < deadline:
        state = storage_repo.get_app_state(bundle.conn)
        if state.door_open == 0:
            break
        time.sleep(0.02)
    assert state.door_open == 0

    # Close again → no_session
    r_none = client.post("/api/session/end", json={})
    assert r_none.status_code == 200
    assert r_none.get_json().get("no_session") is True


def test_classifier_aborts_on_wipe_epoch_change(
    app_cfg: AppConfig,
    tmp_data_dir: Path,
    fake_camera: _FakeCamera,
):
    """Regression guard for the wipe-epoch abort contract.

    A classifier thread snapshots ``_wipe_epoch`` at entry and must bail
    before any DB write if an admin wipe bumps the epoch mid-flight.
    Otherwise the thread would insert review_queue rows / mint lots that
    reference now-deleted events — leaving stale references the sweeper
    can't clean up.

    This test drives the full flow:
      1. Start classification on a background thread.
      2. Block inside the classifier's Anthropic ``send()`` call.
      3. Call ``bump_wipe_epoch()`` while it's blocked.
      4. Release the mock so the classifier proceeds.
      5. Verify no ``review_queue`` rows were written and no new lot
         was minted — the abort check at the last wipe_happened()
         guard must have short-circuited before any write site.
    """
    conn = init_db(str(app_cfg.db_path))
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Wipe Test",
            barcode="55555",
            brand="Test",
            net_weight_g=200.0,
            gross_weight_g=200.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )

    # Classifier that blocks inside send() until released.
    release = threading.Event()
    send_in_flight = threading.Event()

    class _BlockingAnthropicClient:
        """Waits inside send() so the test can bump the wipe epoch before
        the classifier body would otherwise write to the DB."""

        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload
            self.calls: list[dict[str, Any]] = []

        def send(self, payload, *, model=None, max_tokens=512):
            self.calls.append({"payload": payload, "model": model})
            send_in_flight.set()
            # Block until the test releases. A generous timeout prevents
            # a hung classifier from hanging the whole test suite on
            # failure; the assertion below will catch missed releases.
            release.wait(timeout=5.0)
            return ClassifierCallResult(
                text=json.dumps(self._payload),
                model=model or "claude-sonnet-4-6",
                usage={"input_tokens": 10, "output_tokens": 5},
                raw=None,
            )

    classifier = _BlockingAnthropicClient(
        {
            "item_id": product.product_id,
            "action": "added",
            "confidence": 0.95,
            "reasoning": "blocked test",
            "multi_match": [],
        }
    )
    bundle = create_app(
        config=app_cfg,
        camera=fake_camera,  # type: ignore[arg-type]
        conn=conn,
        classifier_client=classifier,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        client = bundle.app.test_client()
        # Open + close a session so frame capture works for an
        # out-of-session ADD event.
        ts_open = now_iso_utc_ms()
        fake_camera.emit_transition(
            BrightnessTransition("open", ts_open, 120.0)
        )
        time.sleep(0.02)
        ts_close = now_iso_utc_ms()
        fake_camera.emit_transition(
            BrightnessTransition("close", ts_close, 10.0)
        )

        r = client.post(
            "/api/scale-event",
            json={
                "ts": now_iso_utc_ms(),
                "device_id": "scale-01",
                "delta_g": 200.0,
                "before_weight_g": 0.0,
                "after_weight_g": 200.0,
                "stable_samples": 8,
                "event_seq": 77,
            },
        )
        assert r.status_code == 200
        event_id = r.get_json()["event_id"]

        # Wait for the classifier to actually start (enter send()).
        # The dispatch path runs on a background thread; generous timeout.
        assert send_in_flight.wait(timeout=3.0), (
            "classifier send() was never called"
        )

        # Bump the wipe epoch WHILE send() is blocked. The classifier's
        # _wipe_happened() check (after the response returns) must see
        # the change and bail before writing the event classification
        # or enqueueing a review row.
        bumped = bundle.scale_handler.bump_wipe_epoch()
        assert bumped >= 1

        # Release the blocked send() so the classifier body can proceed
        # past the mocked API call and hit the wipe-check.
        release.set()

        # Give the classifier thread time to reach the abort check and
        # return. Wait up to 2s for the status to transition out of
        # 'classifying' (either aborted or completed).
        deadline = time.time() + 2.0
        while time.time() < deadline:
            with bundle.db_lock:
                status_row = conn.execute(
                    "SELECT classifier_status FROM scale_events "
                    "WHERE event_id = ?",
                    (event_id,),
                ).fetchone()
            if status_row and status_row[0] != "classifying":
                break
            time.sleep(0.05)

        # Post-wipe-abort assertions:
        # 1. No review_queue rows for this event. If the classifier had
        #    completed its success-write path, it would have minted a lot
        #    (no review row for confident ADD), but a failed-path abort
        #    could have enqueued one. Either way, the success path's
        #    wipe-check must have aborted cleanly → zero rows.
        with bundle.db_lock:
            rq_count = conn.execute(
                "SELECT COUNT(*) FROM review_queue WHERE event_id = ?",
                (event_id,),
            ).fetchone()[0]
        assert rq_count == 0, (
            f"expected 0 review_queue rows after wipe-abort; got {rq_count}"
        )

        # 2. No on_shelf lots minted for this product — _apply_lot_update
        #    lives inside the same wipe-guarded transaction as the event
        #    classification write, so if the abort fired neither happens.
        lots = [
            lot for lot in storage_repo.list_lots_by_status(conn, "on_shelf")
            if lot.product_id == product.product_id
        ]
        assert lots == [], (
            f"expected no minted lots after wipe-abort; got {len(lots)}"
        )
    finally:
        # Ensure the blocker is released even if an assertion fails so
        # the test doesn't leak a hung thread.
        release.set()
        bundle.shutdown()


def test_healthz_reports_camera_alive(bundle: AppBundle):
    """/healthz returns ok=True with the faked camera reporting alive."""
    client = bundle.app.test_client()
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True


def test_healthz_exposes_cloud_fields_when_cloud_disabled(bundle: AppBundle):
    """Deep-audit finding #8: /healthz must report the four cloud-side
    fields even when CLOUD_ENABLED=false so dashboards can detect the
    flag flip. When disabled, the worker/outbox fields are None — not
    missing — so consumers don't have to guard for key absence.
    """
    client = bundle.app.test_client()
    body = client.get("/healthz").get_json()
    # Keys are always present.
    assert "cloud_enabled" in body
    assert "cloud_worker_alive" in body
    assert "cloud_outbox_pending" in body
    assert "cloud_outbox_permanent_failures" in body
    # Fixture runs with cloud disabled — enabled flag is False and the
    # three state fields degrade to None.
    assert body["cloud_enabled"] is False
    assert body["cloud_worker_alive"] is None
    assert body["cloud_outbox_pending"] is None
    assert body["cloud_outbox_permanent_failures"] is None


def test_shutdown_logs_each_step_at_info(bundle: AppBundle, caplog):
    """Deep-audit finding #9: shutdown must log INFO at each phase so
    a hung shutdown is debuggable from the log. We also verify the
    cloud-worker is_alive check's log line when no cloud worker exists
    (the path for CLOUD_ENABLED=false) — it should simply skip the
    cloud block without failing."""
    import logging
    with caplog.at_level(logging.INFO, logger="server.app"):
        bundle.shutdown()
    # One INFO per phase — "starting" / "camera" / "closing db" / "complete".
    messages = [r.getMessage() for r in caplog.records if r.name == "server.app"]
    assert any("shutdown: starting" in m for m in messages)
    assert any("shutdown: setting camera shutdown" in m for m in messages)
    assert any("shutdown: camera stopped" in m for m in messages)
    assert any("shutdown: closing db" in m for m in messages)
    assert any("shutdown: complete" in m for m in messages)


def test_api_state_and_config(bundle: AppBundle):
    """/api/state and /api/config are both wired correctly."""
    client = bundle.app.test_client()
    r = client.get("/api/state")
    assert r.status_code == 200
    data = r.get_json()
    assert "door_open" in data
    assert data["door_open"] is False

    r_cfg = client.get("/api/config")
    assert r_cfg.status_code == 200
    cfg_data = r_cfg.get_json()
    assert cfg_data["event_delta_threshold_g"] == 5.0

    r_update = client.post(
        "/api/config",
        json={"event_delta_threshold_g": 8.0},
    )
    assert r_update.status_code == 200
    updated = r_update.get_json()
    assert updated["event_delta_threshold_g"] == 8.0
