"""Debug / observability endpoints.

Exposed routes:

    GET /api/debug/event/<event_id>      — lifecycle + event + classification
    GET /api/debug/session/<session_id>  — lifecycle + session + events-in-window
    GET /api/debug/invariants            — run invariant checks
    GET /api/debug/health?since=1h       — last N system_health snapshots
    GET /event/<id>/timeline             — HTML timeline view
    GET /session/<id>/timeline           — HTML timeline view

All endpoints are read-only. They reuse the shared DB connection + lock
passed in at factory time. The HTML views use inline Jinja (no extra
templates) to keep the debug surface self-contained.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Optional

from flask import Blueprint, Response, abort, jsonify, request

from ..storage import lifecycle
from ..tools.invariants import run_invariant_checks


def _parse_since(raw: Optional[str], default_seconds: int = 3600) -> int:
    """Parse a ``since`` query string into seconds.

    Accepts: ``1h``, ``30m``, ``120s``, or a bare integer (treated as
    seconds). Falls back to ``default_seconds`` on anything unparseable.
    """
    if not raw:
        return default_seconds
    raw = raw.strip().lower()
    try:
        if raw.endswith("h"):
            return int(float(raw[:-1]) * 3600)
        if raw.endswith("m"):
            return int(float(raw[:-1]) * 60)
        if raw.endswith("s"):
            return int(float(raw[:-1]))
        return int(float(raw))
    except (TypeError, ValueError):
        return default_seconds


def _row_to_dict(row: Any) -> dict[str, Any]:
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    return dict(row)


def make_debug_bp(
    conn: sqlite3.Connection,
    db_lock: threading.Lock,
    *,
    runtime_health_provider: Optional[Any] = None,
) -> Blueprint:
    """Build the debug blueprint bound to a shared DB connection.

    ``runtime_health_provider`` is a zero-arg callable returning a dict
    of runtime-side health probes (Anthropic counters, camera daemon
    liveness) that the SQLite-only ``system_health`` snapshot can't
    capture. Surfaced under ``/api/debug/health.runtime``. Wired by
    ``app.py``; tests can pass ``None`` to skip. UX audit FLAG 3.
    """
    bp = Blueprint("web_debug", __name__)

    # --- JSON -----------------------------------------------------------

    @bp.get("/api/debug/event/<event_id>")
    def api_debug_event(event_id: str):
        with db_lock:
            row = conn.execute(
                "SELECT * FROM scale_events WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            timeline = lifecycle.get_event_timeline(conn, event_id, limit=500)
        if row is None and not timeline:
            abort(404)
        event_dict = _row_to_dict(row) if row is not None else None
        classification = None
        if event_dict and event_dict.get("classification"):
            try:
                classification = json.loads(event_dict["classification"])
            except (TypeError, ValueError):
                classification = None
        return jsonify(
            {
                "event_id": event_id,
                "event": event_dict,
                "classification": classification,
                "lifecycle": timeline,
            }
        )

    @bp.get("/api/debug/session/<session_id>")
    def api_debug_session(session_id: str):
        with db_lock:
            row = conn.execute(
                "SELECT * FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            events = conn.execute(
                "SELECT event_id, ts, direction, delta_g, classifier_status "
                "FROM scale_events WHERE session_id = ? ORDER BY ts ASC",
                (session_id,),
            ).fetchall()
            timeline = lifecycle.get_session_timeline(
                conn, session_id, limit=500,
            )
        if row is None and not timeline:
            abort(404)
        return jsonify(
            {
                "session_id": session_id,
                "session": _row_to_dict(row) if row is not None else None,
                "events": [_row_to_dict(e) for e in events],
                "lifecycle": timeline,
            }
        )

    @bp.get("/api/debug/invariants")
    def api_debug_invariants():
        with db_lock:
            violations = run_invariant_checks(conn)
        return jsonify({"violations": violations})

    @bp.get("/api/debug/health")
    def api_debug_health():
        since_s = _parse_since(request.args.get("since"), default_seconds=3600)
        with db_lock:
            rows = lifecycle.get_recent_health(
                conn, since_seconds=since_s, limit=1000,
            )
        # UX audit FLAG 3: surface the runtime-only signals
        # (Anthropic call counters, camera daemon liveness) the
        # SQLite snapshot loop can't capture. Best-effort: a missing
        # provider or a thrown probe lands as ``None`` for that field
        # rather than failing the endpoint — operators reading this
        # JSON expect partial data over a 500.
        runtime: dict[str, Any] = {
            "anthropic_calls_total": None,
            "anthropic_errors_total": None,
            "camera_daemon_alive": None,
            "catch_all_camera_alive": None,
        }
        if runtime_health_provider is not None:
            try:
                extra = runtime_health_provider() or {}
                if isinstance(extra, dict):
                    for k, v in extra.items():
                        runtime[k] = v
            except Exception:  # noqa: BLE001 — defensive
                pass
        return jsonify({
            "since_seconds": since_s,
            "snapshots": rows,
            "runtime": runtime,
        })

    # --- HTML timelines ------------------------------------------------

    @bp.get("/event/<event_id>/timeline")
    def html_event_timeline(event_id: str):
        with db_lock:
            row = conn.execute(
                "SELECT event_id, ts, direction, delta_g, classifier_status "
                "FROM scale_events WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            timeline = lifecycle.get_event_timeline(conn, event_id, limit=500)
        return Response(
            _render_timeline_html(
                title=f"Event {event_id}",
                header_row=_row_to_dict(row) if row is not None else None,
                timeline=timeline,
                related_link=(f"/event/{event_id}", "Back to event detail"),
            ),
            mimetype="text/html",
        )

    @bp.get("/session/<session_id>/timeline")
    def html_session_timeline(session_id: str):
        with db_lock:
            row = conn.execute(
                "SELECT session_id, started_at, ended_at, reconciled "
                "FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            timeline = lifecycle.get_session_timeline(
                conn, session_id, limit=500,
            )
        return Response(
            _render_timeline_html(
                title=f"Session {session_id}",
                header_row=_row_to_dict(row) if row is not None else None,
                timeline=timeline,
                related_link=(f"/session/{session_id}", "Back to session detail"),
            ),
            mimetype="text/html",
        )

    return bp


# ---------------------------------------------------------------------------
# HTML rendering helper (kept inline — no template file needed)
# ---------------------------------------------------------------------------


_REASON_COLORS = {
    "event_ingress": "#cceeff",
    "event_ingress_noise": "#eeeeee",
    "event_ingress_dedup_hit": "#ffd699",
    "event_claimed": "#c0f0c0",
    "event_claim_lost": "#f0d0c0",
    "classifier_dispatched": "#ddccff",
    "classifier_prompt_prepared": "#ddccff",
    "classifier_returned": "#aaffaa",
    "classifier_threw": "#ffaaaa",
    "classifier_parse_retry": "#ffe0aa",
    "classifier_malformed_output": "#ffaaaa",
    "apply_accepted": "#aaffaa",
    "apply_skipped": "#ffe0aa",
    "lot_mutated": "#c0f0c0",
    "review_enqueued": "#ffe0aa",
    "sweeper_marked_failed": "#ffaaaa",
    "sweeper_deferred_to_close_hook": "#eeeeee",
    "sweeper_classified": "#c0f0c0",
    "gap_fill_synthesized": "#ffd0ff",
    "frames_picked": "#e0e0ff",
    "frames_copied": "#e0e0ff",
    "frames_copy_error": "#ffaaaa",
    "session_opened": "#aaffaa",
    "session_closed": "#ffccaa",
    "session_capture_opened": "#aaffaa",
    "session_capture_closed": "#ffccaa",
    "reconciler_started": "#ccccff",
    "reconciler_completed": "#aaffaa",
    "reconciler_completed_internal": "#aaffaa",
    "reconciler_skipped_idempotent": "#eeeeee",
    "review_resolved": "#aaffaa",
    "wipe_started": "#ffaaaa",
    "wipe_completed": "#ccaaaa",
    "video_encoded": "#ddddff",
    "video_encode_failed": "#ffaaaa",
    "esp_reboot_detected": "#ffcccc",
}


def _escape(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _render_timeline_html(
    *,
    title: str,
    header_row: Optional[dict[str, Any]],
    timeline: list[dict[str, Any]],
    related_link: Optional[tuple[str, str]] = None,
) -> str:
    header_html = ""
    if header_row:
        header_html = "<dl class=\"meta\">"
        for k, v in header_row.items():
            header_html += f"<dt>{_escape(k)}</dt><dd>{_escape(v)}</dd>"
        header_html += "</dl>"
    rows_html: list[str] = []
    for row in timeline:
        reason = row.get("reason_code") or ""
        color = _REASON_COLORS.get(reason, "#f6f6f6")
        payload = row.get("payload")
        if payload is None and row.get("payload_json"):
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = row["payload_json"]
        payload_rendered = ""
        if payload is not None:
            try:
                payload_rendered = json.dumps(payload, default=str, indent=2)
            except Exception:
                payload_rendered = str(payload)
        rows_html.append(
            f"<tr style=\"background-color:{color}\">"
            f"<td>{_escape(row.get('ts'))}</td>"
            f"<td>{_escape(row.get('actor'))}</td>"
            f"<td><code>{_escape(reason)}</code></td>"
            f"<td><pre>{_escape(payload_rendered)}</pre></td>"
            "</tr>"
        )
    back = ""
    if related_link:
        url, label = related_link
        back = f'<p><a href="{_escape(url)}">&larr; {_escape(label)}</a></p>'
    count = len(timeline)
    # UX-FLAG: debug timeline pages have a light-mode style that
    # contrasts hard with the rest of the dark-themed app — see
    # UX_AUDIT_PI_LIVESHELF_FLAGS.md Flag 5. Decision deferred: keep
    # the loud visual break (intentional "you've left the app" signal)
    # OR migrate to extend _base.html for nav continuity. Both are
    # defensible per the audit.
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{_escape(title)}</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, sans-serif; margin: 24px; }}
  h1 {{ font-size: 20px; }}
  dl.meta {{ display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin-bottom: 16px; }}
  dl.meta dt {{ font-weight: bold; color: #555; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
  th, td {{ text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #ddd; }}
  pre {{ margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; }}
  code {{ font-family: ui-monospace, Menlo, Consolas, monospace; }}
</style>
</head><body>
<h1>{_escape(title)}</h1>
{back}
{header_html}
<p><strong>{count}</strong> lifecycle rows</p>
<table>
  <thead><tr><th>ts</th><th>actor</th><th>reason_code</th><th>payload</th></tr></thead>
  <tbody>{''.join(rows_html) or '<tr><td colspan="4">(no rows)</td></tr>'}</tbody>
</table>
</body></html>"""


__all__ = ["make_debug_bp"]
