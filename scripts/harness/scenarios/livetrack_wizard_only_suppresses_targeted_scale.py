"""Scenario: LiveTrack wizard suppresses ONLY the targeted scale.

Bug class
---------
Pre-2026-04-27 the wizard-suppression gate keyed on "is ANY active
livetrack_import_sessions row present for this user?". That meant
calibrating scale-03 (live_scale) on the catch-all wizard would freeze
unrelated scale-01 (live_shelf) events for up to 10 minutes — every
fridge-shelf placement during the calibration would be silently dropped
from cloud's chefbyte.shelf_event_log.

The fix scopes suppression to the (device_id, scale_id) tuple the
wizard is targeting. The Pi caches active sessions per-tuple via
:class:`LiveTrackPoller` and the gate predicate
(:meth:`ScaleHandler._is_wizard_active_for`) only matches incoming
events whose scale_id is in the active set.

What this scenario asserts
--------------------------
Two-act regression test against the real cloud + Pi stack.

Act 1: wizard targets scale-03; event from scale-01 lands.
  * Seed cloud: livetrack_import_sessions row with scale_id='scale-03'.
  * Pi pollers seed-snapshot.
  * Fire a normal live_shelf event from scale-01.
  * Assert handler did NOT suppress (no `suppressed` sentinel).
  * Assert Pi-local scale_events row was created.

Act 2: close that wizard, open one targeting scale-01.
  * Cloud flips scale-03 session to closed; opens new session for
    scale-01.
  * Pi tick_once resyncs.
  * Fire a live_shelf event from scale-01.
  * Assert handler DID suppress this time.
  * Assert no new scale_events row.

Why a harness scenario in addition to the unit test
---------------------------------------------------
The unit test (``test_livetrack_per_scale_scope.py``) drives the gate
predicate with a stub poller. It does NOT exercise:

  * The actual Postgres schema (the new ``scale_id`` column, the new
    partial index, RLS).
  * The edge function's ``/active?scale_id=`` route returning the
    correct subset of sessions.
  * The :class:`CloudClient.get_active_livetrack_sessions` body-shape
    parsing path (legacy ``{ session }`` vs new ``{ sessions: [...] }``).

This scenario walks the full vertical so a regression at any layer
turns the assertions red.
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


@scenario("livetrack_wizard_only_suppresses_targeted_scale")
def _livetrack_wizard_only_suppresses_targeted_scale(ctx: HarnessContext) -> None:
    # 1. Cloud + Pi setup.
    ctx.seed_cloud_user()
    ctx.seed_device()

    # Open a wizard session targeting scale-03 (the live_scale). Use a
    # raw INSERT with the new scale_id column; the orchestrator helper
    # didn't accept scale_id pre-2026-04-27, so we stamp it directly.
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chefbyte.livetrack_import_sessions
                (user_id, device_id, scale_id, state)
            VALUES (%s, %s, 'scale-03', 'waiting_barcode')
            RETURNING session_id
            """,
            (ctx.user_id, ctx.device_id),
        )
        scale03_session_id = str(cur.fetchone()[0])

    ctx.check(
        "cloud_session_seeded_for_scale_03",
        bool(scale03_session_id),
        evidence=f"session_id={scale03_session_id}",
    )

    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    poller = ctx.pi_livetrack_poller
    poller.seed_snapshot()

    # The poller should have cached the (device_id_uuid, scale-03) tuple.
    active_scales = poller.active_scale_ids()
    ctx.check(
        "pi_poller_sees_scale_03_active",
        "scale-03" in active_scales,
        evidence=f"active_scale_ids={active_scales}",
    )
    ctx.check(
        "pi_poller_does_not_see_scale_01_active",
        "scale-01" not in active_scales,
        evidence=f"active_scale_ids={active_scales}",
    )

    # 2. Act 1: fire a live_shelf event from scale-01 — must NOT suppress.
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",  # ESP id == scale_id for live_shelf
        "scale_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })
    ctx.check(
        "scale_01_event_not_suppressed_during_scale_03_wizard",
        status == 200 and "suppressed" not in resp,
        evidence=(
            f"status={status} resp={resp!r} "
            f"(suppression should be scoped to scale-03 only)"
        ),
    )

    # The normal pipeline ran for the scale-01 event.
    pi_conn = ctx.pi_sqlite
    scale_rows = pi_conn.execute(
        "SELECT COUNT(*) FROM scale_events"
    ).fetchone()[0]
    ctx.check(
        "scale_events_row_created_for_unrelated_scale",
        scale_rows == 1,
        evidence=(
            f"expected 1 scale_events row from the unrelated scale-01 "
            f"event; got {scale_rows}"
        ),
    )

    # 3. Act 2: close the scale-03 wizard, open one targeting scale-01.
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.livetrack_import_sessions "
            "   SET state='closed', updated_at=now() "
            " WHERE session_id=%s",
            (scale03_session_id,),
        )
        cur.execute(
            """
            INSERT INTO chefbyte.livetrack_import_sessions
                (user_id, device_id, scale_id, state)
            VALUES (%s, %s, 'scale-01', 'waiting_barcode')
            RETURNING session_id
            """,
            (ctx.user_id, ctx.device_id),
        )
        scale01_session_id = str(cur.fetchone()[0])

    poller.tick_once()
    active_scales_2 = poller.active_scale_ids()
    ctx.check(
        "pi_poller_sees_scale_01_active_after_swap",
        "scale-01" in active_scales_2 and "scale-03" not in active_scales_2,
        evidence=f"active_scale_ids={active_scales_2}",
    )

    # Fire another scale-01 event — this time it MUST be suppressed.
    resp2, status2 = handler.handle_scale_event({
        "ts": _now_iso(offset_s=1.0),
        "device_id": "scale-01",
        "scale_id": "scale-01",
        "event_seq": 2,
        "delta_g": -100.0,
        "before_weight_g": 314.0,
        "after_weight_g": 214.0,
    })
    ctx.check(
        "scale_01_event_suppressed_when_scale_01_wizard_active",
        status2 == 200
        and resp2.get("suppressed") == "livetrack_wizard_active"
        and resp2.get("livetrack_session_id") == scale01_session_id,
        evidence=f"status={status2} resp={resp2!r}",
    )
    ctx.check(
        "suppressed_response_carries_scale_id",
        resp2.get("scale_id") == "scale-01",
        evidence=(
            f"expected scale_id=scale-01 in suppressed response; "
            f"got {resp2.get('scale_id')!r}"
        ),
    )

    # No new scale_events row from the suppressed event.
    scale_rows_after = pi_conn.execute(
        "SELECT COUNT(*) FROM scale_events"
    ).fetchone()[0]
    ctx.check(
        "no_new_scale_events_row_after_suppression",
        scale_rows_after == 1,
        evidence=(
            f"expected scale_events count to stay at 1 (only Act 1 row); "
            f"got {scale_rows_after}"
        ),
    )
