"""End-to-end regression for the catch-all self-copy bug.

Bug history (2026-04-28):
    Production event ``6baa809d-066f-4c2c-8d25-f7f3ad0f87e0`` got
    stuck at ``classifier_status='failed'`` with the exact error
    ``"after copy failed: '...after.jpg' and PosixPath('...after.jpg')
    are the same file"``. Cause: the catch-all fast-path persists
    the canonical event-dir paths back onto ``scale_events``, then
    ``_classify_recorded_event`` re-enters ``_capture_frames`` with
    those paths as ``src``. ``shutil.copyfile`` raised
    ``SameFileError`` (subclass of ``OSError``) and the helper
    returned an error tuple — the classifier never ran.

This test mirrors the END-TO-END flow that produced that event:
    handle_scale_event (catch-all branch)
      → _capture_catch_all_frames        (writes to event dir)
      → persist paths on scale_events
      → _dispatch_classification         (worker thread)
        → _classify_recorded_event
          → _capture_frames              ← THE BUG SITE
            (re-enters with src == dst)

Crucially this test does NOT patch ``_capture_frames`` (unlike
``test_catch_all_dispatch_end_to_end.py``, which patches it as a
no-op pass-through specifically to bypass this bug while
exercising layers below). The same-file guard must do its job.

Mutation discipline:
    * Reverting the same-file guard inside ``_capture_frames`` →
      classifier returns the SameFileError, the row ends up at
      ``classifier_status='failed'``, and the
      ``_stub_classify_event`` mock is NEVER called.
      ``mock_classify.called`` flips False; the
      ``classifier_status != 'failed'`` assert fires with the
      original SameFileError text included.
    * Removing the resolve() comparison (e.g. comparing raw strings)
      while the actual src/dst paths happen to differ syntactically
      (the persisted path went through ``str(dst.resolve())`` so it
      may or may not match the canonical path char-for-char) flips
      this test on platforms where they differ.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from unittest.mock import patch

import cv2  # noqa: F401  - keeps numpy linked for ring frames
import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import CameraDaemon, DaemonConfig  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_frame(idx: int) -> np.ndarray:
    frame = np.full((32, 32, 3), 128, dtype=np.uint8)
    frame[0, 0, 0] = idx & 0xFF
    return frame


def _iso(ts: datetime) -> str:
    return (
        ts.strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{ts.microsecond // 1000:03d}Z"
    )


def _seed_ring(daemon: CameraDaemon, n: int, fps: int, start: datetime) -> list[str]:
    period = timedelta(seconds=1.0 / fps)
    out: list[str] = []
    for i in range(n):
        ts = _iso(start + period * i)
        daemon._ring.append((ts, _make_frame(i)))  # type: ignore[attr-defined]
        daemon.last_frame_ts = ts
        out.append(ts)
    return out


def _seed_cloud_lot(
    conn: sqlite3.Connection,
    *,
    lot_id: str,
    product_id: str,
    qty: float = 1.0,
):
    from server.storage import repo as storage_repo  # noqa: E402
    from server.storage.models import ProductIn  # noqa: E402

    storage_repo.create_product(
        conn,
        ProductIn(
            barcode=f"BC-{product_id}",
            name=f"Product {product_id}",
            net_weight_g=500.0,
            gross_weight_g=525.0,
            tare_weight_g=25.0,
            unit_type="liquid",
            container_type="bottle",
            certified=True,
        ),
    )
    with conn:
        conn.execute(
            "UPDATE products SET product_id = ? WHERE barcode = ?",
            (product_id, f"BC-{product_id}"),
        )
        conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                in_flight_kind, pickup_event_id, in_flight_since,
                created_at, updated_at
            ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
            """,
            (
                lot_id, product_id, qty,
                "2026-04-28T00:00:00Z", "2026-04-28T00:00:00Z",
            ),
        )


def _make_handler(
    conn: sqlite3.Connection,
    tmp_path: Path,
    *,
    catch_all_camera: Optional[CameraDaemon] = None,
) -> ScaleHandler:
    from server.cloud.integration import CloudEventEmitter  # noqa: E402

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
        catch_all_camera=catch_all_camera,
        catch_all_photo_delay_s=0.0,
        cloud_emitter=CloudEventEmitter(conn, enabled=True),
    )


