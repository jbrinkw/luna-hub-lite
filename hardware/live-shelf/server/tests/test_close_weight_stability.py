"""Close-weight stability gate tests (bug fix 2026-04-22).

Regression context
------------------
The user was rearranging items on the shelf — nothing was removed.
The scale briefly read ``-0.21 g`` (noise from the user's hand brushing
the shelf) at the exact moment the door-close brightness transition
fired. The old ``_last_weight_from_state`` returned this transient as
the session's ``final_weight``, which made
``_maybe_synthesize_remove_gap`` compute a ~472 g ``unaccounted`` gap
against the session's ``initial_shelf_weight_g``. The sweeper then
synthesized a phantom bulk-REMOVE event; the classifier matched it to
a chocolate-milk lot by weight similarity; the lot flipped to
``in_flight_pickup`` cloud-side. The milk never moved.

Fix under test
--------------
``server/app.py::_last_weight_from_state`` now runs the raw reading
through a stability gate:

  1. If the ESP has reported ``stable=true`` on its most recent fresh
     heartbeat, use that weight directly.
  2. Otherwise, pull the last N heartbeat samples from
     :func:`server.handlers.scale_events.get_weight_trace` and return
     the median. A single noisy sample (one ``-0.2 g`` reading in a
     sea of ``472 g`` readings) is outvoted by 4/5 consistent samples.
  3. If fewer than 3 heartbeat samples are available (fresh boot, ESP
     down), fall back to the legacy ``app_state.last_scale_weight_g``
     with a WARNING log so session close never hangs.

Also covered here: the gap-fill-skipped reason label now distinguishes
``positive_gap_not_supported`` (items added without stability —
impossible to synthesize an ADD) from ``below_threshold`` (noise
floor). Session ``d76783e6`` from the same incident had a +622 g
unaccounted-but-mislabeled-as-"below_threshold" row which made the
forensic reason confusing.
"""

from __future__ import annotations

import threading

import pytest

from server.app import _last_weight_from_state
from server.handlers import scale_events as scale_events_mod
from server.storage import init_db, repo as storage_repo
from server.storage.models import AppStatePatch


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn():
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def lock():
    return threading.RLock()


@pytest.fixture(autouse=True)
def _clear_runtime_state():
    """Reset the module-level weight trace + runtime state between tests.

    These are process-global by design (heartbeat cadence is high, we
    don't want a sqlite write per tick). Without a reset, samples from
    one test bleed into the next.
    """
    with scale_events_mod._WEIGHT_TRACE_LOCK:
        scale_events_mod._WEIGHT_TRACE.clear()
    with scale_events_mod._SCALE_RUNTIME_LOCK:
        scale_events_mod._SCALE_RUNTIME_STATE.clear()
    yield
    with scale_events_mod._WEIGHT_TRACE_LOCK:
        scale_events_mod._WEIGHT_TRACE.clear()
    with scale_events_mod._SCALE_RUNTIME_LOCK:
        scale_events_mod._SCALE_RUNTIME_STATE.clear()


# ---------------------------------------------------------------------------
# Helpers — push synthetic heartbeats into the trace + runtime state.
# ---------------------------------------------------------------------------


