"""HTML routes + image serving for Live Shelf web UI (Bundle G).

Exports:

    * :class:`WebRepo` — read-side protocol that the UI depends on.
    * :func:`make_html_bp` — factory returning a Flask blueprint wired to a
      concrete repo instance.

Design notes:

* The blueprint is built via a factory so we can pass the repo + data root
  in at app init without leaning on Flask's globals. This also keeps the
  module trivially testable: the test suite constructs a tiny fake repo
  and confirms every route renders.
* No globals, no module-level state. All state flows through the repo.
* All entity IDs are treated as opaque strings. For image-serving routes,
  the blueprint validates the event exists before calling
  ``send_from_directory`` (which itself guards against path traversal).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional, Protocol, runtime_checkable

from flask import Blueprint, abort, redirect, render_template, request, send_from_directory

# ---------------------------------------------------------------------------
# Read-side repository protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class WebRepo(Protocol):
    """Everything the web UI needs to read from storage.

    The host app supplies a concrete implementation (Bundle A's repo + any
    small joining helpers). The protocol intentionally returns plain dicts
    for join-heavy views — Jinja templates are happier with dicts than
    dataclasses, and the join shape differs from what the single-entity
    storage models look like.

    All timestamps are ISO-8601 UTC strings. All money-like weights are grams
    as ``float``. IDs are opaque strings (UUID v7 in practice).
    """

    # --- App state ------------------------------------------------------

    def get_app_state(self) -> dict[str, Any]:
        """Current singleton app state.

        Returns a dict with at least::

            {
              "door_open": bool,
              "current_session_id": Optional[str],
              "last_scale_weight_g": Optional[float],
              "last_scale_event_ts": Optional[str],
              "shelf_name": str,
              "pending_reviews": int,   # count of review_queue rows with status='pending'
              "total_events": int,
              "updated_at": Optional[str],
            }
        """
        ...

    # --- Registry -------------------------------------------------------

    def get_shelf_registry(
        self,
        shelf_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Lots currently on the shelf, joined with their product row.

        When ``shelf_id`` is ``'live_shelf'`` or ``'catch_all'``, restrict
        to that shelf's lots. ``None`` returns lots from every shelf —
        preserves legacy callers that predate the catch-all split.

        Each element::

            {
              "lot": {...lots row...},
              "product": {...products row...}
            }
        """
        ...

    def get_products_certified_not_on_shelf(self) -> list[dict[str, Any]]:
        """Certified products that have no on_shelf lot (catalog view)."""
        ...

    # --- Events ---------------------------------------------------------

    def count_events(self) -> int:
        ...

    def list_events(
        self,
        *,
        limit: int,
        offset: int,
        with_frames: bool = False,
    ) -> list[dict[str, Any]]:
        """Page of scale events, newest first. Each element flattens
        the event row + (optional) joined product name for the
        classifier-identified item id.

        ``with_frames=True`` restricts the result to events whose
        ``before_frame_path`` is non-NULL so thumbnail grids never
        render empty tiles for events that never got frames attached.
        """
        ...

    def get_event(self, event_id: str) -> Optional[dict[str, Any]]:
        """Single event row or None. Includes::

            {
              "event_id", "session_id", "ts", "delta_g",
              "before_weight_g", "after_weight_g", "direction",
              "before_frame_path", "after_frame_path",
              "classification": Optional[dict],  # parsed JSON
              "classifier_status", "created_at",
              "matched_product": Optional[dict],  # joined on classification.item_id
            }
        """
        ...

    # --- Sessions -------------------------------------------------------

    def list_sessions(self, *, limit: int = 50) -> list[dict[str, Any]]:
        """Sessions newest first, each with a ``resolution_count`` + ``event_count``."""
        ...

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        """Single session; separate listing of its events and resolutions
        exposed via the two methods below (this just returns the session row
        itself plus totals)."""
        ...

    def list_session_events(self, session_id: str) -> list[dict[str, Any]]:
        ...

    def list_session_resolutions(self, session_id: str) -> list[dict[str, Any]]:
        ...

    # --- Review queue ---------------------------------------------------

    def count_pending_reviews(self) -> int:
        ...

    def list_review_items(
        self,
        *,
        status: Optional[str] = "pending",
    ) -> list[dict[str, Any]]:
        ...

    def get_review_item(self, review_id: str) -> Optional[dict[str, Any]]:
        """Single review item plus its candidate pool.

        Shape::

            {
              "review": {...row...},      # proposed + images decoded to dict/list
              "event": Optional[dict],    # the triggering scale event
              "session": Optional[dict],
              "candidates": [             # derived from proposed.candidates OR from
                                          # the classifier's candidate pool
                {
                  "candidate_id": str,
                  "name": str,
                  "brand": Optional[str],
                  "expected_weight_g": Optional[float],
                  "reference_image_paths": list[str],
                  "why_candidate": Optional[str],
                  "confidence": Optional[float],   # from classifier output
                },
                ...
              ],
            }
        """
        ...

    def resolve_review_item(
        self,
        review_id: str,
        *,
        resolution: dict[str, Any],
    ) -> dict[str, Any]:
        """Apply the user's answer + flip review_queue.status='resolved'.

        ``resolution`` is the parsed form body; the concrete repo decides
        what to do with each `kind` per §5.6. Returns the updated review
        item row.
        """
        ...


