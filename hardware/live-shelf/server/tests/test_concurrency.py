"""Concurrency-safety regression tests.

Covers three independent race conditions that have been fixed in prod:

1. ``_classify_recorded_event`` atomically claims the row via a
   conditional UPDATE — two simultaneous dispatches for the same event
   must NOT both write classification / lot updates.

2. ``reconcile_session`` serializes same-session calls via a per-session
   lock so two concurrent reconciles can't duplicate session_resolutions.

3. ``_dispatch_classification`` uses a BoundedSemaphore(value=3) to cap
   concurrent Anthropic calls — burst of 5 must queue 2.

Uses ``threading.Event`` / ``Barrier`` for synchronization — never
wall-clock sleeps — so tests are deterministic.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.anthropic_client import ClassifierCallResult  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.reconciler.reconcile import reconcile_session  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import (  # noqa: E402
    LotIn,
    ProductIn,
    ScaleEventIn,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _BarrierAnthropicClient:
    """Classifier that blocks on a barrier + event so the test can
    orchestrate precise thread choreography.
    """

    def __init__(
        self,
        payload: dict[str, Any],
        *,
        barrier: threading.Barrier,
        release: threading.Event,
    ) -> None:
        self._payload = payload
        self._barrier = barrier
        self._release = release
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def send(self, payload, *, model=None, max_tokens=512):
        with self._lock:
            self.calls.append({"payload": payload, "model": model})
        # Announce we've entered; wait until both threads have made it in.
        # Short timeout — if only one thread arrives (the expected
        # atomic-claim outcome) we fall through quickly.
        try:
            self._barrier.wait(timeout=0.3)
        except threading.BrokenBarrierError:
            # Only one thread made it in — that's the expected outcome
            # when the atomic-claim blocks the second.
            pass
        self._release.wait(timeout=5.0)
        return ClassifierCallResult(
            text=json.dumps(self._payload),
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 10, "output_tokens": 5},
            raw=None,
        )


def _make_handler(
    conn: sqlite3.Connection,
    client: Any,
    tmp_path: Path,
    *,
    candidate_source: Any = None,
) -> ScaleHandler:
    """Minimal ScaleHandler wired for these tests — no camera needed.

    ``candidate_source`` defaults to a null stub (empty pools). Tests
    that need classifier.send() to actually fire for REMOVE events must
    pass a source that returns at least one lot, since pool_for_remove
    short-circuits when the pool is empty.
    """
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)

    class _NullCandidateSource:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,  # not used by the methods we exercise
        candidate_source=candidate_source or _NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=client,
    )


class _LotBackedCandidateSource:
    """Thin CandidateSource that returns the single seeded lot from an
    in-memory DB. Used when the test needs classify_event to reach
    client.send() for a REMOVE event.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get_on_shelf_lots(self):
        from server.classifier.models import LotCandidate

        rows = self._conn.execute(
            """
            SELECT l.lot_id, l.product_id, p.name, p.brand,
                   l.current_weight_g, p.container_type, l.status
              FROM lots l
              JOIN products p ON p.product_id = l.product_id
             WHERE l.status = 'on_shelf'
            """
        ).fetchall()
        return [
            LotCandidate(
                lot_id=r["lot_id"],
                product_id=r["product_id"],
                name=r["name"],
                brand=r["brand"],
                expected_weight_g=r["current_weight_g"],
                container_type=r["container_type"],
                status="on_shelf",
                reference_image_paths=(),
            )
            for r in rows
        ]

    def get_recently_out_lots(self, window_seconds):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _seed_product_lot_and_event(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> tuple[str, str, str]:
    """Seed a product + on_shelf lot + pending REMOVE event + after.jpg.

    Returns (product_id, lot_id, event_id).
    """
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Conc Test",
            barcode="777777",
            brand="T",
            net_weight_g=200.0,
            gross_weight_g=200.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=200.0,
            initial_weight_g=200.0,
        ),
    )
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-15T12:00:00.000Z",
            delta_g=-200.0,
            before_weight_g=400.0,
            after_weight_g=200.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    # Create after.jpg — _classify_recorded_event needs it present so the
    # capture copy step succeeds.
    after_src = tmp_path / "after.jpg"
    after_src.write_bytes(b"\xff\xd8\xff\xd9")  # minimal JPEG sentinel
    before_src = tmp_path / "before.jpg"
    before_src.write_bytes(b"\xff\xd8\xff\xd9")
    return product.product_id, lot.lot_id, ev.event_id


