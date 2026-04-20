"""Sweeper TTL reaper + reconciler skip-logic tests
(IN_FLIGHT_TRACKER_PLAN.md §7, §8).
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self):
        return []

    def get_recently_out_lots(self, window_seconds):
        return []

    def get_in_flight_lots(self, max_age_seconds=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


_BC = [0]


def _setup_lot(conn, weight_g=200.0):
    _BC[0] += 1
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=f"Item {_BC[0]}", barcode=f"SwB-{_BC[0]}",
            net_weight_g=weight_g, gross_weight_g=weight_g,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=weight_g, initial_weight_g=weight_g),
    )
    return product, lot


def _make_handler(conn, tmp_path, **kwargs):
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )
    defaults.update(kwargs)
    return ScaleHandler(**defaults)


# ---------------------------------------------------------------------------
# Sweeper TTL reaper (§8)
# ---------------------------------------------------------------------------


def test_reap_expired_in_flight_flips_expired_lots_to_out(tmp_path):
    """Lots with in_flight_since older than TTL get flipped to out +
    get an in_flight_ttl_expired resolution row AND the pickup weight is
    accounted for in total_consumed_g (item presumed gone for good)."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=1)

    _, lot = _setup_lot(conn)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T00:00:00.000Z", initial_weight_g=200.0,
    ).session_id
    # Artificially seed the lot as in_flight with a past pickup time.
    conn.execute(
        """
        UPDATE lots
           SET status='in_flight',
               in_flight_since = datetime('now', '-1 hour'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'EV1',
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (session_id, lot.lot_id),
    )
    conn.commit()

    reaped = handler._reap_expired_in_flight()
    assert reaped == 1

    now = storage_repo.get_lot(conn, lot.lot_id)
    assert now.status == "out"
    assert now.in_flight_since is None
    assert now.pickup_weight_g is None
    assert now.last_out_at is not None  # stamped by the reaper
    # Consumption accounting — the 200g pickup is now in the lifetime total.
    assert now.total_consumed_g == 200.0

    resolutions = conn.execute(
        "SELECT pattern, lot_id, consumed_g FROM session_resolutions "
        "WHERE session_id=?",
        (session_id,),
    ).fetchall()
    row = next(r for r in resolutions if r[0] == "in_flight_ttl_expired")
    assert row[1] == lot.lot_id
    assert row[2] == 200.0


def test_reap_expired_in_flight_leaves_fresh_lots_alone(tmp_path):
    """Lots younger than TTL are not reaped."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=86400)

    _, lot = _setup_lot(conn)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T00:00:00.000Z", initial_weight_g=200.0,
    ).session_id
    conn.execute(
        """
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-5 minutes'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'EV1',
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (session_id, lot.lot_id),
    )
    conn.commit()

    reaped = handler._reap_expired_in_flight()
    assert reaped == 0

    now = storage_repo.get_lot(conn, lot.lot_id)
    assert now.status == "in_flight"


def test_reap_expired_in_flight_race_concurrent_return_skips_lot(tmp_path):
    """C2 regression: if a concurrent ADD/return flipped the lot out of
    ``in_flight`` between the sweeper's list query and the per-lot reap
    call, ``reap_in_flight_lot_as_consumed``'s UPDATE hits 0 rows (it's
    guarded by ``AND status='in_flight'``). The reaper must detect this
    via the post-update Lot and skip: no resolution, no usage_log, no
    counter bump. Simulated here by flipping the lot status to 'out'
    manually after the reaper has loaded its expired list."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=1)

    _, lot = _setup_lot(conn)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T00:00:00.000Z", initial_weight_g=200.0,
    ).session_id
    conn.execute(
        """
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-1 hour'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'EV1',
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (session_id, lot.lot_id),
    )
    conn.commit()

    # Monkeypatch reap_in_flight_lot_as_consumed so between the list
    # and the reap call, the lot gets flipped out of ``in_flight``
    # concurrently — exactly mimicking the race described in C2.
    from server.storage import repo as storage_repo_mod

    real_reap = storage_repo_mod.reap_in_flight_lot_as_consumed

    def racy_reap(conn_, lot_id, *, consumed_g, last_out_at):
        # Simulate the concurrent return completing first — flip to
        # on_shelf and clear in-flight columns so the helper's
        # ``AND status='in_flight'`` guard hits 0 rows.
        conn_.execute(
            "UPDATE lots SET status='on_shelf', in_flight_since=NULL, "
            "pickup_weight_g=NULL, pickup_event_id=NULL, "
            "pickup_session_id=NULL WHERE lot_id=?",
            (lot_id,),
        )
        conn_.commit()
        # Now call the real helper — its guarded UPDATE hits 0 rows and
        # returns a Lot with status='on_shelf' (not 'out').
        return real_reap(
            conn_, lot_id,
            consumed_g=consumed_g, last_out_at=last_out_at,
        )

    storage_repo_mod.reap_in_flight_lot_as_consumed = racy_reap
    try:
        reaped = handler._reap_expired_in_flight()
    finally:
        # Restore on the module object — ``scale_events.storage_repo``
        # is the SAME module object, so this single assignment covers
        # both reference paths.
        storage_repo_mod.reap_in_flight_lot_as_consumed = real_reap

    # Race fired — reaped counter stays at 0; no resolution row; no
    # usage_log row; lot is in whatever state the concurrent writer
    # left it (on_shelf here).
    assert reaped == 0
    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "on_shelf"

    resolutions = conn.execute(
        "SELECT pattern FROM session_resolutions WHERE session_id=?",
        (session_id,),
    ).fetchall()
    assert not any(r[0] == "in_flight_ttl_expired" for r in resolutions), (
        "reaper wrote an in_flight_ttl_expired resolution despite the "
        "concurrent-return race"
    )
    usage_rows = storage_repo.list_usage_log(
        conn, kinds=["in_flight_ttl_expired"]
    )
    assert len(usage_rows) == 0


def test_reaper_with_null_pickup_event_id_does_not_collapse_usage_log_rows(
    tmp_path,
):
    """H5: reaped lots with ``pickup_event_id = NULL`` get distinct
    ``usage_log`` rows — they must not be dedup'd into one.

    The ``usage_log`` dedup is a partial unique index on
    ``pickup_event_id`` gated by ``WHERE pickup_event_id IS NOT NULL``,
    so multiple NULL rows are legal. Before the H5 fix, the handler
    coerced a null ``event_id`` into ``""`` at
    ``mark_lot_in_flight`` call time, which did NOT hit the NULL guard
    — every null-pickup row collapsed into a single empty-string
    dedup entry and later reaps silently dropped rows.

    Seed two in-flight lots with ``pickup_event_id = NULL`` directly,
    age both past the TTL, run the reaper, and assert each lot got its
    own ``usage_log`` row.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=1)

    _, lot_a = _setup_lot(conn, weight_g=100.0)
    _, lot_b = _setup_lot(conn, weight_g=150.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T00:00:00.000Z", initial_weight_g=250.0,
    ).session_id

    # Both lots: in_flight, aged past TTL, NULL pickup_event_id.
    for lot, w in ((lot_a, 100.0), (lot_b, 150.0)):
        conn.execute(
            """
            UPDATE lots
               SET status='in_flight',
                   in_flight_since = datetime('now', '-1 hour'),
                   pickup_weight_g = ?,
                   pickup_event_id = NULL,
                   pickup_session_id = ?
             WHERE lot_id = ?
            """,
            (w, session_id, lot.lot_id),
        )
    conn.commit()

    reaped = handler._reap_expired_in_flight()
    assert reaped == 2

    usage_rows = conn.execute(
        "SELECT lot_id, consumed_g, pickup_event_id FROM usage_log "
        "WHERE kind = 'in_flight_ttl_expired' "
        "ORDER BY lot_id"
    ).fetchall()
    # Two distinct rows — one per lot — both with NULL pickup_event_id.
    assert len(usage_rows) == 2, (
        f"reaper collapsed null-pickup usage_log rows into {len(usage_rows)} "
        "row(s); partial-unique index must permit multiple NULLs"
    )
    written_lot_ids = {r[0] for r in usage_rows}
    assert written_lot_ids == {lot_a.lot_id, lot_b.lot_id}
    for _, _, pickup_event_id in usage_rows:
        assert pickup_event_id is None


