"""`WebRepo` protocol → Bundle A repo adapter.

The web UI consumes dicts with join fields flattened. This adapter
translates typed repo rows into those dict shapes and handles the
``resolve_review_item`` write path (§5.6).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import asdict, is_dataclass
from typing import Any, Optional

from ..handlers.scale_events import get_scale_runtime_state
from ..storage import lifecycle, repo as storage_repo
from ..storage.lifecycle import ReasonCode
from ..storage.models import AppStatePatch, LotIn, ReviewQueueIn
from ..tools.locks import NullLock as _NullLock

log = logging.getLogger(__name__)


def _to_dict(obj: Any) -> dict[str, Any]:
    """Pydantic-dataclass → plain dict (safe for Jinja / JSON)."""
    if obj is None:
        return {}
    if is_dataclass(obj):
        return asdict(obj)
    if isinstance(obj, dict):
        return obj
    return {}


def _json_or_none(raw: Optional[str]) -> Any:
    if raw is None or raw == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


class RepoWebAdapter:
    """Concrete :class:`web.WebRepo` implementation.

    Uses a caller-supplied lock to serialize all DB access. Without this,
    concurrent Flask request threads + background sweeper + session-
    capture callback + scale-event handler all hit the same sqlite3
    connection simultaneously, which SQLite surfaces as the cryptic
    ``sqlite3.InterfaceError: bad parameter or other API misuse``.

    ``db_lock`` is optional only so tests that construct an in-memory
    single-thread repo don't have to wire one; production callers in
    ``app.py`` MUST pass the same ``db_lock`` instance that the scale
    event / brightness / sweeper paths use.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        db_lock: Optional[threading.Lock] = None,
        apply_reviewed_candidate_fn: Optional[Any] = None,
        *,
        catch_all_device_id: str = "scale-02",
    ) -> None:
        self._conn = conn
        self._db_lock: Any = db_lock if db_lock is not None else _NullLock()
        # Optional callback invoked by resolve_review_item when the user
        # confirms a candidate via the review UI. Signature:
        #   fn(*, event_id: str, candidate_id: str) -> dict
        # When None, review resolution is metadata-only (the original MVP
        # behavior) — but this means user-confirmed candidates don't
        # actually create/update lots, so the intended product never
        # reaches inventory. app.py wires this to ScaleHandler's
        # apply_user_reviewed_candidate.
        self._apply_reviewed_candidate_fn = apply_reviewed_candidate_fn
        # Pass-2 audit finding #14: threading the catch-all device id
        # through ``__init__`` (rather than reading it from
        # ``os.environ`` each call) removes the hidden env-var
        # dependency from :meth:`get_catch_all_state`, which was
        # breaking test isolation that patched ``AppConfig`` but not
        # the environment.
        self._catch_all_device_id = str(catch_all_device_id)

    # ----------------------------------------------------------- app state

    def get_app_state(self) -> dict[str, Any]:
        with self._db_lock:
            state = storage_repo.get_app_state(self._conn)
            pending_reviews_row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM review_queue WHERE status = 'pending'"
            ).fetchone()
            total_events_row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM scale_events"
            ).fetchone()
        state_d = _to_dict(state)
        state_d["door_open"] = bool(state_d.get("door_open"))
        state_d["pending_reviews"] = int(
            pending_reviews_row["c"] if pending_reviews_row is not None else 0
        )
        state_d["total_events"] = int(
            total_events_row["c"] if total_events_row is not None else 0
        )
        # Volatile scale runtime (stable flag, latest heartbeat values).
        # Merge without clobbering authoritative DB fields.
        rt = get_scale_runtime_state()
        if rt:
            state_d["scale_stable"] = rt.get("stable")
            state_d["scale_device_id"] = rt.get("device_id")
            state_d["scale_last_heartbeat_ts"] = rt.get("ts")
            # Prefer the fresher heartbeat weight for visual display.
            if rt.get("weight_g") is not None:
                state_d["last_scale_weight_g"] = rt["weight_g"]
        else:
            state_d["scale_stable"] = None
        # Cloud clock drift (populated by CloudClient on every response).
        # Lazy import so web_repo stays importable in environments without
        # the cloud stack (e.g. bare-bones pytest fixtures).
        try:
            from ..cloud.client import get_last_drift_s
            state_d["cloud_drift_s"] = get_last_drift_s()
        except Exception:  # noqa: BLE001 — defensive
            state_d["cloud_drift_s"] = None
        return state_d

    # ----------------------------------------------------------- registry

    def get_shelf_registry(
        self,
        shelf_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """On-shelf lots joined to their product row.

        When ``shelf_id`` is given (``'live_shelf'`` or ``'catch_all'``),
        restricts the result to lots with that ``shelf_id``. When ``None``,
        returns every shelf's on_shelf lots — preserves pre-catch-all
        callers that don't care about the discriminator.

        The underlying ``storage_repo.get_shelf_registry`` returns every
        on-shelf lot regardless of shelf. We filter post-fetch rather than
        pushing the predicate into the SQL helper: keeps the low-level
        query stable for the many callers that don't need the split, and
        the on-shelf set is small (tens of rows) so a Python-side filter
        is cheap.
        """
        with self._db_lock:
            rows = storage_repo.get_shelf_registry(self._conn)
            # Peek at shelf_id on the lots row (not carried by the Lot
            # dataclass yet) inside the same lock acquisition, so a
            # filtered call is still a single critical section.
            shelf_by_lot: dict[str, Optional[str]] = {}
            if shelf_id is not None:
                for item in rows:
                    r = self._conn.execute(
                        "SELECT shelf_id FROM lots WHERE lot_id = ?",
                        (item.lot.lot_id,),
                    ).fetchone()
                    shelf_by_lot[item.lot.lot_id] = (
                        r["shelf_id"] if r is not None else None
                    )
        out: list[dict[str, Any]] = []
        for item in rows:
            lot_d = _to_dict(item.lot)
            if shelf_id is not None:
                # Source of truth: the per-row shelf_id peeked under the
                # same lock acquisition above. Previously this line also
                # consulted ``lot_d.get("shelf_id")`` as an OR-fallback,
                # but that arm is a footgun — if/when the Lot dataclass
                # carries shelf_id the SQL peek would shadow the fresher
                # dataclass value via truthy-short-circuit. Keep the SQL
                # peek as the one authoritative source; it's already what
                # the shelf_by_lot dict holds.
                row_shelf = shelf_by_lot.get(item.lot.lot_id)
                if row_shelf != shelf_id:
                    continue
            out.append({"lot": lot_d, "product": _to_dict(item.product)})
        return out

    def get_products_certified_not_on_shelf(self) -> list[dict[str, Any]]:
        with self._db_lock:
            rows = storage_repo.get_products_certified_not_on_shelf(self._conn)
        return [_to_dict(p) for p in rows]

    def list_usage(
        self,
        *,
        product_id: Optional[str] = None,
        kinds: Optional[list[str]] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Paginated usage_log rows (USAGE_LOG_PLAN.md §5.3)."""
        with self._db_lock:
            rows = storage_repo.list_usage_log(
                self._conn,
                product_id=product_id,
                kinds=kinds,
                since=since,
                until=until,
                limit=limit,
                offset=offset,
            )
        return [_to_dict(r) for r in rows]

    def count_usage(
        self,
        *,
        product_id: Optional[str] = None,
        kinds: Optional[list[str]] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> int:
        with self._db_lock:
            return storage_repo.count_usage_log(
                self._conn,
                product_id=product_id,
                kinds=kinds,
                since=since,
                until=until,
            )

    def usage_summary_by_product(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        with self._db_lock:
            return storage_repo.sum_usage_log_by_product(
                self._conn, since=since, until=until,
            )

    def get_in_flight_lots(
        self,
        shelf_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """In-flight lots with their product — ordered oldest pickup first.

        See IN_FLIGHT_TRACKER_PLAN.md §10.1. When ``shelf_id`` is provided
        (``'live_shelf'`` or ``'catch_all'``) the result is restricted to
        lots with that discriminator; ``None`` preserves the pre-catch-all
        behavior and returns every shelf's in-flight lots. The Lot
        dataclass doesn't carry shelf_id yet, so we peek at the raw row
        inside the same lock acquisition.
        """
        with self._db_lock:
            lots = storage_repo.list_in_flight_lots(self._conn)
            shelf_by_lot: dict[str, Optional[str]] = {}
            if shelf_id is not None:
                for lot in lots:
                    r = self._conn.execute(
                        "SELECT shelf_id FROM lots WHERE lot_id = ?",
                        (lot.lot_id,),
                    ).fetchone()
                    shelf_by_lot[lot.lot_id] = (
                        r["shelf_id"] if r is not None else None
                    )
            out: list[dict[str, Any]] = []
            for lot in lots:
                if shelf_id is not None and shelf_by_lot.get(lot.lot_id) != shelf_id:
                    continue
                product = storage_repo.get_product(self._conn, lot.product_id)
                if product is None:
                    continue
                out.append(
                    {"lot": _to_dict(lot), "product": _to_dict(product)}
                )
            return out

    def get_catch_all_state(self) -> dict[str, Any]:
        """Shelf-scoped state shape for the catch-all preview tile.

        Mirrors :meth:`get_app_state` but reads catch-all fields:
        ``current_catch_all_session_id`` on ``app_state``, last
        scale_events row where ``device_id`` matches the catch-all's
        configured device, and the stable flag from the scale runtime
        cache. ``door_open`` is not meaningful for a weight-gated
        shelf; ``session_open`` (derived from the session id) stands
        in for it on the client.
        """
        device_id = self._catch_all_device_id

        with self._db_lock:
            app_state_row = self._conn.execute(
                "SELECT current_catch_all_session_id FROM app_state "
                "WHERE id = 1"
            ).fetchone()
            last_ev = self._conn.execute(
                "SELECT ts, after_weight_g FROM scale_events "
                "WHERE device_id = ? ORDER BY ts DESC LIMIT 1",
                (device_id,),
            ).fetchone()
            on_shelf_row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM lots "
                "WHERE shelf_id = 'catch_all' AND status = 'on_shelf'"
            ).fetchone()
            in_flight_row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM lots "
                "WHERE shelf_id = 'catch_all' AND status = 'in_flight'"
            ).fetchone()

        current_session_id = (
            app_state_row["current_catch_all_session_id"]
            if app_state_row is not None else None
        )
        last_weight: Optional[float] = None
        last_ts: Optional[str] = None
        if last_ev is not None:
            last_weight = last_ev["after_weight_g"]
            last_ts = last_ev["ts"]

        # Prefer the heartbeat's weight when fresher (same logic as
        # get_app_state does for live shelf).
        stable: Optional[bool] = None
        rt = get_scale_runtime_state(device_id)
        if rt:
            stable = rt.get("stable")
            if rt.get("weight_g") is not None:
                last_weight = rt["weight_g"]

        return {
            "shelf_id": "catch_all",
            "current_session_id": current_session_id,
            "last_scale_weight_g": last_weight,
            "last_scale_event_ts": last_ts,
            "scale_stable": stable,
            "scale_device_id": device_id,
            "on_shelf_count": int(on_shelf_row["c"] if on_shelf_row is not None else 0),
            "in_flight_count": int(in_flight_row["c"] if in_flight_row is not None else 0),
        }

    # ----------------------------------------------------------- events

    def count_events(self) -> int:
        with self._db_lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM scale_events"
            ).fetchone()
        return int(row["c"] if row is not None else 0)

    def _enrich_event(self, event_row: dict[str, Any]) -> dict[str, Any]:
        """Parse JSON fields + resolve ``matched_product`` for the detail
        view. Caller MUST hold ``self._db_lock``."""
        classification = _json_or_none(event_row.get("classification"))
        enriched = dict(event_row)
        enriched["classification"] = classification

        matched_product: Optional[dict[str, Any]] = None
        if isinstance(classification, dict):
            item_id = classification.get("item_id")
            if isinstance(item_id, str) and item_id and item_id != "UNKNOWN":
                # item_id may be a lot_id OR a product_id (depending on
                # which pool produced it). Try lot→product first.
                lot = storage_repo.get_lot(self._conn, item_id)
                product = None
                if lot is not None:
                    product = storage_repo.get_product(self._conn, lot.product_id)
                else:
                    product = storage_repo.get_product(self._conn, item_id)
                if product is not None:
                    matched_product = _to_dict(product)
        enriched["matched_product"] = matched_product
        return enriched

    def list_events(
        self,
        *,
        limit: int,
        offset: int,
        with_frames: bool = False,
    ) -> list[dict[str, Any]]:
        """Page of events newest-first.

        When ``with_frames=True``, restricts the result set to events
        whose ``before_frame_path`` is set. Used by the dashboard
        thumbnail grid so the tiles don't show broken images for
        failed events (no session matched) or events still pending
        classification.
        """
        where = "WHERE before_frame_path IS NOT NULL " if with_frames else ""
        with self._db_lock:
            rows = self._conn.execute(
                f"""
                SELECT * FROM scale_events
                {where}
                ORDER BY ts DESC
                LIMIT ? OFFSET ?
                """,
                (int(limit), int(offset)),
            ).fetchall()
            return [self._enrich_event(dict(r)) for r in rows]

    def get_event(self, event_id: str) -> Optional[dict[str, Any]]:
        with self._db_lock:
            row = self._conn.execute(
                "SELECT * FROM scale_events WHERE event_id = ?", (event_id,)
            ).fetchone()
            if row is None:
                return None
            return self._enrich_event(dict(row))

    # ----------------------------------------------------------- sessions

    def list_sessions(self, *, limit: int = 50) -> list[dict[str, Any]]:
        # ``duration_seconds`` computed from ended_at - started_at via
        # SQLite's julianday so the template doesn't have to parse
        # timestamps. NULL when the session is still open.
        with self._db_lock:
            rows = self._conn.execute(
                """
                SELECT s.*,
                       (SELECT COUNT(*) FROM scale_events e WHERE e.session_id = s.session_id) AS event_count,
                       (SELECT COUNT(*) FROM session_resolutions r WHERE r.session_id = s.session_id) AS resolution_count,
                       CASE WHEN s.ended_at IS NOT NULL
                            THEN CAST(
                                (julianday(s.ended_at) - julianday(s.started_at)) * 86400.0
                                AS INTEGER
                            )
                            ELSE NULL END AS duration_seconds
                  FROM sessions s
                 ORDER BY s.started_at DESC
                 LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        with self._db_lock:
            row = self._conn.execute(
                """
                SELECT s.*,
                       (SELECT COUNT(*) FROM scale_events e WHERE e.session_id = s.session_id) AS event_count,
                       (SELECT COUNT(*) FROM session_resolutions r WHERE r.session_id = s.session_id) AS resolution_count,
                       CASE WHEN s.ended_at IS NOT NULL
                            THEN CAST(
                                (julianday(s.ended_at) - julianday(s.started_at)) * 86400.0
                                AS INTEGER
                            )
                            ELSE NULL END AS duration_seconds
                  FROM sessions s
                 WHERE s.session_id = ?
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_session_events(self, session_id: str) -> list[dict[str, Any]]:
        with self._db_lock:
            rows = self._conn.execute(
                "SELECT * FROM scale_events WHERE session_id = ? ORDER BY ts ASC",
                (session_id,),
            ).fetchall()
            return [self._enrich_event(dict(r)) for r in rows]

    def list_session_resolutions(self, session_id: str) -> list[dict[str, Any]]:
        with self._db_lock:
            rows = self._conn.execute(
                """
                SELECT r.*, p.name AS product_name
                  FROM session_resolutions r
             LEFT JOIN lots l ON l.lot_id = r.lot_id
             LEFT JOIN products p ON p.product_id = l.product_id
                 WHERE r.session_id = ?
                 ORDER BY r.created_at ASC
                """,
                (session_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------------------------- reviews

    def count_pending_reviews(self) -> int:
        with self._db_lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS c FROM review_queue WHERE status = 'pending'"
            ).fetchone()
        return int(row["c"] if row is not None else 0)

    def list_review_items(
        self,
        *,
        status: Optional[str] = "pending",
    ) -> list[dict[str, Any]]:
        with self._db_lock:
            if status is None:
                rows = self._conn.execute(
                    "SELECT * FROM review_queue ORDER BY created_at DESC"
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM review_queue WHERE status = ? ORDER BY created_at DESC",
                    (status,),
                ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            row = dict(r)
            row["proposed"] = _json_or_none(row.get("proposed"))
            row["images"] = _json_or_none(row.get("images")) or []
            row["user_response"] = _json_or_none(row.get("user_response"))
            out.append(row)
        return out

    def get_review_item(self, review_id: str) -> Optional[dict[str, Any]]:
        with self._db_lock:
            row = self._conn.execute(
                "SELECT * FROM review_queue WHERE review_id = ?", (review_id,)
            ).fetchone()
        if row is None:
            return None
        review = dict(row)
        review["proposed"] = _json_or_none(review.get("proposed"))
        review["images"] = _json_or_none(review.get("images")) or []
        review["user_response"] = _json_or_none(review.get("user_response"))

        # Related event (if any)
        event: Optional[dict[str, Any]] = None
        ev_id = review.get("event_id")
        if ev_id:
            event = self.get_event(ev_id)

        # Related session (if any)
        session: Optional[dict[str, Any]] = None
        sess_id = review.get("session_id")
        if sess_id:
            session = self.get_session(sess_id)

        # Candidate pool: try to hydrate from event.classification.candidate_pool_used
        # (stored by the scale handler). Fall back to an empty list.
        candidates: list[dict[str, Any]] = []
        if isinstance(event, dict):
            classification = event.get("classification")
            if isinstance(classification, dict):
                pool = classification.get("candidate_pool_used") or []
                if isinstance(pool, list):
                    for c in pool:
                        if not isinstance(c, dict):
                            continue
                        candidates.append(
                            {
                                "candidate_id": c.get("candidate_id"),
                                "name": c.get("name"),
                                "brand": c.get("brand"),
                                "expected_weight_g": c.get("expected_weight_g"),
                                "reference_image_paths": c.get(
                                    "reference_image_paths", []
                                )
                                or [],
                                "why_candidate": c.get("why_candidate"),
                                "confidence": None,
                            }
                        )

        return {
            "review": review,
            "event": event,
            "session": session,
            "candidates": candidates,
        }

    # --------------------------------------------------- review resolution

    def resolve_review_item(
        self,
        review_id: str,
        *,
        resolution: dict[str, Any],
    ) -> dict[str, Any]:
        """Apply the user's answer + mark review resolved/dismissed (§5.6).

        ``resolution`` is the parsed form body per the API contract. We
        always flip status to 'resolved' unless the caller set ``dismiss``
        truthy (in which case 'dismissed').

        For ``low_confidence`` reviews where the user picked a candidate
        (non-empty ``candidate_id``, not ``dismiss``), we additionally
        invoke the wired ``apply_reviewed_candidate_fn`` to create or
        update the lot so the item actually lands in inventory. Without
        this step, resolving a low-confidence review was a no-op — the
        review status flipped to 'resolved' but nothing reached the lots
        table, so the user's confirmation was lost.
        """
        with self._db_lock:
            review = storage_repo.get_review(self._conn, review_id)
            if review is None:
                raise LookupError(f"review not found: {review_id!r}")

            new_status = "dismissed" if resolution.get("dismiss") else "resolved"
            updated = storage_repo.resolve_review(
                self._conn,
                review_id,
                status=new_status,
                user_response=json.dumps(resolution, default=str),
            )
        # Apply the user-picked candidate OUTSIDE the lock (the callable
        # manages its own locking + runs the full validation/mint path).
        # Skip for dismiss or when no candidate was picked.
        apply_result: Optional[dict[str, Any]] = None
        if (
            new_status == "resolved"
            and self._apply_reviewed_candidate_fn is not None
            and review.kind == "low_confidence"
            and review.event_id
            and resolution.get("candidate_id")
            and resolution.get("candidate_id") != "UNKNOWN"
        ):
            try:
                apply_result = self._apply_reviewed_candidate_fn(
                    event_id=review.event_id,
                    candidate_id=str(resolution["candidate_id"]),
                )
            except Exception:
                log.exception(
                    "resolve_review_item: apply_reviewed_candidate_fn threw "
                    "for review_id=%s event_id=%s",
                    review_id, review.event_id,
                )
        out = _to_dict(updated)
        if apply_result is not None:
            out["apply"] = apply_result
        # Lifecycle trail — correlate by event_id if we have one.
        if review.event_id:
            lifecycle.log_event(
                self._conn, self._db_lock, review.event_id,
                actor="user",
                reason_code=ReasonCode.REVIEW_RESOLVED,
                payload={
                    "review_id": review_id,
                    "review_kind": review.kind,
                    "new_status": new_status,
                    "user_response": resolution,
                    "apply_result": apply_result,
                },
            )
        if review.session_id:
            lifecycle.log_session(
                self._conn, self._db_lock, review.session_id,
                actor="user",
                reason_code=ReasonCode.REVIEW_RESOLVED,
                payload={
                    "review_id": review_id,
                    "new_status": new_status,
                },
            )
        return out


    # ------------------------------------------------------- tare arm
    # Catch-all tare-capture plumbing (CATCH_ALL_TARE_CAPTURE_PLAN.md
    # §4.4 + §4.5). These wrap the storage-level helpers under the
    # shared db_lock so the HTTP handler path matches every other DB
    # access in the adapter.

    def get_product(self, product_id: str) -> Optional[dict[str, Any]]:
        with self._db_lock:
            product = storage_repo.get_product(self._conn, product_id)
        return _to_dict(product) if product is not None else None

    def arm_tare(
        self,
        product_id: str,
        *,
        device_id: Optional[str] = None,
        ttl_s: int = 60,
    ) -> dict[str, Any]:
        """Arm the catch-all tare interceptor for ``product_id``.

        Re-arming on a different product overwrites any existing arm
        (id=1 singleton) — matches the owner's "always one target at a
        time" mental model. ``device_id`` defaults to whatever the
        adapter was constructed with so the catch-all override wired
        via AppConfig is honored.
        """
        dev = device_id if device_id is not None else self._catch_all_device_id
        with self._db_lock:
            arm = storage_repo.arm_tare(
                self._conn,
                product_id,
                device_id=dev,
                ttl_s=ttl_s,
            )
        return _to_dict(arm)

    def cancel_tare_arm(self) -> int:
        with self._db_lock:
            return storage_repo.cancel_tare_arm(self._conn)

    def get_tare_arm_status(self) -> dict[str, Any]:
        """Return the UI-facing status payload for ``GET /api/tare/status``.

        Shape mirrors the plan §4.4: ``armed`` bool, the armed product's
        id + name if any, ``expires_at`` ISO string, computed
        ``seconds_remaining`` (float, clamped at 0), and ``last_error``
        carried through from the arm row.
        """
        with self._db_lock:
            arm = storage_repo.get_active_tare_arm(
                self._conn, device_id=self._catch_all_device_id,
            )
            if arm is None:
                return {
                    "armed": False,
                    "product_id": None,
                    "product_name": None,
                    "device_id": self._catch_all_device_id,
                    "expires_at": None,
                    "seconds_remaining": None,
                    "last_error": None,
                }
            product = storage_repo.get_product(self._conn, arm.product_id)
            # Compute seconds_remaining under the lock too so the value
            # reflects the same wall-clock SQLite used when the arm was
            # selected. Don't raise on parse failure — UI tolerates null.
            remaining_row = self._conn.execute(
                """
                SELECT CAST(
                    (julianday(?) - julianday('now')) * 86400.0
                    AS REAL
                ) AS remaining
                """,
                (arm.expires_at,),
            ).fetchone()
        seconds_remaining: Optional[float] = None
        if remaining_row is not None:
            try:
                seconds_remaining = max(0.0, float(remaining_row["remaining"]))
            except (TypeError, ValueError):  # pragma: no cover - defensive
                seconds_remaining = None
        return {
            "armed": True,
            "product_id": arm.product_id,
            "product_name": (
                product.name if product is not None else None
            ),
            "device_id": arm.device_id,
            "expires_at": arm.expires_at,
            "seconds_remaining": seconds_remaining,
            "last_error": arm.last_error,
        }

    def get_active_tare_arm(self) -> Optional[dict[str, Any]]:
        """Dict-form active arm (or None). Used by ``inventory()`` to
        render the sticky banner + highlight the armed button without a
        second round-trip to /api/tare/status."""
        with self._db_lock:
            arm = storage_repo.get_active_tare_arm(
                self._conn, device_id=self._catch_all_device_id,
            )
        return _to_dict(arm) if arm is not None else None

    # ------------------------------------------------------ single-track
    # Single-track scales (cloud term: ``live_scale``; Pi-local term:
    # ``single_item``) are direct-consumption scales paired to one
    # product — see ``scale_events.py:3525``. They do NOT write to
    # ``scale_events`` for non-noise events (those short-circuit
    # straight to the cloud emitter), so the UI's "current weight"
    # comes from a layered source: latest scale_events row first
    # (covers noise events + any legacy data), then the volatile
    # heartbeat runtime state (always fresher when the device is
    # online). This matches the live-shelf + catch-all pattern in
    # :meth:`get_app_state` / :meth:`get_catch_all_state`.

    def get_single_track_scales(self) -> list[dict[str, Any]]:
        """Return per-pairing rows for the inventory + dashboard surfaces.

        One element per ``scale_pairings`` row whose ``shelf_id =
        'single_item'``. Each dict carries::

            {
              "device_id": str,
              "shelf_id": "single_item",
              "product_id": Optional[str],     # NULL = unpaired
              "product_name": Optional[str],
              "product_brand": Optional[str],
              "lot_id": Optional[str],         # FEFO target if paired
              "first_seen_at": str,
              "last_heartbeat_ts": Optional[str],
              "last_event_ts": Optional[str],   # latest scale_events row
              "last_event_kind": Optional[str], # direction ('add' | 'remove' | 'noise')
              "last_event_delta_g": Optional[float],
              "current_weight_g": Optional[float],  # heartbeat-fresh if online,
                                                    # else last scale_events.after
              "scale_stable": Optional[bool],
              "is_online": bool,                # heartbeat <60s
            }

        Ordering: by paired ``product_name`` ascending (unpaired rows
        sort last). Stable across calls. The caller is responsible for
        any further filtering / grouping.
        """
        with self._db_lock:
            pairings = self._conn.execute(
                """
                SELECT sp.device_id,
                       sp.shelf_id,
                       sp.product_id,
                       sp.lot_id,
                       sp.first_seen_at,
                       sp.last_heartbeat_ts,
                       p.name        AS product_name,
                       p.brand       AS product_brand
                  FROM scale_pairings sp
             LEFT JOIN products p ON p.product_id = sp.product_id
                 WHERE sp.shelf_id = 'single_item'
                """,
            ).fetchall()
            # Latest scale_events row per device_id. Single-item
            # non-noise events short-circuit before writing scale_events
            # (handlers/scale_events.py:3525), so this captures only
            # noise rows + any legacy data — that's the contract.
            last_events: dict[str, dict[str, Any]] = {}
            for row in pairings:
                ev = self._conn.execute(
                    """
                    SELECT ts, after_weight_g, delta_g, direction
                      FROM scale_events
                     WHERE device_id = ?
                     ORDER BY ts DESC
                     LIMIT 1
                    """,
                    (row["device_id"],),
                ).fetchone()
                if ev is not None:
                    last_events[row["device_id"]] = dict(ev)

        out: list[dict[str, Any]] = []
        for row in pairings:
            device_id = row["device_id"]
            ev = last_events.get(device_id)
            last_event_ts = ev["ts"] if ev is not None else None
            last_event_kind = ev["direction"] if ev is not None else None
            last_event_delta = ev["delta_g"] if ev is not None else None
            current_weight: Optional[float] = (
                ev["after_weight_g"] if ev is not None else None
            )
            heartbeat_ts = row["last_heartbeat_ts"]
            stable: Optional[bool] = None
            # Volatile runtime cache (heartbeats — see
            # handlers/scale_events.py:5751). When fresh, supersedes the
            # scale_events-derived weight + provides the ``stable`` flag.
            rt = get_scale_runtime_state(device_id)
            if rt:
                if rt.get("weight_g") is not None:
                    current_weight = rt["weight_g"]
                if rt.get("ts"):
                    heartbeat_ts = rt["ts"]
                stable = rt.get("stable")
            is_online = _is_heartbeat_recent(heartbeat_ts, max_age_s=60.0)
            out.append(
                {
                    "device_id": device_id,
                    "shelf_id": "single_item",
                    "product_id": row["product_id"],
                    "product_name": row["product_name"],
                    "product_brand": row["product_brand"],
                    "lot_id": row["lot_id"],
                    "first_seen_at": row["first_seen_at"],
                    "last_heartbeat_ts": heartbeat_ts,
                    "last_event_ts": last_event_ts,
                    "last_event_kind": last_event_kind,
                    "last_event_delta_g": last_event_delta,
                    "current_weight_g": current_weight,
                    "scale_stable": stable,
                    "is_online": is_online,
                }
            )
        # Order: paired-by-name ascending, unpaired last (NULLs sort
        # last). Stable so the inventory + dashboard tile show rows
        # in the same order on every render.
        out.sort(
            key=lambda r: (
                r["product_name"] is None,
                (r["product_name"] or "").lower(),
                r["device_id"],
            )
        )
        return out

    def get_single_track_state(self) -> dict[str, Any]:
        """Aggregate state for the dashboard tile (``GET /api/state?shelf=single_item``).

        Returns::

            {
              "shelf_id": "single_item",
              "scales_total": int,           # number of paired rows
              "scales_online": int,          # heartbeat <60s
              "scales": [                    # truncated dashboard list
                {
                  "device_id", "product_id", "product_name",
                  "current_weight_g", "last_heartbeat_ts",
                  "is_online", "scale_stable",
                },
                ...
              ],
            }

        Mirrors :meth:`get_catch_all_state` so the dashboard polling
        layer can reuse the same shape conventions.
        """
        scales = self.get_single_track_scales()
        compact = [
            {
                "device_id": s["device_id"],
                "product_id": s["product_id"],
                "product_name": s["product_name"],
                "current_weight_g": s["current_weight_g"],
                "last_heartbeat_ts": s["last_heartbeat_ts"],
                "is_online": s["is_online"],
                "scale_stable": s["scale_stable"],
            }
            for s in scales
        ]
        return {
            "shelf_id": "single_item",
            "scales_total": len(scales),
            "scales_online": sum(1 for s in scales if s["is_online"]),
            "scales": compact,
        }


def _is_heartbeat_recent(ts: Optional[str], *, max_age_s: float) -> bool:
    """True iff ``ts`` (ISO-8601 UTC, ``...Z`` accepted) is within ``max_age_s``
    of now. ``None`` / unparseable values return False so a never-heartbeated
    pairing never gets flagged "online"."""
    if not isinstance(ts, str) or not ts:
        return False
    import datetime as _dt
    try:
        parsed = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    age = _dt.datetime.now(_dt.timezone.utc) - parsed
    return age.total_seconds() <= max_age_s


__all__ = ["RepoWebAdapter"]