def _push_heartbeat(
    device_id: str,
    weight_g: float,
    *,
    stable: bool = False,
    esp_ts: str = "2026-04-22T00:00:00.000Z",
) -> None:
    """Append one heartbeat sample the same way handle_heartbeat does.

    We don't call handle_heartbeat itself because it would require a full
    ScaleHandler instance + app_state write; the stability gate only
    reads ``_WEIGHT_TRACE`` + ``_SCALE_RUNTIME_STATE`` so we seed both
    directly. This mirrors production shape exactly (see handle_heartbeat
    at scale_events.py:4257).
    """
    scale_events_mod._append_weight_trace({
        "kind": "heartbeat",
        "device_id": device_id,
        "esp_ts": esp_ts,
        "pi_ts": esp_ts,
        "weight_g": float(weight_g),
        "stable": stable,
        "uptime_s": 0,
    })
    with scale_events_mod._SCALE_RUNTIME_LOCK:
        from datetime import datetime, timezone
        fresh_ts = datetime.now(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        scale_events_mod._SCALE_RUNTIME_STATE[device_id] = {
            "stable": stable,
            "weight_g": float(weight_g),
            "ts": fresh_ts,
            "uptime_s": 0,
            "device_id": device_id,
        }


# ---------------------------------------------------------------------------
# 1. Median rejects a single noisy sample at session close.
# ---------------------------------------------------------------------------


def test_median_rejects_single_noise_sample_at_session_close(conn, lock):
    """Regression: one ``-0.2 g`` transient among four ``472 g`` samples
    must NOT become the close weight. The median pulls the phantom
    sample out and the gate returns 472 g.
    """
    # Simulate a shelf holding 472 g; the user brushes the shelf right
    # before the close transition, producing a single -0.21 g sample
    # in-between stable readings. Order matters — the noise sample is
    # the MOST RECENT one, which is what the naive last-reading path
    # would pick up.
    for w in [472.0, 472.0, 472.0, 472.0, -0.21]:
        _push_heartbeat("scale-01", w, stable=False)
    getter = _last_weight_from_state(conn, lock, device_id="scale-01")

    weight = getter()

    # The naive impl would return -0.21. The fixed impl returns the
    # median of [472, 472, 472, 472, -0.21] = 472.
    assert weight == pytest.approx(472.0), (
        f"stability gate leaked a transient: got {weight!r}; the naive "
        f"path would return -0.21 (the last sample). Median of the "
        f"5-sample window must outvote the single noise sample."
    )


# ---------------------------------------------------------------------------
# 2. Median correctly tracks a real descending removal.
# ---------------------------------------------------------------------------


def test_median_tracks_genuine_removal(conn, lock):
    """Counterpart to the above: when the user ACTUALLY removes
    everything, the median must follow the descent and produce 0.
    """
    # Removal trajectory: shelf holds 472g, then user picks it up over
    # ~2s (the HX711 settles toward zero). At session close, the last
    # 5 heartbeat samples look like [200, 0, 0, 0, 0].
    for w in [472.0, 472.0, 400.0, 200.0, 0.0, 0.0, 0.0]:
        _push_heartbeat("scale-01", w, stable=False)
    getter = _last_weight_from_state(conn, lock, device_id="scale-01")

    weight = getter()

    # Last 5 samples = [400, 200, 0, 0, 0] → median = 0.0 (middle of
    # sorted [0, 0, 0, 200, 400]). A real removal is preserved.
    assert weight == pytest.approx(0.0), (
        f"stability gate swallowed a real removal: got {weight!r}; "
        f"median of last 5 should be 0 so gap-fill can synthesize."
    )


# ---------------------------------------------------------------------------
# 3. ESP-reported STABLE weight wins over median.
# ---------------------------------------------------------------------------


def test_stable_flag_bypasses_median(conn, lock):
    """When the ESP has declared the scale stable on its most recent
    fresh heartbeat, we trust that reading directly rather than
    smoothing. The scale's own stability algorithm is more authoritative
    than any window we'd pick on the Pi side.
    """
    # Trace has some noise; the last heartbeat is ESP-STABLE at 400g.
    for w in [472.0, 472.0, -0.5, 472.0]:
        _push_heartbeat("scale-01", w, stable=False)
    # The final, most-recent heartbeat — ESP says "stable at 400g".
    _push_heartbeat("scale-01", 400.0, stable=True)

    getter = _last_weight_from_state(conn, lock, device_id="scale-01")
    weight = getter()

    assert weight == pytest.approx(400.0), (
        f"stable-flag path ignored: got {weight!r}; when ESP reports "
        f"stable=true we must return its weight directly, not the "
        f"median of historical samples."
    )


# ---------------------------------------------------------------------------
# 4. Fallback when the trace has fewer than 3 samples.
# ---------------------------------------------------------------------------


def test_fallback_to_app_state_when_trace_is_empty(conn, lock):
    """Fresh boot / tests that don't push heartbeats → no trace data.
    The gate must fall back to ``app_state.last_scale_weight_g`` rather
    than hang or return a nonsense 0.
    """
    # Seed app_state with a known weight — this is the legacy behavior
    # we want preserved as a safety net.
    with lock:
        storage_repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=123.45),
        )

    getter = _last_weight_from_state(conn, lock, device_id="scale-01")
    weight = getter()

    assert weight == pytest.approx(123.45), (
        f"fallback path broken: got {weight!r}; with an empty trace "
        f"the gate must return app_state.last_scale_weight_g=123.45"
    )


def test_fallback_when_only_two_samples_available(conn, lock):
    """Two samples is below the median minimum (3). Must still degrade
    gracefully to app_state rather than compute a meaningless "median".
    """
    _push_heartbeat("scale-01", 500.0, stable=False)
    _push_heartbeat("scale-01", 500.0, stable=False)
    with lock:
        storage_repo.update_app_state(
            conn, AppStatePatch(last_scale_weight_g=999.99),
        )

    getter = _last_weight_from_state(conn, lock, device_id="scale-01")
    weight = getter()

    # With only 2 heartbeats the median minimum isn't met — fallback to
    # app_state which was seeded to 999.99 distinguishes "fell through
    # to fallback path" from "returned 500 from the two samples".
    assert weight == pytest.approx(999.99), (
        f"short-trace fallback broken: got {weight!r}; with only 2 "
        f"samples we must NOT compute a median; must use app_state."
    )


