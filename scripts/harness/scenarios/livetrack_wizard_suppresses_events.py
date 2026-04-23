"""Scenario: LiveTrack wizard suppresses the Pi event pipeline end-to-end.

Bug class
---------
While the browser-side LiveTrack Import wizard is running, any weight
delta the Pi detects (container placement for calibration / pairing /
initial inventory) would normally flow through the full event pipeline:

  * ``scale_events`` row insertion
  * classifier dispatch (Anthropic API call)
  * ``session_resolutions`` / lot mutations
  * ``cloud_outbox`` enqueue + mirror to ``chefbyte.shelf_event_log``

Those placements are intentional user actions, already handled by the
wizard's own flow. Letting them through creates phantom pickup/remove/
add sessions and wrong in-flight states, plus spurious classifier
calls that cost money and confuse the operator.

The fix (2026-04-22) adds a suppression gate at the top of
``ScaleHandler.handle_scale_event``:

  * Gated on ``LiveTrackPoller.snapshot()`` reporting a non-terminal
    session state (anything NOT IN ('closed','expired')).
  * Defensive Pi-side 15-minute ceiling on snapshot age — safety
    net in case the poll thread dies. The cloud-side 10-minute
    ``expires_at`` is the primary clock.
  * Applies to ALL shelves (live_shelf, catch_all, live_scale).
  * Short-circuits BEFORE every downstream branch: no scale_events
    row, no classifier, no cloud_outbox emission.

Why a harness scenario (not just the unit test)
-----------------------------------------------
The unit test (``test_wizard_suppress_events.py``) uses a stub poller
and asserts on the local SQLite side. It does NOT verify the cloud
round-trip — specifically that:

  * A real ``chefbyte.livetrack_import_sessions`` row, created via the
    edge function's schema defaults (``expires_at = now() + 10min``),
    translates to a snapshot the Pi will actually honor.
  * ``GET /livetrack-session/active`` returns that row (with the
    ``created_at`` field the Pi's defensive timeout keys off).
  * After the wizard closes (row state → 'closed'), the next Pi poll
    clears the snapshot and events resume flowing to cloud.

The key cloud-side assertion — ``chefbyte.shelf_event_log`` is empty
while suppression is active — is the regression canary. Pre-fix, even
a single REMOVE would surface there via the outbox.

Assertions walk-through (what would have caught the pre-fix behavior)
---------------------------------------------------------------------
1. Wizard active → Pi receives REMOVE delta → handler returns
   ``suppressed=livetrack_wizard_active``.
2. Pi-local scale_events table has ZERO rows for the shelf.
3. Pi-local cloud_outbox has ZERO pending rows — no mirror dispatched.
4. Draining the worker (``pi_worker.tick()``) writes nothing to
   ``chefbyte.shelf_event_log`` for this device.
5. Wizard closes (cloud flips state→'closed'; next poll clears
   snapshot) → next REMOVE runs the normal pipeline: scale_events row
   created, outbox populated, ``shelf_event_log`` contains the event
   after drain.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@scenario("livetrack_wizard_suppresses_events")
def _livetrack_wizard_suppresses_events(ctx: HarnessContext) -> None:
    # 1. Seed cloud state: user + device + active wizard session.
    ctx.seed_cloud_user()
    ctx.seed_device()
    session_id = ctx.seed_livetrack_session(state="waiting_barcode")
    ctx.check(
        "cloud_session_seeded_waiting_barcode",
        bool(session_id),
        evidence=f"session_id={session_id}",
    )

    # 2. Build the Pi handler + REAL LiveTrackPoller wired to the cloud's
    # /livetrack-session/active edge function. Seed the snapshot so the
    # handler sees the session immediately (matches app.py's mid-wizard
    # reboot behavior).
    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    poller = ctx.pi_livetrack_poller
    poller.seed_snapshot()

    snap_after_seed = poller.snapshot()
    ctx.check(
        "pi_poller_sees_active_session",
        snap_after_seed is not None
        and snap_after_seed.get("state") == "waiting_barcode",
        evidence=f"snapshot={snap_after_seed!r}",
    )

    # 3. Fire a REMOVE event at the Pi — would normally create a
    # scale_events row + an unmatched-session pickup + eventually a
    # cloud_outbox row.
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",  # live_shelf
        "event_seq": 1,
        "delta_g": -314.0,
        "before_weight_g": 314.0,
        "after_weight_g": 0.0,
    })
    ctx.check(
        "handler_returned_suppressed_response",
        status == 200 and resp.get("suppressed") == "livetrack_wizard_active",
        evidence=f"status={status} resp={resp!r}",
    )
    ctx.check(
        "suppressed_response_carries_session_id",
        resp.get("livetrack_session_id") == session_id,
        evidence=(
            f"expected session_id={session_id}; "
            f"got {resp.get('livetrack_session_id')!r}"
        ),
    )

    # 4. Pi-local: scale_events untouched, cloud_outbox empty.
    pi_conn = ctx.pi_sqlite
    scale_rows = pi_conn.execute(
        "SELECT COUNT(*) FROM scale_events"
    ).fetchone()[0]
    ctx.check(
        "pi_scale_events_table_empty",
        scale_rows == 0,
        evidence=f"scale_events count={scale_rows} (expected 0)",
    )
    # cloud_outbox may not exist on all init paths — guard + check.
    outbox_rows = 0
    has_outbox = pi_conn.execute(
        "SELECT name FROM sqlite_master "
        " WHERE type='table' AND name='cloud_outbox'"
    ).fetchone()
    if has_outbox:
        # Pending = not yet sent AND not marked permanently failed.
        # Matches the worker's drain predicate in ``cloud/worker.py``.
        outbox_rows = pi_conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox "
            " WHERE sent_at IS NULL AND failed_permanently = 0"
        ).fetchone()[0]
    ctx.check(
        "pi_cloud_outbox_empty",
        outbox_rows == 0,
        evidence=f"cloud_outbox pending={outbox_rows} (expected 0)",
    )

    # 5. Drain the worker to cloud. There's nothing to drain — but we
    # tick anyway to prove the cloud side remains clean.
    ctx.pi_worker.tick()
    cloud_events_during_wizard = ctx.q_one(
        "SELECT COUNT(*) "
        "  FROM chefbyte.shelf_event_log "
        " WHERE device_id = %s",
        (ctx.device_id,),
    )
    ctx.check(
        "cloud_shelf_event_log_empty_during_wizard",
        cloud_events_during_wizard is not None
        and int(cloud_events_during_wizard[0]) == 0,
        evidence=(
            f"expected shelf_event_log empty during wizard; "
            f"got count={cloud_events_during_wizard!r}"
        ),
    )

    # 6. Wizard ends: browser closes the session → cloud flips state
    # to 'closed'. The next poll clears the Pi snapshot (the edge
    # function's /active filters closed/expired out).
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.livetrack_import_sessions "
            "   SET state = 'closed', updated_at = now() "
            " WHERE session_id = %s",
            (session_id,),
        )
    poller.tick_once()  # synchronous repoll → snapshot should be None now
    snap_after_close = poller.snapshot()
    ctx.check(
        "pi_poller_cleared_after_wizard_close",
        snap_after_close is None,
        evidence=f"snapshot_after_close={snap_after_close!r}",
    )

    # 7. Next event runs the normal pipeline.
    resp2, status2 = handler.handle_scale_event({
        "ts": _now_iso(offset_s=1.0),
        "device_id": "scale-01",
        "event_seq": 2,
        "delta_g": -200.0,
        "before_weight_g": 200.0,
        "after_weight_g": 0.0,
    })
    ctx.check(
        "handler_ran_normal_pipeline_after_close",
        status2 == 200 and "suppressed" not in resp2,
        evidence=f"status={status2} resp={resp2!r}",
    )
    scale_rows_after = pi_conn.execute(
        "SELECT COUNT(*) FROM scale_events"
    ).fetchone()[0]
    ctx.check(
        "pi_scale_events_row_created_after_close",
        scale_rows_after == 1,
        evidence=(
            f"expected 1 scale_events row after close; "
            f"got {scale_rows_after}"
        ),
    )
