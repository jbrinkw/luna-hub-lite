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
    # in_flight_pickup fires at REMOVE time — occurred_at should be the
    # pickup event's wall clock so the cloud's in_flight_since matches
    # when the user physically picked up the item.
    "in_flight_pickup",
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
    # Companion to ``in_flight_replaced_new_item``: the NEW mass put on
    # the shelf after a replacement. Cloud resolver decides MOVE vs
    # MINT based on the same product_id — see migration
    # 20260424080000_stock_lots_invariant_and_resolve.sql.
    "in_flight_replacement_add": "added",
    "in_flight_ttl_expired": "consumed",
    # v2 territory — no cloud mutation for now.
    "swap_in": None,
    "swap_out": None,
    "relocation": None,
    "unknown": None,
    "no_op": None,
    # Bug B fix 2026-04-22: in_flight_pickup now DOES emit to cloud as a
    # dedicated in_flight_pickup event_kind, which the cloud-side
    # apply_shelf_event (migration 20260425080000) stamps onto
    # stock_lots.in_flight_since without mutating qty. This closes the
    # divergence window where the Pi tracks a bottle as in-flight while
    # the companion consumed_or_removed row zero'd cloud qty, hiding the
    # lot from /chef/inventory entirely.
    "in_flight_pickup": "in_flight_pickup",
    # EMIT→HANDLE matrix fix 2026-04-27: the cloud validator
    # (supabase/functions/shelf-ingest/index.ts VALID_EVENT_KINDS) and
    # the DB branch in private.apply_shelf_event both accept
    # event_kind='in_flight_return' since migration 20260425080000, but
    # no Pi producer path had a mapping — the harness exercised it only
    # via a hand-crafted _enqueue payload. The result: when a user put
    # an in-flight item back, the Pi emitted only ``consumed`` (or
    # ``refilled`` for a top-up), which decremented qty but NEVER
    # cleared stock_lots.in_flight_since. The lot stayed stuck as
    # "in flight" forever in the cloud UI.
    #
    # Fix: synthetic pattern ``in_flight_return_clear`` (never written
    # to session_resolutions — it's an emit-only key) maps to
    # event_kind='in_flight_return'. The fast-path return branch +
    # TTL-reap path both fire this after their consumption emit so the
    # cloud marker gets cleared. Topped-up returns don't need it
    # because ``refilled`` already routes through
    # private.resolve_add_to_shelf_lot which clears in_flight_since.
    "in_flight_return_clear": "in_flight_return",
    # Manual-discard from /inventory remove button (2026-04-27).
    # Synthetic emit-only pattern (never written to session_resolutions
    # — produced exclusively by the Pi-side _delete_lot route). Maps to
    # cloud event_kind='discarded' which the cloud's apply_shelf_event
    # zeros qty + clears in_flight_since/pickup_event_id WITHOUT writing
    # food_logs. See migration 20260427020000_shelf_event_discarded.sql
    # and decisions.md #44 for the rationale (vs. consumed+skip_macros).
    "manual_discard": "discarded",
}