# ---------------------------------------------------------------------------
# 5. Gap-fill log label: positive vs below-threshold.
# ---------------------------------------------------------------------------


def test_gap_fill_positive_gap_uses_new_reason_label(conn, lock, tmp_path):
    """Session ``d76783e6`` had a +622g unaccounted gap (items
    physically added without ESP stability) and the old code labeled
    it ``below_threshold`` — which was misleading since the magnitude
    was well ABOVE the threshold; the real reason was "synthesizer
    can't produce ADD events."

    Fix: distinct reason strings.
      * ``positive_gap_not_supported`` — gap is positive and > threshold.
      * ``below_threshold`` — gap magnitude < threshold (true noise floor).
    """
    # We drive _maybe_synthesize_remove_gap indirectly by seeding a
    # closed session with an intentionally-positive unaccounted gap.
    from server.camera.daemon import CameraDaemon  # type: ignore
    from server.handlers.scale_events import ScaleHandler

    # Minimal stub candidate source — the gap-fill path doesn't read
    # candidates (the synthetic event is classified later).
    class _NullSrc:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, _):
            return []

        def get_certified_not_on_shelf(self):
            return []

    handler = ScaleHandler(
        conn=conn,
        db_lock=lock,
        camera=None,  # type: ignore[arg-type]
        candidate_source=_NullSrc(),
        events_root=tmp_path / "events",
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=False,
    )

    # Seed a closed session with initial=100g, final=722g → +622g gap,
    # no stability events during the session → all unaccounted.
    open_ts = "2026-04-22T00:00:00.000Z"
    close_ts = "2026-04-22T00:01:00.000Z"
    session_id = storage_repo.open_session(
        conn, open_ts, initial_weight_g=100.0,
    ).session_id
    storage_repo.close_session(conn, session_id, close_ts, 722.0)

    # Drive the gap-fill consideration. The helper resolves session_id
    # from open_ts; the first positional arg is the camera-session
    # dict (unused by this codepath but required by signature).
    result = handler._maybe_synthesize_remove_gap(
        {"open_ts": open_ts, "close_ts": close_ts}, open_ts, close_ts,
    )
    assert result is None

    # Read the skip row's payload.reason.
    from server.storage import lifecycle
    rows = lifecycle.get_session_timeline(conn, session_id)
    skipped = [r for r in rows if r["reason_code"] == "gap_fill_skipped"]
    assert skipped, "expected a gap_fill_skipped lifecycle row"

    reasons = [r["payload"].get("reason") for r in skipped]
    assert "positive_gap_not_supported" in reasons, (
        f"expected the NEW reason label 'positive_gap_not_supported' "
        f"for a +622g unaccounted gap; got {reasons!r}. The label "
        f"must distinguish 'positive gap (can't synthesize ADD)' from "
        f"'negative gap below threshold (noise floor)'."
    )
    # Defence-in-depth: the old label must NOT appear for a positive
    # gap.
    assert "below_threshold" not in reasons, (
        f"positive-gap skip leaked the old below_threshold label: "
        f"{reasons!r}. Forensic logs need distinct reasons."
    )


def test_gap_fill_below_threshold_still_uses_below_threshold_label(
    conn, lock, tmp_path,
):
    """The rename is surgical — a genuinely-below-threshold negative
    gap must still use the old label so existing dashboards/alerts
    that grep for ``below_threshold`` keep working.
    """
    from server.handlers.scale_events import ScaleHandler

    class _NullSrc:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, _):
            return []

        def get_certified_not_on_shelf(self):
            return []

    handler = ScaleHandler(
        conn=conn,
        db_lock=lock,
        camera=None,  # type: ignore[arg-type]
        candidate_source=_NullSrc(),
        events_root=tmp_path / "events",
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=False,
    )

    # -1g gap (below the 20g GAP_REMOVE_MIN_G threshold → noise floor).
    open_ts = "2026-04-22T00:00:00.000Z"
    close_ts = "2026-04-22T00:01:00.000Z"
    session_id = storage_repo.open_session(
        conn, open_ts, initial_weight_g=500.0,
    ).session_id
    storage_repo.close_session(conn, session_id, close_ts, 499.0)

    result = handler._maybe_synthesize_remove_gap(
        {"open_ts": open_ts, "close_ts": close_ts}, open_ts, close_ts,
    )
    assert result is None

    from server.storage import lifecycle
    rows = lifecycle.get_session_timeline(conn, session_id)
    skipped = [r for r in rows if r["reason_code"] == "gap_fill_skipped"]
    assert skipped

    reasons = [r["payload"].get("reason") for r in skipped]
    assert "below_threshold" in reasons, (
        f"expected the preserved 'below_threshold' label for a -1g gap; "
        f"got {reasons!r}. The rename is only for POSITIVE gaps."
    )
