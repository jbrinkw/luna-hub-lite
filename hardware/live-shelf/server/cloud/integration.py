"""Cloud event emission hooks (PROD_MIGRATION_PLAN.md §4 Phase 4).

Every time the Pi definitively commits a state change that mutates cloud
inventory, the producer (reconciler, single-item handler, TTL reaper)
calls one of the ``emit_*`` methods on :class:`CloudEventEmitter` to
enqueue a ``cloud_outbox`` row mirroring the change. The
:class:`~server.cloud.worker.CloudWorker` drains that queue to the
Supabase shelf-ingest edge function asynchronously.

Transactional boundary
----------------------
Producers hold ``db_lock`` while they commit their local mutation
(``write_resolution``, ``reap_in_flight_lot_as_consumed``, etc.). They
then call ``emit_*`` **while still holding the same lock** so no other
writer can interleave a row that would arrive at the cloud out of order.

Each ``emit_*`` call delegates to :func:`server.cloud.outbox.enqueue_event`,
which performs a single ``INSERT`` under its own ``with conn:`` context.
That commits independently of the caller's mutation commit — a true
two-phase atomic write would require re-wiring the outbox helper to
accept an in-progress transaction. For the MVP we accept the microscopic
window where the local mutation succeeds and the Pi crashes before the
outbox insert: the resolution rows on the Pi remain the authoritative
audit trail (the cloud can be re-derived from them in a recovery script).
In steady state the two writes land within a microsecond of each other
under the same ``db_lock`` hold.

Deep-audit finding #5 flagged this gap. We evaluated rewiring every
producer (reconciler, single-item, in-flight reaper) to use a shared
open transaction — Option A in the audit — and chose the less
invasive Option B: a startup self-heal scan that diff's recent
``session_resolutions`` against the ``cloud_outbox`` keys and back-
fills missing events. See :func:`backfill_missing_outbox_events` below
and the call site in ``app.py`` (startup path, after migrations + auth
but before the worker starts). The scan is idempotent and cheap.

Gating
------
The emitter is a **no-op** when ``cloud_enabled=False``. Producers always
call the emit helpers regardless of the flag; the helper short-circuits
so the hot path stays cheap and producers don't need to thread the flag
through their own state.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

from .outbox import enqueue_event

log = logging.getLogger(__name__)

# Pi RTC plausibility guard — mirrors the HTTP ingress check in
# ``server.handlers.scale_events._ts_is_pre_ntp`` so every cloud emit
# path is protected even when the timestamp is generated internally
# (e.g. ``now_iso_utc_ms()`` at TTL reap time before the Pi's clock has
# NTP-synced). Pass-2 audit finding #4.
_MIN_PLAUSIBLE_YEAR = 2024


def _ts_is_pre_ntp(ts: Optional[str]) -> bool:
    """Return True when ``ts`` looks like a pre-NTP RTC fallback.

    ``None`` is considered plausible — the emitter stamps a fresh now
    later in that case, and that path is itself guarded by this check.
    An unparseable string also returns False (defer to downstream
    validators); the common ESP/Pi failure mode is a valid ISO string
    with year=1970, which is exactly what this check catches.
    """
    if not ts or not isinstance(ts, str):
        return False
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.year < _MIN_PLAUSIBLE_YEAR

# Backfill window — how far back to scan for orphaned resolutions.
# Default 7 days (168h): covers week-long outages on a remote Pi without
# re-scanning the whole history on every boot. Configurable via
# ``AppConfig.cloud_backfill_window_hours`` / ``CLOUD_BACKFILL_WINDOW_HOURS``
# env var; ``app.py`` threads the knob through
# :func:`backfill_missing_outbox_events`.
_BACKFILL_WINDOW_HOURS = 168

# Resolution pattern → which event timestamp to prefer when stamping the
# cloud event's ``occurred_at``. Both reconciler + back-fill code paths
# read these sets so analytics place the consumption / restock at the
# wall-clock moment the user physically acted on the item. Previously
# these sets were duplicated in ``server.adapters.reconciler_repo``;
# finding #13 consolidates them here so the two paths can't drift.
#
#   * REMOVE-side: consumption is realized at pickup time, not at
#     return time. Patterns: ``use_return_consumed``,
#     ``consumed_or_removed``, ``in_flight_ttl_expired``,
#     ``in_flight_return``, ``in_flight_replaced_new_item``.
#   * ADD-side: new stock arrived at the add event. Patterns:
#     ``new_arrival``, ``topped_up``.
#
# Other patterns (``no_op``, ``unknown``, ``swap_*``, ``relocation``,
# ``use_return_no_consumption``, ``in_flight_pickup``) don't produce a
# cloud event so they aren't in either set.
REMOVE_SIDE_PATTERNS: frozenset[str] = frozenset({
    "consumed_or_removed",
    "use_return_consumed",
    "in_flight_ttl_expired",
    "in_flight_return",
    "in_flight_replaced_new_item",
})
ADD_SIDE_PATTERNS: frozenset[str] = frozenset({
    "new_arrival",
    "topped_up",
})


def _pick_occurred_at(
    pattern: str,
    remove_ts: Optional[str],
    add_ts: Optional[str],
    fallback_ts: Optional[str],
) -> Optional[str]:
    """Pick the cloud event's ``occurred_at`` from the two event ts'.

    Pass-1 audit finding #5: for REMOVE-side resolutions the
    consumption happened at the pickup (remove) event — timestamping at
    the ADD event files the consumption "in the future" (potentially
    hours later when the user put the lot back). ADD-side resolutions
    are the mirror image: restock happened at the ADD event. Unknown
    patterns fall through to the fallback.

    Parameters
    ----------
    pattern:
        The resolution's ``pattern`` literal. Looked up against
        :data:`REMOVE_SIDE_PATTERNS` / :data:`ADD_SIDE_PATTERNS`.
    remove_ts, add_ts:
        Timestamps of the remove / add events attached to the
        resolution. Either can be ``None`` (one-sided resolutions).
    fallback_ts:
        Timestamp used when neither event ts applies (unknown pattern)
        or both are ``None``. Callers usually pass the resolution's
        creation time so the cloud event at least carries the Pi's
        commit wall-clock.
    """
    if pattern in REMOVE_SIDE_PATTERNS:
        return remove_ts or add_ts or fallback_ts
    if pattern in ADD_SIDE_PATTERNS:
        return add_ts or remove_ts or fallback_ts
    # Unknown pattern or patterns that don't produce a cloud event in
    # practice — keep the fallback so callers always get a string back.
    return fallback_ts


# Reconciler pattern → cloud event_kind. ``None`` means "skip this
# resolution entirely" — v2 will decide what to do with relocation /
# swap / unknown (they don't mutate stock quantities in v1).
PATTERN_TO_EVENT_KIND: dict[str, Optional[str]] = {
    # Use-returns: consumption happened while off-shelf.
    "use_return_consumed": "consumed",
    "use_return_no_consumption": None,  # stock unchanged
    # Top-up: user added contents to an existing container.
    "topped_up": "refilled",
    # Leftover REMOVE that never paired with an ADD.
    "consumed_or_removed": "consumed",
    # Brand-new lot first-placed this session.
    "new_arrival": "added",
    # In-flight fast-path resolutions (handlers/scale_events.py).
    "in_flight_return": "consumed",
    "in_flight_replaced_new_item": "consumed",  # old mass presumed eaten
    "in_flight_ttl_expired": "consumed",
    # v2 territory — no cloud mutation for now.
    "swap_in": None,
    "swap_out": None,
    "relocation": None,
    "unknown": None,
    "no_op": None,
    # in_flight_pickup is bookkeeping only (lot picked up but not
    # consumed yet); the terminal return/reap emits the actual event.
    "in_flight_pickup": None,
}


def _iso_utc_ms() -> str:
    """Return current UTC time as ISO-8601 with ms precision + ``Z``."""
    now = datetime.now(tz=timezone.utc)
    ms = now.microsecond // 1000
    return now.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


class CloudEventEmitter:
    """Producer-side facade for cloud event enqueueing.

    Producers (reconciler adapter, scale_events handler) hold a
    reference to an instance and call one of the ``emit_*`` methods at
    commit time. When ``enabled=False`` every call short-circuits and
    returns immediately — no DB I/O, no logging noise.

    Parameters
    ----------
    conn:
        Shared sqlite connection. Reused for every outbox insert.
    enabled:
        Master switch driven by ``AppConfig.cloud_enabled``.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        enabled: bool = False,
    ) -> None:
        self._conn = conn
        self._enabled = bool(enabled)

    @property
    def enabled(self) -> bool:
        """Expose the flag for callers that want to skip upstream work too."""
        return self._enabled

    # ------------------------------------------------------------------
    # Low-level
    # ------------------------------------------------------------------

    def _enqueue(self, payload: dict) -> Optional[str]:
        """Insert one outbox row. Returns the client_event_id or ``None``.

        Swallows every exception — cloud observability must never bring
        down the Pi's local event pipeline. Failures surface in logs and
        will be retried by a later producer (or diagnosed via the
        ``cloud_outbox`` audit trail).

        Pass-2 audit finding #4: every ``occurred_at`` passing through
        here is run against the Pi RTC plausibility guard. A pre-NTP
        timestamp (year < 2024, fallback from ``now_iso_utc_ms()`` when
        the Pi boots before NTP completes) would stamp the outbox row
        with a 1970 ts that the cloud's validator would reject — and
        since 422 is retryable per finding #8, the row would stall
        forever. Skip + WARN so the event is dropped cleanly rather
        than poisoning the queue.
        """
        if not self._enabled:
            return None
        occurred_at = payload.get("occurred_at")
        if _ts_is_pre_ntp(occurred_at):
            log.warning(
                "cloud emitter: dropping event with pre-NTP occurred_at=%r "
                "(year < %d); event_kind=%r product_id=%r",
                occurred_at, _MIN_PLAUSIBLE_YEAR,
                payload.get("event_kind"), payload.get("product_id"),
            )
            return None
        try:
            return enqueue_event(self._conn, payload)
        except Exception:  # noqa: BLE001 - observability is best-effort
            log.warning(
                "cloud emitter: enqueue_event raised for payload keys=%r",
                list(payload.keys()),
                exc_info=True,
            )
            return None

    # ------------------------------------------------------------------
    # Public emit helpers
    # ------------------------------------------------------------------

    def emit_reconciler_resolution(
        self,
        *,
        pattern: str,
        product_id: Optional[str],
        scale_id: str,
        kind: str,
        delta_g: float,
        occurred_at: Optional[str] = None,
        resolution_id: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a cloud event for a reconciler-written session_resolution.

        ``pattern`` maps via :data:`PATTERN_TO_EVENT_KIND`. Patterns that
        don't mutate cloud stock (``no_op``, ``unknown``, ``swap_*``,
        ``relocation``, ``use_return_no_consumption``, ``in_flight_pickup``)
        short-circuit to a silent no-op.

        ``delta_g`` is the **signed** stock delta on the cloud side:
        negative for consumption (including refill's negative-of-added
        container mass? — no: refill is positive, stock goes up), positive
        for additions/refills. The reconciler mapping:

          * consumed      → negative delta
          * refilled      → positive delta (the topped-up amount)
          * added         → positive delta (the new lot's weight)

        Callers compute the magnitude + sign and pass it through.
        """
        event_kind = PATTERN_TO_EVENT_KIND.get(pattern)
        if event_kind is None:
            return None
        if not product_id:
            # Resolutions with lot_id=None (unknown, no_op) shouldn't hit
            # this branch after the mapping guard, but defend anyway:
            # the cloud /event handler keys off product_id and will 400
            # without it.
            log.debug(
                "cloud emitter: skipping %s resolution with null product_id",
                pattern,
            )
            return None
        payload: dict[str, Any] = {
            "scale_id": scale_id,
            "kind": kind,
            "event_kind": event_kind,
            "product_id": product_id,
            "delta_g": float(delta_g),
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        # Finding #5 back-fill support: embed the resolution_id so the
        # startup self-heal scan can cross-reference outbox rows against
        # session_resolutions without walking the full event. The cloud
        # /event handler ignores unknown fields.
        if resolution_id:
            payload["_pi_resolution_id"] = resolution_id
        return self._enqueue(payload)

    def emit_single_item_event(
        self,
        *,
        scale_id: str,
        product_id: str,
        delta_g: float,
        noise_floor_g: float,
        refill_threshold_g: float,
        depleted: bool,
        occurred_at: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a cloud event for a single-item scale delta commit.

        Single-item scales report one event per discrete scale-reading
        change. Classification:

          * ``depleted=True``  → ``depleted`` event (weight dropped to
            ~0 and stayed there). ``delta_g`` is the absolute mass that
            vanished (positive magnitude, we negate it in the payload).
          * ``delta_g`` ≤ -noise_floor_g → ``consumed`` event.
          * ``delta_g`` ≥  refill_threshold_g → ``refilled`` event.
          * everything in-between → noise; returns ``None`` without
            enqueuing.

        The cloud applies the delta to the paired product's stock row
        identified by ``product_id``; there is no lot concept on the
        cloud for single-item scales.
        """
        if depleted:
            event_kind = "depleted"
            # Depletion delta is the full missing mass — producer passes
            # in a positive magnitude; emit as negative since stock
            # dropped.
            emit_delta = -abs(float(delta_g))
        elif delta_g <= -abs(noise_floor_g):
            event_kind = "consumed"
            emit_delta = float(delta_g)  # already negative
        elif delta_g >= abs(refill_threshold_g):
            event_kind = "refilled"
            emit_delta = float(delta_g)  # positive
        else:
            return None  # noise band — nothing to sync
        payload: dict[str, Any] = {
            "scale_id": scale_id,
            "kind": "live_scale",
            "event_kind": event_kind,
            "product_id": product_id,
            "delta_g": emit_delta,
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        return self._enqueue(payload)

    def emit_in_flight_reap(
        self,
        *,
        scale_id: str,
        product_id: str,
        consumed_g: float,
        occurred_at: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a ``consumed`` event for a TTL-expired in-flight lot.

        The reaper flips the lot to ``out`` after it stays off-shelf for
        ``in_flight_ttl_seconds``; we mirror that as a consumption of the
        full pickup mass since the item never came back.
        """
        if consumed_g <= 0 or not product_id:
            return None
        payload: dict[str, Any] = {
            "scale_id": scale_id,
            "kind": "live_shelf",
            "event_kind": "consumed",
            "product_id": product_id,
            "delta_g": -abs(float(consumed_g)),
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        return self._enqueue(payload)


def backfill_missing_outbox_events(
    conn: sqlite3.Connection,
    emitter: "CloudEventEmitter",
    *,
    scale_id: str = "scale-01",
    shelf_kind: str = "live_shelf",
    window_hours: int = _BACKFILL_WINDOW_HOURS,
) -> int:
    """Scan recent resolutions for missing cloud-outbox mirrors + re-emit.

    Called at startup (after migrations + auth, before worker.start)
    to close the "Pi crashed between local commit and outbox insert"
    gap described in the module docstring. Finding #5 Option B.

    Walks ``session_resolutions`` rows created in the last
    ``window_hours`` whose pattern maps to a non-null cloud event_kind.
    For each, checks whether ANY ``cloud_outbox`` row's payload_json
    references the resolution's id via the ``_pi_resolution_id`` key
    stamped by :meth:`CloudEventEmitter.emit_reconciler_resolution`. If
    no match, re-emits the resolution to the outbox so the worker can
    drain it.

    Resolutions emitted before the ``_pi_resolution_id`` stamp was
    introduced won't match — those are treated as "already covered by
    legacy emit, skip" via the ``created_at >= cutoff`` window. A fresh
    install has zero rows; the scan is a no-op.

    Returns the number of rows re-emitted. Safe to call repeatedly —
    a resolution re-emitted twice would get ``client_event_id``
    dedupe at the cloud side, but avoiding that case is cheaper than
    letting it happen. The scan is idempotent: once a resolution has a
    matching outbox row, the next scan skips it.
    """
    if not emitter.enabled:
        return 0

    # Pull candidate resolutions in the window. Join products to resolve
    # product_id via lot_id (same logic as _emit_cloud_for_resolution).
    try:
        rows = conn.execute(
            """
            SELECT sr.resolution_id, sr.pattern, sr.lot_id, sr.consumed_g,
                   sr.add_event_id, sr.remove_event_id, sr.created_at,
                   l.product_id AS lot_product_id
              FROM session_resolutions sr
              LEFT JOIN lots l ON l.lot_id = sr.lot_id
             WHERE sr.created_at >= datetime('now', ? )
               AND sr.pattern IN (
                   'use_return_consumed', 'topped_up', 'consumed_or_removed',
                   'new_arrival', 'in_flight_return',
                   'in_flight_replaced_new_item', 'in_flight_ttl_expired'
               )
             ORDER BY sr.created_at ASC
            """,
            (f'-{int(window_hours)} hours',),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        log.warning(
            "backfill_missing_outbox_events: DB scan failed: %s", exc,
        )
        return 0

    if not rows:
        return 0

    re_emitted = 0
    for row in rows:
        resolution_id = row["resolution_id"]
        # Check if this resolution already has a corresponding outbox
        # row. SQLite has the json1 extension enabled in the default
        # build we ship with (python 3.13 on the Pi), so we look up by
        # exact key match rather than ``LIKE '%..%'`` — robust against
        # payload whitespace / key-order variations and faster on a
        # populated outbox. Pass-2 audit finding #11.
        existing = conn.execute(
            "SELECT 1 FROM cloud_outbox "
            " WHERE json_extract(payload_json, '$._pi_resolution_id') = ? "
            " LIMIT 1",
            (resolution_id,),
        ).fetchone()
        if existing is not None:
            continue

        # Gather product_id — lot.product_id is what we prefer; fall
        # back to treating the lot_id as a product_id for
        # catalog_not_on_shelf minted lots (mirrors live-path logic).
        product_id = row["lot_product_id"]
        if not product_id:
            # Could be a product_id stored directly in lot_id (pre-mint
            # catalog_not_on_shelf branch). Validate against products.
            if row["lot_id"]:
                p = conn.execute(
                    "SELECT product_id FROM products WHERE product_id = ?",
                    (row["lot_id"],),
                ).fetchone()
                if p is not None:
                    product_id = p["product_id"]
        if not product_id:
            log.debug(
                "backfill: skipping resolution %s (no product_id)",
                resolution_id,
            )
            continue

        # Derive delta_g + occurred_at from the pattern, matching the
        # live-path logic in ``RepoReconcilerAdapter``. We keep the
        # derivation inline here to avoid a circular import back into
        # the adapter module (``server.cloud`` must not depend on
        # ``server.adapters``).
        delta_g, occurred_at = _derive_backfill_delta(conn, row)
        if delta_g == 0.0:
            continue

        try:
            emitter.emit_reconciler_resolution(
                pattern=row["pattern"],
                product_id=product_id,
                scale_id=scale_id,
                kind=shelf_kind,
                delta_g=delta_g,
                occurred_at=occurred_at,
                resolution_id=resolution_id,
            )
            re_emitted += 1
            log.warning(
                "backfill: re-emitted orphan resolution %s "
                "(pattern=%s, delta_g=%.1f)",
                resolution_id, row["pattern"], delta_g,
            )
        except Exception:  # noqa: BLE001 - backfill must not crash boot
            log.warning(
                "backfill: emit failed for resolution %s",
                resolution_id, exc_info=True,
            )
    if re_emitted > 0:
        log.info(
            "backfill_missing_outbox_events: re-emitted %d orphan "
            "resolution(s) in last %dh window",
            re_emitted, window_hours,
        )
    return re_emitted


def _derive_backfill_delta(
    conn: sqlite3.Connection, row: sqlite3.Row
) -> tuple[float, Optional[str]]:
    """Compute (delta_g, occurred_at) for a backfill row.

    Mirror of :meth:`RepoReconcilerAdapter._derive_delta_g_from_resolution`
    but works off a raw sqlite3.Row instead of a
    :class:`SessionResolution` dataclass, since this module can't import
    the adapter (circular-dep risk — adapter already depends on us).
    """
    pattern = row["pattern"]
    consumed = row["consumed_g"]
    add_event_id = row["add_event_id"]
    remove_event_id = row["remove_event_id"]

    def _ev_ts(event_id: Optional[str]) -> Optional[str]:
        if not event_id:
            return None
        r = conn.execute(
            "SELECT ts FROM scale_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        return r["ts"] if r else None

    def _ev_delta(event_id: Optional[str]) -> float:
        if not event_id:
            return 0.0
        r = conn.execute(
            "SELECT delta_g FROM scale_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        return abs(float(r["delta_g"] or 0.0)) if r else 0.0

    # Delegate to the canonical pattern→side helper so reconciler +
    # back-fill paths can't drift. ``fallback_ts`` is the resolution's
    # ``created_at`` — it's the best available stand-in when neither
    # event carries a timestamp (shouldn't happen in practice; defence
    # in depth for legacy rows).
    remove_ts = _ev_ts(remove_event_id)
    add_ts = _ev_ts(add_event_id)
    fallback_ts: Optional[str] = row["created_at"]
    occurred_at = _pick_occurred_at(pattern, remove_ts, add_ts, fallback_ts)

    if pattern in ("use_return_consumed", "topped_up"):
        if consumed is None:
            return (0.0, occurred_at)
        c = float(consumed)
        if pattern == "topped_up" and c == 0.0:
            return (0.0, occurred_at)
        if pattern == "use_return_consumed" and c < 0:
            return (0.0, occurred_at)
        return (-c, occurred_at)
    if pattern in (
        "in_flight_return", "in_flight_replaced_new_item",
        "in_flight_ttl_expired",
    ):
        if consumed is None or consumed <= 0:
            return (0.0, occurred_at)
        return (-float(consumed), occurred_at)
    if pattern == "consumed_or_removed":
        if consumed is not None and consumed > 0:
            return (-float(consumed), occurred_at)
        return (-_ev_delta(remove_event_id), occurred_at)
    if pattern == "new_arrival":
        return (_ev_delta(add_event_id), occurred_at)
    return (0.0, occurred_at)


# Sentinel for "emit disabled" — producers hold a concrete instance so
# callers don't need ``if emitter is not None:`` everywhere.
class _NullEmitter(CloudEventEmitter):
    """Drop-in replacement for :class:`CloudEventEmitter` when disabled.

    Mirrors the public surface but does nothing. Kept as a sentinel so
    callers that receive a ``None`` emitter never have to guard — every
    site can unconditionally call ``emit_*``. Built via
    :func:`null_emitter` so tests can assert ``isinstance(x, CloudEventEmitter)``
    on either path.
    """

    def __init__(self) -> None:  # noqa: D401 - doc on parent
        # No conn, enabled=False; the parent's __init__ does enough.
        super().__init__(None, enabled=False)  # type: ignore[arg-type]

    def _enqueue(self, payload: dict) -> Optional[str]:  # noqa: ARG002
        return None


def null_emitter() -> CloudEventEmitter:
    """Return a no-op emitter for callers that don't have cloud wired."""
    return _NullEmitter()


__all__ = [
    "ADD_SIDE_PATTERNS",
    "CloudEventEmitter",
    "PATTERN_TO_EVENT_KIND",
    "REMOVE_SIDE_PATTERNS",
    "backfill_missing_outbox_events",
    "null_emitter",
]