# ---------------------------------------------------------------------------
# 1. Atomic claim
# ---------------------------------------------------------------------------


def test_claim_is_atomic_under_concurrent_dispatch(tmp_path: Path):
    """Two threads call ``_classify_recorded_event`` for the same event
    simultaneously. The conditional UPDATE (pending → classifying) is the
    only dedup gate — exactly one thread must reach the classifier and
    write results. The other's rowcount==0 early-return path must fire.
    """
    conn = init_db(":memory:")
    _, lot_id, event_id = _seed_product_lot_and_event(conn, tmp_path)

    # Both threads will enter send() simultaneously via the barrier — but
    # only ONE should get that far, because the atomic claim blocks the
    # other before it even builds the classifier call. We use timeout=0.5
    # on the barrier so the "didn't-enter" thread isn't stuck forever.
    barrier = threading.Barrier(2, timeout=0.5)
    release = threading.Event()
    release.set()  # Let whoever enters send() proceed immediately.
    client = _BarrierAnthropicClient(
        {
            "item_id": lot_id,
            "action": "removed",
            "confidence": 0.95,
            "reasoning": "atomic-claim test",
            "multi_match": [],
        },
        barrier=barrier,
        release=release,
    )
    handler = _make_handler(
        conn, client, tmp_path,
        candidate_source=_LotBackedCandidateSource(conn),
    )

    session = {
        "open_ts": "2026-04-15T11:59:00.000Z",
        "close_ts": "2026-04-15T12:01:00.000Z",
        "before_path": str(tmp_path / "before.jpg"),
        "after_path": str(tmp_path / "after.jpg"),
        "video_path": None,
    }

    errors: list[BaseException] = []

    def _call():
        try:
            handler._classify_recorded_event(event_id, session)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t1 = threading.Thread(target=_call)
    t2 = threading.Thread(target=_call)
    t1.start()
    t2.start()
    t1.join(timeout=10.0)
    t2.join(timeout=10.0)

    assert errors == [], f"unexpected thread errors: {errors}"

    # Exactly one thread should have sent to the classifier. The other
    # must have returned immediately (rowcount==0 on the UPDATE claim).
    assert len(client.calls) == 1, (
        f"expected exactly 1 classifier call (atomic claim); got {len(client.calls)}"
    )

    # Review queue must contain 0 rows for this event (confident ADD/REMOVE
    # with a valid candidate produces no review row).
    review_rows = conn.execute(
        "SELECT COUNT(*) FROM review_queue WHERE event_id = ?", (event_id,)
    ).fetchone()[0]
    assert review_rows == 0

    # The event must be in 'classified' status (one winner wrote it).
    status = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (event_id,),
    ).fetchone()[0]
    assert status == "classified"


# ---------------------------------------------------------------------------
# 2. Per-session reconcile lock
# ---------------------------------------------------------------------------


