"""End-to-end catch-all dispatch — proves the classifier dispatch ACTUALLY
runs in production, not just when invoked directly via a helper.

Bug history (2026-04-27):
   ``test_catch_all_empty_container.py`` ships 8 PASSING tests that
   exercise ``ScaleHandler._apply_lot_update_from_classification`` by
   invoking it directly. That helper is only the *innermost* of the
   catch-all dispatch chain:

       handle_scale_event
         → _dispatch_classification     (worker thread)
           → _classify_recorded_event   (frames + Anthropic call)
             → _apply_lot_update_from_classification
               → _dispatch_catch_all_add  (cloud emit + branch logic)

   The pre-existing tests skipped EVERY upper layer by calling the leaf
   directly — meaning they would still pass even if
   ``_classify_recorded_event`` never fired ``_apply_lot_update_from_
   classification`` at all (e.g. an exception caught + swallowed in the
   classifier wrapper, a routing bug that diverted catch_all events to
   the legacy live_shelf path, or a regression that broke the synthetic-
   session dispatch). This test closes that gap by driving the FULL
   pipeline starting from event arrival, with no mocks above the
   Anthropic SDK boundary.

Mutation guard (mutation discipline):
   Three load-bearing production lines are pinned:

   (1) ``scale_events.py`` ~line 3794 — the inline
       ``self._dispatch_classification(event_id, synthetic_session)``
       call inside ``handle_scale_event``'s catch-all branch. Removing
       this leaves the event at status='pending' forever (no worker
       thread is ever spawned).

   (2) ``scale_events.py`` ~line 5556 — ``_classify_recorded_event``'s
       call to ``_apply_lot_update_from_classification`` inside the
       successful-classification branch. Removing it skips the apply
       path entirely.

   (3) ``scale_events.py`` ~line 2620 — ``_apply_lot_update_from_
       classification``'s shelf-id gate that dispatches catch-all
       events to ``_dispatch_catch_all_add``. Reverting this gate
       routes catch-all events through the legacy live_shelf code
       and the catch-all-specific cloud emits never fire.

   Any of those three reversions MUST flip this test red. The
   per-assertion docstrings call out which production line each
   defends.

Test mechanics:
   * No stub on ``_classify_recorded_event`` or
     ``_apply_lot_update_from_classification`` — those are the
     layers under test.
   * No stub on ``_dispatch_catch_all_add`` — that's also under
     test.
   * Anthropic client mocked at the SDK boundary (the only real
     external dependency) so the test is hermetic and deterministic.
   * Pi-local ``cloud_lots`` row seeded so the catch-all dispatch's
     row lookup resolves cleanly.
   * The classifier itself is monkey-patched at the
     ``classify_event`` boundary (just below
     ``_classify_recorded_event``'s try/except) so we don't depend
     on the candidate-pool builder's invariants. The wrapper around
     it preserves the exact return-shape the production code reads
     from.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from unittest.mock import patch

import cv2  # noqa: F401  (cv2 import keeps numpy linked for ring frames)
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
    """No-op candidate source — we patch ``classify_event`` directly so
    the candidate pool builder is never invoked. This is the same
    pattern used by all the other ScaleHandler tests."""

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
    conn: sqlite3.Connection, *, lot_id: str, product_id: str, qty: float = 1.0,
    in_flight_kind: Optional[str] = None,
    pickup_event_id: Optional[str] = None,
    in_flight_since: Optional[str] = None,
):
    """Seed a Pi-local ``cloud_lots`` row + matching ``products`` row.

    The catch-all dispatch resolves the classifier-picked id against
    ``cloud_lots`` (NOT the Pi-local ``lots`` table) — that's the
    table the cloud-poller writes mirror rows to. The dispatch refuses
    to emit if the picked lot has no cloud_lots row.
    """
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lot_id, product_id, qty,
                in_flight_kind, pickup_event_id, in_flight_since,
                "2026-04-27T00:00:00Z", "2026-04-27T00:00:00Z",
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
        classifier_client=None,  # not consulted — classify_event is patched
        catch_all_enabled=True,
        shelf_registry_override=registry,
        catch_all_camera=catch_all_camera,
        catch_all_photo_delay_s=0.0,
        cloud_emitter=CloudEventEmitter(conn, enabled=True),
    )


def _wait_for_classifier_status(
    conn: sqlite3.Connection, event_id: str, *,
    timeout_s: float = 8.0,
) -> str:
    """Poll the classifier_status column until it leaves the
    in-flight states ('pending', 'classifying'). The dispatch is
    fire-and-forget on a worker thread, so we busy-poll rather than
    racing the test against the worker's wallclock. Generous
    timeout for the Anthropic-shaped wrapper code path.
    """
    deadline = time.monotonic() + timeout_s
    last_status: Any = None
    while time.monotonic() < deadline:
        row = conn.execute(
            "SELECT classifier_status FROM scale_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if row is not None:
            last_status = row[0]
            if last_status in ("classified", "review", "failed"):
                return last_status
        time.sleep(0.05)
    pytest.fail(
        f"classifier never finished for event_id={event_id}; "
        f"last status = {last_status!r} (expected classified/review/failed)"
    )


def test_catch_all_event_drives_dispatch_through_full_pipeline(tmp_path: Path):
    """End-to-end mutation guard for the THREE production layers that
    must run for a catch-all event to land its cloud emit:

        handle_scale_event
          → _dispatch_classification           (LAYER 1 — production line ~3794)
            → _classify_recorded_event         (LAYER 2 — production line ~5556)
              → _apply_lot_update_from_classification
                → _dispatch_catch_all_add      (LAYER 3 — production line ~2620)
                  → emit_catch_all_first_measurement   ← what we spy on

    The pre-fix world (commit 65722f3 onward) had a bug where layer 1
    (the inline dispatch from handle_scale_event for catch-all events)
    didn't fire — events sat at classifier_status='pending' forever.
    The 8 tests in test_catch_all_empty_container.py couldn't have
    caught this because they invoked the LEAF helper directly,
    bypassing layers 1 and 2 entirely.

    Mutation discipline:
      * Comment out the ``_dispatch_classification`` call at line ~3794
        → ``_wait_for_classifier_status`` times out and the test fails.
      * Comment out the ``_apply_lot_update_from_classification`` call
        at line ~5556 → ``mock_emit.call_count == 0`` and the test fails
        with the descriptive message about layer 2.
      * Revert the catch-all gate at line ~2620 (set ``handled = False``
        unconditionally) → ``mock_emit.call_count == 0`` and the test
        fails with the descriptive message about layer 3.
    """
    conn = init_db(":memory:")

    # Seed the Pi-local cloud_lots mirror so the catch-all dispatch's
    # row lookup resolves. No prior in_flight session → FIRST
    # measurement branch should fire.
    target_lot_id = "lot-catch-all-target-001"
    target_product_id = "prod-catch-all-target-001"
    _seed_cloud_lot(conn, lot_id=target_lot_id, product_id=target_product_id, qty=2.0)

    # Daemon + ring-buffer setup so frame capture has bytes to copy.
    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    # Patch the classifier at the SDK boundary so we don't need the
    # candidate-pool builder or a real Anthropic key. Everything
    # downstream of the classifier (apply path, dispatch, cloud emit)
    # runs unmodified — that's what we're testing. Catch-all ADDs
    # route through ``classify_catch_all_with_fallback`` (the
    # two-pass orchestrator); we patch both names so a future revert
    # to the single-pass routing keeps this test green.
    from server.classifier.models import ScaleEvent as _SE  # noqa: F401

    def _stub_classify(event, ctx, *args, **kwargs):
        # Build a ClassificationResult — the production code reads
        # ``item_id``, ``confidence``, ``meta``, ``candidate_pool_used``,
        # and ``multi_match`` from this. We supply a high-confidence
        # pick that includes the target lot in the candidate pool so
        # the hallucination guard accepts it. ``*args, **kwargs`` covers
        # the orchestrator's ``model=`` keyword while still accepting
        # the legacy ``classify_event(event, ctx)`` signature.
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
            reasoning="end-to-end stub",
            secondary_candidates=tuple(),
            multi_match=tuple(),
            candidate_pool_used=(pool_entry,),
            meta={"attempts": [{"ok": True}], "usage": {}},
        )

    real_emitter = handler._cloud_emitter

    # Audit C-MED-5 (2026-05-04): the ``_capture_frames`` passthrough
    # patch was added to bypass a same-file copy bug — the production
    # helper called ``shutil.copyfile`` with src == dst when the
    # catch-all fast-path had already written the frame to the event
    # dir. That bug was fixed in scale_events.py:1186 (resolve()-
    # equality short-circuit) and pinned by
    # test_catch_all_classifier_runs_on_self_copy_path.py. The
    # passthrough is now dead — removing it lets the REAL
    # ``_capture_frames`` run, which is what production does and what
    # the end-to-end mutation guards should pin.

    with patch(
        "server.handlers.scale_events.classify_catch_all_with_fallback",
        side_effect=_stub_classify,
    ), patch(
        "server.handlers.scale_events.classify_event",
        side_effect=_stub_classify,
    ), patch.object(
        real_emitter,
        "emit_catch_all_first_measurement",
        wraps=real_emitter.emit_catch_all_first_measurement,
    ) as mock_emit:
        # Drive the full pipeline starting at event arrival on
        # scale-02 (the catch-all device id). No layer below this is
        # mocked.
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
        assert resp["direction"] == "add", (
            f"event {event_id} routed as direction={resp['direction']}; "
            "the test seeds an ADD event but ingress mis-classified it"
        )

        # LAYER 1 + 2 (combined) — the worker thread must finish.
        # If layer 1 was reverted, this hangs and times out with the
        # status='pending' message — the test fails clearly.
        final_status = _wait_for_classifier_status(conn, event_id)

        assert final_status == "classified", (
            f"LAYER 1 + LAYER 2 mutation guard: catch-all event "
            f"{event_id} ended in classifier_status={final_status!r}, "
            "expected 'classified'. The classifier dispatch chain is "
            "broken upstream of the apply path. Inspect:\n"
            "  scale_events.py ~line 3794 — handle_scale_event's inline\n"
            "  ``self._dispatch_classification(event_id, synthetic_session)``\n"
            "  call. If commented out, no worker thread is ever spawned\n"
            "  for catch-all events."
        )

        # LAYER 3 — the catch-all dispatch fired and routed this as a
        # FIRST measurement (no prior in-flight session for this lot).
        # Reverting the catch-all branch in
        # ``_apply_lot_update_from_classification`` (line ~2620)
        # — by commenting out the ``handled = self._dispatch_catch_all_add(...)``
        # call so the event falls through to the legacy live_shelf
        # path — drops this count to 0.
        assert mock_emit.call_count == 1, (
            f"LAYER 3 mutation guard: emit_catch_all_first_measurement "
            f"was called {mock_emit.call_count} times; expected exactly "
            "1. The catch-all dispatch in "
            "_apply_lot_update_from_classification never reached the "
            "cloud emit. Possible mutations:\n"
            "  (a) shelf_id routing is broken (event landed on the "
            "      live_shelf path despite scale-02 device_id), OR\n"
            "  (b) the inline _dispatch_catch_all_add invocation in\n"
            "      scale_events.py ~line 2620 was removed, OR\n"
            "  (c) _dispatch_catch_all_add returned False so the\n"
            "      caller fell through to the legacy mint path."
        )

        # Bonus: assert the emit's payload is shaped correctly so a
        # mutation that passes wrong args is also caught.
        call_kwargs = mock_emit.call_args.kwargs
        assert call_kwargs.get("product_id") == target_product_id, (
            f"emit_catch_all_first_measurement received product_id="
            f"{call_kwargs.get('product_id')!r}, expected "
            f"{target_product_id!r}. The dispatch resolved a different "
            "lot than the classifier picked — likely a bug in the "
            "cloud_lots lookup at line ~2126."
        )
        assert call_kwargs.get("scale_id") == "scale-02", (
            f"emit_catch_all_first_measurement received scale_id="
            f"{call_kwargs.get('scale_id')!r}, expected 'scale-02'. "
            "The shelf_id → scale_id mapping in _scale_id_for_shelf "
            "is broken."
        )
        # measured_weight_g must be > 0 — the dispatch rejects
        # non-positive weights with a fall-through warning.
        assert float(call_kwargs.get("measured_weight_g", 0)) > 0, (
            "emit_catch_all_first_measurement called with non-positive "
            "measured_weight_g — the dispatch should have fallen through."
        )
