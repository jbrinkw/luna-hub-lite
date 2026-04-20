"""Session reconciler — §5.5 close flow and §8 algorithm.

`reconcile_session(session_id, repo)` walks the scale events of a closed
session, pairs REMOVEs with ADDs by classifier-identified lot identity,
emits `session_resolutions` for every pattern, runs a weight sanity
check, and updates lots via the repo.

Storage access is mediated by the `ReconcilerRepo` protocol — Bundle H
injects a real implementation backed by Bundle A. We never import
Bundle A or Bundle D directly.

Scope: single-shelf demo. `relocation` is defined in the schema but
not detected here (would need cross-shelf events). All §8 logic is
implemented as 4 explicit passes.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional, Protocol

from .models import (
    ClassificationResult,
    LotLike,
    MatchCandidate,
    PairingCandidate,
    PatternClassification,
    ReviewQueueItem,
    ScaleEventLike,
    SessionLike,
    SessionResolution,
    UNKNOWN_ITEM_IDS,
    normalize_classification,
)


log = logging.getLogger(__name__)


# Optional lifecycle sink set by app.py.
_LIFECYCLE_SINK: Optional[Any] = None


def set_lifecycle_sink(sink: Optional[Any]) -> None:
    global _LIFECYCLE_SINK
    _LIFECYCLE_SINK = sink


def _lc(session_id: Optional[str], *, actor: str, reason_code: str,
        payload: Optional[dict[str, Any]] = None) -> None:
    sink = _LIFECYCLE_SINK
    if sink is None or not session_id:
        return
    try:
        sink(session_id, actor=actor, reason_code=reason_code, payload=payload)
    except Exception:  # pragma: no cover - observability must not raise
        log.warning("reconciler lifecycle sink raised", exc_info=True)


# -- Tunable thresholds (§8) ----------------------------------------------

# `classify_pair` thresholds (§8)
CONSUMED_NEAR_ZERO_G: float = 5.0  # |consumed| < this → use_return_no_consumption
TOPPED_UP_THRESHOLD_G: float = 5.0  # consumed < -this → topped_up

# Weight sanity check tolerance (§8, §5.5d)
WEIGHT_SANITY_TOLERANCE_G: float = 10.0

# Swap detection timing (§11 notes — same session, similar timing)
# If REMOVE and ADD within this window have different identities but
# similar magnitudes, treat as swap_out/swap_in. MVP heuristic only.
SWAP_SIMILAR_WEIGHT_PCT: float = 0.20  # ±20%


# -- Per-session reconcile serialization ---------------------------------
#
# Two concurrent ``reconcile_session`` calls for the SAME session_id
# can both pass the ``session.reconciled`` read-check before either
# writes ``reconciled=1``. ``session_resolutions`` has no unique
# constraint, so both would persist duplicate rows and double-count
# lot consumption. We serialize same-session calls with a per-session
# lock allocated on demand under a small guard lock. The entry is
# removed when the winning thread exits so the dict doesn't grow
# unbounded across many sessions.
_SESSION_RECONCILE_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD: threading.Lock = threading.Lock()


# -- Repo protocol --------------------------------------------------------


class ReconcilerRepo(Protocol):
    """Minimal storage surface the reconciler needs. Bundle H implements.

    Method contracts:

        get_session(session_id)
            Return the `SessionLike` for this id, or raise if missing.
            Used for the weight sanity check (reads
            initial/final_shelf_weight_g).

        get_events_for_session(session_id)
            Return all `scale_events` rows for this session ordered
            ascending by `ts`. Every row's `classification` field may be
            a dict (JSON-decoded column) or a ClassificationResult. The
            reconciler normalizes at read time.

        get_lot(lot_id)
            Return the `LotLike`, or None if unknown (classifier might
            return an item_id that no longer resolves — we skip it).

        write_resolution(resolution)
            Persist a `SessionResolution` row. Should return the
            freshly-inserted resolution_id (used to link a review_queue
            row to the resolution), but the reconciler tolerates a
            return of None.

        enqueue_review(item)
            Write a `review_queue` row. Return value unused.

        update_lot_on_resolution(resolution, lot)
            Apply the side-effect of a committed resolution to the
            affected lot:
              - use_return_*, topped_up: lot.current_weight_g ←
                add_event.after_weight_g, total_consumed_g +=
                max(0, consumed_g), status = 'on_shelf'
              - consumed_or_removed: status stays 'out' (reconciler does
                not re-home depleted items in MVP)
              - new_arrival: a fresh lot was minted by the ADD handler at
                event time — this hook can refresh weights/timestamps
            The implementation lives in Bundle H; the reconciler merely
            invokes it so the repo can keep related writes atomic.
    """

    def get_session(self, session_id: str) -> SessionLike:
        ...

    def get_events_for_session(
        self, session_id: str
    ) -> list[ScaleEventLike]:
        ...

    def get_lot(self, lot_id: str) -> Optional[LotLike]:
        ...

    def write_resolution(
        self, resolution: SessionResolution
    ) -> Optional[str]:
        ...

    def enqueue_review(self, item: ReviewQueueItem) -> None:
        ...

    def update_lot_on_resolution(
        self,
        resolution: SessionResolution,
        lot: Optional[LotLike],
    ) -> None:
        ...

    def list_existing_resolutions(
        self, session_id: str
    ) -> list[SessionResolution]:
        """Return session_resolutions rows already written for this session.

        IN_FLIGHT_TRACKER_PLAN.md §7.1 — the fast-path apply in
        ``handlers/scale_events.py`` writes ``in_flight_pickup`` /
        ``in_flight_return`` / ``in_flight_replaced_new_item`` rows at
        event time. Reconciler passes skip any event already claimed by
        those rows to avoid double-booking. Default implementation may
        return ``[]`` — older ReconcilerRepo stubs without the method
        fall back to that via getattr in ``process_session_events``.
        """
        ...

    def mark_session_reconciled(self, session_id: str) -> None:
        """Flip the session's ``reconciled`` flag.

        H3: the reconciler calls this as the FIRST write inside
        ``_reconcile_session_locked`` so a crash or retry after that
        point is short-circuited by the idempotency guard at the top of
        the same function (which reads ``session.reconciled``). Older
        test stubs without the method degrade gracefully — the
        reconciler reaches for it via ``getattr`` and skips if absent.
        """
        ...


# -- Helpers --------------------------------------------------------------


def classify_pair(
    consumed: float,
    remove_ev: ScaleEventLike,
    add_ev: ScaleEventLike,
) -> PatternClassification:
    """§8 pair pattern classifier.

    Given a REMOVE then later ADD of the same lot, the "consumed" amount
    is ``|remove_delta| - |add_delta|`` — positive if the returned
    container weighs less (food consumed), negative if it weighs more
    (contents were added to it — a top-up).

    Thresholds (§8):
      - |consumed| < 5g  → use_return_no_consumption (just picked up and
        replaced; measurement noise)
      - consumed  > 5g  → use_return_consumed
      - consumed  < -5g → topped_up
    """
    if abs(consumed) < CONSUMED_NEAR_ZERO_G:
        pattern = "use_return_no_consumption"
    elif consumed > CONSUMED_NEAR_ZERO_G:
        pattern = "use_return_consumed"
    else:
        # consumed < -TOPPED_UP_THRESHOLD_G (i.e. <= -5g)
        pattern = "topped_up"
    return PatternClassification(pattern=pattern, consumed_g=consumed)


def _extract_multi_match(
    cls: ClassificationResult,
) -> list[MatchCandidate]:
    """Return the multi_match list, or a singleton wrapping item_id.

    REMOVE events can identify multiple lots at once (§5.4, §7.1). When
    multi_match is empty but item_id is set, we treat the single-item
    case uniformly.
    """
    if cls.multi_match:
        return list(cls.multi_match)
    if cls.item_id and cls.item_id not in UNKNOWN_ITEM_IDS:
        return [
            MatchCandidate(
                candidate_id=cls.item_id, confidence=cls.confidence
            )
        ]
    return []


def _is_identified(cls: ClassificationResult) -> bool:
    """Classifier nailed a concrete lot_id."""
    return (
        cls.item_id is not None and cls.item_id not in UNKNOWN_ITEM_IDS
    )


def _similar_magnitude(a: float, b: float, pct: float) -> bool:
    base = max(abs(a), abs(b))
    if base == 0:
        return abs(a - b) < 1e-6
    return abs(abs(a) - abs(b)) / base <= pct


# -- Main entry point -----------------------------------------------------


def reconcile_session(
    session_id: str,
    repo: ReconcilerRepo,
) -> list[SessionResolution]:
    """§8 — reconcile all events in a closed session.

    Returns the list of resolutions that were written. Side-effects:
    writes `session_resolutions` rows, enqueues `review_queue` items
    for weight mismatches, and updates lot state via the repo.

    The 4 passes mirror the pseudocode verbatim:
      1. Pair REMOVEs with later ADDs by lot_id
      2. Leftover REMOVEs → consumed_or_removed (expand multi_match)
      3. Leftover ADDs    → new_arrival OR use_return_consumed (if lot
                            was previously 'out')
      4. Weight sanity    → enqueue weight_mismatch if |Σdelta - final| > 10g

    A swap detection step runs between passes 2 and 3: leftover
    REMOVE + leftover ADD in the same session with different
    identities but similar magnitudes → swap_out + swap_in.

    Special cases:
      - No events at all → emit a single 'no_op' resolution so the
        session still has an audit trail.
      - Unidentified events already have review_queue rows from the
        ingestion path (§5.3/§5.4) — the reconciler does not re-enqueue
        them, but it does emit a resolution with pattern='unknown' so
        the session timeline shows them.
    """
    # Per-session serialization: the TOCTOU between the ``reconciled``
    # read below and the ``mark_session_reconciled`` write at the end
    # would otherwise let two concurrent callers both pass the early
    # check, both write duplicate resolutions, then both mark the row
    # reconciled. Allocate (or reuse) a lock keyed by session_id and
    # hold it across the full read→work→write sequence.
    with _LOCKS_GUARD:
        session_lock = _SESSION_RECONCILE_LOCKS.get(session_id)
        if session_lock is None:
            session_lock = threading.Lock()
            _SESSION_RECONCILE_LOCKS[session_id] = session_lock

    with session_lock:
        try:
            return _reconcile_session_locked(session_id, repo)
        finally:
            # Drop the entry so the dict doesn't grow unbounded across
            # many sessions. Guarded to stay consistent with the
            # allocation path above.
            with _LOCKS_GUARD:
                _SESSION_RECONCILE_LOCKS.pop(session_id, None)


def _reconcile_session_locked(
    session_id: str,
    repo: ReconcilerRepo,
) -> list[SessionResolution]:
    """Body of :func:`reconcile_session` — called with the per-session
    lock already held. See that function's docstring."""
    session = repo.get_session(session_id)

    # Idempotency guard: reconciling a session twice duplicates every
    # session_resolutions row and double-counts lot consumption because
    # ``session_resolutions`` has no unique constraint on
    # ``(session_id, add_event_id/remove_event_id)``. Back-to-back
    # brightness wobbles or a retry after a partial-write crash can
    # trigger this. If the session is already marked reconciled, bail.
    # The per-session lock acquired by the public wrapper closes the
    # TOCTOU window between this read and the final write.
    if session is not None and getattr(session, "reconciled", 0):
        log.info(
            "reconciler: session %s already reconciled; skipping",
            session_id,
        )
        _lc(
            session_id,
            actor="reconciler",
            reason_code="reconciler_skipped_idempotent",
        )
        return []

    # H3: flip the ``reconciled`` flag as the VERY FIRST write. If a
    # crash or retry lands after this point, the idempotency guard
    # above returns ``[]`` on the next attempt instead of re-writing
    # resolutions and double-counting consumption. ``getattr`` keeps
    # older test stubs that don't implement the method working — the
    # pre-H3 behavior was to mark reconciled at the end, so missing
    # the method just reverts to that on those stubs.
    _mark_reconciled = getattr(repo, "mark_session_reconciled", None)
    if callable(_mark_reconciled):
        try:
            _mark_reconciled(session_id)
        except Exception:  # pragma: no cover - defensive
            log.exception(
                "reconciler: mark_session_reconciled raised for %s",
                session_id,
            )

    events = list(repo.get_events_for_session(session_id))

    resolutions: list[SessionResolution] = []

    # IN_FLIGHT_TRACKER_PLAN.md §7: events claimed by the fast-path
    # apply (in_flight_pickup / in_flight_return /
    # in_flight_replaced_new_item) are already resolved — don't
    # re-resolve them here. Build a set of claimed event_ids so the
    # reconciler passes skip them. Graceful fallback via getattr for
    # older test stubs that don't implement list_existing_resolutions.
    #
    # C3: ``in_flight_pickup`` rows are conditional — only claim the
    # REMOVE event if a matching terminal in-flight resolution
    # (in_flight_return / in_flight_replaced_new_item /
    # in_flight_ttl_expired) exists for the same lot in the same
    # session. Without that pairing, the pickup is UNPAIRED (return
    # never came, server crashed mid-session, etc.) and letting Pass 2
    # resolve the REMOVE as ``consumed_or_removed`` is how the lot
    # gets its terminal accounting — otherwise the REMOVE event is
    # permanently swallowed and the lot never reconciles.
    _list_existing = getattr(repo, "list_existing_resolutions", None)
    claimed_event_ids: set[str] = set()
    if callable(_list_existing):
        try:
            existing_list = list(_list_existing(session_id))
            # Build a set of lot_ids that have a terminal in-flight
            # resolution in this session. If a lot_id appears here, its
            # ``in_flight_pickup`` REMOVE was paired and the pickup row
            # is safe to claim.
            lot_ids_with_terminal_in_flight: set[str] = {
                getattr(r, "lot_id", None)
                for r in existing_list
                if getattr(r, "pattern", None) in (
                    "in_flight_return",
                    "in_flight_replaced_new_item",
                    "in_flight_ttl_expired",
                    "topped_up",
                )
                and getattr(r, "lot_id", None) is not None
            }
            for existing in existing_list:
                p = getattr(existing, "pattern", None)
                if p not in (
                    "in_flight_pickup",
                    "in_flight_return",
                    "in_flight_replaced_new_item",
                    "in_flight_ttl_expired",
                ):
                    continue
                add_id = getattr(existing, "add_event_id", None)
                remove_id = getattr(existing, "remove_event_id", None)
                if add_id:
                    claimed_event_ids.add(add_id)
                if p == "in_flight_pickup":
                    # C3: only claim the REMOVE if a terminal in-flight
                    # resolution exists for the same lot this session.
                    # Unpaired pickups fall through to Pass 2 so the
                    # lot still gets terminal accounting.
                    r_lot = getattr(existing, "lot_id", None)
                    if remove_id and r_lot in lot_ids_with_terminal_in_flight:
                        claimed_event_ids.add(remove_id)
                else:
                    if remove_id:
                        claimed_event_ids.add(remove_id)
        except Exception:  # pragma: no cover - defensive
            log.exception(
                "reconciler: list_existing_resolutions raised on session %s",
                session_id,
            )
    if claimed_event_ids:
        before_count = len(events)
        events = [e for e in events if e.event_id not in claimed_event_ids]
        log.info(
            "reconciler: session %s skipped %d events already claimed by "
            "fast-path in_flight resolutions",
            session_id, before_count - len(events),
        )

    # No events → no_op and we're done.
    if not events:
        res = SessionResolution(
            session_id=session_id,
            pattern="no_op",
        )
        resolutions.append(res)
        repo.write_resolution(res)
        repo.update_lot_on_resolution(res, None)
        return resolutions

    # Normalize classifications once so downstream logic can rely on
    # ClassificationResult attributes instead of defensive dict probes.
    normalized: dict[str, ClassificationResult] = {
        ev.event_id: normalize_classification(ev.classification)
        for ev in events
    }

    # Ordered working copy; we pull events out as they get paired so
    # later passes only see leftovers. List-of-events matches §8.
    remaining: list[ScaleEventLike] = list(events)

    def _remove(ev: ScaleEventLike) -> None:
        try:
            remaining.remove(ev)
        except ValueError:
            pass

    # ---- Pass 1: pair REMOVE → later ADD by lot_id ----------------------
    # Iterate on a snapshot of the remove events; we mutate `remaining`.
    for ev_remove in [e for e in list(remaining) if e.direction == "remove"]:
        rcls = normalized[ev_remove.event_id]
        if not _is_identified(rcls):
            continue
        # Only consider the first (earliest) later ADD with the same lot.
        for ev_add in [
            e
            for e in remaining
            if e.direction == "add" and e.ts > ev_remove.ts
        ]:
            acls = normalized[ev_add.event_id]
            if not _is_identified(acls):
                continue
            if acls.item_id != rcls.item_id:
                continue

            consumed = abs(ev_remove.delta_g) - abs(ev_add.delta_g)
            cls_pair = classify_pair(consumed, ev_remove, ev_add)
            confidence = min(rcls.confidence, acls.confidence)

            res = SessionResolution(
                session_id=session_id,
                pattern=cls_pair.pattern,
                lot_id=rcls.item_id,
                consumed_g=cls_pair.consumed_g,
                add_event_id=ev_add.event_id,
                remove_event_id=ev_remove.event_id,
                confidence=confidence,
            )
            resolutions.append(res)
            _remove(ev_remove)
            _remove(ev_add)
            break  # One ADD pairs with one REMOVE; next remove.

    # ---- Pass 2: leftover REMOVEs → consumed_or_removed -----------------
    for ev in [e for e in list(remaining) if e.direction == "remove"]:
        cls = normalized[ev.event_id]

        if not _is_identified(cls):
            # Classifier couldn't pin it. Emit 'unknown' for audit;
            # review_queue row already exists from §5.4 ingestion path.
            resolutions.append(
                SessionResolution(
                    session_id=session_id,
                    pattern="unknown",
                    lot_id=None,
                    remove_event_id=ev.event_id,
                    confidence=cls.confidence,
                )
            )
            _remove(ev)
            continue

        # Expand multi_match into one resolution per matched lot,
        # splitting via per-candidate confidence (§8). Single-match
        # case falls through the helper which yields a one-element list.
        matches = _extract_multi_match(cls)
        for match in matches:
            resolutions.append(
                SessionResolution(
                    session_id=session_id,
                    pattern="consumed_or_removed",
                    lot_id=match.candidate_id,
                    # MVP: we don't compute consumed_g for unpaired
                    # removes — the item might come back next session.
                    consumed_g=None,
                    remove_event_id=ev.event_id,
                    confidence=match.confidence,
                )
            )
        _remove(ev)

    # ---- Swap detection (between passes 2 and 3) ------------------------
    # Happens BEFORE Pass 3 so that a REMOVE+ADD with different identities
    # doesn't get mis-classified as a lone new_arrival. Only applies to
    # leftover ADDs following a leftover REMOVE in same session with
    # similar-magnitude weights (MVP heuristic §11).
    #
    # Fix 2: we only consider REMOVEs whose resolutions are CURRENTLY
    # marked ``consumed_or_removed``. Previously we scanned the full
    # input `events` list — if a REMOVE was paired by Pass 1 (and thus
    # has no `consumed_or_removed` resolution), the in-place rewrite
    # below would silently miss it but a ``swap_in`` would still be
    # appended, producing an orphan. By restricting to REMOVEs that
    # actually have a ``consumed_or_removed`` resolution pending
    # rewrite, we guarantee every emitted ``swap_in`` has a matching
    # ``swap_out``.
    swap_pairs: list[tuple[ScaleEventLike, ScaleEventLike]] = []
    leftover_adds = [e for e in remaining if e.direction == "add"]

    # Build an event_id → event lookup for the REMOVEs that Pass 2 wrote
    # out as consumed_or_removed. These are the ONLY legal swap_out
    # candidates: any other REMOVE has already been paired (Pass 1) or
    # is still unresolved, and mutating a non-existent resolution leaves
    # orphans.
    consumed_or_removed_by_event: dict[str, ScaleEventLike] = {}
    event_by_id = {e.event_id: e for e in events}
    for r in resolutions:
        if (
            r.pattern == "consumed_or_removed"
            and r.remove_event_id is not None
            and r.remove_event_id in event_by_id
        ):
            consumed_or_removed_by_event[r.remove_event_id] = event_by_id[
                r.remove_event_id
            ]

    for ev_add in list(leftover_adds):
        acls = normalized[ev_add.event_id]
        if not _is_identified(acls):
            continue
        # Find the most recent REMOVE-with-a-consumed_or_removed-resolution
        # *before* this ADD whose lot differs from the ADD's lot.
        candidate_remove: Optional[ScaleEventLike] = None
        candidates = sorted(
            [
                e
                for e in consumed_or_removed_by_event.values()
                if e.ts < ev_add.ts
            ],
            key=lambda e: e.ts,
            reverse=True,
        )
        for ev_remove in candidates:
            rcls = normalized[ev_remove.event_id]
            if not _is_identified(rcls):
                continue
            if rcls.item_id == acls.item_id:
                # Same identity — Pass 1 would have caught it. Skip.
                continue
            if _similar_magnitude(
                ev_remove.delta_g, ev_add.delta_g, SWAP_SIMILAR_WEIGHT_PCT
            ):
                candidate_remove = ev_remove
                break
        if candidate_remove is None:
            continue

        # Convert the previously-emitted consumed_or_removed for the
        # REMOVE into swap_out, and emit a swap_in for the ADD. The
        # invariant above guarantees this lookup succeeds — if it
        # somehow doesn't we bail without emitting swap_in rather than
        # leaving an orphan.
        target_lot_id = normalized[candidate_remove.event_id].item_id
        rewrote = False
        for i, r in enumerate(resolutions):
            if (
                r.pattern == "consumed_or_removed"
                and r.remove_event_id == candidate_remove.event_id
                and r.lot_id == target_lot_id
            ):
                resolutions[i] = SessionResolution(
                    session_id=session_id,
                    pattern="swap_out",
                    lot_id=target_lot_id,
                    consumed_g=None,
                    remove_event_id=candidate_remove.event_id,
                    confidence=r.confidence,
                )
                rewrote = True
                break
        if not rewrote:
            # Defensive: no matching consumed_or_removed to rewrite.
            # Skip this swap rather than create an orphan swap_in.
            continue
        # Remove the now-consumed REMOVE from the eligible pool so two
        # adjacent ADDs can't both claim the same swap_out.
        consumed_or_removed_by_event.pop(candidate_remove.event_id, None)

        resolutions.append(
            SessionResolution(
                session_id=session_id,
                pattern="swap_in",
                lot_id=acls.item_id,
                consumed_g=None,
                add_event_id=ev_add.event_id,
                confidence=acls.confidence,
            )
        )
        swap_pairs.append((candidate_remove, ev_add))
        _remove(ev_add)

    # ---- Pass 3: leftover ADDs → new_arrival or returning out-lot -------
    for ev in [e for e in list(remaining) if e.direction == "add"]:
        cls = normalized[ev.event_id]

        if not _is_identified(cls):
            # UNKNOWN sentinel / unidentified — review queue row already
            # exists from §5.3 (unknown_item_add). We DO emit an
            # 'unknown' audit row so the session timeline is complete.
            resolutions.append(
                SessionResolution(
                    session_id=session_id,
                    pattern="unknown",
                    lot_id=None,
                    add_event_id=ev.event_id,
                    confidence=cls.confidence,
                )
            )
            _remove(ev)
            continue

        lot = repo.get_lot(cls.item_id)
        if lot is not None and lot.status == "out":
            # Returning from a prior session — consumption happened off-shelf.
            prior_weight = (
                lot.current_weight_g
                if lot.current_weight_g is not None
                else 0.0
            )
            consumed = max(0.0, prior_weight - ev.after_weight_g)
            resolutions.append(
                SessionResolution(
                    session_id=session_id,
                    pattern="use_return_consumed",
                    lot_id=lot.lot_id,
                    consumed_g=consumed,
                    add_event_id=ev.event_id,
                    confidence=cls.confidence,
                )
            )
        else:
            resolutions.append(
                SessionResolution(
                    session_id=session_id,
                    pattern="new_arrival",
                    lot_id=lot.lot_id if lot is not None else cls.item_id,
                    add_event_id=ev.event_id,
                    confidence=cls.confidence,
                )
            )
        _remove(ev)

    # ---- Pass 4 (DEFERRED: same-session TTL reap) -----------------------
    # TODO(H4): Flip lots that are still ``status='in_flight'`` with
    # ``pickup_session_id == session_id`` AND in-flight duration exceeding
    # ``cfg.in_flight_ttl_seconds`` to ``out`` + write
    # ``in_flight_ttl_expired`` resolution + usage_log row + increment
    # ``total_consumed_g``.
    #
    # Gap: sessions that close and reconcile between two sweeper ticks
    # skip the existing TTL reaper for that window. The sweeper runs on a
    # 5s interval, so the race window is small. Deferred to avoid
    # threading a new TTL config through the reconciler signature +
    # extending the ReconcilerRepo protocol with a new storage method.
    # The existing 5s-tick reaper (scale_events.py _reap_expired_in_flight)
    # still covers the TTL case end-to-end; Pass 4 here would only close
    # a narrow inter-tick race that the operator wouldn't observe.
    #
    # ---- Pass 4 (existing): weight sanity check -------------------------
    initial_w = session.initial_shelf_weight_g
    final_w = session.final_shelf_weight_g
    if initial_w is not None and final_w is not None:
        expected_delta = final_w - initial_w
        actual_delta = 0.0
        for e in events:
            mag = abs(e.delta_g)
            if e.direction == "remove":
                actual_delta -= mag
            elif e.direction == "add":
                actual_delta += mag
            # 'noise' direction contributes nothing
        if abs(expected_delta - actual_delta) > WEIGHT_SANITY_TOLERANCE_G:
            repo.enqueue_review(
                ReviewQueueItem(
                    kind="weight_mismatch",
                    session_id=session_id,
                    proposed={
                        "expected_delta_g": expected_delta,
                        "actual_delta_g": actual_delta,
                        "tolerance_g": WEIGHT_SANITY_TOLERANCE_G,
                        "events": [
                            {
                                "event_id": e.event_id,
                                "direction": e.direction,
                                "delta_g": e.delta_g,
                            }
                            for e in events
                        ],
                    },
                )
            )

    # ---- Commit resolutions + update affected lots ----------------------
    for r in resolutions:
        repo.write_resolution(r)
        lot = repo.get_lot(r.lot_id) if r.lot_id else None
        repo.update_lot_on_resolution(r, lot)

    _lc(
        session_id,
        actor="reconciler",
        reason_code="reconciler_completed_internal",
        payload={
            "resolutions_written": len(resolutions),
            "errors_count": 0,
        },
    )
    return resolutions