def test_reconcile_session_per_session_lock_blocks_concurrent_calls():
    """Two ``reconcile_session`` calls for the same session must NOT both
    pass the read-check + write resolutions. The per-session lock in
    ``_SESSION_RECONCILE_LOCKS`` serializes them so only ONE pass emits
    write_resolution calls; the other sees reconciled=1 and bails.
    """
    from dataclasses import dataclass, field
    from typing import Optional

    from server.reconciler.models import (  # noqa: E402
        ClassificationResult,
        ReviewQueueItem,
        SessionResolution,
    )

    entered = threading.Event()
    proceed = threading.Event()

    @dataclass
    class _FakeSession:
        session_id: str = "S1"
        started_at: str = "2026-04-15T12:00:00Z"
        ended_at: Optional[str] = "2026-04-15T12:05:00Z"
        initial_shelf_weight_g: Optional[float] = 1000.0
        final_shelf_weight_g: Optional[float] = 1000.0
        reconciled: int = 0

    @dataclass
    class _FakeEvent:
        event_id: str
        session_id: Optional[str]
        ts: str
        delta_g: float
        before_weight_g: float
        after_weight_g: float
        direction: str
        classification: Any = None

    @dataclass
    class _FakeRepo:
        session_obj: _FakeSession = field(default_factory=_FakeSession)
        events: list = field(default_factory=list)
        written: list = field(default_factory=list)
        reviews: list = field(default_factory=list)
        calls: int = 0
        lock: threading.Lock = field(default_factory=threading.Lock)

        def get_session(self, session_id: str):
            # On the SECOND call, flip reconciled=1 so the inner guard fires.
            return self.session_obj

        def get_events_for_session(self, session_id: str):
            # This is the blocking point — first caller waits here so the
            # second caller has time to reach the per-session lock.
            with self.lock:
                self.calls += 1
                is_first = self.calls == 1
            if is_first:
                entered.set()
                proceed.wait(timeout=5.0)
            return list(self.events)

        def get_lot(self, lot_id: str):
            return None

        def write_resolution(self, r) -> Optional[str]:
            self.written.append(r)
            return f"res-{len(self.written)}"

        def enqueue_review(self, item) -> None:
            self.reviews.append(item)

        def update_lot_on_resolution(self, r, lot) -> None:
            pass

    # Seed a minimal event so reconcile does some real work (no_op path
    # would also work but this exercises a real resolution write).
    cls_json = ClassificationResult(
        item_id="UNKNOWN",
        confidence=0.0,
        action="unknown",
        reasoning="",
        multi_match=(),
    )
    repo = _FakeRepo()
    repo.events = [
        _FakeEvent(
            event_id="E1",
            session_id="S1",
            ts="2026-04-15T12:01:00Z",
            delta_g=-100.0,
            before_weight_g=1000.0,
            after_weight_g=900.0,
            direction="remove",
            classification=cls_json,
        )
    ]

    errors: list[BaseException] = []

    def _call():
        try:
            reconcile_session("S1", repo)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t1 = threading.Thread(target=_call, name="recon-1")
    t1.start()
    # Wait for t1 to actually enter get_events_for_session.
    assert entered.wait(timeout=3.0)
    # At this point t1 holds the per-session lock. Kick off t2 — it will
    # block on the lock, NOT call get_events_for_session yet.
    t2 = threading.Thread(target=_call, name="recon-2")
    t2.start()
    # Before releasing t1, flip reconciled=1 so the second caller's
    # inner early-return check fires (mimicking mark_session_reconciled).
    repo.session_obj.reconciled = 1
    proceed.set()
    t1.join(timeout=5.0)
    t2.join(timeout=5.0)

    assert errors == [], f"unexpected errors: {errors}"
    # Only the first pass called write_resolution; the second returned
    # early because reconciled=1 when it acquired the lock.
    # Events list has 1 REMOVE, unidentified → Pass 2 emits one
    # 'unknown' resolution.
    assert len(repo.written) == 1, (
        f"expected exactly 1 resolution write (serialized + idempotent); "
        f"got {len(repo.written)}"
    )


# ---------------------------------------------------------------------------
# 3. Bounded classification semaphore
# ---------------------------------------------------------------------------


