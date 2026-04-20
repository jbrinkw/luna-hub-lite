"""``RepoReconcilerAdapter.get_events_for_session`` filtering.

By default the adapter must exclude ``failed`` and ``pending`` events
so the reconciler only sees events with a real classifier decision.
Passing ``include_failed=True`` opts out of the filter (used by audit
tooling that wants the full picture).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ScaleEventIn  # noqa: E402


def _seed_session_with_events():
    """Return (conn, session_id, event_ids_by_status)."""
    conn = init_db(":memory:")
    sess = storage_repo.open_session(conn, "2026-04-15T12:00:00Z", 1000.0)
    statuses = ["classified", "review", "failed", "pending"]
    ids: dict[str, str] = {}
    for i, status in enumerate(statuses):
        ev = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                ts=f"2026-04-15T12:00:{i:02d}Z",
                delta_g=-50.0,
                before_weight_g=1000.0 - i * 50,
                after_weight_g=1000.0 - (i + 1) * 50,
                direction="remove",
                session_id=sess.session_id,
                classifier_status=status,  # type: ignore[arg-type]
            ),
        )
        ids[status] = ev.event_id
    return conn, sess.session_id, ids


def test_reconciler_repo_get_events_for_session_filters_failed_by_default():
    """Default kwargs: only 'classified' + 'review' events come through."""
    conn, session_id, ids = _seed_session_with_events()
    adapter = RepoReconcilerAdapter(conn, db_lock=None)

    # Default include_failed=False.
    events = adapter.get_events_for_session(session_id)
    event_ids_returned = {e.event_id for e in events}

    assert ids["classified"] in event_ids_returned
    assert ids["review"] in event_ids_returned
    assert ids["failed"] not in event_ids_returned, (
        "failed events must be filtered out by default"
    )
    assert ids["pending"] not in event_ids_returned, (
        "pending events must be filtered out by default"
    )


def test_reconciler_repo_get_events_for_session_include_failed_returns_all():
    """include_failed=True returns the full set including failed + pending."""
    conn, session_id, ids = _seed_session_with_events()
    adapter = RepoReconcilerAdapter(conn, db_lock=None)

    events = adapter.get_events_for_session(session_id, include_failed=True)
    event_ids_returned = {e.event_id for e in events}

    assert set(ids.values()) == event_ids_returned
