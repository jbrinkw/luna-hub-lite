"""Clock-freeze context manager (lens L7).

Purpose
-------
Run the same scenario at UTC-midnight, local-midnight, DST transition,
leap-day. The wrapper freezes wall-clock both:

* **Client-side** (Python): monkey-patches ``datetime.datetime.now``,
  ``datetime.datetime.utcnow``, ``time.time`` and ``time.time_ns`` so
  any harness code that calls them sees the frozen instant.
* **Server-side** (Postgres): sets the ``app.frozen_now`` GUC on the
  supplied connection. ``private.now_with_freeze()`` (migration
  20260429130000) returns this value in place of ``now()``.

Functions on the cloud DB that have NOT been retrofitted to use
``private.now_with_freeze()`` will continue to see real wall-clock —
that's intentional per AUDIT_STRATEGY_MERGED.md §5. The affordance is
in place; per-function opt-in is a follow-up.

Usage
-----

    >>> from datetime import datetime, timezone
    >>> import psycopg2
    >>> conn = psycopg2.connect(dsn)
    >>> with clock_freeze(datetime(2024, 2, 29, 5, 0, tzinfo=timezone.utc), conn):
    ...     # datetime.now() returns the frozen instant
    ...     # `SELECT private.now_with_freeze()` returns it too
    ...     run_scenario()
    >>> # both client + server are unfrozen here

The CM is reentrant only via independent ``with`` blocks — nested
freezes against the same connection are rejected (ambiguous semantics).

Determinism
-----------
The wrapper does NOT modify the OS clock. It can't poison the parent
process the way a system-level freeze would. Tests can run in
parallel because each context only patches the live process for the
lifetime of the with-block.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import time as _time
from typing import Iterator, Optional

# Sentinel so we can detect "no connection passed" vs "passed None
# explicitly" — None means "client-side freeze only".
_UNSET = object()


# ---------------------------------------------------------------------------
# Internal state. We can't subclass ``datetime.datetime`` and replace it on
# the module (CPython enforces immutability of the C-implemented type), so
# instead we replace the bound *symbol* on ``datetime`` and ``time`` and
# present a wrapper class whose ``now()`` / ``utcnow()`` consult the freeze.
#
# Code that grabbed ``from datetime import datetime`` BEFORE ``clock_freeze``
# was active will continue to see the original class. That's fine for the
# harness use case: the harness imports ``clock_freeze`` first and runs
# scenarios that import datetime lazily.
# ---------------------------------------------------------------------------

_REAL_DATETIME = _dt.datetime
_REAL_TIME = _time.time
_REAL_TIME_NS = _time.time_ns


class _FrozenDatetime:
    """Stand-in for ``datetime.datetime`` exposing only the methods harness
    code reaches for. Delegates everything else to the real class.
    """

    _frozen: Optional[_dt.datetime] = None

    @classmethod
    def now(cls, tz: _dt.tzinfo | None = None) -> _dt.datetime:
        if cls._frozen is None:
            return _REAL_DATETIME.now(tz)
        if tz is None:
            return cls._frozen.replace(tzinfo=None) if cls._frozen.tzinfo else cls._frozen
        if cls._frozen.tzinfo is None:
            return cls._frozen.replace(tzinfo=tz)
        return cls._frozen.astimezone(tz)

    @classmethod
    def utcnow(cls) -> _dt.datetime:
        if cls._frozen is None:
            return _REAL_DATETIME.utcnow()
        if cls._frozen.tzinfo is None:
            return cls._frozen
        return cls._frozen.astimezone(_dt.timezone.utc).replace(tzinfo=None)

    # Constructors + everything else fall through to the real class so
    # ``datetime(2024, 1, 1)`` still works while patches are installed.
    def __new__(cls, *args, **kwargs):  # type: ignore[no-untyped-def]
        return _REAL_DATETIME(*args, **kwargs)

    def __getattr__(self, name: str):  # pragma: no cover - delegated
        return getattr(_REAL_DATETIME, name)

    @classmethod
    def fromisoformat(cls, s: str) -> _dt.datetime:
        return _REAL_DATETIME.fromisoformat(s)

    @classmethod
    def fromtimestamp(cls, ts: float, tz: _dt.tzinfo | None = None) -> _dt.datetime:
        return _REAL_DATETIME.fromtimestamp(ts, tz)

    @classmethod
    def utcfromtimestamp(cls, ts: float) -> _dt.datetime:
        return _REAL_DATETIME.utcfromtimestamp(ts)


def _install_patches() -> None:
    """Install module-level patches. Idempotent."""
    if getattr(_dt, "_clock_freeze_installed", False):
        return
    _dt._clock_freeze_installed = True  # type: ignore[attr-defined]
    _dt.datetime = _FrozenDatetime  # type: ignore[misc]
    _time.time = _patched_time
    _time.time_ns = _patched_time_ns


def _patched_time() -> float:
    if _FrozenDatetime._frozen is None:
        return _REAL_TIME()
    inst = _FrozenDatetime._frozen
    if inst.tzinfo is None:
        inst = inst.replace(tzinfo=_dt.timezone.utc)
    return inst.timestamp()


def _patched_time_ns() -> int:
    return int(_patched_time() * 1_000_000_000)


@contextlib.contextmanager
def clock_freeze(
    instant: _dt.datetime,
    conn=_UNSET,  # psycopg2 connection or None; sentinel means "client-only"
) -> Iterator[_dt.datetime]:
    """Freeze wall-clock at ``instant`` for the duration of the with-block.

    Parameters
    ----------
    instant
        ``datetime.datetime`` to freeze at. **Should be timezone-aware.**
        A naive datetime is treated as UTC.
    conn
        Optional psycopg2 connection. If supplied, ``app.frozen_now`` is
        SET on it (session-level) and RESET on exit. Pass ``None`` to
        skip the server-side freeze entirely. Pass nothing (default) to
        get the same as ``None`` plus a warning skipped.

    Yields
    ------
    The frozen instant (timezone-aware, UTC if input was naive).
    """
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=_dt.timezone.utc)

    if _FrozenDatetime._frozen is not None:
        raise RuntimeError(
            "clock_freeze() is already active in this process — "
            "nested freezes are ambiguous. Stack one above the other "
            "in separate with-blocks."
        )

    _install_patches()
    _FrozenDatetime._frozen = instant

    db_conn = None if conn is _UNSET else conn
    db_set = False
    if db_conn is not None:
        with db_conn.cursor() as cur:
            cur.execute(
                "SELECT set_config('app.frozen_now', %s, false)",
                (instant.isoformat(),),
            )
        db_conn.commit() if not db_conn.autocommit else None
        db_set = True
    try:
        yield instant
    finally:
        _FrozenDatetime._frozen = None
        if db_set and db_conn is not None:
            try:
                with db_conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.frozen_now', '', false)")
                if not db_conn.autocommit:
                    db_conn.commit()
            except Exception:
                # Connection might be in failed state — leave it to the
                # caller to deal with. The next BEGIN reset will scrub
                # the GUC anyway because it's session-level.
                pass


# ---------------------------------------------------------------------------
# Convenience: well-known boundary instants for the L7 lens
# ---------------------------------------------------------------------------

#: UTC-midnight on a normal day. Use as a control.
UTC_MIDNIGHT = _dt.datetime(2026, 4, 15, 0, 0, 0, tzinfo=_dt.timezone.utc)

#: Local-midnight in America/New_York for the same date. Used to verify
#: ``private.get_logical_date()`` does not flake at the local-vs-UTC seam.
LOCAL_MIDNIGHT_NY = _dt.datetime(2026, 4, 15, 4, 0, 0, tzinfo=_dt.timezone.utc)

#: Forward DST transition (US, 2026). UTC instant when local clock jumps
#: from 02:00 EST to 03:00 EDT.
DST_SPRING_FORWARD = _dt.datetime(2026, 3, 8, 7, 0, 0, tzinfo=_dt.timezone.utc)

#: Backward DST transition (US, 2026). UTC instant when local clock falls
#: from 02:00 EDT back to 01:00 EST.
DST_FALL_BACK = _dt.datetime(2026, 11, 1, 6, 0, 0, tzinfo=_dt.timezone.utc)

#: Leap-day instant. Picks the calendar-edge case
#: ``private.get_logical_date()`` is most likely to flake on.
LEAP_DAY = _dt.datetime(2024, 2, 29, 12, 0, 0, tzinfo=_dt.timezone.utc)


def main() -> int:
    """CLI smoke test: ``python3 scripts/harness/clock_freeze.py``.

    Prints a 4-line check. Used by the meta-test as a fast end-to-end
    proof the patch installs correctly.
    """
    import sys

    instant = LEAP_DAY
    real_before = _dt.datetime.now(_dt.timezone.utc)
    with clock_freeze(instant):
        frozen_now = _dt.datetime.now(_dt.timezone.utc)
        if frozen_now != instant:
            print(
                f"FAIL: client-side freeze returned {frozen_now}, expected {instant}",
                file=sys.stderr,
            )
            return 1
    real_after = _dt.datetime.now(_dt.timezone.utc)
    if real_after < real_before:
        print(
            "FAIL: client-side time appeared to go backwards after unfreeze",
            file=sys.stderr,
        )
        return 1
    print(f"clock_freeze OK | frozen={instant.isoformat()} | now={real_after.isoformat()}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
