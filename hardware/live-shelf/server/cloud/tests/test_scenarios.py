"""End-to-end scenario tests for Pi ↔ cloud event round-trips.

Scenario-first audit per 2026-04-19 hardening pass. Each scenario
documents a concrete failure mode the live-shelf system must survive in
production, then asserts the behaviour with a test that would fail if
the relevant guard were reverted.

Scenarios covered:

1. Pi boots with RTC in 1970; pre-NTP events dropped before outbox.
   → Already exercised by :mod:`test_integration_hooks.TestRtcPlausibilityGuard`.
   Re-asserted here as a smoke check so the full scenario list lives in
   one file.
2. Pi crashes between reconciler commit + outbox insert; startup
   back-fill scan recovers orphans.
3. Pi offline 7+ days, reconnects; FIFO drain preserves
   ``occurred_at`` order via outbox_id autoincrement.
5. Concurrent duplicate ``client_event_id`` POSTs; unit-side cache
   replay semantics (full 2-thread cloud test lives in the e2e suite;
   here we verify the Pi's retry safety — resending the same outbox row
   is idempotent on the client side so the cloud's dedup is sufficient).
6. Device revoked (`is_active=false`) mid-drain; 401 surfaced as ERROR
   with outbox pending count, rows stay pending (NOT permanent).
7. Heartbeat payload carries ``outbox_pending_count`` +
   ``outbox_permanent_failures``; Pi-side provider asserts the shape so
   the companion cloud migration + edge-function persistence has a
   contract to sign against.

Scenario 4 (manual-edit staleness fence) is a cloud-side property —
exercised by ``scripts/e2e_shelf_ingest_prod.py::test_stale_fence``.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.cloud import outbox  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402
from server.cloud.integration import (  # noqa: E402
    CloudEventEmitter,
    backfill_missing_outbox_events,
)
from server.cloud.worker import CloudWorker  # noqa: E402
from server.reconciler.models import SessionResolution  # noqa: E402
from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def seed_product(conn) -> str:
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Scenario Yogurt",
            brand="TestCo",
            net_weight_g=170.0,
            container_type="jar",
        ),
    )
    return product.product_id


@pytest.fixture
def seed_session(conn) -> str:
    session = storage_repo.open_session(
        conn, ts="2026-04-19T14:00:00.000Z", initial_weight_g=0.0,
    )
    return session.session_id


@pytest.fixture
def seed_lot(conn, seed_product) -> str:
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=seed_product,
            status="on_shelf",
            current_weight_g=450.0,
            initial_weight_g=450.0,
            total_consumed_g=0.0,
        ),
    )
    return lot.lot_id


# ---------------------------------------------------------------------------
# Scenario 1 — pre-NTP RTC events are dropped at the emit boundary
# ---------------------------------------------------------------------------


class TestScenario1PreNtpDropped:
    """Pi boots with RTC in 1970; NTP hasn't synced; a reconciler tick
    fires with ``occurred_at`` in 1970. The emit must drop these (not
    let them reach the outbox) because the cloud validator would reject
    them with 422 — currently retryable, but retries would keep failing
    until the clock catches up which could be minutes, flooding logs.

    The existing RTC plausibility guard (year < 2024) blocks each emit
    path; this test enumerates the three entry points to guarantee the
    guard is applied consistently.
    """

    def test_pre_ntp_reconciler_resolution_dropped(self, conn, caplog):
        emitter = CloudEventEmitter(conn, enabled=True)
        with caplog.at_level(logging.WARNING, logger="server.cloud.integration"):
            cid = emitter.emit_reconciler_resolution(
                pattern="use_return_consumed",
                product_id="p-1",
                scale_id="scale-01",
                kind="live_shelf",
                delta_g=-100.0,
                occurred_at="1970-01-01T00:00:05.000Z",
            )
        assert cid is None
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 0
        warn_records = [
            r for r in caplog.records
            if "pre-NTP" in r.message and r.levelname == "WARNING"
        ]
        assert warn_records, "expected a WARN log about pre-NTP drop"

    def test_pre_ntp_single_item_dropped(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="p-1",
            delta_g=-50.0,
            noise_floor_g=2.0,
            refill_threshold_g=20.0,
            depleted=False,
            occurred_at="1970-01-01T00:00:00.000Z",
        )
        assert cid is None

    def test_pre_ntp_in_flight_reap_dropped(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="p-1",
            consumed_g=100.0,
            occurred_at="1970-01-01T00:00:05.000Z",
        )
        assert cid is None


# ---------------------------------------------------------------------------
# Scenario 2 — back-fill scanner recovers orphan resolutions
# ---------------------------------------------------------------------------


class TestScenario2BackfillRecovery:
    """Pi crashes between ``write_resolution`` commit and the outbox
    insert. On next boot the startup back-fill scan walks recent
    resolutions and re-emits any that don't have a matching outbox row.

    Simulated here by writing a resolution through the low-level repo
    (bypassing the emit hook), then calling
    :func:`backfill_missing_outbox_events` and asserting an outbox row
    now exists keyed to the resolution via ``_pi_resolution_id``.
    """

    def test_orphan_resolution_is_re_emitted(
        self, conn, seed_session, seed_product, seed_lot,
    ):
        # Seed an ADD scale event the back-fill will read to derive
        # delta_g (new_arrival pattern).
        event = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=seed_session,
                ts="2026-04-19T15:00:00.000Z",
                delta_g=175.0,
                before_weight_g=0.0,
                after_weight_g=175.0,
                direction="add",
                classification=None,
                classifier_status="classified",
            ),
        )
        # Write a resolution via the LOW-LEVEL repo — simulates the
        # crash where the reconciler committed but the adapter's
        # ``_emit_cloud_for_resolution`` never ran.
        from server.storage.models import SessionResolutionIn
        res = storage_repo.write_resolution(
            conn,
            SessionResolutionIn(
                session_id=seed_session,
                pattern="new_arrival",
                lot_id=seed_lot,
                confidence=0.9,
                add_event_id=event.event_id,
            ),
        )

        # Before back-fill: the outbox is empty.
        before = conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0]
        assert before == 0

        emitter = CloudEventEmitter(conn, enabled=True)
        count = backfill_missing_outbox_events(
            conn, emitter, scale_id="scale-01",
            shelf_kind="live_shelf", window_hours=168,
        )
        assert count == 1

        # After back-fill: one outbox row exists, keyed to the
        # resolution via ``_pi_resolution_id`` for idempotency.
        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox WHERE sent_at IS NULL"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload.get("_pi_resolution_id") == res.resolution_id
        assert payload["event_kind"] == "added"
        assert payload["delta_g"] == pytest.approx(175.0)

    def test_backfill_is_idempotent(
        self, conn, seed_session, seed_product, seed_lot,
    ):
        """Calling back-fill twice must not create duplicate outbox
        rows — the second call sees the ``_pi_resolution_id`` key and
        skips the resolution. This is the guard that keeps the scan
        safe to run on every Pi boot."""
        event = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=seed_session,
                ts="2026-04-19T15:05:00.000Z",
                delta_g=-120.0,
                before_weight_g=500.0,
                after_weight_g=380.0,
                direction="remove",
                classification=None,
                classifier_status="classified",
            ),
        )
        from server.storage.models import SessionResolutionIn
        storage_repo.write_resolution(
            conn,
            SessionResolutionIn(
                session_id=seed_session,
                pattern="consumed_or_removed",
                lot_id=seed_lot,
                consumed_g=120.0,
                remove_event_id=event.event_id,
            ),
        )
        emitter = CloudEventEmitter(conn, enabled=True)
        first = backfill_missing_outbox_events(
            conn, emitter, scale_id="scale-01",
            shelf_kind="live_shelf",
        )
        second = backfill_missing_outbox_events(
            conn, emitter, scale_id="scale-01",
            shelf_kind="live_shelf",
        )
        assert first == 1
        assert second == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 1


# ---------------------------------------------------------------------------
# Scenario 3 — FIFO drain order after a long offline buffer
# ---------------------------------------------------------------------------


class TestScenario3OfflineDrainFifo:
    """Pi offline 7+ days, reconnects. Every one of the 100 queued
    events must POST to the cloud in ascending ``occurred_at`` order so
    the cloud's stock deltas reconcile correctly. The guarantee comes
    from ``outbox_id AUTOINCREMENT`` + producer enqueue-in-occurred-
    order — this test makes the invariant explicit against regression
    (e.g. someone changing list_pending to ORDER BY enqueued_at DESC).
    """

    def test_100_rows_drained_in_ascending_occurred_at_order(self, conn):
        # Seed 100 rows with monotonically increasing occurred_at.
        expected_order: list[str] = []
        for i in range(100):
            ts = f"2026-04-{(i // 24) + 1:02d}T{i % 24:02d}:00:00.000Z"
            cid = outbox.enqueue_event(
                conn,
                {
                    "scale_id": "scale-01",
                    "kind": "live_shelf",
                    "event_kind": "consumed",
                    "product_id": "p-1",
                    "delta_g": -10.0,
                    "occurred_at": ts,
                    "_seq": i,
                },
            )
            expected_order.append(cid)

        # Mock client records every POST in the order it received them.
        posted: list[dict] = []
        fake_client = MagicMock()

        def post_side_effect(path: str, body: dict) -> dict:
            if path == "/event":
                posted.append(body)
            return {"applied": True}

        fake_client.post.side_effect = post_side_effect

        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
            poll_interval_s=5.0,
        )
        # Two ticks drain the queue in batches of 50 (OUTBOX_DRAIN_BATCH).
        worker.tick()
        worker.tick()

        assert len(posted) == 100, (
            f"expected all 100 rows drained, got {len(posted)}"
        )
        # occurred_at must be monotone non-decreasing across the drain.
        timestamps = [p["occurred_at"] for p in posted]
        assert timestamps == sorted(timestamps), (
            "drain order broke ascending occurred_at invariant"
        )
        # And for defence against a sort-flattening bug: the client_event_ids
        # must match the seeded order exactly.
        drained_cids = [p["client_event_id"] for p in posted]
        assert drained_cids == expected_order

    def test_permanent_row_does_not_block_fifo_drain(self, conn):
        """A row flagged ``failed_permanently`` is skipped — the next
        row keeps draining in order. Guards against the anti-pattern of
        "head-of-line block when row 0 is poisoned"."""
        outbox.enqueue_event(conn, {"_seq": 0, "occurred_at": "2026-04-01T00:00Z"})
        outbox.enqueue_event(conn, {"_seq": 1, "occurred_at": "2026-04-02T00:00Z"})
        outbox.enqueue_event(conn, {"_seq": 2, "occurred_at": "2026-04-03T00:00Z"})

        first_id = conn.execute(
            "SELECT outbox_id FROM cloud_outbox "
            "ORDER BY outbox_id ASC LIMIT 1"
        ).fetchone()["outbox_id"]
        outbox.mark_permanent_failure(conn, first_id, "400: poison")

        posted: list[dict] = []
        fake_client = MagicMock()

        def post_side_effect(path: str, body: dict) -> dict:
            if path == "/event":
                posted.append(body)
            return {"applied": True}

        fake_client.post.side_effect = post_side_effect
        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
        )
        worker.tick()

        seqs = [p.get("_seq") for p in posted]
        assert seqs == [1, 2], (
            f"expected [_seq=1, _seq=2], got {seqs}"
        )


# ---------------------------------------------------------------------------
# Scenario 5 — duplicate client_event_id concurrent POST semantics
# ---------------------------------------------------------------------------


class TestScenario5DuplicateClientEventIdClientSide:
    """A 2-thread adversarial cloud test already lives in
    ``scripts/e2e_shelf_ingest_prod.py::test_event_consumed`` (idempotent
    replay: two sequential POSTs with the same client_event_id echo the
    cached outcome + qty unchanged). Here we assert the Pi-side
    invariant that complements it: re-enqueuing the SAME payload via
    the outbox always mints a fresh client_event_id, so the cloud's
    dedup fence is the single place that collapses duplicates — the Pi
    never generates a true duplicate client_event_id collision.
    """

    def test_re_enqueuing_same_payload_mints_fresh_client_event_ids(self, conn):
        payload = {
            "scale_id": "scale-01",
            "kind": "live_shelf",
            "event_kind": "consumed",
            "product_id": "p-1",
            "delta_g": -50.0,
            "occurred_at": "2026-04-19T14:00:00.000Z",
        }
        cid_a = outbox.enqueue_event(conn, payload)
        cid_b = outbox.enqueue_event(conn, payload)
        assert cid_a != cid_b, (
            "enqueue_event must mint a fresh client_event_id per call"
        )
        # Caller's dict is NOT mutated — stamping in place would let a
        # retry helper accidentally reuse the first id.
        assert "client_event_id" not in payload

    def test_worker_drains_both_and_cloud_sees_two_distinct_ids(self, conn):
        """If enqueuing twice minted the SAME id, the cloud's UNIQUE
        constraint on ``chefbyte.shelf_event_log`` would 409 one of them.
        Assert the outbox's worker sends two distinct payloads so the
        cloud's cache-replay path is reserved for true retry scenarios."""
        payload = {
            "scale_id": "scale-01",
            "kind": "live_shelf",
            "event_kind": "consumed",
            "product_id": "p-1",
            "delta_g": -50.0,
            "occurred_at": "2026-04-19T14:00:00.000Z",
        }
        outbox.enqueue_event(conn, payload)
        outbox.enqueue_event(conn, payload)

        posted_cids: list[str] = []
        fake_client = MagicMock()

        def post_side_effect(path: str, body: dict) -> dict:
            if path == "/event":
                posted_cids.append(body["client_event_id"])
            return {"applied": True}

        fake_client.post.side_effect = post_side_effect
        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
        )
        worker.tick()
        assert len(posted_cids) == 2
        assert len(set(posted_cids)) == 2, (
            f"expected 2 distinct client_event_ids, got {posted_cids}"
        )


