"""End-to-end catch-all SECOND-measurement (return-leg) dispatch guard.

Closes the FP-6 coverage hole from the 2026-06-03 deep-audit
TEST-INTEGRITY scorecard. Before this test the entire catch-all
RETURN leg — Branch 2 of ``_dispatch_catch_all_add`` and the
``emit_catch_all_second_measurement`` cloud write it performs — had
ZERO Pi coverage. The audit proved it by corrupting the emit's
``measured_weight_g=measured_g`` argument to ``-99999.0`` and watching
all 769 Pi tests stay GREEN: a nonsensical negative weight could ship
to the cloud on the return measurement and nothing would notice.

This test mirrors ``test_catch_all_dispatch_end_to_end.py`` (the
FIRST-measurement guard) but seeds the picked lot's ``cloud_lots``
mirror with ``in_flight_kind='catch_all'`` + a ``pickup_event_id``
from a prior FIRST event, so the dispatch routes through Branch 2
(SECOND measurement) instead of Branch 4 (FIRST). It drives the FULL
pipeline from event arrival and spies on the REAL
``emit_catch_all_second_measurement`` at the emitter boundary.

The SECOND-measurement branch lives at scale_events.py ~line 2571
(``if in_flight_kind == "catch_all":``) and emits at ~line 2596 with
``measured_weight_g=measured_g`` where ``measured_g = abs(delta_g)``
(line 2401). The load-bearing assertion below pins exactly that:
``measured_weight_g`` must equal ``measured_g`` (a sane POSITIVE value
matching the scale reading). Corrupting the emit arg to ``-99999.0``
(the audit's mutation) flips this test RED two ways at once:

  1. ``emit_catch_all_second_measurement`` rejects ``measured_weight_g
     < 0`` (integration.py:871) → returns None → the dispatch returns
     False → the event never reaches classifier_status='classified'.
  2. Even ignoring (1), the spy records the call kwargs, so the
     ``measured_weight_g == measured_g`` assertion fails directly on
     the ``-99999.0`` value.

Test mechanics match the FIRST-measurement guard exactly:
  * No stub on ``_classify_recorded_event`` /
    ``_apply_lot_update_from_classification`` / ``_dispatch_catch_all_add``
    — those are the layers under test.
  * Anthropic client mocked at the SDK boundary (``classify_event`` /
    ``classify_catch_all_with_fallback``) so the run is hermetic.
  * Pi-local ``cloud_lots`` row seeded so the dispatch's row lookup
    resolves — here with the in-flight catch_all markers set.
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
    """No-op candidate source — ``classify_event`` is patched directly so
    the candidate-pool builder is never invoked."""

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
    return ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


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
    ``cloud_lots`` (NOT the Pi-local ``lots`` table). Setting
    ``in_flight_kind='catch_all'`` + a non-null ``pickup_event_id`` routes
    the dispatch through Branch 2 (SECOND measurement).
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


def test_catch_all_second_measurement_drives_dispatch_through_full_pipeline(
    tmp_path: Path,
):
    """End-to-end guard for the catch-all SECOND-measurement (return) leg.

        handle_scale_event
          → _dispatch_classification
            → _classify_recorded_event
              → _apply_lot_update_from_classification
                → _dispatch_catch_all_add  (Branch 2, scale_events.py ~2571)
                  → emit_catch_all_second_measurement  ← what we spy on

    The picked lot is seeded in-flight on catch-all (a prior FIRST event
    already stamped ``in_flight_kind='catch_all'`` + ``pickup_event_id``),
    so the dispatch takes the SECOND-measurement branch and emits the
    return-leg cloud event.

    Mutation guard (FP-6, audit 2026-06-03): corrupting the emit
    argument ``measured_weight_g=measured_g`` → ``measured_weight_g=
    -99999.0`` at scale_events.py ~line 2599 flips this test RED — the
    final ``measured_weight_g == measured_g`` assertion fails (and the
    emit's own ``< 0`` reject would also drop the event out of
    'classified'). Reverting any of the FIRST-measurement test's three
    upstream layers (dispatch ~3794, apply ~5556, catch-all gate ~2620)
    also flips it RED via the status / call-count assertions.
    """
    conn = init_db(":memory:")

    # FIRST event already happened: seed the Pi-local cloud_lots mirror
    # in the in-flight catch_all state with a pickup_event_id stamp so
    # this incoming event routes through Branch 2 (SECOND measurement).
    target_lot_id = "lot-catch-all-second-001"
    target_product_id = "prod-catch-all-second-001"
    first_event_pi_event_id = "first-evt-001"
    _seed_cloud_lot(
        conn,
        lot_id=target_lot_id,
        product_id=target_product_id,
        qty=2.0,
        in_flight_kind="catch_all",
        pickup_event_id=first_event_pi_event_id,
        in_flight_since="2026-04-27T00:00:00Z",
    )

    # Daemon + ring-buffer setup so frame capture has bytes to copy.
    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    def _stub_classify(event, ctx, *args, **kwargs):
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
            reasoning="second-measurement stub",
            secondary_candidates=tuple(),
            multi_match=tuple(),
            candidate_pool_used=(pool_entry,),
            meta={"attempts": [{"ok": True}], "usage": {}},
        )

    real_emitter = handler._cloud_emitter

    # The incoming SECOND event reads as an ADD (the user sets the
    # partially-consumed container back down) with delta_g = the absolute
    # measured weight; measured_g = abs(delta_g) = 180.0g.
    expected_measured_g = 180.0

    with patch(
        "server.handlers.scale_events.classify_catch_all_with_fallback",
        side_effect=_stub_classify,
    ), patch(
        "server.handlers.scale_events.classify_event",
        side_effect=_stub_classify,
    ), patch.object(
        real_emitter,
        "emit_catch_all_second_measurement",
        wraps=real_emitter.emit_catch_all_second_measurement,
    ) as mock_second, patch.object(
        real_emitter,
        "emit_catch_all_first_measurement",
        wraps=real_emitter.emit_catch_all_first_measurement,
    ) as mock_first:
        resp, status = handler.handle_scale_event({
            "ts": timestamps[15],
            "device_id": "scale-02",
            "event_seq": 2,
            "delta_g": expected_measured_g,
            "before_weight_g": 0.0,
            "after_weight_g": expected_measured_g,
        })
        assert status == 200, resp
        event_id = resp["event_id"]
        assert resp["direction"] == "add", (
            f"event {event_id} routed as direction={resp['direction']}; "
            "the test seeds an ADD (return) event but ingress mis-classified it"
        )

        final_status = _wait_for_classifier_status(conn, event_id)
        assert final_status == "classified", (
            f"catch-all SECOND-measurement event {event_id} ended in "
            f"classifier_status={final_status!r}, expected 'classified'. "
            "The dispatch chain broke before the SECOND-measurement emit "
            "could succeed. If you applied the FP-6 mutation "
            "(measured_weight_g=-99999.0), the emitter's <0 reject "
            "(integration.py:871) returns None and the dispatch leaves the "
            "event pending — that is the regression this test guards."
        )

        # The SECOND-measurement (return-leg) emit MUST have fired, and the
        # FIRST-measurement emit MUST NOT have — the lot was already
        # in-flight on catch-all.
        assert mock_second.call_count == 1, (
            f"emit_catch_all_second_measurement fired {mock_second.call_count} "
            "times; expected exactly 1. The in-flight catch_all lot should "
            "have routed through Branch 2 (scale_events.py ~line 2571)."
        )
        assert mock_first.call_count == 0, (
            f"emit_catch_all_first_measurement fired {mock_first.call_count} "
            "times; expected 0. A lot already in-flight on catch-all must NOT "
            "re-route as a FIRST measurement."
        )

        call_kwargs = mock_second.call_args.kwargs
        # LOAD-BEARING (FP-6): the return-leg weight reported to the cloud
        # MUST equal measured_g = abs(delta_g) — a sane POSITIVE reading.
        # This is the exact line the audit corrupted to -99999.0.
        assert call_kwargs.get("measured_weight_g") == expected_measured_g, (
            "FP-6 mutation guard: emit_catch_all_second_measurement was "
            f"called with measured_weight_g="
            f"{call_kwargs.get('measured_weight_g')!r}, expected "
            f"{expected_measured_g!r} (== measured_g = abs(delta_g)). "
            "scale_events.py ~line 2599 must pass measured_weight_g="
            "measured_g, NOT a corrupted/negative value."
        )
        assert float(call_kwargs.get("measured_weight_g", -1)) > 0, (
            "emit_catch_all_second_measurement reported a non-positive "
            "return-leg weight to the cloud — the scale reading must be "
            "positive."
        )
        # The return leg must reference the FIRST event so the cloud can
        # match the in-flight stamp and compute the consumed delta.
        assert call_kwargs.get("first_event_pi_event_id") == first_event_pi_event_id, (
            "emit_catch_all_second_measurement received "
            f"first_event_pi_event_id="
            f"{call_kwargs.get('first_event_pi_event_id')!r}, expected "
            f"{first_event_pi_event_id!r} (the seeded pickup_event_id)."
        )
        assert call_kwargs.get("product_id") == target_product_id, (
            "emit_catch_all_second_measurement received product_id="
            f"{call_kwargs.get('product_id')!r}, expected "
            f"{target_product_id!r}."
        )
        assert call_kwargs.get("scale_id") == "scale-02", (
            "emit_catch_all_second_measurement received scale_id="
            f"{call_kwargs.get('scale_id')!r}, expected 'scale-02'."
        )
