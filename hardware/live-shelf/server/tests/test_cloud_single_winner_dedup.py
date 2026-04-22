"""Single-winner cloud-emit dedup for dual-resolution REMOVE events.

Regression suite for the 2026-04-22 chocolate-milk bug: a single
physical REMOVE produced TWO cloud events because the Pi wrote both
an ``in_flight_pickup`` row (fast-path at REMOVE time) AND a
``consumed_or_removed`` row (reconciler Pass 2 for the unpaired
pickup). Both rows mirrored to cloud, so ``stock_lots.in_flight_since``
got stamped correctly BUT ``stock_lots.qty_containers`` was also
decremented — producing phantom consumption.

Precedence (``cloud.integration.CLOUD_PATTERN_PRECEDENCE``):
    depleted > in_flight_pickup > consumed_or_removed

When both ``in_flight_pickup`` and ``consumed_or_removed`` rows exist
for the same ``remove_event_id``, only the ``in_flight_pickup`` event
must reach the cloud. ``consumed_or_removed`` is a local-only accounting
row on the Pi.

Test shape:
* ``test_dual_pattern_write_emits_only_in_flight_pickup`` — drive both
  writes through the real ``RepoReconcilerAdapter`` and assert exactly
  ONE cloud event fires, with ``event_kind='in_flight_pickup'``. Before
  the fix, this asserted TWO events; the failure log preserved in the
  test docstring captures the pre-fix signature for future forensics.
* ``test_backfill_skips_consumed_or_removed_when_in_flight_pickup_exists``
  — mirror assertion for the boot-time backfill path. The scan must
  apply the same single-winner rule so the next boot doesn't re-emit
  the loser.
* ``test_only_one_pattern_emits_unchanged`` — ensure patterns without
  a sibling still pass through unaffected.
"""

from __future__ import annotations

import json
import sys
import sqlite3
import threading
from pathlib import Path
from typing import List

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.cloud.integration import (  # noqa: E402
    CLOUD_PATTERN_PRECEDENCE,
    CloudEventEmitter,
    backfill_missing_outbox_events,
)
from server.reconciler.models import SessionResolution  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import (  # noqa: E402
    LotIn,
    ProductIn,
    ScaleEventIn,
    SessionResolutionIn,
)