def test_dispatch_classification_semaphore_bounds_to_3(tmp_path: Path):
    """Fire 5 ``_dispatch_classification`` calls with a classifier that
    blocks forever. Only 3 should enter the classifier stub; the other 2
    must queue on the semaphore.
    """
    conn = init_db(":memory:")

    in_flight = threading.Semaphore(0)  # release one permit per entry
    hold = threading.Event()  # keeps every entered thread pinned
    active_lock = threading.Lock()
    active = 0
    max_concurrent = 0
    enter_count = 0

    class _Client:
        def send(self, payload, *, model=None, max_tokens=512):
            nonlocal active, max_concurrent, enter_count
            with active_lock:
                active += 1
                enter_count += 1
                if active > max_concurrent:
                    max_concurrent = active
            in_flight.release()
            try:
                hold.wait(timeout=5.0)
                return ClassifierCallResult(
                    text=json.dumps({
                        "item_id": "UNKNOWN",
                        "action": "unknown",
                        "confidence": 0.0,
                        "reasoning": "",
                        "multi_match": [],
                    }),
                    model=model or "claude-sonnet-4-6",
                    usage={"input_tokens": 1, "output_tokens": 1},
                    raw=None,
                )
            finally:
                with active_lock:
                    active -= 1

    client = _Client()
    handler = _make_handler(conn, client, tmp_path)

    # Seed 5 distinct events + minimal frame files.
    (tmp_path / "before.jpg").write_bytes(b"\xff\xd8\xff\xd9")
    (tmp_path / "after.jpg").write_bytes(b"\xff\xd8\xff\xd9")
    event_ids: list[str] = []
    for i in range(5):
        storage_repo.create_product(
            conn,
            ProductIn(
                name=f"S{i}",
                barcode=f"B{i:06d}",
                net_weight_g=100.0,
                gross_weight_g=100.0,
                unit_type="solid",
                container_type="tray",
                certified=1,
            ),
        )
        # ADD direction — pool_for_add always appends the UNKNOWN
        # sentinel, so classify_event always calls client.send() (even
        # with a null candidate source). REMOVE with an empty pool
        # would short-circuit to _unknown_result without a send() call,
        # which is the wrong behavior to test here.
        ev = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                ts=f"2026-04-15T12:00:{i:02d}.000Z",
                delta_g=100.0,
                before_weight_g=100.0,
                after_weight_g=200.0,
                direction="add",
                session_id=None,
                classifier_status="pending",
            ),
        )
        event_ids.append(ev.event_id)

    session = {
        "open_ts": "2026-04-15T11:59:00.000Z",
        "close_ts": "2026-04-15T12:01:00.000Z",
        "before_path": str(tmp_path / "before.jpg"),
        "after_path": str(tmp_path / "after.jpg"),
        "video_path": None,
    }

    # Fire all 5 dispatches.
    for eid in event_ids:
        handler._dispatch_classification(eid, session)

    # Wait for 3 threads to reach send() — the 4th and 5th must NOT
    # enter. We wait for 3 permits to be released.
    for _ in range(3):
        assert in_flight.acquire(timeout=3.0), (
            "timed out waiting for a dispatched classification to enter send()"
        )

    # Give any 4th attempt ~100ms grace — but we use an Event instead of
    # sleep: poll in_flight with zero timeout to confirm no extra permits.
    got_extra = in_flight.acquire(timeout=0.2)
    assert not got_extra, (
        f"expected at most 3 concurrent classifier calls; a 4th entered"
    )

    # Release everyone so the threads can exit cleanly.
    hold.set()

    # Drain remaining 2 permits (the 4th + 5th will now enter as
    # predecessors release).
    for _ in range(2):
        assert in_flight.acquire(timeout=3.0)

    assert max_concurrent == 3, (
        f"semaphore should cap concurrency at 3; observed max={max_concurrent}"
    )
    assert enter_count == 5, (
        f"all 5 should eventually run (after queueing); got {enter_count}"
    )
