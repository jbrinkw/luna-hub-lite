"""Shared pytest fixtures + helpers for the audit gap-fill tests.

These helpers are consumed by the new test modules added in response to
the coverage audit:
  * test_concurrency.py            — atomic-claim / per-session lock /
                                     semaphore-bound concurrency tests
  * test_sweep_orphans.py          — sweeper grace + wipe-epoch guards
  * test_process_session_events.py — close-hook grace window correlation
  * test_heartbeat_regression.py   — last_scale_weight_g monotonicity
  * test_dedup_reboot.py           — ESP reboot purges stale dedup LRU
  * test_candidate_pool_validation.py — hallucinated id rejection
  * test_session_capture_extra.py  — ring-buffer filter + video_path rebind
  * test_brightness_extra.py       — no-reconciler-spawn contract
  * test_reconciler_repo_filter.py — include_failed default
  * test_migrations.py             — rebuild-table CHECK upgrade
  * test_web_api_routes.py         — /auto-exposure / /diag dump cap / save
  * test_app_startup.py            — classifying reset + zombie cleanup
  * test_prompt_injection.py       — no-name-interpolation guard
  * test_locked_settings_pin.py    — calibrated default values
  * test_weight_mismatch_events.py — events blob inside review_queue

Fixtures intentionally stay small; each test module constructs what it
needs rather than inheriting a giant shared scaffold.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import pytest


# ---------------------------------------------------------------------------
# sys.path setup — make ``server.*`` importable when pytest is invoked from
# the repo root or a subdir.
# ---------------------------------------------------------------------------

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


# ---------------------------------------------------------------------------
# Blocking Anthropic client — used by concurrency / wipe-epoch tests.
# ---------------------------------------------------------------------------


class BlockingAnthropicClient:
    """Anthropic-client stand-in whose ``send()`` blocks until released.

    Use for concurrency tests that need to pin the classifier mid-flight
    without any wall-clock sleeping.

    Attributes
    ----------
    release : threading.Event
        Set this to unblock any waiting ``send()`` calls.
    in_flight : threading.Event
        Set whenever a thread ENTERS ``send()``. Callers can wait on
        this to know the classifier thread has started its API call.
    concurrent_count : int
        Max number of threads that were simultaneously inside ``send()``.
        Used by the semaphore-bound test to assert the cap is enforced.
    calls : list[dict]
        One entry per ``send()`` invocation (with payload + model).
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        from server.classifier.anthropic_client import ClassifierCallResult  # noqa: E402

        self._payload = payload
        self._ClassifierCallResult = ClassifierCallResult
        self.calls: list[dict[str, Any]] = []
        self.release = threading.Event()
        self.in_flight = threading.Event()
        self._active = 0
        self._active_lock = threading.Lock()
        self.concurrent_count = 0

    def send(self, payload, *, model=None, max_tokens=512):
        self.calls.append({"payload": payload, "model": model})
        with self._active_lock:
            self._active += 1
            if self._active > self.concurrent_count:
                self.concurrent_count = self._active
        self.in_flight.set()
        try:
            self.release.wait(timeout=5.0)
            return self._ClassifierCallResult(
                text=json.dumps(self._payload),
                model=model or "claude-sonnet-4-6",
                usage={"input_tokens": 10, "output_tokens": 5},
                raw=None,
            )
        finally:
            with self._active_lock:
                self._active -= 1


@pytest.fixture
def blocking_anthropic_client() -> Callable[..., BlockingAnthropicClient]:
    """Factory for a fresh ``BlockingAnthropicClient`` per test."""
    def _factory(payload: Optional[dict[str, Any]] = None) -> BlockingAnthropicClient:
        return BlockingAnthropicClient(payload or {
            "item_id": "UNKNOWN",
            "action": "unknown",
            "confidence": 0.0,
            "reasoning": "test stub",
            "multi_match": [],
        })
    return _factory


# ---------------------------------------------------------------------------
# Two-thread runner — small wrapper for symmetric concurrency tests.
# ---------------------------------------------------------------------------


def two_thread_runner(
    target: Callable[..., Any],
    args1: tuple = (),
    args2: tuple = (),
    *,
    timeout: float = 10.0,
) -> tuple[Any, Any, list[BaseException]]:
    """Run ``target`` in two threads and join both.

    Returns ``(result1, result2, exceptions)``. Exceptions raised inside
    either thread are captured (not re-raised) so the caller can assert
    on them explicitly.
    """
    results: list[Any] = [None, None]
    errors: list[Optional[BaseException]] = [None, None]

    def _worker(idx: int, args: tuple) -> None:
        try:
            results[idx] = target(*args)
        except BaseException as exc:  # noqa: BLE001 — we want to catch SystemExit too
            errors[idx] = exc

    t1 = threading.Thread(target=_worker, args=(0, args1))
    t2 = threading.Thread(target=_worker, args=(1, args2))
    t1.start()
    t2.start()
    t1.join(timeout=timeout)
    t2.join(timeout=timeout)
    assert not t1.is_alive(), "thread 1 did not finish within timeout"
    assert not t2.is_alive(), "thread 2 did not finish within timeout"
    real_errors = [e for e in errors if e is not None]
    return results[0], results[1], real_errors  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Old-schema sqlite connection — used by the migration-rebuild test.
# ---------------------------------------------------------------------------


