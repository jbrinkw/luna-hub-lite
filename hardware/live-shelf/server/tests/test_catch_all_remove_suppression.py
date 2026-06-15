"""Catch-all REMOVE-suppression guard (single-event placement model).

Closes the FP-7 coverage hole from the 2026-06-03 deep-audit
TEST-INTEGRITY scorecard. The single-event placement model (commit
68abb2b) drops catch-all REMOVE (lift-off) events BEFORE the dedup /
session / classifier / cloud-emit pipeline: the user weighs an item
then lifts it off, and that lift-off is redundant. The suppression
branch lives at scale_events.py:4016
(``if shelf_id == "catch_all" and direction == "remove":``) and
returns ``{"suppressed": "catch_all_remove", ...}`` while writing NO
``scale_events`` row.

Before this test that branch had ZERO coverage: the audit disabled it
(``... and False``) so catch-all REMOVE events fell through into the
full pipeline, and all 769 Pi tests stayed GREEN. ``grep catch_all_remove
server/tests`` returned nothing.

This test drives a ``scale-02`` (catch_all) REMOVE event — a negative
delta beyond the threshold — straight through ``handle_scale_event``
and asserts both observable effects of the suppression:

  1. the handler returns ``suppressed == "catch_all_remove"`` (200), and
  2. NO ``scale_events`` row is written (the branch returns before the
     row insert).

Disabling the suppression (the FP-7 mutation ``and False`` at line 4016)
flips this test RED: the event falls through, ``suppressed`` is absent
from the response, and a ``scale_events`` row gets inserted.

A control test also confirms the ADD direction is NOT suppressed, so the
mutation evidence (only REMOVE is dark; ADD is well-covered) is pinned
here too — a regression that broadened suppression to ADD would flip the
control RED.
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

from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


class _NullCandidateSource:
    """Minimal CandidateSource — these tests exercise ingress plumbing,
    not classifier logic."""

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn: sqlite3.Connection, tmp_path: Path) -> ScaleHandler:
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=registry,
    )


def test_catch_all_remove_event_is_suppressed_and_writes_no_row(tmp_path: Path):
    """A catch-all (scale-02) REMOVE event is dropped by the single-event
    model: returns ``suppressed: catch_all_remove`` and writes NO
    ``scale_events`` row.

    Mutation guard (FP-7, audit 2026-06-03): disabling the suppression
    branch at scale_events.py:4016 (``and False``) flips this test RED —
    the event falls through into the pipeline, ``suppressed`` is absent,
    and a ``scale_events`` row is inserted.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # delta_g = -120.0 < -delta_threshold_g (5.0) → direction == 'remove'.
    # device_id scale-02 resolves to shelf_id == 'catch_all'.
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 7,
        "delta_g": -120.0,
        "before_weight_g": 120.0,
        "after_weight_g": 0.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("suppressed") == "catch_all_remove", (
        "catch-all REMOVE event was not suppressed — expected "
        f"suppressed='catch_all_remove', got {resp!r}. The single-event "
        "placement model branch at scale_events.py:4016 must drop catch-all "
        "lift-off events before the session/classifier/cloud-emit pipeline."
    )
    assert resp.get("shelf_id") == "catch_all", resp
    assert resp.get("direction") == "remove", resp

    # The suppression returns BEFORE the scale_events row insert — a
    # suppressed event leaves zero rows behind.
    count = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert count == 0, (
        f"catch-all REMOVE suppression must write NO scale_events row, found "
        f"{count}. If the suppression branch (scale_events.py:4016) is "
        "disabled, the event falls through and the pipeline inserts a row."
    )


def test_catch_all_add_event_is_not_suppressed(tmp_path: Path):
    """Control / asymmetry guard: a catch-all (scale-02) ADD event is NOT
    suppressed — it must flow into the pipeline and write a scale_events
    row. Pins the FP-7 asymmetry note (only REMOVE is suppressed; ADD is
    load-bearing). Broadening the suppression to ADD flips this RED.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 8,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("suppressed") != "catch_all_remove", (
        "a catch-all ADD event was wrongly suppressed as catch_all_remove — "
        f"only REMOVE events should be dropped. resp={resp!r}"
    )
    assert "event_id" in resp, (
        f"catch-all ADD must produce a scale_events row (event_id), got {resp!r}"
    )
    count = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert count == 1, (
        f"catch-all ADD must write exactly one scale_events row, found {count}"
    )
