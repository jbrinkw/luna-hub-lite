"""Non-intake / non-scale JSON endpoints for Live Shelf (Bundle G).

These are the endpoints the web UI polls or submits to:

    GET  /api/state
    POST /api/config
    GET  /api/events
    POST /review/<id>/resolve

Scale ingestion (``/api/scale-event``, ``/api/scale-heartbeat``) belongs to
Bundle H. Intake endpoints (``/api/intake/*``) belong to Bundle F.

The ``/review/<id>/resolve`` endpoint is exposed as an API but mounted under
``/review/*`` (matching the HTML routes) rather than ``/api/*`` — that is
what §4.6 of the plan specifies.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

from flask import Blueprint, abort, jsonify, request

from .routes import EVENTS_PER_PAGE, WebRepo

log = logging.getLogger(__name__)

# Allowlist for the /api/camera/auto-exposure `device` field. The value is
# passed to v4l2-ctl via subprocess argv, so a permissive value would let a
# LAN client substitute arbitrary argv tokens. Accept either /dev/videoN
# (legacy form, max 4 digits — /dev/video9999 is the practical ceiling)
# or a /dev/v4l/by-id/... symlink (stable across replug — what app.py's
# resolved ``camera_device`` actually holds when an .env points at the
# Sunplus rig). By-id names are alphanum + ``_.-`` and driver-generated
# names cap around ~80 chars; allow up to 128 to be safe.
_V4L2_DEVICE_RE = re.compile(
    r"^/dev/video\d{1,4}$"
    r"|^/dev/v4l/by-id/[A-Za-z0-9_.-]{1,128}$"
)
_V4L2_DEVICE_MAX_LEN = 160


# Type alias: a config patcher that the host app supplies.
# Contract: receives the JSON body of POST /api/config and returns the
# current config dict (post-merge). Implementations should validate keys
# and raise ValueError with a descriptive message on bad input.
ConfigPatcher = Callable[[dict[str, Any]], dict[str, Any]]

# Type alias: a config reader (GET /api/config counterpart for the POST
# round trip). Returns the current full config dict.
ConfigReader = Callable[[], dict[str, Any]]

# Wipe callable: returns a small summary dict describing what was cleared.
# Host app owns the DB + filesystem side-effects; the route just invokes it.
WipeFn = Callable[[], dict[str, Any]]


# Session control callables — let the dashboard force-open / force-close a
# session without relying on brightness detection (useful on a bench where
# the camera isn't behind a door with reliable brightness transitions).
ForceOpenFn = Callable[[], dict[str, Any]]
ForceCloseFn = Callable[[], dict[str, Any]]


# Delete a single product (+ its lots + its reference images). The host app
# owns the DB + filesystem side-effects; the route just looks up the id and
# dispatches. Raise ``LookupError`` for an unknown product id so the route
# can turn it into a 404.
DeleteProductFn = Callable[[str], dict[str, Any]]

# Per-lot delete callable. Raises LookupError when the id isn't known so
# the route can return a 404.
DeleteLotFn = Callable[[str], dict[str, Any]]

# Per-usage-row delete callable. Reverts consumption on the associated lot
# and removes the usage_log row. Returns a summary dict. Does NOT raise for
# unknown ids — deletes are idempotent (summary reports ``deleted: 0``).
DeleteUsageFn = Callable[[str], dict[str, Any]]

# Dedup-group delete callable. Backs POST /api/usage/dedupe-group/delete —
# the inventory page needs a way to drop every usage_log row that shares a
# (return_event_id, lot_id, kind) key in one transaction. The per-row
# delete only removes one of the duplicates the re-emission backend bug
# leaves behind (see UX_AUDIT R2 F2). Idempotent — empty groups return
# ``deleted: 0`` without raising.
DeleteUsageDedupGroupFn = Callable[..., dict[str, Any]]


def make_api_bp(
    repo: WebRepo,
    *,
    read_config: Optional[ConfigReader] = None,
    update_config: Optional[ConfigPatcher] = None,
    wipe_fn: Optional[WipeFn] = None,
    force_open_session: Optional[ForceOpenFn] = None,
    force_close_session: Optional[ForceCloseFn] = None,
    delete_product_fn: Optional[DeleteProductFn] = None,
    delete_lot_fn: Optional[DeleteLotFn] = None,
    delete_usage_fn: Optional[DeleteUsageFn] = None,
    delete_usage_dedup_group_fn: Optional[DeleteUsageDedupGroupFn] = None,
    default_camera_device: str = "/dev/video0",
    cloud_outbox_conn: Optional[Callable[[], Any]] = None,
    intake_dlq_conn: Optional[Callable[[], Any]] = None,
    intake_dlq_lock: Optional[Any] = None,
    intake_dlq_cloud_client: Optional[Any] = None,
    intake_dlq_cloud_upsert_fn: Optional[Callable[..., Any]] = None,
) -> Blueprint:
    """Build the JSON API blueprint.

    Args:
        repo: storage read/write interface (same protocol used by HTML bp).
        read_config: returns the current config dict (optional — if None, the
            GET branch of /api/config returns 501).
        update_config: applies a config patch (optional — if None, POST
            /api/config returns 501).
    """
    bp = Blueprint("web_api", __name__)

    # ----- /api/state ------------------------------------------------------

    @bp.get("/api/state")
    def api_state():
        # Per-shelf dispatch — when the caller asks for ``?shelf=catch_all``
        # the response mirrors the catch-all's fields (session id, last
        # weight from scale-02, on/in-flight counts). ``?shelf=single_item``
        # returns the aggregate single-track tile state (count + paired
        # device list with per-device weight + product name). The default
        # path (no query, or ``?shelf=live_shelf``) returns the existing
        # app_state shape unchanged for backward compat.
        #
        # Unknown ``shelf`` values are rejected with 400 rather than silently
        # falling back to live-shelf state — silently coercing would mask
        # typos in clients and hide the fact that a new shelf key hasn't
        # been wired into the backend yet.
        shelf = request.args.get("shelf")
        if shelf is not None and shelf not in {
            "live_shelf", "catch_all", "single_item",
        }:
            return jsonify({"error": "unknown shelf"}), 400
        if shelf == "catch_all":
            get_ca = getattr(repo, "get_catch_all_state", None)
            if not callable(get_ca):
                return jsonify({"error": "catch-all state not configured"}), 501
            ca = get_ca()
            return jsonify(dict(ca))
        if shelf == "single_item":
            get_st = getattr(repo, "get_single_track_state", None)
            if not callable(get_st):
                return jsonify({"error": "single-track state not configured"}), 501
            st = get_st()
            return jsonify(dict(st))
        state = repo.get_app_state()
        # Shape defensively: Jinja-friendly dict already, but ensure bools
        # are primitives not 0/1 ints for JS polling code.
        out = dict(state)
        if "door_open" in out:
            out["door_open"] = bool(out["door_open"])
        return jsonify(out)

    # ----- /api/config -----------------------------------------------------

    @bp.get("/api/config")
    def api_config_get():
        if read_config is None:
            return jsonify({"error": "config read not configured"}), 501
        return jsonify(read_config())

    @bp.post("/api/config")
    def api_config_post():
        if update_config is None:
            return jsonify({"error": "config update not configured"}), 501
        if not request.is_json:
            return jsonify({"error": "expected application/json"}), 400
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object"}), 400

        # Persistence contract — Phase 1 audit finding L8/MEDIUM
        # (AUDIT_FINDINGS_PHASE1.md): the current host-supplied
        # ``update_config`` is in-memory only. Changes apply to the
        # running process but do NOT survive a restart. The audit's
        # preferred fix is "return 501 if persist=True is requested
        # without a backing patcher, so callers can't silently expect
        # persistence". A meta-key ``_persist`` in the request body is
        # treated as the explicit persist hint — when it is true and
        # we don't have a disk-backed patcher, we 501 with a clear
        # error message rather than logging a warning + lying about
        # the result.
        wants_persist = bool(body.pop("_persist", False))
        if wants_persist:
            return (
                jsonify({
                    "error": "config persistence is not implemented; the "
                             "in-memory patcher cannot honor _persist=true. "
                             "Edit config.json directly and restart the "
                             "service for durable changes.",
                    "persisted": False,
                }),
                501,
            )

        try:
            updated = update_config(body)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        # Surface the in-memory-only nature of the write to the client
        # explicitly so the UI can show a "changes are session-only"
        # notice. The WARNING log entry mirrors what the deferred-fix
        # backlog tracks.
        persisted = False
        log.warning(
            "config update is in-memory only; changes will not survive "
            "a restart (keys=%s)",
            sorted(body.keys()),
        )
        response: dict[str, Any] = {"ok": True, "persisted": persisted}
        # Preserve the existing contract: the updated config dict is spread
        # into the response so clients that read individual keys keep working.
        if isinstance(updated, dict):
            for k, v in updated.items():
                response.setdefault(k, v)
        return jsonify(response)

    # ----- /api/camera/auto-exposure ---------------------------------------
    #
    # Toggle the camera between manual (calibrated) exposure and auto
    # exposure. Calibrated values work inside a lit fridge but produce
    # near-black frames on a dark bench; the dashboard exposes this
    # toggle so the user can flip to auto for bench demos.

    @bp.post("/api/camera/auto-exposure")
    def api_camera_auto_exposure():
        from ..camera.locked_settings import set_auto_exposure
        body = request.get_json(silent=True) or {}
        enabled = bool(body.get("enabled", True))
        # The dashboard button sends no ``device``; fall back to the
        # live-shelf camera that the host app actually opened (was
        # hardcoded to ``/dev/video0``, which on this rig is the HD Web
        # Camera that has NO auto_exposure control — so the toggle
        # silently no-op'd). ``default_camera_device`` reflects the
        # resolved ``cfg.camera_device`` passed in from ``create_app``.
        device = str(body.get("device", default_camera_device))
        # Defence-in-depth: the `device` field is forwarded to v4l2-ctl
        # subprocess argv. Allowlist to /dev/videoN so a LAN client can't
        # smuggle shell metacharacters or argv-splitting spaces through.
        if len(device) > _V4L2_DEVICE_MAX_LEN or not re.fullmatch(
            _V4L2_DEVICE_RE, device
        ):
            return jsonify({"error": "invalid device path"}), 400
        ok = set_auto_exposure(device=device, enabled=enabled)
        return jsonify({"ok": ok, "enabled": enabled, "device": device})

    # ----- /api/session/start + /api/session/end ---------------------------
    #
    # Manual door-open / door-close trigger for bench demos. The
    # brightness watcher still runs in the background; these endpoints
    # simply invoke the same handler path so the session lifecycle
    # semantics are identical.

    @bp.post("/api/session/start")
    def api_session_start():
        if force_open_session is None:
            return jsonify({"error": "session control not configured"}), 501
        try:
            result = force_open_session()
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:  # defensive — DB failures etc.
            log.exception("force-open failed")
            return jsonify({"error": f"force-open failed: {exc}"}), 500
        return jsonify({"ok": True, **result})

    @bp.post("/api/session/end")
    def api_session_end():
        if force_close_session is None:
            return jsonify({"error": "session control not configured"}), 501
        try:
            result = force_close_session()
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:  # defensive
            log.exception("force-close failed")
            return jsonify({"error": f"force-close failed: {exc}"}), 500
        return jsonify({"ok": True, **result})

    # ----- /api/diag/dump-session ------------------------------------------
    #
    # Diagnostic capture. Call RIGHT AFTER performing a real transaction
    # (open fridge → grab item → close fridge → hit this endpoint). The
    # server dumps:
    #   * every frame currently in the ring buffer (last ~30s of footage),
    #     saved as timestamped JPEGs in data/diag/<dump_id>/frames/
    #   * the last 20 scale events with full metadata (ts + Pi receipt +
    #     motion timing + classifier output + saved frame paths) → events.json
    #   * recent app_state snapshot (door flag, last weight/ts, stable flag)
    #     → state.json
    #
    # Then SCP the folder off the Pi and hand it to an LLM to eyeball
    # exactly when the door was open, when the item moved, and whether our
    # frame-anchor math is landing in the right window.

    @bp.post("/api/diag/dump-session")
    def api_diag_dump_session():
        import cv2
        import json as _json
        import uuid as _uuid
        from ..camera.extract import get_daemon
        from ..handlers.scale_events import get_weight_trace

        try:
            d = get_daemon()
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 503

        # Where to write — use the existing data dir convention.
        import os
        data_root = os.environ.get("DATA_DIR") or "./data"
        diag_id = _uuid.uuid4().hex[:12]
        dump_dir = os.path.join(data_root, "diag", diag_id)
        frames_dir = os.path.join(dump_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)

        # Snapshot the ring buffer and write each frame as JPEG, naming
        # files with their ISO timestamp so brightness + timing analysis
        # is trivial ex post.
        #
        # Cap at the most recent 60 frames (~6s @ 10fps) so a LAN client
        # can't trigger multi-tens-of-megabyte writes per call.
        snaps = d.snapshot_ring()[-60:]
        frames_meta = []
        for ts, frame in snaps:
            safe_ts = ts.replace(":", "-")
            fname = f"frame-{safe_ts}.jpg"
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                continue
            path = os.path.join(frames_dir, fname)
            with open(path, "wb") as f:
                f.write(buf.tobytes())
            frames_meta.append({"ts": ts, "filename": fname, "mean": float(frame.mean())})

        # Pull recent events + state via the shared web_repo adapter so the
        # reads happen under the same db_lock every other DB access uses
        # (see handoff §7.1). The previous implementation opened a second
        # sqlite3 connection outside the lock, which can surface as
        # `sqlite3.InterfaceError: bad parameter or other API misuse` under
        # concurrent load.
        events_list: list[dict] = []
        state_snapshot: dict = {}
        try:
            events_list = list(repo.list_events(limit=20, offset=0))
            state_snapshot = dict(repo.get_app_state())
        except Exception as exc:
            log.exception("diag dump: db read failed")
            events_list.append({"error": f"db read failed: {exc}"})

        weight_trace = get_weight_trace()

        with open(os.path.join(dump_dir, "events.json"), "w") as f:
            _json.dump(events_list, f, indent=2, default=str)
        with open(os.path.join(dump_dir, "state.json"), "w") as f:
            _json.dump(state_snapshot, f, indent=2, default=str)
        with open(os.path.join(dump_dir, "frames_meta.json"), "w") as f:
            _json.dump(frames_meta, f, indent=2)
        with open(os.path.join(dump_dir, "weight_trace.json"), "w") as f:
            _json.dump(weight_trace, f, indent=2)

        # Absolute path so scp can fetch it without worrying about the
        # Pi-side working directory (data_root is './data' relative to the
        # server process cwd, which the caller can't easily know).
        abs_dump_dir = os.path.abspath(dump_dir)
        return jsonify({
            "ok": True,
            "diag_id": diag_id,
            "dump_dir": abs_dump_dir,
            "frame_count": len(frames_meta),
            "event_count": len(events_list),
            "trace_count": len(weight_trace),
            "scp_cmd": (
                f"scp -r jeremy@192.168.0.181:{abs_dump_dir} /tmp/diag-{diag_id}"
            ),
        })

    # ----- /api/debug/ring-buffer ------------------------------------------
    # Temporary diagnostic: dump ring buffer timestamps + per-frame brightness
    # so we can tell whether black event frames are due to (a) camera never
    # seeing light at the event timestamp, (b) frame-at lookup miss, or
    # (c) buffer retention being too shallow.

    @bp.get("/api/debug/ring-buffer")
    def api_debug_ring_buffer():
        from ..camera.extract import get_daemon
        try:
            d = get_daemon()
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 503
        snaps = d.snapshot_ring()
        if not snaps:
            return jsonify({"size": 0})
        means = [float(frame.mean()) for (_, frame) in snaps]
        step = max(1, len(snaps) // 20)
        timeline = []
        for i in range(0, len(snaps), step):
            ts, frame = snaps[i]
            timeline.append({"i": i, "ts": ts, "mean": round(float(frame.mean()), 1)})
        return jsonify({
            "size": len(snaps),
            "oldest_ts": snaps[0][0],
            "newest_ts": snaps[-1][0],
            "mean_min": round(min(means), 1),
            "mean_max": round(max(means), 1),
            "mean_avg": round(sum(means) / len(means), 1),
            "lit_count": sum(1 for m in means if m > 30),
            "dark_count": sum(1 for m in means if m < 5),
            "timeline": timeline,
        })

    # ----- /api/admin/wipe -------------------------------------------------

    @bp.post("/api/admin/wipe")
    def api_admin_wipe():
        """Destroy all product + transaction state. Keeps app_state + camera.

        This is the backend for the top-right "wipe" button in the nav. The
        host app owns the actual wipe logic (DB deletes + filesystem cleanup);
        this route is a thin authenticated (by LAN scope) trigger.
        """
        if wipe_fn is None:
            return jsonify({"error": "wipe not configured"}), 501
        try:
            summary = wipe_fn()
        except Exception as exc:  # defensive — host side-effects can fail
            log.exception("wipe failed")
            return jsonify({"error": f"wipe failed: {exc}"}), 500
        # Clear in-memory session-capture state so _CURRENT / _CLOSED
        # don't keep dangling references to sessions whose JPEGs and MP4
        # have just been deleted from disk by wipe_fn.
        try:
            from ..camera import session_capture
            session_capture.reset()
        except Exception:  # pragma: no cover — defensive, don't fail the wipe
            log.exception("wipe: session_capture.reset() failed")
        log.warning("admin wipe executed: %s", summary)
        return jsonify({"ok": True, "summary": summary})

    # ----- /api/admin/dead-letter ------------------------------------------
    #
    # Dead-letter queue inspection + retry. The cloud worker dead-letters
    # an outbox row after DEAD_LETTER_ATTEMPT_THRESHOLD consecutive
    # transient failures so downstream rows can drain. Operators inspect
    # what's stuck via this endpoint and either accept the loss or fix
    # the root cause + click "retry" to re-enqueue. See worker.py +
    # outbox.mark_dead_letter for the full flow.

    @bp.get("/api/admin/dead-letter")
    def api_admin_dead_letter_list():
        """Return the dead-lettered + permanently-failed outbox rows."""
        if cloud_outbox_conn is None:
            return jsonify({
                "error": "cloud outbox not configured",
                "rows": [],
            }), 501
        try:
            from ..cloud import outbox as _ob  # local import — cloud dep optional
            conn = cloud_outbox_conn()
            rows = _ob.list_dead_letter(conn, limit=200)
        except Exception as exc:  # noqa: BLE001 — never crash the route
            log.exception("dead-letter list failed: %s", exc)
            return jsonify({"error": "dead-letter list failed", "rows": []}), 500
        return jsonify({
            "rows": [
                {
                    "outbox_id": r.outbox_id,
                    "client_event_id": r.client_event_id,
                    "enqueued_at": r.enqueued_at,
                    "attempts": r.attempts,
                    "last_error": r.last_error,
                    "payload_json": r.payload_json,
                }
                for r in rows
            ],
        })

    @bp.post("/api/admin/dead-letter/<int:outbox_id>/retry")
    def api_admin_dead_letter_retry(outbox_id: int):
        """Clear failed_permanently so the worker re-tries the row.

        Resets ``attempts`` to 0 — without that the row would re-dead-
        letter on the very next failure. Idempotent: returns 404 when
        the row isn't currently in the dead-letter bucket.
        """
        if cloud_outbox_conn is None:
            return jsonify({"error": "cloud outbox not configured"}), 501
        try:
            from ..cloud import outbox as _ob
            conn = cloud_outbox_conn()
            updated = _ob.reset_dead_letter(conn, outbox_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("dead-letter retry failed for %d: %s", outbox_id, exc)
            return jsonify({"error": "dead-letter retry failed"}), 500
        if not updated:
            return jsonify({"error": "row not in dead-letter state"}), 404
        log.warning(
            "operator retried dead-lettered outbox row %d", outbox_id,
        )
        return jsonify({"ok": True, "outbox_id": outbox_id})

    # ----- /api/admin/intake-dlq -------------------------------------------
    #
    # Intake dead-letter queue (AUDIT_FINDINGS_PHASE1 L8/HIGH closed).
    # When ``POST /shelf-ingest/intake`` returns 5xx or the request
    # never makes it (DNS / TCP reset / timeout), the user-typed
    # product spec is parked in ``intake_pending`` so an operator can
    # retry it later from this endpoint without forcing the user to
    # re-enter every field. Distinct from the ``cloud_outbox``
    # dead-letter (event ledger) — see server/intake/dlq.py docstring.

    @bp.get("/api/admin/intake-dlq")
    def api_admin_intake_dlq_list():
        """List intake_pending rows.

        Default to the all-statuses view (newest first) so the
        admin UI can render the audit trail (resolved + abandoned)
        too. Pass ``?status=pending`` to scope to retry-eligible
        rows only.
        """
        if intake_dlq_conn is None:
            return jsonify({
                "error": "intake DLQ not configured",
                "rows": [],
            }), 501
        try:
            from ..intake import dlq as _dlq  # local import — cloud dep optional
            conn = intake_dlq_conn()
            scope = (request.args.get("status") or "").strip().lower()
            if scope == "pending":
                rows = _dlq.list_pending(conn, limit=200)
            else:
                rows = _dlq.list_all(conn, limit=200)
        except Exception as exc:  # noqa: BLE001 — never crash the route
            log.exception("intake-dlq list failed: %s", exc)
            return jsonify({
                "error": "intake-dlq list failed",
                "rows": [],
            }), 500
        return jsonify({
            "rows": [
                {
                    "intake_id": r.intake_id,
                    "client_intake_id": r.client_intake_id,
                    "enqueued_at": r.enqueued_at,
                    "resolved_at": r.resolved_at,
                    "attempts": r.attempts,
                    "last_error": r.last_error,
                    "status": r.status,  # 0=pending 1=resolved 2=abandoned
                    "product_id": r.product_id,
                    # Echo the queued payload so the operator can
                    # eyeball what would be re-POSTed before clicking
                    # retry. Strings only — never log secrets via this
                    # endpoint; intake bodies are user-typed product
                    # specs (no API keys / passwords).
                    "payload_json": r.payload_json,
                }
                for r in rows
            ],
        })

    @bp.post("/api/admin/intake-dlq/<int:intake_id>/retry")
    def api_admin_intake_dlq_retry(intake_id: int):
        """Re-POST a queued intake to the cloud.

        On success: stamps ``status=1``, ``resolved_at=now``,
        ``product_id=<cloud-minted>`` and writes-through the local
        product cache so subsequent classifier lookups see the row.
        On a transient failure: bumps ``attempts`` and stores the
        latest error; row stays pending for the next click.
        On a 4xx (validation) failure: surface to the operator
        (don't auto-abandon — operator chooses via the abandon
        endpoint when they're sure).
        """
        if intake_dlq_conn is None:
            return jsonify({"error": "intake DLQ not configured"}), 501
        if intake_dlq_cloud_client is None:
            # Cloud disabled / missing import key — no point retrying.
            return jsonify({
                "error": "cloud client not configured; cannot retry",
            }), 501
        try:
            from ..intake import dlq as _dlq
            from ..cloud import CloudError as _CloudError
            conn = intake_dlq_conn()
            row = _dlq.get(conn, intake_id)
        except Exception as exc:  # noqa: BLE001
            log.exception(
                "intake-dlq retry pre-check failed for %d: %s",
                intake_id, exc,
            )
            return jsonify({
                "error": "intake-dlq retry failed (pre-check)",
            }), 500
        if row is None:
            return jsonify({"error": "intake_id not found"}), 404
        if row.status != 0:
            return jsonify({
                "error": "row is not pending",
                "status": row.status,
            }), 409

        try:
            payload = row.payload
        except Exception as exc:  # noqa: BLE001
            log.exception("intake-dlq retry: payload decode failed for %d", intake_id)
            return jsonify({
                "error": f"payload decode failed: {exc}",
            }), 500

        # Re-POST verbatim. The cloud /intake handler doesn't dedupe
        # on client_intake_id today — operator-driven retries are how
        # we keep this safe (operator only clicks after they've
        # confirmed the prior attempt didn't land a row).
        try:
            cloud_product = intake_dlq_cloud_client.post("/intake", payload)
        except _CloudError as exc:  # type: ignore[misc]
            err = f"cloud {exc.status_code}: {(exc.body or '')[:300]}"
            _dlq.record_retry_failure(
                conn, intake_id, error=err, db_lock=intake_dlq_lock,
            )
            log.warning("intake-dlq retry %d returned %s", intake_id, err)
            return jsonify({
                "error": "retry failed",
                "status_code": exc.status_code,
                "body": exc.body,
            }), 502 if exc.status_code >= 500 else 400
        except Exception as exc:  # noqa: BLE001
            err = f"network: {exc}"[:500]
            _dlq.record_retry_failure(
                conn, intake_id, error=err, db_lock=intake_dlq_lock,
            )
            log.warning(
                "intake-dlq retry %d network error: %s", intake_id, exc,
            )
            return jsonify({
                "error": f"retry failed (network): {exc}",
            }), 503

        product_id = (
            cloud_product.get("product_id")
            if isinstance(cloud_product, dict) else None
        )
        if not isinstance(product_id, str) or not product_id.strip():
            err = "cloud response missing product_id"
            _dlq.record_retry_failure(
                conn, intake_id, error=err, db_lock=intake_dlq_lock,
            )
            log.error(
                "intake-dlq retry %d: %s (%r)", intake_id, err, cloud_product,
            )
            return jsonify({"error": err}), 502

        # Mirror the success path of intake_save: write-through the
        # local cache so classifier lookups + subsequent UI reads see
        # the row immediately. Failures here are non-fatal (cloud
        # already wrote; next product-sync poller tick recovers).
        if intake_dlq_cloud_upsert_fn is not None:
            try:
                intake_dlq_cloud_upsert_fn(
                    conn, cloud_product, db_lock=intake_dlq_lock,
                )
            except Exception:
                log.exception(
                    "intake-dlq retry %d: local cache upsert failed for %s",
                    intake_id, product_id,
                )

        _dlq.mark_resolved(
            conn, intake_id, product_id=product_id, db_lock=intake_dlq_lock,
        )
        log.warning(
            "operator-resolved intake-dlq row %d as product %s",
            intake_id, product_id,
        )
        return jsonify({
            "ok": True,
            "intake_id": intake_id,
            "product_id": product_id,
        })

    @bp.post("/api/admin/intake-dlq/<int:intake_id>/abandon")
    def api_admin_intake_dlq_abandon(intake_id: int):
        """Mark a pending DLQ row as abandoned.

        Operator path for "this will never succeed" — e.g. the cloud
        rejected with 4xx after the operator manually fixed something
        and confirmed the queued payload is no longer needed.
        """
        if intake_dlq_conn is None:
            return jsonify({"error": "intake DLQ not configured"}), 501
        body = request.get_json(silent=True) or {}
        reason = str(body.get("reason") or "operator abandoned")[:300]
        try:
            from ..intake import dlq as _dlq
            conn = intake_dlq_conn()
            updated = _dlq.mark_abandoned(
                conn, intake_id, reason=reason, db_lock=intake_dlq_lock,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception(
                "intake-dlq abandon failed for %d: %s", intake_id, exc,
            )
            return jsonify({"error": "intake-dlq abandon failed"}), 500
        if not updated:
            return jsonify({"error": "row not in pending state"}), 404
        log.warning(
            "operator abandoned intake-dlq row %d: %s", intake_id, reason,
        )
        return jsonify({"ok": True, "intake_id": intake_id})

    # ----- /api/product/<product_id>/tare/arm ------------------------------
    #
    # Tare-capture arm/status/cancel trio (CATCH_ALL_TARE_CAPTURE_PLAN.md
    # §4.4). POST arm writes a singleton arm row; the next non-noise
    # catch-all event whose reading lies within the product's plausible
    # bounds is intercepted by ``ScaleHandler.handle_scale_event`` and
    # its settled weight is written to ``products.tare_weight_g``.
    # Rejects non-existent and non-certified products (owner resolution
    # #5 — only certified rows get tared).

    @bp.post("/api/product/<product_id>/tare/arm")
    def api_product_tare_arm(product_id: str):
        if not product_id or "/" in product_id or ".." in product_id:
            return jsonify({"error": "invalid product_id"}), 400
        get_product = getattr(repo, "get_product", None)
        if not callable(get_product):
            return jsonify({"error": "tare arm not configured"}), 501
        product = get_product(product_id)
        if product is None:
            return jsonify({"error": "product not found"}), 404
        # Certified gate: non-certified products aren't shown the Tare
        # button in the UI, so a POST here means the client is out of
        # sync (stale page) or hand-crafted. Reject with 400 rather
        # than silently arming.
        if isinstance(product, dict):
            is_certified = bool(product.get("certified"))
        else:
            is_certified = bool(getattr(product, "certified", None))
        if not is_certified:
            return jsonify({"error": "product is not certified"}), 400
        arm_fn = getattr(repo, "arm_tare", None)
        if not callable(arm_fn):
            return jsonify({"error": "tare arm not configured"}), 501
        arm = arm_fn(product_id)
        if not isinstance(arm, dict):
            arm = dict(arm)  # pragma: no cover - defensive
        return jsonify({
            "ok": True,
            "product_id": arm.get("product_id"),
            "device_id": arm.get("device_id"),
            "armed_at": arm.get("armed_at"),
            "expires_at": arm.get("expires_at"),
        })

    @bp.post("/api/tare/cancel")
    def api_tare_cancel():
        cancel_fn = getattr(repo, "cancel_tare_arm", None)
        if not callable(cancel_fn):
            return jsonify({"error": "tare cancel not configured"}), 501
        deleted = int(cancel_fn() or 0)
        return jsonify({"ok": True, "deleted": deleted})

    @bp.get("/api/tare/status")
    def api_tare_status():
        status_fn = getattr(repo, "get_tare_arm_status", None)
        if not callable(status_fn):
            return jsonify({
                "armed": False,
                "product_id": None,
                "product_name": None,
                "expires_at": None,
                "seconds_remaining": None,
                "last_error": None,
            })
        return jsonify(status_fn())

    # ----- /api/product/<product_id>/delete --------------------------------
    #
    # Per-row delete from the registry catalog table. Removes the product,
    # any lots referencing it, and the product's reference-image directory
    # under data/refs/<product_id>/. Not exposed as DELETE because the UI
    # calls it from a plain fetch() and the dashboard only has LAN scope.

    @bp.post("/api/product/<product_id>/delete")
    def api_product_delete(product_id: str):
        if delete_product_fn is None:
            return jsonify({"error": "product delete not configured"}), 501
        if not product_id or "/" in product_id or ".." in product_id:
            return jsonify({"error": "invalid product_id"}), 400
        try:
            summary = delete_product_fn(product_id)
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404
        except Exception as exc:  # defensive — host side-effects can fail
            log.exception("product delete failed")
            return jsonify({"error": f"delete failed: {exc}"}), 500
        log.warning("product delete: %s", summary)
        return jsonify({"ok": True, "summary": summary})

    # ----- /api/lot/<lot_id>/delete ----------------------------------------
    #
    # Per-row delete from the on-shelf inventory table on /registry. Only
    # drops the lot; the underlying product stays in the catalog so the
    # user can re-place a new instance later.

    @bp.post("/api/lot/<lot_id>/delete")
    def api_lot_delete(lot_id: str):
        if delete_lot_fn is None:
            return jsonify({"error": "lot delete not configured"}), 501
        if not lot_id or "/" in lot_id or ".." in lot_id:
            return jsonify({"error": "invalid lot_id"}), 400
        try:
            summary = delete_lot_fn(lot_id)
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404
        except Exception as exc:  # defensive
            log.exception("lot delete failed")
            return jsonify({"error": f"delete failed: {exc}"}), 500
        log.warning("lot delete: %s", summary)
        return jsonify({"ok": True, "summary": summary})

    # ----- /api/events -----------------------------------------------------

    @bp.get("/api/events")
    def api_events():
        try:
            page = int(request.args.get("page", 1))
        except (TypeError, ValueError):
            page = 1
        page = max(page, 1)
        try:
            per_page = int(request.args.get("per_page", EVENTS_PER_PAGE))
        except (TypeError, ValueError):
            per_page = EVENTS_PER_PAGE
        per_page = max(1, min(per_page, 100))
        total = repo.count_events()
        offset = (page - 1) * per_page
        items = repo.list_events(limit=per_page, offset=offset)
        return jsonify(
            {
                "page": page,
                "per_page": per_page,
                "total": total,
                "total_pages": max(1, (total + per_page - 1) // per_page),
                "events": items,
            }
        )

    # ----- /api/usage (USAGE_LOG_PLAN.md §5.3) ---------------------------

    @bp.get("/api/usage")
    def api_usage():
        try:
            page = int(request.args.get("page", 1))
        except (TypeError, ValueError):
            page = 1
        page = max(page, 1)
        try:
            per_page = int(request.args.get("per_page", 50))
        except (TypeError, ValueError):
            per_page = 50
        per_page = max(1, min(per_page, 500))

        product_id = request.args.get("product") or None
        kind = request.args.get("kind") or None
        since = request.args.get("since") or None
        until = request.args.get("until") or None
        kinds = [kind] if kind else None

        list_usage = getattr(repo, "list_usage", None)
        if list_usage is None:
            return jsonify({
                "page": 1, "per_page": per_page,
                "total": 0, "total_pages": 1, "items": [],
            })

        total = repo.count_usage(
            product_id=product_id, kinds=kinds, since=since, until=until,
        )
        offset = (page - 1) * per_page
        items = list_usage(
            product_id=product_id, kinds=kinds, since=since, until=until,
            limit=per_page, offset=offset,
        )
        return jsonify({
            "page": page,
            "per_page": per_page,
            "total": total,
            "total_pages": max(1, (total + per_page - 1) // per_page),
            "items": items,
        })

    @bp.post("/api/usage/<usage_id>/delete")
    def api_usage_delete(usage_id: str):
        if delete_usage_fn is None:
            return jsonify({"error": "usage delete not configured"}), 501
        if not usage_id or "/" in usage_id or ".." in usage_id:
            return jsonify({"error": "invalid usage_id"}), 400
        try:
            summary = delete_usage_fn(usage_id)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("usage delete failed")
            return jsonify({"error": f"delete failed: {exc}"}), 500
        try:
            deleted = int(summary["deleted"])
        except (KeyError, TypeError, ValueError):
            log.error("usage delete returned malformed summary: %r", summary)
            return jsonify({"error": "delete summary malformed", "summary": summary}), 500
        if deleted == 0:
            return jsonify({"error": "usage row not found", "summary": summary}), 404
        log.info("usage delete: %s", summary)
        return jsonify({"ok": True, "summary": summary})

    # ----- /api/usage/dedupe-group/delete (UX_AUDIT R2 F2) ----------------
    #
    # Drop every usage_log row that shares a (return_event_id, lot_id,
    # kind) dedup key. Backs the survivor row's "Nx" pill action on the
    # inventory page when the per-row × button would only remove one of N
    # duplicates (the re-emission backend bug). Body is JSON::
    #
    #     {"return_event_id": "<event_id>",
    #      "lot_id": "<lot_id>"|null,    # optional
    #      "kind": "<usage_kind>"|null}  # optional
    #
    # ``lot_id`` and ``kind`` narrow the scope so two unrelated dedup
    # groups that happened to share a return_event_id can't be wiped
    # with one POST. Returns the same summary shape as the per-row
    # delete: ``{ok, summary: {deleted, reverted_g, lot_id}}``.
    @bp.post("/api/usage/dedupe-group/delete")
    def api_usage_dedupe_group_delete():
        if delete_usage_dedup_group_fn is None:
            return jsonify({"error": "dedupe-group delete not configured"}), 501
        if not request.is_json:
            return jsonify({"error": "expected application/json"}), 400
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object"}), 400
        return_event_id = body.get("return_event_id")
        if (not isinstance(return_event_id, str)
                or not return_event_id.strip()
                or "/" in return_event_id
                or ".." in return_event_id):
            return jsonify({"error": "invalid return_event_id"}), 400
        lot_id_raw = body.get("lot_id")
        kind_raw = body.get("kind")
        # Guard the optional narrowing fields the same way the route's
        # other handlers do — non-string values that aren't None are
        # rejected so a hostile caller can't smuggle dicts/lists through.
        lot_id: Optional[str] = None
        if lot_id_raw is not None:
            if not isinstance(lot_id_raw, str) or "/" in lot_id_raw or ".." in lot_id_raw:
                return jsonify({"error": "invalid lot_id"}), 400
            lot_id = lot_id_raw or None
        kind: Optional[str] = None
        if kind_raw is not None:
            if not isinstance(kind_raw, str):
                return jsonify({"error": "invalid kind"}), 400
            kind = kind_raw or None
        try:
            summary = delete_usage_dedup_group_fn(
                return_event_id=return_event_id,
                lot_id=lot_id,
                kind=kind,
            )
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("dedupe-group delete failed")
            return jsonify({"error": f"delete failed: {exc}"}), 500
        try:
            deleted = int(summary["deleted"])
        except (KeyError, TypeError, ValueError):
            log.error(
                "dedupe-group delete returned malformed summary: %r", summary,
            )
            return jsonify(
                {"error": "delete summary malformed", "summary": summary},
            ), 500
        if deleted == 0:
            return jsonify(
                {"error": "no rows in dedupe group", "summary": summary},
            ), 404
        log.info("usage dedupe-group delete: %s", summary)
        return jsonify({"ok": True, "summary": summary})

    @bp.get("/api/usage/summary")
    def api_usage_summary():
        since = request.args.get("since") or None
        until = request.args.get("until") or None
        summary_fn = getattr(repo, "usage_summary_by_product", None)
        if summary_fn is None:
            return jsonify({"since": since, "until": until, "items": []})
        items = summary_fn(since=since, until=until)
        return jsonify({"since": since, "until": until, "items": items})

    # ----- /review/<id>/resolve -------------------------------------------

    @bp.post("/review/<review_id>/resolve")
    def api_review_resolve(review_id: str):
        if repo.get_review_item(review_id) is None:
            abort(404)

        # Accept either form-encoded (from a plain <form>) or JSON body.
        payload: dict[str, Any]
        if request.is_json:
            body = request.get_json(silent=True)
            payload = body if isinstance(body, dict) else {}
        else:
            payload = {k: v for k, v in request.form.items()}

        # Normalize keys that tests + the default review form use.
        candidate_id = payload.get("candidate_id") or payload.get("item_id")
        resolution_body: dict[str, Any] = {
            "candidate_id": candidate_id,
            "note": payload.get("note") or payload.get("free_text") or None,
            "action": payload.get("action"),
            "dismiss": str(payload.get("dismiss", "")).lower() in {"1", "true", "yes", "on"},
        }
        # Anything else the caller sent — pass through for kind-specific logic.
        for k, v in payload.items():
            resolution_body.setdefault(k, v)

        try:
            updated = repo.resolve_review_item(review_id, resolution=resolution_body)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        # If the caller looks like a browser form submit, redirect back to
        # the review list; JSON clients get the updated row.
        wants_json = request.is_json or "application/json" in (
            request.headers.get("Accept", "")
        )
        if wants_json:
            return jsonify(updated)
        # Simple 303-style redirect — Flask will fall through to redirect().
        from flask import redirect, url_for

        try:
            return redirect(url_for("web_html.review_list"))
        except Exception:
            return redirect("/review")

    return bp