# ---------------------------------------------------------------------------
# Blueprint factory
# ---------------------------------------------------------------------------


EVENTS_PER_PAGE = 24
USAGE_PER_PAGE_DEFAULT = 25
USAGE_PER_PAGE_OPTIONS = (5, 25, 50, 100)
# Back-compat alias — older callers and tests reference this directly.
# Kept until those imports are migrated.
USAGE_PER_PAGE = USAGE_PER_PAGE_DEFAULT


def make_html_bp(
    repo: WebRepo,
    *,
    data_dir: Path,
    templates_dir: Optional[Path] = None,
    catch_all_enabled: Optional[Callable[[], bool]] = None,
    live_scale_enabled: Optional[Callable[[], bool]] = None,
    classifier_pool_provider: Optional[Callable[[], list]] = None,
) -> Blueprint:
    """Build an HTML blueprint bound to ``repo``.

    Args:
        repo: concrete WebRepo implementation.
        data_dir: root of the data directory. Event artifacts live under
            ``<data_dir>/events/<event_id>/{before,after}.jpg``; reference
            images under ``<data_dir>/refs/<product_id>/<filename>``.
        templates_dir: override template search path (defaults to the
            sibling ``templates/`` folder in this package).
        catch_all_enabled: zero-arg callable returning the current
            ``CATCH_ALL_ENABLED`` flag. Injected so the inventory +
            dashboard templates can hide catch-all sections when the
            hardware isn't attached. Defaults to a constant ``False``
            callable — single-shelf deployments keep the page clean.
        live_scale_enabled: zero-arg callable returning the current
            single-track flag. When ``None``, the route auto-derives
            the flag from the presence of any ``scale_pairings`` row
            with ``shelf_id='single_item'`` — so the section + tile
            appear the moment a single-track ESP heartbeats and the
            auto-register handler mints a pairing row. Pass an
            explicit callable to override (e.g. force-on for
            screenshots, force-off to hide while debugging).
        classifier_pool_provider: zero-arg callable returning the current
            ``pool_for_add`` output for the live_shelf — a list of
            :class:`server.classifier.models.Candidate`. Used to render
            the "Classifier candidates" debug section on /inventory so
            the operator can see at a glance what the classifier would
            consider for the next ADD event without having to query
            SQLite or read ``session_resolutions``. ``None`` skips the
            section entirely (e.g. tests that don't care). The provider
            MUST be re-callable; the route invokes it on every page
            render to capture live state. Failures are swallowed and
            logged — the inventory page must never crash on this.
    """
    data_dir = Path(data_dir)
    events_root = data_dir / "events"
    refs_root = data_dir / "refs"
    sessions_root = data_dir / "sessions"

    tpl_dir = templates_dir or (Path(__file__).resolve().parent / "templates")
    bp = Blueprint(
        "web_html",
        __name__,
        template_folder=str(tpl_dir),
    )

    # Resolve the catch-all flag each request so a live `POST /api/config`
    # flip takes effect without a restart. Fall back to False (catch-all
    # hidden) when no reader is wired.
    def _catch_all_on() -> bool:
        if catch_all_enabled is None:
            return False
        try:
            return bool(catch_all_enabled())
        except Exception:  # pragma: no cover — UI must never crash on this
            return False

    # Resolve the single-track flag each request. Default ON — the
    # operator wants the section visible even before any ESP has paired
    # so they can see the empty state and confirm setup is wired
    # correctly. Hosts can still pass an explicit callable (e.g.
    # single-shelf deployments that want to hide the surface entirely).
    def _live_scale_on() -> bool:
        if live_scale_enabled is not None:
            try:
                return bool(live_scale_enabled())
            except Exception:  # pragma: no cover — UI must never crash on this
                return True
        return True

    # ----- shared helper ---------------------------------------------------

    def _nav_ctx() -> dict[str, Any]:
        try:
            pending = repo.count_pending_reviews()
        except Exception:  # pragma: no cover — UI must never crash on nav
            pending = 0
        return {"pending_reviews": pending}

    # ----- dashboard -------------------------------------------------------

    @bp.get("/")
    def dashboard():
        state = repo.get_app_state()
        try:
            # Only events that actually have frames — keeps the
            # thumbnail grid consistent (no broken-image tiles for
            # failed / pending events). The full /events page still
            # shows everything.
            recent = repo.list_events(limit=6, offset=0, with_frames=True)
        except Exception:
            recent = []
        try:
            in_flight = repo.get_in_flight_lots()
        except Exception:
            in_flight = []
        ca_on = _catch_all_on()
        # Initial catch-all state snapshot so the template can render
        # the tile with sensible values before the polling JS takes over.
        catch_all_state: Optional[dict[str, Any]] = None
        if ca_on:
            get_ca = getattr(repo, "get_catch_all_state", None)
            if callable(get_ca):
                try:
                    catch_all_state = get_ca()
                except Exception:  # pragma: no cover — defensive
                    catch_all_state = None
        # Single-track tile: only render when at least one paired
        # single_item scale exists (matches the ``catch_all_enabled``
        # gate pattern). Initial snapshot lets the template render
        # populated cells before the polling JS kicks in.
        ls_on = _live_scale_on()
        single_track_state: dict[str, Any] = {}
        if ls_on:
            get_st = getattr(repo, "get_single_track_state", None)
            if callable(get_st):
                try:
                    single_track_state = get_st() or {}
                except Exception:  # pragma: no cover — defensive
                    single_track_state = {}
        return render_template(
            "dashboard.html",
            state=state,
            recent_events=recent,
            in_flight=in_flight,
            catch_all_enabled=ca_on,
            catch_all_state=catch_all_state or {},
            live_scale_enabled=ls_on,
            single_track_state=single_track_state,
            health=_collect_dashboard_health(repo),
            **_nav_ctx(),
        )

    # ----- inventory (combined registry + usage) --------------------------

    @bp.get("/inventory")
    def inventory():
        # Registry side — per-shelf for the rendered sections + an
        # unscoped copy for the top summary / legacy templates that
        # still read ``on_shelf`` / ``in_flight`` as flat lists.
        ca_on = _catch_all_on()
        live_on_shelf = repo.get_shelf_registry(shelf_id="live_shelf")
        try:
            live_in_flight = repo.get_in_flight_lots(shelf_id="live_shelf")
        except Exception:
            live_in_flight = []
        if ca_on:
            catch_all_on_shelf = repo.get_shelf_registry(shelf_id="catch_all")
            try:
                catch_all_in_flight = repo.get_in_flight_lots(shelf_id="catch_all")
            except Exception:
                catch_all_in_flight = []
        else:
            catch_all_on_shelf = []
            catch_all_in_flight = []
        # Aggregate (cross-shelf) views — used by the top summary banner
        # and any template block that predates the split.
        on_shelf = live_on_shelf + catch_all_on_shelf
        in_flight = live_in_flight + catch_all_in_flight
        catalog = repo.get_products_certified_not_on_shelf()

        # Single-track scales (cloud term ``live_scale``; see
        # CLAUDE.md "Live Shelf" notes). Auto-derived flag — the
        # section appears the moment a LiveTrack ESP heartbeats.
        ls_on = _live_scale_on()
        single_track_scales: list[dict[str, Any]] = []
        if ls_on:
            get_st_scales = getattr(repo, "get_single_track_scales", None)
            if callable(get_st_scales):
                try:
                    single_track_scales = list(get_st_scales())
                except Exception:  # pragma: no cover — defensive
                    single_track_scales = []

        # Tare-capture arm — present when the operator clicked Tare on
        # a catalog row and the 60s TTL hasn't elapsed yet. Template
        # uses this to highlight the armed row's button + render a
        # sticky banner. Defensive getattr so test fakes that predate
        # the tare feature still render.
        get_arm = getattr(repo, "get_active_tare_arm", None)
        tare_arm: Optional[dict[str, Any]] = None
        if callable(get_arm):
            try:
                tare_arm = get_arm()
            except Exception:  # pragma: no cover — UI must never crash on this
                tare_arm = None

        # Usage side.
        try:
            page = int(request.args.get("page", 1))
        except (TypeError, ValueError):
            page = 1
        page = max(page, 1)
        # Operator-controlled per_page picker. The user complaint in the
        # 2026-04-28 UX audit was that 5/page across 81 rows = 17 pages of
        # paging hell. Allow a small whitelist of values; reject anything
        # else by snapping to the default. Whitelisted set keeps a hostile
        # caller from passing per_page=10000 to OOM the page render.
        try:
            per_page = int(request.args.get("per_page", USAGE_PER_PAGE_DEFAULT))
        except (TypeError, ValueError):
            per_page = USAGE_PER_PAGE_DEFAULT
        if per_page not in USAGE_PER_PAGE_OPTIONS:
            per_page = USAGE_PER_PAGE_DEFAULT
        product_id = request.args.get("product") or None
        kind_filter = request.args.get("kind") or None
        since = request.args.get("since") or None
        until = request.args.get("until") or None
        kinds = [kind_filter] if kind_filter else None

        list_usage = getattr(repo, "list_usage", None)
        usage_items: list = []
        usage_total = 0
        usage_total_pages = 1
        summary: list = []
        if list_usage is not None:
            usage_total = repo.count_usage(
                product_id=product_id, kinds=kinds, since=since, until=until,
            )
            offset = (page - 1) * per_page
            raw_usage = list_usage(
                product_id=product_id, kinds=kinds, since=since, until=until,
                limit=per_page, offset=offset,
            )
            # Server-side de-dup: a known backend bug emits the same
            # "Pulled <product> N g return" row repeatedly across Pi
            # restarts (UX audit §inventory friction #11). Group by
            # (occurred_at, return_event_id, product_id) and tag the
            # representative with ``dup_count`` so the template can render
            # one row + a "Nx" badge instead of N near-identical rows.
            # Falls back to (occurred_at, product_id) when the row predates
            # the return_event_id column. ``usage_id`` of the
            # representative is preserved so the per-row delete still
            # resolves to a real row; the count tells the user how many
            # collateral rows exist.
            usage_items = _dedupe_usage_rows(raw_usage)
            usage_total_pages = max(
                1, (usage_total + per_page - 1) // per_page
            )
            # 7-day summary (fixed window, not tied to filter bar).
            import datetime as _dt
            since_7d = (
                _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=7)
            ).isoformat(timespec="seconds").replace("+00:00", "Z")
            summary = repo.usage_summary_by_product(since=since_7d)

        # Classifier candidate pool — live snapshot of what the next
        # ADD event would see. Debug affordance for the user: when
        # classification goes sideways (UNKNOWN-only events, mismatched
        # picks, etc.) they can immediately see whether the pool is
        # empty, missing the expected product, or mis-tiered. The
        # template renders this collapsed-by-default so it doesn't
        # dominate the page when not needed.
        #
        # Failure mode: if the provider raises (e.g. the classifier
        # source can't reach SQLite, or no provider is wired in tests),
        # we surface ``None`` to the template so the entire section
        # quietly disappears — the inventory page must never 500 on
        # this. Real production wiring sets the provider in app.py.
        classifier_candidates: Optional[list] = None
        if classifier_pool_provider is not None:
            try:
                classifier_candidates = list(classifier_pool_provider())
            except Exception:  # noqa: BLE001 - debug UI must never crash the page
                classifier_candidates = None

        return render_template(
            "inventory.html",
            on_shelf=on_shelf,
            catalog=catalog,
            in_flight=in_flight,
            live_on_shelf=live_on_shelf,
            live_in_flight=live_in_flight,
            catch_all_on_shelf=catch_all_on_shelf,
            catch_all_in_flight=catch_all_in_flight,
            catch_all_enabled=ca_on,
            live_scale_enabled=ls_on,
            single_track_scales=single_track_scales,
            tare_arm=tare_arm,
            usage_items=usage_items,
            usage_total=usage_total,
            usage_page=page,
            usage_per_page=per_page,
            usage_per_page_options=USAGE_PER_PAGE_OPTIONS,
            usage_total_pages=usage_total_pages,
            summary=summary,
            classifier_candidates=classifier_candidates,
            filters={
                "product": product_id or "",
                "kind": kind_filter or "",
                "since": since or "",
                "until": until or "",
            },
            **_nav_ctx(),
        )

    # Back-compat redirects — /registry and /usage now live under /inventory.
    @bp.get("/registry")
    def registry_redirect():
        return redirect("/inventory", code=301)

    # ----- events list -----------------------------------------------------

    @bp.get("/events")
    def events():
        try:
            page = int(request.args.get("page", 1))
        except (TypeError, ValueError):
            page = 1
        page = max(page, 1)
        total = repo.count_events()
        offset = (page - 1) * EVENTS_PER_PAGE
        items = repo.list_events(limit=EVENTS_PER_PAGE, offset=offset)
        total_pages = max(1, (total + EVENTS_PER_PAGE - 1) // EVENTS_PER_PAGE)
        return render_template(
            "events.html",
            events=items,
            page=page,
            total_pages=total_pages,
            total=total,
            per_page=EVENTS_PER_PAGE,
            **_nav_ctx(),
        )

    # ----- event detail ----------------------------------------------------

    @bp.get("/event/<event_id>")
    def event_detail(event_id: str):
        event = repo.get_event(event_id)
        if event is None:
            abort(404)
        has_before = _event_image_exists(events_root, event_id, "before.jpg")
        has_after = _event_image_exists(events_root, event_id, "after.jpg")
        # Video lookup: prefer the per-event copy (made at classification
        # time when the video already existed), fall back to the canonical
        # session-dir location. The per-event copy can be missing if the
        # async video encode finished AFTER classification ran — in that
        # case the session-dir file is the only survivor.
        has_video = (
            _event_image_exists(events_root, event_id, "session.mp4")
            or _session_video_path(sessions_root, repo, event) is not None
        )
        return render_template(
            "event_detail.html",
            event=event,
            event_id=event_id,
            has_before=has_before,
            has_after=has_after,
            has_video=has_video,
            **_nav_ctx(),
        )

    # ----- event image serving (before/after jpgs) -------------------------

    @bp.get("/event/<event_id>/<path:filename>")
    def event_image(event_id: str, filename: str):
        # 1) event must exist in the DB to prevent scanning unrelated folders
        event = repo.get_event(event_id)
        if event is None:
            abort(404)
        # 2) only allow a small whitelist of filenames so this doesn't become
        #    a general file-server. Plus `send_from_directory` blocks traversal.
        if filename not in {"before.jpg", "after.jpg", "session.mp4"}:
            abort(404)

        # Session video: if the per-event copy is missing (classifier ran
        # before the async video encode completed), fall back to the
        # canonical session-dir copy. This decouples the UI's ability to
        # show the video from a race in the ingest pipeline.
        if filename == "session.mp4":
            per_event = events_root / event_id / "session.mp4"
            if per_event.is_file():
                return send_from_directory(
                    events_root / event_id, filename, mimetype="video/mp4",
                )
            session_video = _session_video_path(sessions_root, repo, event)
            if session_video is not None:
                return send_from_directory(
                    session_video.parent, session_video.name,
                    mimetype="video/mp4",
                )
            abort(404)

        # before.jpg / after.jpg — per-event dir only (session-level
        # before/after don't map cleanly onto chained events).
        subdir = events_root / event_id
        if not subdir.is_dir():
            abort(404)
        return send_from_directory(subdir, filename)

    # ----- reference image serving -----------------------------------------

    @bp.get("/refs/<product_id>/<path:filename>")
    def reference_image(product_id: str, filename: str):
        # Any filename under data/refs/<product_id>/ is OK, but filter so
        # dotfiles / traversal segments fail fast.
        if not product_id or "/" in product_id or ".." in product_id or product_id.startswith("."):
            abort(404)
        if "/" in filename or ".." in filename or filename.startswith("."):
            abort(404)
        subdir = refs_root / product_id
        if not subdir.is_dir():
            abort(404)
        # Restrict to the image extensions actually captured during intake so
        # this route can't be coaxed into serving arbitrary files dropped
        # under data/refs/<product_id>/ (e.g. stray .txt / .py / config).
        if not filename.lower().endswith(('.jpg', '.jpeg', '.png')):
            abort(404)
        return send_from_directory(subdir, filename)

    # ----- sessions list ---------------------------------------------------

    @bp.get("/sessions")
    def sessions():
        items = repo.list_sessions(limit=100)
        return render_template(
            "sessions.html",
            sessions=items,
            **_nav_ctx(),
        )

    @bp.get("/session/<session_id>")
    def session_detail(session_id: str):
        session = repo.get_session(session_id)
        if session is None:
            abort(404)
        events_for_session = repo.list_session_events(session_id)
        resolutions = repo.list_session_resolutions(session_id)
        # Pre-compute timeline entries for the template to keep Jinja simple.
        timeline = [
            {
                "kind": "event",
                "ts": ev.get("ts"),
                "data": ev,
            }
            for ev in events_for_session
        ]
        timeline.sort(key=lambda row: row["ts"] or "")
        return render_template(
            "session_detail.html",
            session=session,
            timeline=timeline,
            resolutions=resolutions,
            **_nav_ctx(),
        )

    # ----- review list + detail -------------------------------------------

    @bp.get("/review")
    def review_list():
        status = request.args.get("status", "pending")
        if status not in {"pending", "resolved", "dismissed", "all"}:
            status = "pending"
        items = repo.list_review_items(status=None if status == "all" else status)
        return render_template(
            "review_list.html",
            reviews=items,
            status=status,
            **_nav_ctx(),
        )

    @bp.get("/review/<review_id>")
    def review_detail(review_id: str):
        item = repo.get_review_item(review_id)
        if item is None:
            abort(404)
        return render_template(
            "review_detail.html",
            review=item.get("review") or {},
            event=item.get("event"),
            session=item.get("session"),
            candidates=item.get("candidates") or [],
            **_nav_ctx(),
        )

    # Back-compat redirect — /usage moved under /inventory (preserve query string).
    @bp.get("/usage")
    def usage_redirect():
        qs = request.query_string.decode("utf-8", errors="replace")
        target = "/inventory" + (f"?{qs}" if qs else "")
        return redirect(target, code=301)

    return bp


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def _dedupe_usage_rows(rows: list[dict]) -> list[dict]:
    """Collapse near-identical usage_log rows for the same logical event.

    Background: a known backend defect (see UX audit 2026-04-28
    §inventory friction #11) re-emits the same return row on every Pi
    restart, producing N rows that share ``(occurred_at,
    return_event_id, product_id)``. The user-visible noise drowns out
    real events; rather than blocking on the backend fix, the UI side
    collapses the visual representation here.

    Logic: walk in input order (callers feed us newest-first), group by
    ``(occurred_at, return_event_id or '__no_return__', product_id)``.
    Annotate the *first* row of each group with::

        row['_dup_count'] = N   # how many duplicates collapsed to this row
        row['_dup_usage_ids'] = [usage_id, ...]  # the suppressed sibling ids

    For groups of size 1 the keys are still set (count=1, ids=[]) so the
    template can rely on their presence without ``is defined``-style
    guards.

    The representative ``usage_id`` is preserved so the per-row delete
    still resolves to a real row — though if the operator deletes that
    one, the duplicates will reappear on next refresh until the backend
    bug is fixed. We surface that explicitly via the ``Nx`` badge.
    """
    if not rows:
        return list(rows)

    out: list[dict] = []
    by_key: dict[tuple, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            out.append(row)
            continue
        key = (
            row.get("occurred_at"),
            row.get("return_event_id") or "__no_return__",
            row.get("product_id"),
        )
        # Rows missing all three discriminators (degenerate) flow through
        # un-grouped — we'd rather show a duplicate than coalesce
        # unrelated rows together.
        if all(part in (None, "__no_return__") for part in key):
            row["_dup_count"] = 1
            row["_dup_usage_ids"] = []
            out.append(row)
            continue
        existing = by_key.get(key)
        if existing is None:
            row["_dup_count"] = 1
            row["_dup_usage_ids"] = []
            by_key[key] = row
            out.append(row)
        else:
            existing["_dup_count"] = int(existing.get("_dup_count", 1)) + 1
            sib_ids = existing.setdefault("_dup_usage_ids", [])
            sib_id = row.get("usage_id")
            if sib_id is not None:
                sib_ids.append(sib_id)
    return out


def _collect_dashboard_health(repo: "WebRepo") -> dict[str, Any]:
    """Best-effort summary of health-relevant counters for the dashboard.

    Surfaces the data the user otherwise only saw in
    ``/api/debug/health``. Each field is independently best-effort —
    a missing repo method or a thrown exception lands as ``None`` for
    that one field rather than failing the dashboard render. The user
    saw no signal at all before this; "some signals or none" is a strict
    improvement.
    """
    out: dict[str, Any] = {
        "failed_events": None,
        "pending_events": None,
        "classifying_events": None,
        "anthropic_errors_total": None,
        "cloud_drift_s": None,
        "outbox_backlog": None,
    }
    state_fn = getattr(repo, "get_app_state", None)
    if callable(state_fn):
        try:
            state = state_fn() or {}
            # cloud_drift_s is plumbed in via the web_repo adapter. The
            # rest are populated below where the data lives.
            if isinstance(state, dict) and "cloud_drift_s" in state:
                out["cloud_drift_s"] = state.get("cloud_drift_s")
        except Exception:  # noqa: BLE001 — defensive, dashboard must render
            pass
    health_fn = getattr(repo, "get_dashboard_health", None)
    if callable(health_fn):
        try:
            extra = health_fn() or {}
            if isinstance(extra, dict):
                for k, v in extra.items():
                    out[k] = v
        except Exception:  # noqa: BLE001 — defensive
            pass
    return out


def _event_image_exists(events_root: Path, event_id: str, filename: str) -> bool:
    # Defensive: event_id is an opaque string but we still guard against
    # pathological values that could cross directory boundaries.
    if "/" in event_id or ".." in event_id or not event_id:
        return False
    candidate = events_root / event_id / filename
    try:
        return candidate.is_file()
    except OSError:
        return False


def _session_video_path(
    sessions_root: Path, repo: WebRepo, event: dict,
) -> Optional[Path]:
    """Resolve the canonical session-video path for an event.

    The session-capture subsystem stores the encoded video at
    ``<sessions_root>/<safe_ts>/session.mp4`` where ``safe_ts`` is the
    session's ``started_at`` with ``:`` replaced by ``-`` (ISO-friendly
    directory name). The ``sessions`` table stores ``started_at`` as the
    original ISO string, so deriving the dir is a pure string op.

    Returns a :class:`Path` if the file exists on disk, else ``None``.
    The caller can use the presence of a return value both for the
    ``has_video`` check and for streaming.
    """
    session_id = event.get("session_id")
    if not session_id:
        return None
    session = repo.get_session(session_id)
    if session is None:
        return None
    started_at = session.get("started_at")
    if not started_at or not isinstance(started_at, str):
        return None
    # Directory name convention mirrors ``camera.session_capture._safe_ts``.
    # Keeping the derivation here (rather than importing) avoids a web->
    # camera module dep for a 1-line transform.
    safe_ts = started_at.replace(":", "-")
    # Defense-in-depth: reject any traversal smuggling even though the
    # string comes from our own DB.
    if "/" in safe_ts or ".." in safe_ts:
        return None
    candidate = sessions_root / safe_ts / "session.mp4"
    try:
        return candidate if candidate.is_file() else None
    except OSError:
        return None