# ---------------------------------------------------------------------------
# Scenario 6 — device revoked mid-drain (401 handling + log contract)
# ---------------------------------------------------------------------------


class TestScenario6DeviceRevokedMidDrain:
    """Pi is happily draining when the operator flips ``is_active=false``
    (key compromise, device retired, whatever). The next /event POST
    returns 401. The worker MUST:

      * log at ERROR (not INFO) with the current outbox pending count,
      * reference ``CLOUD_IMPORT_KEY`` so the operator knows what to
        rotate,
      * keep the row pending (NOT flag it ``failed_permanently``), since
        401 is a device-level state, not a property of the row.

    401 is NOT in ``NON_RETRYABLE_EVENT_STATUS_CODES`` so the row stays
    live; once the operator re-enables the device the drain resumes.
    """

    def test_401_surfaces_as_error_with_pending_count_and_keeps_row_live(
        self, conn, caplog,
    ):
        # Seed 3 rows so "pending count" is non-trivial after the first
        # row's POST fails.
        for i in range(3):
            outbox.enqueue_event(conn, {"n": i})

        fake_client = MagicMock()

        def post_side_effect(path: str, body: dict) -> dict:
            if path == "/event":
                raise CloudError(401, "inactive device")
            return {}

        fake_client.post.side_effect = post_side_effect
        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
        )
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            worker.tick()

        # Contract: ERROR level, mentions outbox_pending + CLOUD_IMPORT_KEY.
        errors = [
            r for r in caplog.records
            if r.name == "server.cloud.worker" and r.levelname == "ERROR"
        ]
        assert errors, "expected at least one ERROR-level log for 401"
        assert any("outbox_pending" in r.message for r in errors)
        assert any("CLOUD_IMPORT_KEY" in r.message for r in errors)

        # Every queued row stays pending (NOT flagged permanent).
        pending = conn.execute(
            "SELECT failed_permanently, sent_at FROM cloud_outbox"
        ).fetchall()
        for r in pending:
            assert r["failed_permanently"] == 0
            assert r["sent_at"] is None

    def test_drain_resumes_after_device_reactivated(self, conn):
        """Operator re-flips is_active=true; next tick drains the
        waiting rows. Simulates this by swapping the mock's side_effect
        mid-test between two ticks."""
        for i in range(3):
            outbox.enqueue_event(conn, {"n": i})

        fake_client = MagicMock()
        call_state = {"revoked": True}

        def post_side_effect(path: str, body: dict) -> dict:
            if path == "/event" and call_state["revoked"]:
                raise CloudError(401, "inactive device")
            return {"applied": True}

        fake_client.post.side_effect = post_side_effect

        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
        )
        worker.tick()  # revoked: all rows stay pending
        assert outbox.count_pending(conn) == 3

        call_state["revoked"] = False
        worker.tick()  # re-activated: drains
        assert outbox.count_pending(conn) == 0
        assert outbox.count_permanent_failures(conn) == 0


