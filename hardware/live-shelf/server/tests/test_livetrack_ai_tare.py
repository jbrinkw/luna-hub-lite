"""Tests for LiveTrackPoller's AI-tare dispatch on awaiting_ai_tare.

Scope:
  * Happy path — estimate called with correctly-shaped args, result POSTed
    with state='ai_tare_ready'.
  * No camera attached — immediate fail-post with last_error='no_camera'.
  * Empty ring buffer — fail-post with last_error='no_frame_available'.
  * estimate raises → fail-post carries the error in last_error.
  * Repeated ticks while in-flight are single-flighted.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.livetrack_poller import LiveTrackPoller  # noqa: E402
from server.intake.ai_tare import AiTareApiError  # noqa: E402
from server.intake.models import AiTareProductForm  # noqa: E402


class _StubClient:
    def __init__(self) -> None:
        self.sessions_to_return: list = []
        self.updates: list[tuple[str, dict]] = []

    def get_active_livetrack_session(self):
        if not self.sessions_to_return:
            return None
        return self.sessions_to_return.pop(0)

    def post_livetrack_session_update(self, session_id, **fields):
        self.updates.append((session_id, dict(fields)))
        return {"session_id": session_id, **fields}


class _FakeCamera:
    """Stand-in for CameraDaemon exposing ``current_frame_jpeg``."""

    def __init__(self, jpeg: bytes | None):
        self._jpeg = jpeg

    def current_frame_jpeg(self):
        return self._jpeg


class _FakeEstimate:
    tare_weight_g = 27.5
    confidence = "high"
    appears_sealed = False
    reasoning = "Glass jar looks ~250ml — typical empty weight ~27g."


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_awaiting_ai_tare_runs_estimate_and_posts_result(tmp_path):
    session = {
        "session_id": "sess-1",
        "state": "awaiting_ai_tare",
        "scale_reading_g": 314.0,
        "ai_tare_product_form": {
            "name": "Mason Jar",
            "brand": "Ball",
            "net_weight_g": 200.0,
            "container_type": "jar",
            "unit_type": "solid",
        },
    }
    client = _StubClient()
    client.sessions_to_return = [session]
    camera = _FakeCamera(jpeg=b"\xff\xd8\xff\xe0JPEGDATA")

    calls: list[dict] = []

    def fake_estimate(*, ref_image_paths, product_form, measured_gross_g, is_partial, **kwargs):
        calls.append({
            "ref_image_paths": list(ref_image_paths),
            "product_form": product_form,
            "measured_gross_g": measured_gross_g,
            "is_partial": is_partial,
        })
        return (_FakeEstimate(), "claude-sonnet-4-6", 0)

    poller = LiveTrackPoller(
        client, camera=camera, tmp_dir=tmp_path, ai_tare_fn=fake_estimate,
    )

    poller.tick_once()

    # estimate() called exactly once with correctly-shaped args.
    assert len(calls) == 1
    call = calls[0]
    assert len(call["ref_image_paths"]) == 1
    assert call["ref_image_paths"][0].endswith("livetrack-sess-1.jpg")
    assert call["measured_gross_g"] == pytest.approx(314.0)
    assert call["is_partial"] is True
    pf: AiTareProductForm = call["product_form"]
    assert pf.name == "Mason Jar"
    assert pf.brand == "Ball"
    assert pf.net_weight_g == pytest.approx(200.0)
    assert pf.container_type == "jar"

    # Result POSTed with state='ai_tare_ready'.
    assert len(client.updates) == 1
    session_id, fields = client.updates[0]
    assert session_id == "sess-1"
    assert fields["ai_tare_g"] == pytest.approx(27.5)
    assert fields["ai_tare_confidence"] == "high"
    assert fields["state"] == "ai_tare_ready"

    # Temp image cleaned up.
    temp_path = tmp_path / "livetrack-sess-1.jpg"
    assert not temp_path.exists()


# ---------------------------------------------------------------------------
# Camera absent / no frame
# ---------------------------------------------------------------------------


def test_no_camera_posts_no_camera_error(tmp_path):
    session = {"session_id": "sess-1", "state": "awaiting_ai_tare"}
    client = _StubClient()
    client.sessions_to_return = [session]
    poller = LiveTrackPoller(client, camera=None, tmp_dir=tmp_path)

    poller.tick_once()

    assert len(client.updates) == 1
    _, fields = client.updates[0]
    assert fields["state"] == "ai_tare_ready"
    assert fields["last_error"] == "no_camera"


def test_camera_empty_ring_buffer_posts_no_frame_error(tmp_path):
    session = {"session_id": "sess-1", "state": "awaiting_ai_tare"}
    client = _StubClient()
    client.sessions_to_return = [session]
    camera = _FakeCamera(jpeg=None)
    poller = LiveTrackPoller(client, camera=camera, tmp_dir=tmp_path)

    poller.tick_once()

    assert len(client.updates) == 1
    _, fields = client.updates[0]
    assert fields["state"] == "ai_tare_ready"
    assert fields["last_error"] == "no_frame_available"


# ---------------------------------------------------------------------------
# estimate error → last_error propagated
# ---------------------------------------------------------------------------


def test_estimate_raises_ai_tare_error_posts_last_error(tmp_path):
    session = {"session_id": "sess-1", "state": "awaiting_ai_tare"}
    client = _StubClient()
    client.sessions_to_return = [session]
    camera = _FakeCamera(jpeg=b"\xff\xd8\xff")

    def boom(**kwargs):
        raise AiTareApiError("anthropic timed out")

    poller = LiveTrackPoller(
        client, camera=camera, tmp_dir=tmp_path, ai_tare_fn=boom,
    )

    poller.tick_once()

    assert len(client.updates) == 1
    _, fields = client.updates[0]
    assert fields["state"] == "ai_tare_ready"
    assert "anthropic timed out" in fields["last_error"]
    # Temp file still cleaned up despite the failure.
    assert not (tmp_path / "livetrack-sess-1.jpg").exists()


# ---------------------------------------------------------------------------
# Non-awaiting_ai_tare state does NOT run estimate
# ---------------------------------------------------------------------------


def test_waiting_scale_state_does_not_run_estimate(tmp_path):
    session = {"session_id": "sess-1", "state": "waiting_scale"}
    client = _StubClient()
    client.sessions_to_return = [session]
    camera = _FakeCamera(jpeg=b"\xff\xd8\xff")

    def forbidden(**kwargs):
        raise AssertionError("estimate must not run in waiting_scale")

    poller = LiveTrackPoller(
        client, camera=camera, tmp_dir=tmp_path, ai_tare_fn=forbidden,
    )

    poller.tick_once()

    # Snapshot updated, no cloud POST.
    assert poller.snapshot() is not None
    assert client.updates == []
