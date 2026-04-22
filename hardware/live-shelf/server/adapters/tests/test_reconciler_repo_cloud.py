"""Cloud-emit behavior of ``RepoReconcilerAdapter``.

Covers the two audit fixes that live in ``_emit_cloud_for_resolution``
and its helpers:

* ``_pick_occurred_at`` must timestamp consumption at the REMOVE event
  for remove-side patterns (``use_return_consumed``,
  ``consumed_or_removed``, in-flight pickup patterns) and at the ADD
  event for add-side patterns (``new_arrival``, ``topped_up``). Using
  the wrong side produces cloud analytics where consumption is filed
  at return time instead of pickup time.
* ``topped_up`` with ``consumed_g=0`` must NOT emit a cloud event —
  a zero-sum refill is nothing to mirror. A log.debug is emitted so
  the drop is visible when debugging a missing cloud row.

These tests exercise the real ``RepoReconcilerAdapter.write_resolution``
path so we catch regressions in the full commit → emit chain, not just
the helper methods in isolation.
"""

from __future__ import annotations

import logging
import sys
import sqlite3
from pathlib import Path
from typing import Any, List

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.reconciler.models import SessionResolution  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import (  # noqa: E402
    LotIn,
    ProductIn,
    ScaleEventIn,
)


class _CapturingEmitter(CloudEventEmitter):
    """Real emitter subclass that records each emit call's kwargs.

    Bypasses the outbox insert by overriding ``_enqueue`` so tests don't
    need a full ``cloud_outbox`` schema. We set ``enabled=True`` so the
    production code path (``if not self._cloud_emitter.enabled: return``)
    doesn't short-circuit.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        super().__init__(conn, enabled=True)
        self.calls: List[dict] = []

    def _enqueue(self, payload: dict):  # type: ignore[override]
        self.calls.append(dict(payload))
        return "stub-event-id"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    return init_db(":memory:")


@pytest.fixture
def seeded(conn):
    """Seed a session, a product, an on-shelf lot, and both an ADD and
    a REMOVE event with distinct timestamps.

    Returns a dict with the ids + timestamps so tests can reference them.
    """
    sess = storage_repo.open_session(
        conn, "2026-04-19T12:00:00.000Z", 1000.0,
    )
    product = storage_repo.create_product(
        conn,
        ProductIn(name="TestProd", barcode="111111111111", certified=1),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=250.0,
            initial_weight_g=250.0,
            total_consumed_g=0.0,
            placed_at="2026-04-19T11:59:00.000Z",
            last_seen_at="2026-04-19T11:59:00.000Z",
        ),
    )
    # Pickup first (remove), then return (add). The two ts values MUST
    # be distinct so _pick_occurred_at's preference is testable.
    remove_ts = "2026-04-19T12:00:05.000Z"
    add_ts = "2026-04-19T12:00:15.000Z"
    remove_ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=remove_ts,
            delta_g=-250.0,
            before_weight_g=1000.0,
            after_weight_g=750.0,
            direction="remove",
            session_id=sess.session_id,
            classifier_status="classified",
        ),
    )
    add_ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=add_ts,
            delta_g=200.0,
            before_weight_g=750.0,
            after_weight_g=950.0,
            direction="add",
            session_id=sess.session_id,
            classifier_status="classified",
        ),
    )
    return {
        "session_id": sess.session_id,
        "product_id": product.product_id,
        "lot_id": lot.lot_id,
        "remove_event_id": remove_ev.event_id,
        "add_event_id": add_ev.event_id,
        "remove_ts": remove_ts,
        "add_ts": add_ts,
    }


# ---------------------------------------------------------------------------
# _pick_occurred_at: remove-side patterns prefer remove_event_id
# ---------------------------------------------------------------------------


def test_use_return_consumed_timestamps_at_pickup_not_return(conn, seeded):
    """``use_return_consumed`` → cloud ``occurred_at`` must be the pickup ts.

    The user took the item off the shelf at ``remove_ts``, ate some,
    and returned the lighter container at ``add_ts``. The consumption
    semantically happened at pickup time — using the return ts files
    the consumption 10s in the future of the actual event.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="use_return_consumed",
            lot_id=seeded["lot_id"],
            consumed_g=50.0,
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=seeded["remove_event_id"],
        )
    )

    assert len(emitter.calls) == 1
    payload = emitter.calls[0]
    assert payload["occurred_at"] == seeded["remove_ts"], (
        "use_return_consumed must stamp occurred_at at the pickup (remove) "
        "event, not the return (add) event"
    )
    # Sanity: the emitted delta is negative (consumption).
    assert payload["delta_g"] == pytest.approx(-50.0)
    assert payload["event_kind"] == "consumed"