class _CapturingEmitter(CloudEventEmitter):
    """Real emitter that records each emit's kwargs without inserting
    to the outbox — so tests can assert on call count + payload shape
    without carrying the outbox schema.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        super().__init__(conn, enabled=True)
        self.calls: List[dict] = []

    def _enqueue(self, payload: dict):  # type: ignore[override]
        self.calls.append(dict(payload))
        return "stub-event-id"


def _seed_in_flight_scenario(conn: sqlite3.Connection) -> dict:
    """Seed the canonical dual-resolution shape:

    * one product, one lot, one session, one REMOVE event
    * ``in_flight_pickup`` resolution already written (fast-path)
    """
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",
            net_weight_g=1537.8,
            gross_weight_g=1537.8,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="in_flight",
            current_weight_g=1672.0,
            initial_weight_g=1672.0,
            pickup_weight_g=1672.0,
            in_flight_since="2026-04-22T03:01:39.000Z",
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=1672.0,
    ).session_id
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-22T03:01:39.000Z",
            delta_g=-1672.0,
            before_weight_g=1672.0,
            after_weight_g=0.0,
            direction="remove",
            session_id=session_id,
            classifier_status="classified",
        ),
    )
    # Fast-path write — scale_events.py does this via storage_repo.write_resolution
    # directly (NOT via the adapter), so no cloud emit fires at this point.
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="in_flight_pickup",
            lot_id=lot.lot_id,
            remove_event_id=remove_event.event_id,
            confidence=0.95,
        ),
    )
    return {
        "session_id": session_id,
        "product_id": product.product_id,
        "lot_id": lot.lot_id,
        "remove_event_id": remove_event.event_id,
    }


# ---------------------------------------------------------------------------
# Live-path: adapter.write_resolution for consumed_or_removed
# ---------------------------------------------------------------------------


def test_dual_pattern_write_emits_only_in_flight_pickup():
    """Bug B 2026-04-22 regression.

    Pre-fix behaviour (this test WOULD have asserted BOTH cloud events):
      1. fast-path writes in_flight_pickup (no emit)
      2. reconciler adapter writes consumed_or_removed → emit fires
      3. backfill on next boot sees in_flight_pickup orphan → emit fires
      * Cloud ends up with 2 events for 1 physical REMOVE:
          * in_flight_pickup  (sets stock_lots.in_flight_since — right)
          * consumed          (decrements stock_lots.qty_containers — wrong)

    Post-fix: adapter.write_resolution for ``consumed_or_removed``
    sees the in_flight_pickup sibling, suppresses the cloud emit, and
    keeps only the local row for Pi accounting. Exactly zero cloud
    emits at session close; the in_flight_pickup then emits via the
    backfill path (next boot) with no competing row to displace it.
    """
    conn = init_db(":memory:")
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=threading.RLock(), cloud_emitter=emitter,
    )
    seed = _seed_in_flight_scenario(conn)

    # The reconciler's Pass 2 write for the unpaired pickup.
    adapter.write_resolution(
        SessionResolution(
            session_id=seed["session_id"],
            pattern="consumed_or_removed",
            lot_id=seed["lot_id"],
            consumed_g=None,
            remove_event_id=seed["remove_event_id"],
            confidence=0.95,
        )
    )

    # Local row IS written (Pi accounting preserved) — assert the
    # session_resolutions table now has BOTH rows.
    rows = list(conn.execute(
        "SELECT pattern FROM session_resolutions "
        " WHERE remove_event_id = ? ORDER BY pattern",
        (seed["remove_event_id"],),
    ))
    assert [r[0] for r in rows] == [
        "consumed_or_removed", "in_flight_pickup",
    ], (
        "both local resolutions must be persisted — only the cloud emit "
        f"should be suppressed; got {rows}"
    )

    # Cloud emit for consumed_or_removed must be suppressed: the
    # in_flight_pickup winner displaces it.
    assert emitter.calls == [], (
        "consumed_or_removed must NOT emit when in_flight_pickup exists "
        f"for the same REMOVE event (got {len(emitter.calls)} emits: "
        f"{[c.get('event_kind') for c in emitter.calls]})"
    )


def test_inverted_order_still_enforces_single_winner():
    """If the adapter is ever asked to emit in_flight_pickup after a
    consumed_or_removed was already written (e.g. hypothetical race),
    the pickup must STILL emit (precedence-higher patterns never
    suppress themselves).
    """
    conn = init_db(":memory:")
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=threading.RLock(), cloud_emitter=emitter,
    )

    # Seed: product + lot + session + REMOVE event + pre-existing
    # consumed_or_removed. We do NOT use _seed_in_flight_scenario
    # because here we want the INVERTED order.
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Milk", barcode="M-1", net_weight_g=500.0,
            gross_weight_g=500.0, unit_type="liquid",
            container_type="bottle", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=500.0, initial_weight_g=500.0,
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=500.0,
    ).session_id
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-22T03:01:00.000Z", delta_g=-500.0,
            before_weight_g=500.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
        ),
    )
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="consumed_or_removed",
            lot_id=lot.lot_id,
            remove_event_id=remove_event.event_id,
        ),
    )

    # Now emit in_flight_pickup — it's HIGHER precedence so must pass.
    adapter.write_resolution(
        SessionResolution(
            session_id=session_id,
            pattern="in_flight_pickup",
            lot_id=lot.lot_id,
            remove_event_id=remove_event.event_id,
            confidence=0.95,
        )
    )
    assert len(emitter.calls) == 1, (
        "in_flight_pickup must ALWAYS emit — it's the highest-precedence "
        f"live_shelf REMOVE pattern. Got {len(emitter.calls)} emits."
    )
    assert emitter.calls[0]["event_kind"] == "in_flight_pickup"


def test_only_one_pattern_emits_unchanged():
    """Sanity: when only ONE pattern exists for the REMOVE event,
    behaviour is unchanged — the dedup guard must not suppress."""
    conn = init_db(":memory:")
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=threading.RLock(), cloud_emitter=emitter,
    )
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Eggs", barcode="E-1", net_weight_g=600.0,
            gross_weight_g=600.0, unit_type="solid",
            container_type="carton", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=600.0, initial_weight_g=600.0,
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=600.0,
    ).session_id
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-22T03:01:00.000Z", delta_g=-600.0,
            before_weight_g=600.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
        ),
    )
    # Only consumed_or_removed, no in_flight_pickup sibling.
    adapter.write_resolution(
        SessionResolution(
            session_id=session_id,
            pattern="consumed_or_removed",
            lot_id=lot.lot_id,
            consumed_g=600.0,
            remove_event_id=remove_event.event_id,
            confidence=0.95,
        )
    )
    assert len(emitter.calls) == 1, (
        "solo consumed_or_removed must emit normally when no higher-"
        "precedence sibling exists"
    )
    assert emitter.calls[0]["event_kind"] == "consumed"


# ---------------------------------------------------------------------------
# Backfill path: boot-time scanner must apply the same single-winner rule
# ---------------------------------------------------------------------------


def _ensure_outbox_table(conn: sqlite3.Connection) -> None:
    """Set up cloud_outbox if not present (init_db may not include it
    under all fixtures). Safe no-op when it already exists."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cloud_outbox (
            outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_event_id TEXT UNIQUE NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            sent_at TEXT,
            attempts INTEGER DEFAULT 0,
            last_error TEXT
        )
        """
    )
    conn.commit()


def test_backfill_skips_consumed_or_removed_when_in_flight_pickup_exists():
    """The boot-time backfill must honour the same precedence.

    Pre-fix: on every Pi reboot the scan would find the orphan
    in_flight_pickup row (correct) AND the orphan consumed_or_removed
    row (wrong) and re-emit BOTH. That would re-introduce the dual-emit
    even after the live path was fixed.

    Post-fix: the backfill scan skips ``consumed_or_removed`` rows
    whose REMOVE event also has an ``in_flight_pickup`` row. The
    in_flight_pickup wins and is the only event emitted for that
    REMOVE.
    """
    conn = init_db(":memory:")
    _ensure_outbox_table(conn)
    emitter = _CapturingEmitter(conn)
    seed = _seed_in_flight_scenario(conn)

    # Add a sibling consumed_or_removed row with no outbox entry —
    # simulating the pre-fix state where reconciler DID emit it but we
    # rolled back the cloud before the outbox drained.
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=seed["session_id"],
            pattern="consumed_or_removed",
            lot_id=seed["lot_id"],
            remove_event_id=seed["remove_event_id"],
        ),
    )

    # Sanity: both rows present, neither has an outbox mirror yet.
    count = conn.execute(
        "SELECT COUNT(*) FROM session_resolutions "
        " WHERE remove_event_id = ?",
        (seed["remove_event_id"],),
    ).fetchone()[0]
    assert count == 2, f"expected both rows seeded, got {count}"

    re_emitted = backfill_missing_outbox_events(
        conn, emitter, scale_id="scale-01", shelf_kind="live_shelf",
    )

    # The backfill MUST pick exactly the in_flight_pickup row.
    assert re_emitted == 1, (
        f"backfill should re-emit exactly 1 row (in_flight_pickup); "
        f"consumed_or_removed must be suppressed. Got {re_emitted}. "
        f"Calls: {[c.get('event_kind') for c in emitter.calls]}"
    )
    assert len(emitter.calls) == 1
    assert emitter.calls[0]["event_kind"] == "in_flight_pickup", (
        f"expected in_flight_pickup to win; got "
        f"{emitter.calls[0].get('event_kind')}"
    )


def test_backfill_solo_consumed_or_removed_still_emits():
    """Regression guard: when ONLY consumed_or_removed exists for a
    REMOVE event (no in-flight sibling), backfill must still re-emit
    it — the dedup guard must not drop legitimate lone rows.
    """
    conn = init_db(":memory:")
    _ensure_outbox_table(conn)
    emitter = _CapturingEmitter(conn)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Solo", barcode="S-1", net_weight_g=100.0,
            gross_weight_g=100.0, unit_type="solid",
            container_type="box", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="out",
            current_weight_g=0.0, initial_weight_g=100.0,
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=100.0,
    ).session_id
    remove_event = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-22T03:01:00.000Z", delta_g=-100.0,
            before_weight_g=100.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="classified",
        ),
    )
    storage_repo.write_resolution(
        conn,
        SessionResolutionIn(
            session_id=session_id,
            pattern="consumed_or_removed",
            lot_id=lot.lot_id,
            consumed_g=100.0,
            remove_event_id=remove_event.event_id,
        ),
    )

    re_emitted = backfill_missing_outbox_events(
        conn, emitter, scale_id="scale-01", shelf_kind="live_shelf",
    )
    assert re_emitted == 1, (
        "solo consumed_or_removed must re-emit during backfill"
    )
    assert emitter.calls[0]["event_kind"] == "consumed"


# ---------------------------------------------------------------------------
# Precedence map invariants
# ---------------------------------------------------------------------------


def test_precedence_map_orders_dedup_patterns_correctly():
    """The precedence map itself must encode the documented order:

    ``depleted`` > ``in_flight_pickup`` > ``consumed_or_removed``
    """
    assert (
        CLOUD_PATTERN_PRECEDENCE["depleted"]
        > CLOUD_PATTERN_PRECEDENCE["in_flight_pickup"]
        > CLOUD_PATTERN_PRECEDENCE["consumed_or_removed"]
    ), (
        "precedence map order drifted — see the CLOUD_PATTERN_PRECEDENCE "
        "docstring for the rationale (reversing the last two recreates "
        "the 2026-04-22 phantom-qty bug)"
    )