def test_reap_expired_in_flight_with_ttl_zero_is_noop(tmp_path):
    """TTL of 0 disables the reaper entirely — for a belt-and-braces
    opt-out. (The live config validator rejects negative values but 0 is
    allowed.)"""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, in_flight_ttl_seconds=0)

    _, lot = _setup_lot(conn)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T00:00:00.000Z", initial_weight_g=200.0,
    ).session_id
    conn.execute(
        """
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-10 hours'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'EV1',
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (session_id, lot.lot_id),
    )
    conn.commit()
    assert handler._reap_expired_in_flight() == 0
    assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"


# ---------------------------------------------------------------------------
# Reconciler skip (§7)
# ---------------------------------------------------------------------------


def test_reconciler_skips_events_claimed_by_in_flight_resolutions(tmp_path):
    """Events already resolved by fast-path in_flight_return must not be
    re-resolved by the reconciler."""
    from server.adapters.reconciler_repo import RepoReconcilerAdapter
    from server.reconciler.reconcile import reconcile_session

    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    _, lot = _setup_lot(conn, weight_g=200.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00.000Z", initial_weight_g=200.0,
    ).session_id

    # REMOVE then ADD through the apply path → produces in_flight_pickup
    # and in_flight_return resolutions, and classifier_status='classified'.
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(ts="2026-04-17T12:00:05Z", delta_g=-200.0,
                     before_weight_g=200.0, after_weight_g=0.0,
                     direction="remove", session_id=session_id,
                     classifier_status="classified"),
    )
    add_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(ts="2026-04-17T12:05:00Z", delta_g=180.0,
                     before_weight_g=0.0, after_weight_g=180.0,
                     direction="add", session_id=session_id,
                     classifier_status="classified"),
    )
    classification_cc = {
        "item_id": lot.lot_id, "confidence": 0.95,
        "multi_match": [], "candidate_pool_used": [{"candidate_id": lot.lot_id}],
    }
    handler._apply_lot_update_from_classification(
        direction="remove", classification=classification_cc,
        event_ts="2026-04-17T12:00:05Z", delta_g=-200.0,
        session_id=session_id, event_id=remove_event.event_id,
    )
    handler._apply_lot_update_from_classification(
        direction="add", classification={**classification_cc, "action": "added"},
        event_ts="2026-04-17T12:05:00Z", delta_g=180.0,
        session_id=session_id, event_id=add_event.event_id,
    )
    # Patch event classification JSON columns so the reconciler sees a
    # valid classified state (we bypassed handle_scale_event's writeback).
    import json
    conn.execute(
        "UPDATE scale_events SET classification=? WHERE event_id=?",
        (json.dumps({**classification_cc, "action": "removed"}), remove_event.event_id),
    )
    conn.execute(
        "UPDATE scale_events SET classification=? WHERE event_id=?",
        (json.dumps({**classification_cc, "action": "added"}), add_event.event_id),
    )
    # Also set final_shelf_weight_g so the weight sanity check passes.
    conn.execute(
        "UPDATE sessions SET ended_at=?, final_shelf_weight_g=? WHERE session_id=?",
        ("2026-04-17T12:06:00Z", 180.0, session_id),
    )
    conn.commit()

    before_rows = conn.execute(
        "SELECT pattern FROM session_resolutions WHERE session_id=?",
        (session_id,),
    ).fetchall()
    pre_patterns = sorted(r[0] for r in before_rows)
    assert "in_flight_pickup" in pre_patterns
    assert "in_flight_return" in pre_patterns

    # Now run the reconciler. It must NOT add use_return_consumed /
    # new_arrival rows duplicating the in_flight_return we already wrote.
    repo_adapter = RepoReconcilerAdapter(conn=conn, db_lock=threading.RLock())
    resolutions = reconcile_session(session_id, repo_adapter)

    # Reconciler should emit 0 or only a weight-sanity row; NO
    # use_return_consumed / new_arrival for our in-flight event pair.
    new_patterns = [r.pattern for r in resolutions]
    assert "use_return_consumed" not in new_patterns, (
        f"reconciler double-resolved in-flight event: {new_patterns}"
    )
    assert "new_arrival" not in new_patterns

    # Final DB state: no duplicate in_flight_return row.
    after = conn.execute(
        "SELECT pattern, COUNT(*) FROM session_resolutions "
        "WHERE session_id=? GROUP BY pattern",
        (session_id,),
    ).fetchall()
    for pattern, count in after:
        assert count == 1, (
            f"pattern {pattern!r} appears {count} times in session_resolutions "
            f"— reconciler duplicated a fast-path row"
        )


def test_reconciler_skips_removes_with_in_flight_pickup_already_written(tmp_path):
    """M4/C3: when an in_flight_pickup has a matching terminal in-flight
    resolution in the same session, the reconciler's claimed_event_ids
    skip logic must cover the REMOVE event — no duplicate
    consumed_or_removed row."""
    from server.adapters.reconciler_repo import RepoReconcilerAdapter
    from server.reconciler.reconcile import reconcile_session
    from server.storage.models import SessionResolutionIn

    conn = init_db(":memory:")

    _, lot = _setup_lot(conn, weight_g=200.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00.000Z", initial_weight_g=200.0,
    ).session_id

    # Seed scale events: a REMOVE (the pickup) and an ADD (the return).
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-17T12:00:05Z", delta_g=-200.0,
            before_weight_g=200.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
            classification='{"item_id":"' + lot.lot_id
                          + '","confidence":0.95,"multi_match":[],'
                            '"candidate_pool_used":[]}',
        ),
    )
    add_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-17T12:05:00Z", delta_g=180.0,
            before_weight_g=0.0, after_weight_g=180.0,
            direction="add", session_id=session_id,
            classifier_status="classified",
            classification='{"item_id":"' + lot.lot_id
                          + '","confidence":0.95,"multi_match":[],'
                            '"candidate_pool_used":[]}',
        ),
    )

    # Seed paired in_flight_pickup + in_flight_return resolutions — the
    # "pickup is paired" case. C3 skip logic should fire.
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="in_flight_pickup",
            lot_id=lot.lot_id,
            remove_event_id=remove_event.event_id,
        ),
    )
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="in_flight_return",
            lot_id=lot.lot_id,
            consumed_g=20.0,
            add_event_id=add_event.event_id,
        ),
    )
    conn.execute(
        "UPDATE sessions SET ended_at=?, final_shelf_weight_g=? WHERE session_id=?",
        ("2026-04-17T12:06:00Z", 180.0, session_id),
    )
    conn.commit()

    adapter = RepoReconcilerAdapter(conn=conn, db_lock=threading.RLock())
    new_resolutions = reconcile_session(session_id, adapter)

    # Reconciler must NOT emit a consumed_or_removed for the REMOVE —
    # the pickup was paired with an in_flight_return terminal.
    new_patterns = [r.pattern for r in new_resolutions]
    assert "consumed_or_removed" not in new_patterns, (
        f"reconciler emitted consumed_or_removed despite paired pickup: "
        f"{new_patterns}"
    )
    # And no fresh use_return_consumed / new_arrival for the return.
    assert "use_return_consumed" not in new_patterns
    assert "new_arrival" not in new_patterns


def test_reconciler_does_not_skip_unpaired_in_flight_pickup(tmp_path):
    """C3 regression: when an in_flight_pickup is UNPAIRED (no matching
    terminal in_flight_return/replaced/ttl_expired for the same lot in
    the same session), the reconciler must NOT claim the REMOVE event.
    Pass 2 should resolve it as ``consumed_or_removed`` so the lot gets
    terminal accounting — otherwise the REMOVE is permanently dropped."""
    from server.adapters.reconciler_repo import RepoReconcilerAdapter
    from server.reconciler.reconcile import reconcile_session
    from server.storage.models import SessionResolutionIn

    conn = init_db(":memory:")

    _, lot = _setup_lot(conn, weight_g=200.0)
    session_id = storage_repo.open_session(
        conn, "2026-04-17T12:00:00.000Z", initial_weight_g=200.0,
    ).session_id

    # Seed a REMOVE event.
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-17T12:00:05Z", delta_g=-200.0,
            before_weight_g=200.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
            classification='{"item_id":"' + lot.lot_id
                          + '","confidence":0.95,"multi_match":[],'
                            '"candidate_pool_used":[]}',
        ),
    )

    # Seed an UNPAIRED in_flight_pickup — no matching terminal in-flight
    # resolution for this lot in this session. This mirrors the
    # server-crash-mid-session / return-never-came scenario.
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="in_flight_pickup",
            lot_id=lot.lot_id,
            remove_event_id=remove_event.event_id,
        ),
    )
    conn.execute(
        "UPDATE sessions SET ended_at=?, final_shelf_weight_g=? WHERE session_id=?",
        ("2026-04-17T12:06:00Z", 0.0, session_id),
    )
    conn.commit()

    adapter = RepoReconcilerAdapter(conn=conn, db_lock=threading.RLock())
    new_resolutions = reconcile_session(session_id, adapter)

    # C3: REMOVE must NOT be claimed — Pass 2 should emit
    # consumed_or_removed so the lot gets terminal accounting.
    new_patterns = [r.pattern for r in new_resolutions]
    assert "consumed_or_removed" in new_patterns, (
        f"reconciler dropped UNPAIRED in_flight_pickup's REMOVE event: "
        f"{new_patterns}"
    )
    # The consumed_or_removed row should reference the REMOVE event and lot.
    cor = next(r for r in new_resolutions if r.pattern == "consumed_or_removed")
    assert cor.remove_event_id == remove_event.event_id
    assert cor.lot_id == lot.lot_id
