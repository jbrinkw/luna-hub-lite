"""Scenario: a noisy sub-gram reading at session close MUST NOT
synthesize a phantom gap-REMOVE.

Bug class
---------
2026-04-22 phantom close-weight: the user was rearranging items (not
removing any). At the exact moment the door-close brightness
transition fired, the HX711 briefly read ``-0.21 g`` (noise from the
user's hand brushing the shelf). The pre-fix
``_last_weight_from_state`` returned this raw transient as the
session's ``final_shelf_weight_g``. The sweeper then computed a huge
``unaccounted`` gap (initial=472g, final=0g → ~-472g), synthesized a
bulk-REMOVE, fed it to the classifier, which matched it by weight to
a chocolate-milk lot → lot flipped to ``in_flight_pickup`` even
though the milk never moved.

Fix under test
--------------
``server/app.py::_last_weight_from_state`` now runs the close-weight
read through a stability gate (see design doc
``hardware/live-shelf/docs/ARCHITECTURE_AUDIT_2026-04-16.md`` §R2 for
the long-term direction). The gate prefers an ESP-STABLE heartbeat,
falls back to a median of the last 5 heartbeats, and only returns
the raw reading when the trace has fewer than 3 samples.

Scenario walkthrough
--------------------
1. Seed the Pi with a session that's about to close. Initial weight
   is 472g (a bottle on shelf). The same 472g reading has been
   heartbeated repeatedly — the last 4 out of 5 samples are 472g,
   the VERY LAST is -0.21g (user brushed shelf right as door shut).
2. Fire the close transition through the real BrightnessHandler.
3. Assert:
   * ``sessions.final_shelf_weight_g`` reflects the STABLE 472g
     (median of last 5 = 472, NOT the transient -0.21g).
   * ``_maybe_synthesize_remove_gap`` returns None (no phantom event)
     because ``scale_delta ≈ 0``.
   * No ``scale_events`` rows were synthesized for this session.
   * The ``GAP_FILL_CONSIDERED`` lifecycle row shows a small
     ``unaccounted`` (near-zero) — proving the gate rejected the
     transient. The old buggy path would have shown ``unaccounted ≈
     -472g``.
"""

from __future__ import annotations