def test_consumed_or_removed_timestamps_at_remove_event(conn, seeded):
    """``consumed_or_removed`` has only a remove side → use it."""
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="consumed_or_removed",
            lot_id=seeded["lot_id"],
            consumed_g=250.0,
            confidence=0.95,
            add_event_id=None,
            remove_event_id=seeded["remove_event_id"],
        )
    )

    assert len(emitter.calls) == 1
    assert emitter.calls[0]["occurred_at"] == seeded["remove_ts"]


def test_new_arrival_timestamps_at_add_event(conn, seeded):
    """``new_arrival`` is add-side → cloud ts = add_event ts."""
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="new_arrival",
            lot_id=seeded["lot_id"],
            consumed_g=None,
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=None,
        )
    )

    assert len(emitter.calls) == 1
    assert emitter.calls[0]["occurred_at"] == seeded["add_ts"]
    assert emitter.calls[0]["event_kind"] == "added"


def test_topped_up_timestamps_at_add_event(conn, seeded):
    """``topped_up`` is add-side (the refill) → cloud ts = add_event ts.

    Previously the helper preferred ``add_event_id or remove_event_id``
    for every pattern, which was correct for topped_up but wrong for
    remove-side patterns. The branch-per-pattern fix keeps topped_up
    on the add side and only changes remove-side behavior.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="topped_up",
            lot_id=seeded["lot_id"],
            consumed_g=-30.0,  # negative consumption = refill
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=seeded["remove_event_id"],
        )
    )

    assert len(emitter.calls) == 1
    assert emitter.calls[0]["occurred_at"] == seeded["add_ts"]
    # Refill delta is positive (stock went up).
    assert emitter.calls[0]["delta_g"] == pytest.approx(30.0)
    assert emitter.calls[0]["event_kind"] == "refilled"


def test_remove_side_falls_back_to_add_event_if_remove_missing(conn, seeded):
    """If the remove event is missing for a remove-side pattern, fall
    back to the add event rather than dropping the occurred_at entirely.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="use_return_consumed",
            lot_id=seeded["lot_id"],
            consumed_g=50.0,
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=None,  # missing — forces fallback
        )
    )

    assert len(emitter.calls) == 1
    assert emitter.calls[0]["occurred_at"] == seeded["add_ts"]


# ---------------------------------------------------------------------------
# topped_up with consumed_g=0 — no cloud event, debug log for audit
# ---------------------------------------------------------------------------


def test_topped_up_with_zero_consumed_emits_nothing(conn, seeded, caplog):
    """Zero-consumption topped_up (user added and took back the same mass)
    produces no cloud event — we log.debug so the drop is visible.

    Regression guard for the in-flight return branch of the reconciler
    when the returned mass equals the pickup mass.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    with caplog.at_level(
        logging.DEBUG, logger="server.adapters.reconciler_repo",
    ):
        adapter.write_resolution(
            SessionResolution(
                session_id=seeded["session_id"],
                pattern="topped_up",
                lot_id=seeded["lot_id"],
                consumed_g=0.0,  # <-- zero — the regression case
                confidence=0.95,
                add_event_id=seeded["add_event_id"],
                remove_event_id=seeded["remove_event_id"],
            )
        )

    assert emitter.calls == [], (
        "zero-consumption topped_up must not emit a cloud event"
    )
    debug_msgs = [
        r.getMessage() for r in caplog.records if r.levelno == logging.DEBUG
    ]
    assert any("topped_up" in m and "consumed_g=0" in m for m in debug_msgs), (
        "expected a debug log explaining why the topped_up drop was silent"
    )


def test_in_flight_return_with_zero_consumed_emits_nothing(conn, seeded):
    """In-flight lot returns at the same mass it left with → no cloud event.

    Regression for the in-flight zero-consumption case (finding #8 of
    the audit): the user picked up a lot, held it briefly, and put it
    back at the same weight. consumed_g is 0 or <=0, so the derive
    helper returns 0.0 and _emit_cloud_for_resolution short-circuits.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="in_flight_return",
            lot_id=seeded["lot_id"],
            consumed_g=0.0,
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=seeded["remove_event_id"],
        )
    )

    assert emitter.calls == [], (
        "zero-consumption in-flight return must not emit a cloud event"
    )


# ---------------------------------------------------------------------------
# Sign guard — deep-audit finding #15
# ---------------------------------------------------------------------------