# Cloud-side single-winner resolution (2026-04-22 dual-emit dedup).
#
# Background: a single physical REMOVE event can produce MULTIPLE
# ``session_resolutions`` rows on the Pi. The fast-path in
# ``handlers/scale_events.py`` writes ``in_flight_pickup`` at REMOVE
# time (lot leaves shelf → status=in_flight). Later at session close,
# the reconciler's Pass 2 writes ``consumed_or_removed`` if the pickup
# stayed unpaired (C3: `reconciler.reconcile.py`). Both rows share the
# same ``remove_event_id``. Each row has historically emitted its own
# cloud event → the user physically picked up one bottle but the cloud
# received TWO events:
#   (a) in_flight_pickup → stock_lots.in_flight_since stamped (correct)
#   (b) consumed         → stock_lots.qty_containers decremented (wrong;
#                           the item isn't consumed, just off-shelf)
#
# This module imposes a single-winner precedence so that when multiple
# patterns exist for one physical event, only the highest-priority one
# emits to cloud. Local ``session_resolutions`` rows on the Pi are kept
# untouched — they remain the authoritative audit trail for reconciler
# bookkeeping (e.g. terminal lot accounting via ``consumed_or_removed``
# local apply). The dedup is strictly about which cloud event fires.
#
# Precedence rules (higher wins; ties keep original emit order):
#
#   depleted (30)            — terminal. An empty lot is unambiguous.
#                              If a ``depleted`` event exists for this
#                              remove, the lot is genuinely gone.
#                              (live_scale only; no live_shelf pattern
#                              maps to depleted today.)
#   in_flight_pickup (20)    — the item left the shelf but is expected
#                              back. A wrong in_flight is REVERSIBLE
#                              (the eventual return reconciles it or
#                              the TTL reaper closes it as consumed).
#   consumed_or_removed (10) — leftover REMOVE resolution written by
#                              the reconciler when no ADD paired back.
#                              A wrong consumption decrement is NOT
#                              reversible on the cloud side (creates
#                              phantom qty); prefer the in_flight
#                              marker when both candidates exist.
#
# Patterns not in this map are treated as precedence 0 — they don't
# clash with the REMOVE-event dedup set above. Terminal in-flight
# patterns (``in_flight_return``, ``in_flight_replaced_new_item``,
# ``in_flight_ttl_expired``) are intentionally outside this map: they
# key on the ADD event (or fire standalone for TTL), not on the
# original REMOVE, so they don't participate in this dedup group. The
# reconciler's C3 claim guard already ensures those rows suppress the
# REMOVE-time Pass 2 write in the paired case.
CLOUD_PATTERN_PRECEDENCE: dict[str, int] = {
    "consumed_or_removed": 10,
    "in_flight_pickup": 20,
    "depleted": 30,
}


def _precedence(pattern: Optional[str]) -> int:
    """Return the cloud-emit precedence for ``pattern`` (0 if unknown)."""
    if not pattern:
        return 0
    return CLOUD_PATTERN_PRECEDENCE.get(pattern, 0)