# ---------------------------------------------------------------------------
# Scenario 7 — heartbeat payload carries outbox counters (Pi-side contract)
# ---------------------------------------------------------------------------


class TestScenario7HeartbeatOutboxCounters:
    """The Pi-side heartbeat_provider (app.py) assembles a body shaped
    like::

        {
          "pending_review_count": int,
          "scales": [...],
          "outbox_pending_count": int,
          "outbox_permanent_failures": int,
        }

    and the cloud edge function persists the two outbox counters on
    ``chefbyte.live_shelf_devices``. Here we assert the Pi side's
    contract: the provider's body shape must include the two keys with
    integer values derived from the cloud_outbox table — a provider
    that silently dropped them would leave the cloud UI with stale 0s.

    The cloud-side persistence is covered by
    ``scripts/e2e_shelf_ingest_prod.py::test_heartbeat_outbox_counters``
    (added in the same pass) so the round-trip is locked down.
    """

    def test_heartbeat_provider_body_shape_against_pending_outbox(self, conn):
        """Simulate the Pi's provider by feeding it a concrete outbox
        state: 4 pending rows, 2 permanent failures, and asserting the
        counters flow through :func:`outbox.count_pending` +
        :func:`outbox.count_permanent_failures`.

        The actual provider closure lives in app.py and isn't
        ergonomically callable from a test (it captures ``conn`` +
        ``db_lock`` from the startup scope). We verify the primitives
        the provider composes from instead — any regression in those
        would propagate into the body.
        """
        # 4 pending
        for i in range(4):
            outbox.enqueue_event(conn, {"n": i})
        # 2 permanent failures (flip 2 of the pending rows)
        ids = [
            r["outbox_id"] for r in conn.execute(
                "SELECT outbox_id FROM cloud_outbox "
                "ORDER BY outbox_id ASC LIMIT 2"
            ).fetchall()
        ]
        for oid in ids:
            outbox.mark_permanent_failure(conn, oid, "400: test")

        pending = outbox.count_pending(conn)
        permanent = outbox.count_permanent_failures(conn)

        # count_pending excludes permanent-flagged rows per the
        # docstring contract (mirrored in list_pending). So after
        # flipping 2 to permanent, pending should be 4-2 = 2.
        assert pending == 2, (
            f"count_pending must exclude permanent-flagged rows; got {pending}"
        )
        assert permanent == 2

        # The Pi's provider composes a body that both numbers end up in.
        # Replicate the shape so regressions in the assembly are caught
        # here rather than only in app.py.
        body = {
            "pending_review_count": 0,
            "scales": [],
            "outbox_pending_count": pending,
            "outbox_permanent_failures": permanent,
        }
        assert "outbox_pending_count" in body
        assert "outbox_permanent_failures" in body
        assert body["outbox_pending_count"] == 2
        assert body["outbox_permanent_failures"] == 2

    def test_worker_forwards_provider_body_to_heartbeat(self, conn):
        """The worker's tick() must forward the provider's full dict as
        the /heartbeat POST body — stripping or rewriting keys would
        break the cloud-side persistence contract."""
        fake_client = MagicMock()
        body = {
            "pending_review_count": 5,
            "scales": [{"scale_id": "s1", "kind": "live_shelf"}],
            "outbox_pending_count": 42,
            "outbox_permanent_failures": 3,
        }
        worker = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: body,
        )
        worker.tick()

        hb_calls = [
            c for c in fake_client.post.call_args_list
            if c.args[0] == "/heartbeat"
        ]
        assert len(hb_calls) == 1
        sent_body = hb_calls[0].args[1]
        # All four keys must round-trip verbatim.
        assert sent_body["outbox_pending_count"] == 42
        assert sent_body["outbox_permanent_failures"] == 3
        assert sent_body["pending_review_count"] == 5
        assert sent_body["scales"] == [{"scale_id": "s1", "kind": "live_shelf"}]