def old_schema_db() -> sqlite3.Connection:
    """Return an in-memory sqlite connection populated with the OLD
    scale_events CHECK (no ``'classifying'``), mirroring the state of
    a long-lived on-disk DB that predates the CHECK-expansion migration.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Deliberately partial — we only seed what the migration's rebuild
    # path touches (scale_events + its FK dependents). Other tables are
    # created empty so the existing-tables probe is satisfied.
    conn.executescript(
        """
        CREATE TABLE products (
          product_id          TEXT PRIMARY KEY,
          barcode             TEXT UNIQUE,
          name                TEXT NOT NULL,
          brand               TEXT,
          variant             TEXT,
          net_weight_g        REAL,
          gross_weight_g      REAL,
          tare_weight_g       REAL,
          serving_weight_g    REAL,
          servings_per_container REAL,
          unit_type           TEXT,
          density_g_per_ml    REAL,
          container_type      TEXT,
          certified           INTEGER NOT NULL DEFAULT 0,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE product_reference_images (
          image_id            TEXT PRIMARY KEY,
          product_id          TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
          file_path           TEXT NOT NULL,
          angle               TEXT,
          captured_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE lots (
          lot_id              TEXT PRIMARY KEY,
          product_id          TEXT NOT NULL REFERENCES products(product_id),
          status              TEXT NOT NULL,
          current_weight_g    REAL,
          initial_weight_g    REAL,
          total_consumed_g    REAL NOT NULL DEFAULT 0,
          placed_at           TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
          last_out_at         TEXT,
          notes               TEXT
        );
        CREATE TABLE sessions (
          session_id          TEXT PRIMARY KEY,
          started_at          TEXT NOT NULL,
          ended_at            TEXT,
          initial_shelf_weight_g REAL,
          final_shelf_weight_g   REAL,
          reconciled          INTEGER NOT NULL DEFAULT 0,
          reconciled_at       TEXT
        );
        -- OLD CHECK — no 'classifying'. Missing device_id column too, to
        -- exercise the migration's NULL-fallback path.
        CREATE TABLE scale_events (
          event_id            TEXT PRIMARY KEY,
          session_id          TEXT REFERENCES sessions(session_id),
          ts                  TEXT NOT NULL,
          delta_g             REAL NOT NULL,
          before_weight_g     REAL NOT NULL,
          after_weight_g      REAL NOT NULL,
          direction           TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
          before_frame_path   TEXT,
          after_frame_path    TEXT,
          classification      TEXT,
          classifier_status   TEXT CHECK(classifier_status IN ('pending','classified','review','failed')),
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_scale_events_session ON scale_events(session_id);
        CREATE INDEX idx_scale_events_ts ON scale_events(ts);
        CREATE TABLE session_resolutions (
          resolution_id       TEXT PRIMARY KEY,
          session_id          TEXT NOT NULL REFERENCES sessions(session_id),
          lot_id              TEXT REFERENCES lots(lot_id),
          pattern             TEXT NOT NULL,
          consumed_g          REAL,
          confidence          REAL,
          add_event_id        TEXT REFERENCES scale_events(event_id),
          remove_event_id     TEXT REFERENCES scale_events(event_id),
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE review_queue (
          review_id           TEXT PRIMARY KEY,
          kind                TEXT NOT NULL,
          status              TEXT NOT NULL DEFAULT 'pending',
          session_id          TEXT REFERENCES sessions(session_id),
          event_id            TEXT REFERENCES scale_events(event_id),
          resolution_id       TEXT REFERENCES session_resolutions(resolution_id),
          proposed            TEXT,
          images              TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at         TEXT,
          user_response       TEXT
        );
        CREATE TABLE app_state (
          id                    INTEGER PRIMARY KEY CHECK(id=1),
          current_session_id    TEXT REFERENCES sessions(session_id),
          last_scale_weight_g   REAL,
          last_scale_event_ts   TEXT,
          door_open             INTEGER NOT NULL DEFAULT 0,
          shelf_name            TEXT NOT NULL DEFAULT 'demo shelf',
          camera_locked_json    TEXT,
          updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO app_state (id) VALUES (1);
        """
    )
    return conn


# ---------------------------------------------------------------------------
# Minimal FakeReconcilerRepo with include_failed filtering for adapter tests.
# ---------------------------------------------------------------------------


class _FakeEventRow:
    """Simple event shape matching what the adapter emits."""

    def __init__(
        self,
        *,
        event_id: str,
        session_id: str,
        ts: str,
        direction: str,
        delta_g: float,
        before_weight_g: float,
        after_weight_g: float,
        classification: Any,
        classifier_status: Optional[str],
    ) -> None:
        self.event_id = event_id
        self.session_id = session_id
        self.ts = ts
        self.direction = direction
        self.delta_g = delta_g
        self.before_weight_g = before_weight_g
        self.after_weight_g = after_weight_g
        self.classification = classification
        self.classifier_status = classifier_status


# ---------------------------------------------------------------------------
# Tiny helper — deterministic ISO ts.
# ---------------------------------------------------------------------------


def iso_ms(dt) -> str:
    """Render a ``datetime`` as ms-precision UTC ISO string."""
    ms = dt.microsecond // 1000
    return dt.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def new_uuid() -> str:
    return str(uuid.uuid4())