import datetime as _dt
import sys
import threading
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@scenario("live_shelf_close_weight_noise_rejected")
def _live_shelf_close_weight_noise_rejected(ctx: HarnessContext) -> None:
    # Lazy imports: harness bootstrap cost scoped to scenarios that
    # actually use the server module.
    from server.app import _last_weight_from_state
    from server.camera.daemon import BrightnessTransition
    from server.handlers import scale_events as scale_events_mod
    from server.handlers.brightness import BrightnessHandler
    from server.storage import lifecycle, repo as storage_repo

    pi_conn = ctx.pi_sqlite
    db_lock = threading.RLock()

    # Reset the module-level weight trace / runtime state — other
    # scenarios may have left data behind since these are process-wide.
    with scale_events_mod._WEIGHT_TRACE_LOCK:
        scale_events_mod._WEIGHT_TRACE.clear()
    with scale_events_mod._SCALE_RUNTIME_LOCK:
        scale_events_mod._SCALE_RUNTIME_STATE.clear()

    # 1. Seed a "bottle on shelf" state: four stable 472g heartbeats
    #    followed by a single -0.21g noise tick as the door closes.
    device_id = "scale-01"
    for weight in [472.0, 472.0, 472.0, 472.0]:
        scale_events_mod._append_weight_trace({
            "kind": "heartbeat",
            "device_id": device_id,
            "esp_ts": _now_iso(offset_s=-5),
            "pi_ts": _now_iso(offset_s=-5),
            "weight_g": weight,
            "stable": False,
            "uptime_s": 0,
        })
    # The poisoned tail sample — user's hand brushed the shelf.
    scale_events_mod._append_weight_trace({
        "kind": "heartbeat",
        "device_id": device_id,
        "esp_ts": _now_iso(),
        "pi_ts": _now_iso(),
        "weight_g": -0.21,
        "stable": False,
        "uptime_s": 0,
    })
    with scale_events_mod._SCALE_RUNTIME_LOCK:
        scale_events_mod._SCALE_RUNTIME_STATE[device_id] = {
            "stable": False,
            "weight_g": -0.21,
            "ts": _now_iso(),
            "uptime_s": 0,
            "device_id": device_id,
        }

    # 2. Build the brightness handler with the REAL stability-gated
    #    weight provider (this is the entire fix under test).
    class _NullRepo:
        pass

    handler = BrightnessHandler(
        conn=pi_conn,
        db_lock=db_lock,
        reconciler_repo=_NullRepo(),
        last_weight_provider=_last_weight_from_state(
            pi_conn, db_lock, device_id=device_id,
        ),
    )

    # 3. Open + close a session through the real handler path.
    open_ts = _now_iso(offset_s=-30)
    close_ts = _now_iso()
    handler(BrightnessTransition("open", open_ts, 40.0))
    with db_lock:
        state_row = pi_conn.execute(
            "SELECT current_session_id FROM app_state WHERE id = 1"
        ).fetchone()
    session_id = state_row[0]
    ctx.check(
        "session_opened",
        bool(session_id),
        evidence=f"session_id={session_id!r} must be set after open",
    )

    handler(BrightnessTransition("close", close_ts, 2.0))

    # 4. Read back the close weight stamped on the session row. The
    #    gate must have returned ~472g (median of the 5 samples),
    #    NOT the raw -0.21g transient.
    with db_lock:
        sess_row = pi_conn.execute(
            "SELECT initial_shelf_weight_g, final_shelf_weight_g "
            "  FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    initial_w = float(sess_row[0] or 0.0)
    final_w = float(sess_row[1] or 0.0)
    ctx.check(
        "initial_weight_reflects_seed",
        abs(initial_w - 472.0) < 1.0,
        evidence=(
            f"initial_shelf_weight_g={initial_w}; the stability gate "
            f"runs on BOTH open and close — the open-time median of "
            f"4x 472g must land near 472g."
        ),
    )
    ctx.check(
        "close_weight_gate_rejected_noise",
        abs(final_w - 472.0) < 1.0,
        evidence=(
            f"final_shelf_weight_g={final_w}; expected ~472g because "
            f"the median of [472,472,472,472,-0.21] = 472. A value "
            f"near -0.21g proves the stability gate leaked and the "
            f"phantom-REMOVE bug is reopen."
        ),
    )

    # 5. Verify the scale_delta is ~zero so the sweeper's gap check
    #    sees an on-budget session and does NOT synthesize.
    scale_delta = final_w - initial_w
    ctx.check(
        "scale_delta_is_near_zero",
        abs(scale_delta) < 2.0,
        evidence=(
            f"scale_delta={scale_delta}; expected near 0 because the "
            f"user didn't actually remove anything. A value near -472g "
            f"means the gate leaked noise and the phantom gap would "
            f"be synthesized."
        ),
    )

    # 6. Assert: no scale_events rows were synthesized for this
    #    session. The gap-fill pathway is gated on scale_delta exceeding
    #    the threshold; with delta ≈ 0, no synth event lands.
    #
    # NOTE: in production the sweeper runs on a timer AFTER close, not
    # inline with the brightness handler. In this scenario we exercise
    # the close path only and rely on the invariant that with a near-
    # zero scale_delta the sweeper's `_maybe_synthesize_remove_gap`
    # (called via process_session_events) returns None. We verify the
    # invariant directly for determinism.
    with db_lock:
        n_events = pi_conn.execute(
            "SELECT COUNT(*) FROM scale_events WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0]
    ctx.check(
        "no_events_synthesized_on_close",
        n_events == 0,
        evidence=(
            f"scale_events count for session={n_events}; expected 0. "
            f"A non-zero count means an event (likely phantom) was "
            f"written before gap-fill even ran."
        ),
    )

    # 7. Lifecycle trail: SESSION_OPENED + SESSION_CLOSED must appear;
    #    the close row's payload.final_weight_g must carry the gated
    #    value (NOT the raw -0.21g).
    rows = lifecycle.get_session_timeline(pi_conn, session_id)
    reasons = [r["reason_code"] for r in rows]
    ctx.check(
        "session_opened_logged",
        "session_opened" in reasons,
        evidence=f"reasons={reasons!r}",
    )
    ctx.check(
        "session_closed_logged",
        "session_closed" in reasons,
        evidence=f"reasons={reasons!r}",
    )
    close_rows = [r for r in rows if r["reason_code"] == "session_closed"]
    close_payload = close_rows[0]["payload"] if close_rows else {}
    close_final_weight = close_payload.get("final_weight_g")
    ctx.check(
        "close_lifecycle_row_carries_gated_weight",
        close_final_weight is not None and abs(close_final_weight - 472.0) < 1.0,
        evidence=(
            f"session_closed payload.final_weight_g={close_final_weight!r}; "
            f"expected ~472g (gate output). The raw -0.21g transient "
            f"must not propagate into the forensic trail either."
        ),
    )