def test_use_return_consumed_with_negative_consumed_skips_emit(
    conn, seeded, caplog,
):
    """If the scale reports the container returning heavier than it
    left (consumed_g negative for ``use_return_consumed``), we must
    NOT emit a cloud event. The old code returned ``-(-X) = +X`` which
    the cloud classified as a consumed event with a positive delta —
    stock would go UP when the user ate something. Finding #15.

    Negative consumed_g on use_return_consumed is a data-corruption
    signal (noise bled past the floor) rather than a legitimate state.
    We clamp to zero, log WARNING, and skip the cloud mirror.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)

    with caplog.at_level(
        logging.WARNING, logger="server.adapters.reconciler_repo",
    ):
        adapter.write_resolution(
            SessionResolution(
                session_id=seeded["session_id"],
                pattern="use_return_consumed",
                lot_id=seeded["lot_id"],
                # Negative — return weighed MORE than pickup after
                # noise floor, which is the corruption case.
                consumed_g=-12.5,
                confidence=0.95,
                add_event_id=seeded["add_event_id"],
                remove_event_id=seeded["remove_event_id"],
            )
        )

    assert emitter.calls == [], (
        "use_return_consumed with negative consumed_g must not emit — "
        "otherwise the cloud sees a positive delta for a consumed event "
        "and stock goes the wrong direction"
    )
    warn_msgs = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(
        "negative consumed_g" in m or "wrong-sign" in m for m in warn_msgs
    ), (
        "expected a WARNING explaining why the use_return_consumed emit "
        "was skipped"
    )


def test_use_return_consumed_with_positive_consumed_still_emits(
    conn, seeded,
):
    """The sign guard fires ONLY for negative consumed_g — a normal
    positive consumption must still emit as it did before the fix."""
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(conn, db_lock=None, cloud_emitter=emitter)
    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="use_return_consumed",
            lot_id=seeded["lot_id"],
            consumed_g=42.0,
            confidence=0.95,
            add_event_id=seeded["add_event_id"],
            remove_event_id=seeded["remove_event_id"],
        )
    )
    assert len(emitter.calls) == 1
    assert emitter.calls[0]["event_kind"] == "consumed"
    assert emitter.calls[0]["delta_g"] == pytest.approx(-42.0)


# ---------------------------------------------------------------------------
# Bug B fix 2026-04-22: in_flight_pickup emits to cloud
# ---------------------------------------------------------------------------


def test_in_flight_pickup_emits_dedicated_event_kind(conn, seeded):
    """``in_flight_pickup`` resolution must produce a cloud event with
    ``event_kind='in_flight_pickup'`` so the cloud handler stamps
    stock_lots.in_flight_since without mutating qty.

    Before the 2026-04-22 fix, PATTERN_TO_EVENT_KIND['in_flight_pickup']
    was None and the emit was silently dropped — cloud /chef/inventory
    diverged from Pi lots by hours until the terminal return emitted
    a consumed event.
    """
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, cloud_emitter=emitter
    )

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="in_flight_pickup",
            lot_id=seeded["lot_id"],
            consumed_g=None,
            confidence=0.95,
            add_event_id=None,
            remove_event_id=seeded["remove_event_id"],
        )
    )

    assert len(emitter.calls) == 1, (
        "in_flight_pickup must emit exactly one cloud event (was 0 before "
        "the 2026-04-22 fix)"
    )
    payload = emitter.calls[0]
    assert payload["event_kind"] == "in_flight_pickup"
    assert payload["occurred_at"] == seeded["remove_ts"], (
        "in_flight_pickup is a REMOVE-side pattern — occurred_at should "
        "be the pickup (remove) event timestamp"
    )
    # Delta is informational for this kind — cloud ignores it — but
    # still needs to be signed consistently (negative for mass-removed).
    assert payload["delta_g"] == pytest.approx(-250.0), (
        "delta_g should mirror the remove event's magnitude as a "
        "negative value (mass left the shelf)"
    )
    # pi_event_id is populated from the REMOVE event id so the cloud
    # viewer can fetch the pickup frame.
    assert payload["pi_event_id"] == seeded["remove_event_id"]


def test_in_flight_pickup_without_remove_event_emits_with_zero_delta(
    conn, seeded,
):
    """Defence in depth — if a malformed resolution somehow arrives with
    no remove_event_id, we still emit the marker (delta_g=0 is legal for
    in_flight_pickup since cloud ignores the field). The old delta guard
    would have suppressed this emit entirely; the new guard special-cases
    in_flight_pickup."""
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, cloud_emitter=emitter
    )

    adapter.write_resolution(
        SessionResolution(
            session_id=seeded["session_id"],
            pattern="in_flight_pickup",
            lot_id=seeded["lot_id"],
            consumed_g=None,
            confidence=0.95,
            add_event_id=None,
            remove_event_id=None,
        )
    )

    assert len(emitter.calls) == 1
    assert emitter.calls[0]["event_kind"] == "in_flight_pickup"
    assert emitter.calls[0]["delta_g"] == pytest.approx(0.0)