def should_suppress_cloud_emit_for_remove_event(
    conn: sqlite3.Connection,
    *,
    this_pattern: str,
    remove_event_id: Optional[str],
) -> bool:
    """Return True when emitting ``this_pattern`` should be SUPPRESSED.

    Looks up every ``session_resolutions`` row sharing the same
    ``remove_event_id``. If any OTHER pattern for the same REMOVE has
    a strictly higher cloud precedence (per :data:`CLOUD_PATTERN_PRECEDENCE`),
    we suppress the emit so the cloud only receives the winner.

    Why this matters — the 2026-04-22 chocolate-milk bug:
      * fast-path writes ``in_flight_pickup`` at REMOVE time
      * reconciler Pass 2 writes ``consumed_or_removed`` at session
        close for the same REMOVE (unpaired pickup path)
      * both emit to cloud → qty drops AND in_flight_since set
    With this guard, ``consumed_or_removed``'s emit is suppressed when
    an ``in_flight_pickup`` exists for the same REMOVE. The local
    resolution row is kept (Pi accounting still works); only the cloud
    event is suppressed.

    Returns False (no suppression) when:
      * ``remove_event_id`` is None (cross-pattern dedup impossible)
      * ``this_pattern`` has the highest precedence of all rows
      * no other rows exist for this REMOVE
      * the query fails (defensive — we prefer emitting a possibly-
        duplicate event over losing data entirely)
    """
    if not remove_event_id:
        return False
    my_prec = _precedence(this_pattern)
    try:
        rows = conn.execute(
            "SELECT pattern FROM session_resolutions "
            " WHERE remove_event_id = ? AND pattern != ?",
            (remove_event_id, this_pattern),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        log.warning(
            "cloud dedup: session_resolutions lookup failed for "
            "remove_event_id=%s: %s",
            remove_event_id, exc,
        )
        return False
    for row in rows:
        other_pattern = row["pattern"] if hasattr(row, "keys") else row[0]
        if _precedence(other_pattern) > my_prec:
            log.info(
                "cloud dedup: suppressing %s emit for remove_event_id=%s; "
                "%s (precedence %d) wins over %s (precedence %d)",
                this_pattern, remove_event_id,
                other_pattern, _precedence(other_pattern),
                this_pattern, my_prec,
            )
            return True
    return False


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
        pi_event_id: Optional[str] = None,
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
        # Cloud event-viewer support: include the Pi's scale_events.event_id
        # so the browser can LAN-fetch images via
        #   http://<lan_ip>:8000/event/<pi_event_id>/before.jpg
        # Backward-compatible: older edge-function versions ignore this
        # field. See migration 20260421040000_event_overrides.sql for the
        # cloud-side storage of shelf_event_log.pi_event_id.
        if pi_event_id:
            payload["pi_event_id"] = pi_event_id
        return self._enqueue(payload)

    def emit_single_item_event(
        self,
        *,
        scale_id: str,
        product_id: Optional[str],
        delta_g: float,
        noise_floor_g: float,
        refill_threshold_g: float,
        depleted: bool,
        occurred_at: Optional[str] = None,
        pi_event_id: Optional[str] = None,
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
            "delta_g": emit_delta,
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        # Pi can omit product_id — cloud's shelf-ingest /event resolves it
        # via scale_pairings. Only include when the caller already knows.
        if product_id is not None:
            payload["product_id"] = product_id
        if pi_event_id:
            payload["pi_event_id"] = pi_event_id
        return self._enqueue(payload)

    def emit_in_flight_reap(
        self,
        *,
        scale_id: str,
        product_id: str,
        consumed_g: float,
        occurred_at: Optional[str] = None,
        pi_event_id: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a ``consumed`` event for a TTL-expired in-flight lot.

        The reaper flips the lot to ``out`` after it stays off-shelf for
        ``in_flight_ttl_seconds``; we mirror that as a consumption of the
        full pickup mass since the item never came back.

        NOTE: this emits ONLY the consumed event. Callers must invoke
        :meth:`emit_in_flight_return_marker` afterward to clear the
        cloud's ``stock_lots.in_flight_since`` — apply_shelf_event's
        consumed branch does NOT clear the marker on its own (EMIT→HANDLE
        matrix fix 2026-04-27).
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
        if pi_event_id:
            payload["pi_event_id"] = pi_event_id
        return self._enqueue(payload)

    def emit_manual_discard(
        self,
        *,
        scale_id: str,
        product_id: str,
        kind: str = "live_shelf",
        occurred_at: Optional[str] = None,
        pi_event_id: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a cloud ``discarded`` event from the Pi /inventory remove button.

        Manual discard semantics: the user explicitly removed the lot
        from inventory WITHOUT recording it as consumed (spilled,
        expired-and-thrown-out, fed-to-pet, given-away). The cloud
        handler (migration 20260427020000_shelf_event_discarded.sql)
        zeros qty_containers, clears in_flight_since +
        pickup_event_id, sets last_update_source='manual_discard', and
        DOES NOT write a food_logs row.

        Idempotent on already-zeroed-and-cleared lots — the cloud
        returns applied=true with reason='discarded (idempotent
        no-op)'. Safe to call as a recovery affordance for stuck
        in-flight lots.

        Producer is the Pi web /api/lot/<lot_id>/delete handler; the
        local DELETE on the Pi happens before this emit so the local
        state is the leading edge. Cloud-side dedup via
        shelf_event_log UNIQUE(user_id, client_event_id) makes a
        worker retry safe.
        """
        if not product_id:
            return None
        payload: dict[str, Any] = {
            "scale_id": scale_id,
            "kind": kind,
            "event_kind": "discarded",
            "product_id": product_id,
            # delta_g is informational for ``discarded`` (handler zeroes
            # the lot regardless). Send 0.0 to satisfy the edge fn
            # validator without claiming a specific mass.
            "delta_g": 0.0,
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        if pi_event_id:
            payload["pi_event_id"] = pi_event_id
        return self._enqueue(payload)

    def emit_in_flight_return_marker(
        self,
        *,
        scale_id: str,
        product_id: str,
        kind: str = "live_shelf",
        occurred_at: Optional[str] = None,
        pi_event_id: Optional[str] = None,
    ) -> Optional[str]:
        """Emit a cloud ``in_flight_return`` marker-clear event.

        EMIT→HANDLE matrix fix 2026-04-27. The cloud's
        ``private.apply_shelf_event`` handler for
        ``event_kind='in_flight_return'`` clears
        ``stock_lots.in_flight_since`` + ``pickup_event_id`` on the
        matching lot WITHOUT mutating qty_containers. Producers pair
        this with their ``consumed`` emit (TTL reap; same-item return)
        so the cloud's in-flight marker tracks the Pi's lot status.

        Topped-up returns (``refilled`` cloud event_kind) don't need
        this — ``private.resolve_add_to_shelf_lot`` already clears the
        marker on the ADD path. Replacement returns (new item heavier
        than pickup) also emit ``added`` which clears the marker via
        the same resolve path.

        Idempotent: the cloud returns applied=true, reason='no in_flight
        lot to clear (no-op)' when no matching lot exists. Safe to call
        multiple times; ``shelf_event_log`` dedup on
        ``(user_id, client_event_id)`` guarantees at-most-once.
        """
        if not product_id:
            return None
        payload: dict[str, Any] = {
            "scale_id": scale_id,
            "kind": kind,
            "event_kind": "in_flight_return",
            "product_id": product_id,
            # delta_g is ignored by the cloud handler for this kind but
            # required by the edge function's validator. Zero is the
            # unambiguous "no mutation" value.
            "delta_g": 0.0,
            "occurred_at": occurred_at or _iso_utc_ms(),
        }
        if pi_event_id:
            payload["pi_event_id"] = pi_event_id
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
                   'in_flight_replaced_new_item', 'in_flight_ttl_expired',
                   -- Bug B fix 2026-04-22: in_flight_pickup now emits to
                   -- cloud as a dedicated event_kind that stamps
                   -- stock_lots.in_flight_since.
                   'in_flight_pickup'
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

        # Single-winner dedup mirror (2026-04-22 dual-emit fix): skip
        # rows whose pattern would be outranked by another resolution
        # for the same REMOVE event. The live-path adapter runs the
        # same check inside ``_emit_cloud_for_resolution``; the backfill
        # must replicate it or else the next boot would re-emit the
        # loser (e.g. a ``consumed_or_removed`` row that rode in behind
        # an ``in_flight_pickup``) and re-introduce the dual-emit bug.
        if row["pattern"] in CLOUD_PATTERN_PRECEDENCE and (
            should_suppress_cloud_emit_for_remove_event(
                conn,
                this_pattern=row["pattern"],
                remove_event_id=row["remove_event_id"],
            )
        ):
            continue

        # Derive delta_g + occurred_at from the pattern, matching the
        # live-path logic in ``RepoReconcilerAdapter``. We keep the
        # derivation inline here to avoid a circular import back into
        # the adapter module (``server.cloud`` must not depend on
        # ``server.adapters``).
        delta_g, occurred_at = _derive_backfill_delta(conn, row)
        if delta_g == 0.0:
            continue

        # Backfill pi_event_id for cloud event viewer — pick
        # remove_event_id for REMOVE-side patterns, add_event_id for
        # ADD-side. Backward-compatible: cloud edge fn ignores if older.
        backfill_pi_event_id: Optional[str] = None
        if row["pattern"] in REMOVE_SIDE_PATTERNS:
            backfill_pi_event_id = (
                row["remove_event_id"] or row["add_event_id"]
            )
        elif row["pattern"] in ADD_SIDE_PATTERNS:
            backfill_pi_event_id = (
                row["add_event_id"] or row["remove_event_id"]
            )
        try:
            emitter.emit_reconciler_resolution(
                pattern=row["pattern"],
                product_id=product_id,
                scale_id=scale_id,
                kind=shelf_kind,
                delta_g=delta_g,
                occurred_at=occurred_at,
                resolution_id=resolution_id,
                pi_event_id=backfill_pi_event_id,
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
    if pattern == "in_flight_pickup":
        # Cloud handler doesn't consume delta_g for this pattern, but we
        # pass the pickup mass (negative) so downstream analytics are
        # consistent with the live-path emit. See reconciler_repo
        # ._derive_delta_g_from_resolution for the mirror.
        return (-_ev_delta(remove_event_id), occurred_at)
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
    "CLOUD_PATTERN_PRECEDENCE",
    "CloudEventEmitter",
    "PATTERN_TO_EVENT_KIND",
    "REMOVE_SIDE_PATTERNS",
    "backfill_missing_outbox_events",
    "null_emitter",
    "should_suppress_cloud_emit_for_remove_event",
]