def _wait_for_classifier_status(
    conn: sqlite3.Connection,
    event_id: str,
    *,
    timeout_s: float = 8.0,
) -> tuple[str, Optional[str]]:
    """Poll until the classifier_status leaves ('pending', 'classifying').
    Returns ``(status, classification_json)``.
    """
    deadline = time.monotonic() + timeout_s
    last_status: Any = None
    last_class: Any = None
    while time.monotonic() < deadline:
        row = conn.execute(
            "SELECT classifier_status, classification "
            "FROM scale_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if row is not None:
            last_status, last_class = row[0], row[1]
            if last_status in ("classified", "review", "failed"):
                return last_status, last_class
        time.sleep(0.05)
    pytest.fail(
        f"classifier never finished for event_id={event_id}; "
        f"last status = {last_status!r}"
    )


def test_catch_all_classifier_runs_on_self_copy_path(tmp_path: Path):
    """The full catch-all dispatch chain must reach the classifier
    even though ``_classify_recorded_event`` re-enters
    ``_capture_frames`` with src paths that resolve to the
    destination paths (the canonical event dir) — i.e. the exact
    flow that produced the failed event 6baa809d on the Pi.

    Mutation guard: revert the same-file guard inside
    ``_capture_frames`` (line ~1040–1054 of scale_events.py) and
    this test fails with the original SameFileError text:
    ``"after copy failed: ... are the same file"``.
    """
    conn = init_db(":memory:")

    target_lot_id = "lot-self-copy-001"
    target_product_id = "prod-self-copy-001"
    _seed_cloud_lot(
        conn, lot_id=target_lot_id, product_id=target_product_id, qty=2.0,
    )

    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    classify_calls: list[tuple[Any, Any]] = []

    def _stub_classify_event(event, ctx):
        # Record the call so we can prove the classifier actually ran
        # — i.e. ``_capture_frames`` returned successfully and didn't
        # short-circuit with the SameFileError.
        classify_calls.append((event, ctx))
        from server.classifier.models import (
            Candidate, ClassificationResult,
        )

        pool_entry = Candidate(
            candidate_id=target_lot_id,
            name=f"Product {target_product_id}",
            brand=None,
            expected_weight_g=500.0,
            container_type="bottle",
            why_candidate="in_flight",
            reference_image_paths=tuple(),
            rank_score=1.0,
            product_id=target_product_id,
            lot_id=target_lot_id,
        )
        return ClassificationResult(
            item_id=target_lot_id,
            action="added",
            confidence=0.95,
            reasoning="self-copy regression stub",
            secondary_candidates=tuple(),
            multi_match=tuple(),
            candidate_pool_used=(pool_entry,),
            meta={"attempts": [{"ok": True}], "usage": {}},
        )

    # NOTE: ``_capture_frames`` is intentionally NOT patched here.
    # The same-file guard inside the real implementation is what
    # this test pins. If it gets reverted, the classifier never
    # runs and ``classify_calls`` stays empty.
    with patch(
        "server.handlers.scale_events.classify_event",
        side_effect=_stub_classify_event,
    ) as mock_classify:
        resp, status = handler.handle_scale_event({
            "ts": timestamps[15],
            "device_id": "scale-02",
            "event_seq": 1,
            "delta_g": 240.0,
            "before_weight_g": 0.0,
            "after_weight_g": 240.0,
        })
        assert status == 200, resp
        event_id = resp["event_id"]

        final_status, classification_json = _wait_for_classifier_status(
            conn, event_id,
        )

        # Primary mutation-pinning assertion — if the same-file
        # guard is reverted, ``_capture_frames`` returns an error
        # and ``_classify_recorded_event`` marks the row failed
        # WITHOUT invoking the classifier.
        assert final_status != "failed", (
            f"catch-all event {event_id} ended at classifier_status="
            "'failed'. The same-file guard inside "
            "ScaleHandler._capture_frames is missing or broken — "
            "the catch-all fast-path writes frames to "
            "data/events/<id>/{before,after}.jpg, persists those "
            "paths, then re-enters _capture_frames with src == dst. "
            "Without the guard, shutil.copyfile raises SameFileError "
            "and the classifier never runs. classification column = "
            f"{classification_json!r}"
        )
        assert final_status == "classified", (
            f"expected 'classified', got {final_status!r} "
            f"(classification={classification_json!r})"
        )

        # Stronger guard: the classifier MUST have been invoked.
        # If the bug returns in a different shape (e.g. the helper
        # silently swallows the error), this catches it.
        assert mock_classify.called, (
            "classify_event was never invoked — _capture_frames "
            "short-circuited before reaching the classifier. "
            "Same-file guard regression."
        )
        assert len(classify_calls) == 1, (
            f"expected exactly 1 classifier call, got {len(classify_calls)}"
        )
