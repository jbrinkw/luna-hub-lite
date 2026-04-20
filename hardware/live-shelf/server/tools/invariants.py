"""Invariant checks — spot-the-weird-thing across the whole DB.

``run_invariant_checks(conn)`` sweeps every rule, returns a list of
violations. Each violation is a dict::

    {"kind": "...", "count": N, "sample_ids": [...], "detail": "..."}

Rules are intentionally simple SQL so a shell reader can reproduce
them. New rule? Add a function with the ``_invariant_`` prefix and it
is auto-picked up by the runner.
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any, Callable, Iterable

log = logging.getLogger(__name__)


_STUCK_CLASSIFYING_AGE_SECONDS = 120  # 2 minutes
_PENDING_EVENT_AGE_SECONDS = 600      # 10 minutes


def _rows_to_ids(rows: Iterable[Any], key: str = "id") -> list[str]:
    out: list[str] = []
    for r in rows:
        try:
            val = r[key] if hasattr(r, "keys") else r[0]
        except (IndexError, KeyError):
            continue
        if val is not None:
            out.append(str(val))
    return out


def _invariant_stale_session_pointer(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT a.current_session_id
          FROM app_state a
          JOIN sessions s ON s.session_id = a.current_session_id
         WHERE a.id = 1 AND s.ended_at IS NOT NULL
        """
    ).fetchall()
    sample = [r[0] for r in rows if r and r[0] is not None]
    return {
        "kind": "stale_session_pointer",
        "count": len(sample),
        "sample_ids": sample[:5],
        "detail": (
            "app_state.current_session_id references a closed session "
            "(sessions.ended_at IS NOT NULL)"
        ),
    }


def _invariant_lot_on_shelf_zero_weight(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT lot_id FROM lots
         WHERE status = 'on_shelf'
           AND (current_weight_g IS NOT NULL AND current_weight_g <= 0)
         LIMIT 20
        """
    ).fetchall()
    return {
        "kind": "lot_on_shelf_zero_weight",
        "count": len(rows),
        "sample_ids": [r[0] for r in rows[:5]],
        "detail": "Lot status='on_shelf' but current_weight_g <= 0",
    }


def _invariant_lot_out_missing_last_out(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT lot_id FROM lots
         WHERE status = 'out' AND last_out_at IS NULL
         LIMIT 20
        """
    ).fetchall()
    return {
        "kind": "lot_out_missing_last_out",
        "count": len(rows),
        "sample_ids": [r[0] for r in rows[:5]],
        "detail": "Lot status='out' but last_out_at is NULL",
    }


def _invariant_gross_lt_net(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT product_id FROM products
         WHERE gross_weight_g IS NOT NULL
           AND net_weight_g IS NOT NULL
           AND gross_weight_g < net_weight_g
         LIMIT 20
        """
    ).fetchall()
    return {
        "kind": "gross_lt_net",
        "count": len(rows),
        "sample_ids": [r[0] for r in rows[:5]],
        "detail": "Product gross_weight_g < net_weight_g (physically impossible)",
    }


def _invariant_scale_nonzero_no_lots(conn: sqlite3.Connection) -> dict[str, Any]:
    state = conn.execute(
        "SELECT last_scale_weight_g FROM app_state WHERE id = 1"
    ).fetchone()
    if not state or state[0] is None:
        return {
            "kind": "scale_nonzero_no_lots",
            "count": 0,
            "sample_ids": [],
            "detail": "ok",
        }
    weight = float(state[0])
    if weight <= 100.0:
        return {
            "kind": "scale_nonzero_no_lots",
            "count": 0,
            "sample_ids": [],
            "detail": f"scale={weight:.1f}g (below 100g threshold, ok)",
        }
    on_shelf = conn.execute(
        "SELECT COUNT(*) FROM lots WHERE status = 'on_shelf'"
    ).fetchone()
    count = int(on_shelf[0] if on_shelf else 0)
    if count > 0:
        return {
            "kind": "scale_nonzero_no_lots",
            "count": 0,
            "sample_ids": [],
            "detail": f"scale={weight:.1f}g, on_shelf lots={count} (ok)",
        }
    return {
        "kind": "scale_nonzero_no_lots",
        "count": 1,
        "sample_ids": [],
        "detail": (
            f"last_scale_weight_g={weight:.1f}g but 0 on_shelf lots — "
            "inventory drift or unregistered item"
        ),
    }


def _invariant_stuck_classifying(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT event_id FROM scale_events
         WHERE classifier_status = 'classifying'
           AND datetime(created_at) < datetime('now', ?)
         LIMIT 20
        """,
        (f"-{_STUCK_CLASSIFYING_AGE_SECONDS} seconds",),
    ).fetchall()
    return {
        "kind": "stuck_classifying",
        "count": len(rows),
        "sample_ids": [r[0] for r in rows[:5]],
        "detail": (
            f"scale_events stuck in 'classifying' for > "
            f"{_STUCK_CLASSIFYING_AGE_SECONDS}s (classifier worker died?)"
        ),
    }


def _invariant_pending_event_old(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT event_id FROM scale_events
         WHERE classifier_status = 'pending'
           AND datetime(created_at) < datetime('now', ?)
         LIMIT 20
        """,
        (f"-{_PENDING_EVENT_AGE_SECONDS} seconds",),
    ).fetchall()
    return {
        "kind": "pending_event_old",
        "count": len(rows),
        "sample_ids": [r[0] for r in rows[:5]],
        "detail": (
            f"scale_events stuck in 'pending' for > "
            f"{_PENDING_EVENT_AGE_SECONDS}s (sweeper not running?)"
        ),
    }


_INVARIANTS: tuple[Callable[[sqlite3.Connection], dict[str, Any]], ...] = (
    _invariant_stale_session_pointer,
    _invariant_lot_on_shelf_zero_weight,
    _invariant_lot_out_missing_last_out,
    _invariant_gross_lt_net,
    _invariant_scale_nonzero_no_lots,
    _invariant_stuck_classifying,
    _invariant_pending_event_old,
)


def run_invariant_checks(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Run every invariant and return the list of violations (count > 0).

    Individual check failures are logged and produce a synthetic
    ``error`` violation so one bad rule doesn't mask the others.
    """
    violations: list[dict[str, Any]] = []
    for check in _INVARIANTS:
        try:
            result = check(conn)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("invariant check %s threw", check.__name__)
            violations.append(
                {
                    "kind": check.__name__.replace("_invariant_", ""),
                    "count": 0,
                    "sample_ids": [],
                    "detail": f"check raised: {exc!r}",
                    "error": True,
                }
            )
            continue
        if result and int(result.get("count", 0) or 0) > 0:
            violations.append(result)
    return violations


__all__ = ["run_invariant_checks"]
