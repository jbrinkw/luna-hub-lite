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
USAGE_PER_PAGE = 50


def make_html_bp(
    repo: WebRepo,
    *,
    data_dir: Path,
    templates_dir: Optional[Path] = None,
    catch_all_enabled: Optional[Callable[[], bool]] = None,
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
        return render_template(
            "dashboard.html",
            state=state,
            recent_events=recent,
            in_flight=in_flight,
            catch_all_enabled=ca_on,
            catch_all_state=catch_all_state or {},
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
            offset = (page - 1) * USAGE_PER_PAGE
            usage_items = list_usage(
                product_id=product_id, kinds=kinds, since=since, until=until,
                limit=USAGE_PER_PAGE, offset=offset,
            )
            usage_total_pages = max(
                1, (usage_total + USAGE_PER_PAGE - 1) // USAGE_PER_PAGE
            )
            # 7-day summary (fixed window, not tied to filter bar).
            import datetime as _dt
            since_7d = (
                _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=7)
            ).isoformat(timespec="seconds").replace("+00:00", "Z")
            summary = repo.usage_summary_by_product(since=since_7d)

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
            tare_arm=tare_arm,
            usage_items=usage_items,
            usage_total=usage_total,
            usage_page=page,
            usage_total_pages=usage_total_pages,
            summary=summary,
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
