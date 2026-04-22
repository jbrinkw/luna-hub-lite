"""Drain idempotency — Pi crash between POST success and mark_sent.

Bug 3 failure mode (2026-04-22):
  1. Drain picks up outbox row R with client_event_id = X.
  2. Worker POSTs /event → cloud ``apply_shelf_event_admin`` runs
     successfully and INSERTs into shelf_event_log.
  3. Network / HTTP response path drops (timeout, socket reset, Pi
     power loss) BEFORE the client sees the 200.
  4. Pi restarts. Row R is still ``sent_at IS NULL`` because
     ``mark_sent`` never executed.
  5. Next drain tick re-POSTs R with the SAME client_event_id X.

At step 5, the cloud's ``apply_shelf_event_admin`` hits
``INSERT ... ON CONFLICT (user_id, client_event_id) DO NOTHING``
(migration 20260419060000_shelf_ingest_hardening_v2.sql, lines 85-100).
The conflict branch re-reads the cached outcome — applied /
resolved_lot_id / reason — and returns it verbatim. No double-apply of
stock / macros; just a cheap replay.

So the Pi-side ``mark_sent`` being AFTER the POST is safe. This test
simulates the full crash + replay sequence against a stub cloud that
mimics the plpgsql dedupe logic and asserts:

  (a) Row R is re-sent on the second tick (it MUST be — Pi doesn't
      know the first POST succeeded).
  (b) Cloud's stub dedupes: counts the unique client_event_ids it
      received, not the call count. One unique id = one logical event
      applied, even across N retries.
  (c) After the replay succeeds, the row is marked sent and never
      re-sent again (steady state).

The test drives the multi-call sequence (POST succeeds → simulated
crash → restart → POST replays → mark_sent) as a single function so
the crash-window behavior is verified as a whole rather than via
three isolated unit tests that might pass individually while the
composed flow breaks.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud import outbox  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402
from server.cloud.worker import CloudWorker  # noqa: E402
from server.storage import init_db  # noqa: E402


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


class _DedupingCloudStub:
    """Stands in for the Supabase edge fn + ``apply_shelf_event_admin``.

    The real plpgsql:
      1. INSERT INTO shelf_event_log (user_id, client_event_id, ...)
         ON CONFLICT (user_id, client_event_id) DO NOTHING
         RETURNING event_id
      2. If RETURNING is NULL (= duplicate), SELECT the cached
         applied / resolved_lot_id / reason and return that.
      3. Otherwise, apply the mutation + cache the outcome.

    Here we replicate the observable behavior: seen ``client_event_id``
    values replay the first response; new ids append and apply.
    """

    def __init__(self) -> None:
        # Map client_event_id → (response_dict, apply_count).
        # apply_count tracks ACTUAL stock/macro application; we assert
        # it never exceeds 1 per unique id, which is the idempotency
        # contract of apply_shelf_event_admin.
        self._cache: dict[str, dict] = {}
        self._apply_counts: dict[str, int] = {}
        self._call_log: list[str] = []
        # When non-None, the next POST raises this instead of
        # returning. Used to simulate a dropped response AFTER the
        # cloud has already done its INSERT.
        self._simulate_response_drop_for: set[str] = set()
        # Count how many POSTs we actually received per id.
        self._post_counts: dict[str, int] = {}

    def simulate_dropped_response(self, client_event_id: str) -> None:
        """Next POST carrying ``client_event_id`` will raise a
        CloudError AFTER the cloud-side apply/cache has committed —
        this is the exact Bug 3 failure mode."""
        self._simulate_response_drop_for.add(client_event_id)

    def post(self, path: str, body: dict) -> dict:
        self._call_log.append(path)
        if path == "/heartbeat":
            return {"ok": True}
        if path != "/event":
            raise AssertionError(f"unexpected path {path!r}")

        cid = body.get("client_event_id")
        assert cid, "Pi must send client_event_id on every POST"
        self._post_counts[cid] = self._post_counts.get(cid, 0) + 1

        # Apply-or-replay (mirrors apply_shelf_event_admin.sql):
        if cid in self._cache:
            # Duplicate ID: replay the cached outcome. No apply.
            response = dict(self._cache[cid])
            response["_was_replay"] = True
        else:
            # New event: apply + cache.
            response = {"ok": True, "applied": True, "reason": "decremented"}
            self._cache[cid] = dict(response)
            self._apply_counts[cid] = self._apply_counts.get(cid, 0) + 1

        # AFTER the cloud commit + cache, decide whether the Pi will
        # see the response or a dropped connection.
        if cid in self._simulate_response_drop_for:
            self._simulate_response_drop_for.discard(cid)
            raise CloudError(0, "connection reset by peer (simulated)")

        return response

    def get(self, path: str) -> dict:  # pragma: no cover - unused here
        return {}

    # Inspection helpers used by assertions:

    def apply_count(self, cid: str) -> int:
        return self._apply_counts.get(cid, 0)

    def post_count(self, cid: str) -> int:
        return self._post_counts.get(cid, 0)

    def unique_applied_ids(self) -> int:
        return len(self._apply_counts)


def _mk_worker(stub: _DedupingCloudStub, conn) -> CloudWorker:
    return CloudWorker(
        client=stub,  # type: ignore[arg-type]
        conn_factory=lambda: conn,
        heartbeat_provider=lambda: {"ok": True},
        poll_interval_s=5.0,
    )


class TestDrainCrashReplay:
    def test_dropped_response_triggers_safe_replay(self, conn):
        """The full Bug 3 sequence in one test:

          tick 1:
            enqueue event → drain POSTs → cloud applies + caches →
            Pi's HTTP client raises (simulated response drop) → Pi
            marks row failed (attempts=1), does NOT mark_sent.

          tick 2:
            drain sees the row is still pending (sent_at IS NULL) →
            POSTs again with the SAME client_event_id → cloud hits
            ON CONFLICT, returns cached outcome → Pi marks row sent.

          tick 3:
            drain sees no pending rows → no more POSTs → steady state.

        Invariants asserted at the end:
          * cloud applied the event exactly ONCE (apply_count == 1)
          * Pi POSTed the event TWICE (the retry was real)
          * Pi's row is marked sent with no permanent-failure flag.
        """
        stub = _DedupingCloudStub()
        w = _mk_worker(stub, conn)

        # Enqueue one event + get its client_event_id so we can arm
        # the response-drop on THIS specific id.
        cid = outbox.enqueue_event(conn, {
            "scale_id": "s1",
            "kind": "live_shelf",
            "event_kind": "consumed",
            "product_id": "p1",
            "delta_g": -100.0,
            "occurred_at": "2026-04-22T12:00:00Z",
        })
        stub.simulate_dropped_response(cid)

        # --- tick 1: POST lands, cloud commits, but response drops.
        w.tick()
        assert stub.post_count(cid) == 1, "first POST was made"
        assert stub.apply_count(cid) == 1, (
            "cloud applied the event on the first POST"
        )
        row = conn.execute(
            "SELECT sent_at, attempts, failed_permanently "
            "FROM cloud_outbox WHERE client_event_id = ?",
            (cid,),
        ).fetchone()
        assert row["sent_at"] is None, (
            "response drop → Pi didn't see 200 → row stays pending. "
            "This is the crash window Bug 3 is about."
        )
        assert row["attempts"] == 1
        assert row["failed_permanently"] == 0, (
            "connection drop is transient, not a permanent failure"
        )

        # --- tick 2: drain retries. Cloud dedupes via client_event_id.
        w.tick()
        assert stub.post_count(cid) == 2, (
            "Pi re-POSTed — it can't know the first request succeeded"
        )
        assert stub.apply_count(cid) == 1, (
            "IDEMPOTENCY CONTRACT: cloud must NOT double-apply stock/"
            "macros when the Pi retries a committed event. Verified by "
            "apply_count staying at 1 across two POSTs with the same "
            "client_event_id — matches the plpgsql "
            "ON CONFLICT (user_id, client_event_id) DO NOTHING path."
        )
        row = conn.execute(
            "SELECT sent_at FROM cloud_outbox WHERE client_event_id = ?",
            (cid,),
        ).fetchone()
        assert row["sent_at"] is not None, (
            "replay succeeded → Pi marked the row sent"
        )

        # --- tick 3: steady state. No more POSTs for this event.
        w.tick()
        assert stub.post_count(cid) == 2, (
            "sent rows must never be re-POSTed"
        )
        assert stub.unique_applied_ids() == 1

    def test_multiple_distinct_events_each_applied_once(self, conn):
        """Not a replay test — a sanity check that the stub's dedupe
        scope is per-client_event_id, not global. Three distinct
        events with three distinct ids → three applies, zero replays."""
        stub = _DedupingCloudStub()
        w = _mk_worker(stub, conn)

        cids = [
            outbox.enqueue_event(conn, {
                "scale_id": f"s{i}", "kind": "live_shelf",
                "event_kind": "consumed", "product_id": "p1",
                "delta_g": -10.0, "occurred_at": "2026-04-22T12:00:00Z",
            })
            for i in range(3)
        ]
        w.tick()
        for cid in cids:
            assert stub.post_count(cid) == 1
            assert stub.apply_count(cid) == 1

    def test_row_stays_pending_until_response_seen(self, conn):
        """Edge case: the response drop happens repeatedly. Row must
        stay pending + keep retrying — never silently mark sent."""
        stub = _DedupingCloudStub()
        w = _mk_worker(stub, conn)

        cid = outbox.enqueue_event(conn, {"k": "v"})
        # Drop the response on the first THREE POSTs. The cloud still
        # caches on the first one; the next two just replay.
        stub.simulate_dropped_response(cid)

        # tick 1: dropped.
        w.tick()
        row = conn.execute(
            "SELECT sent_at, attempts FROM cloud_outbox "
            "WHERE client_event_id = ?", (cid,),
        ).fetchone()
        assert row["sent_at"] is None
        assert row["attempts"] == 1

        # Re-arm the drop: cloud will reply to tick 2 with a replay,
        # but we simulate another drop before the Pi sees it.
        stub.simulate_dropped_response(cid)
        w.tick()
        row = conn.execute(
            "SELECT sent_at, attempts FROM cloud_outbox "
            "WHERE client_event_id = ?", (cid,),
        ).fetchone()
        assert row["sent_at"] is None, (
            "still no 200 observed → still pending"
        )
        assert row["attempts"] == 2

        # Cloud applied exactly once across the two drops.
        assert stub.apply_count(cid) == 1

        # tick 3: no drop. Row marks sent.
        w.tick()
        row = conn.execute(
            "SELECT sent_at FROM cloud_outbox WHERE client_event_id = ?",
            (cid,),
        ).fetchone()
        assert row["sent_at"] is not None
        assert stub.apply_count(cid) == 1
