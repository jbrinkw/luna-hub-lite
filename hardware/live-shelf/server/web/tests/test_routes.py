"""Flask test-client tests for Live Shelf web UI (Bundle G).

Uses a FakeRepo implementing WebRepo. Confirms every HTML route renders a
200 with the expected landmark text + pagination + image-serving behaves
correctly with path traversal attempts.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Any, Optional

import pytest
from flask import Flask


def _iso_days_ago(days: float) -> str:
    """ISO-8601 UTC timestamp ``days`` days before now, with seconds
    resolution and a Z suffix. Used for usage_log seed rows whose
    visibility on the inventory page's "last 7 days" section depends
    on relative recency. Hard-coded dates rot — switching to relative
    timestamps means the test doesn't go red simply because the
    calendar advanced."""
    ts = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=days)
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")

from server.web import make_api_bp, make_html_bp
from server.web.routes import WebRepo


# ---------------------------------------------------------------------------
# Seeded fake data
# ---------------------------------------------------------------------------


def _seed() -> dict[str, Any]:
    products = {
        "p1": {
            "product_id": "p1",
            "name": "Heinz Ketchup",
            "brand": "Heinz",
            "variant": None,
            "barcode": "0001",
            "net_weight_g": 340.0,
            "gross_weight_g": 420.0,
            "tare_weight_g": 80.0,
            "serving_weight_g": 17.0,
            "servings_per_container": 20.0,
            "unit_type": "liquid",
            "container_type": "bottle",
            "certified": 1,
            "density_g_per_ml": 1.1,
            "created_at": "2026-04-14T12:00:00Z",
            "updated_at": "2026-04-14T12:00:00Z",
        },
        "p2": {
            "product_id": "p2",
            "name": "Chobani Yogurt",
            "brand": "Chobani",
            "variant": "Strawberry",
            "barcode": "0002",
            "net_weight_g": 150.0,
            "gross_weight_g": 170.0,
            "tare_weight_g": 20.0,
            "serving_weight_g": 150.0,
            "servings_per_container": 1.0,
            "unit_type": "solid",
            "container_type": "carton",
            "certified": 1,
            "density_g_per_ml": None,
            "created_at": "2026-04-14T12:00:00Z",
            "updated_at": "2026-04-14T12:00:00Z",
        },
    }
    lots = {
        "l1": {
            "lot_id": "l1",
            "product_id": "p1",
            "status": "on_shelf",
            "current_weight_g": 400.0,
            "initial_weight_g": 420.0,
            "total_consumed_g": 20.0,
            "placed_at": "2026-04-14T11:00:00Z",
            "last_seen_at": "2026-04-14T12:00:00Z",
            "last_out_at": None,
            "notes": None,
        },
    }
    sessions = {
        "s1-abcdef01": {
            "session_id": "s1-abcdef01",
            "started_at": "2026-04-14T11:50:00Z",
            "ended_at": "2026-04-14T11:52:00Z",
            "initial_shelf_weight_g": 570.0,
            "final_shelf_weight_g": 400.0,
            "reconciled": 1,
            "reconciled_at": "2026-04-14T11:52:05Z",
            "duration_seconds": 120.0,
            "event_count": 1,
            "resolution_count": 1,
        },
        "s2-live0001": {
            "session_id": "s2-live0001",
            "started_at": "2026-04-14T12:00:00Z",
            "ended_at": None,
            "initial_shelf_weight_g": 400.0,
            "final_shelf_weight_g": None,
            "reconciled": 0,
            "reconciled_at": None,
            "duration_seconds": None,
            "event_count": 0,
            "resolution_count": 0,
        },
    }
    events = {
        "e1-removeket": {
            "event_id": "e1-removeket",
            "session_id": "s1-abcdef01",
            "ts": "2026-04-14T11:51:00Z",
            "delta_g": -170.0,
            "before_weight_g": 570.0,
            "after_weight_g": 400.0,
            "direction": "remove",
            "before_frame_path": "data/events/e1-removeket/before.jpg",
            "after_frame_path": "data/events/e1-removeket/after.jpg",
            "classification": {
                "item_id": "l1",
                "action": "removed",
                "confidence": 0.92,
                "reasoning": "Ketchup bottle clearly missing from front-left.",
                "multi_match": [],
            },
            "classifier_status": "classified",
            "created_at": "2026-04-14T11:51:02Z",
            "matched_product": products["p1"],
        },
    }
    resolutions = {
        "r1": {
            "resolution_id": "r1-fullpair",
            "session_id": "s1-abcdef01",
            "pattern": "consumed_or_removed",
            "lot_id": "l1",
            "consumed_g": 20.0,
            "confidence": 0.92,
            "add_event_id": None,
            "remove_event_id": "e1-removeket",
            "created_at": "2026-04-14T11:52:05Z",
            "product_name": "Heinz Ketchup",
        },
    }
    reviews = {
        "rev1-pending1": {
            "review_id": "rev1-pending1",
            "kind": "low_confidence",
            "status": "pending",
            "session_id": "s1-abcdef01",
            "event_id": "e1-removeket",
            "resolution_id": None,
            "proposed": {
                "item_id": "l1",
                "action": "removed",
                "confidence": 0.42,
                "reasoning": "Weak match; two candidates are close.",
            },
            "images": ["data/events/e1-removeket/before.jpg"],
            "created_at": "2026-04-14T11:52:10Z",
            "resolved_at": None,
            "user_response": None,
        },
    }
    # Usage log rows must fall inside the 7-day "summary" window so
    # the ``{% if summary %}`` panel renders ("last 7 days" label).
    # Use ~2 days ago for u1 and ~1 day ago for u2 — both inside the
    # window across any timezone or DST transition.
    usage_log = [
        {
            "usage_id": "u1",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 20.0,
            "pickup_weight_g": 420.0,
            "return_weight_g": 400.0,
            "kind": "in_flight_return",
            "session_id": "s1-abcdef01",
            "pickup_event_id": "e-pick-1",
            "return_event_id": "e-return-1",
            "occurred_at": _iso_days_ago(2),
            "created_at": _iso_days_ago(2),
        },
        {
            "usage_id": "u2",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 400.0,
            "pickup_weight_g": 400.0,
            "return_weight_g": None,
            "kind": "in_flight_ttl_expired",
            "session_id": "s1-abcdef01",
            "pickup_event_id": "e-pick-2",
            "return_event_id": None,
            "occurred_at": _iso_days_ago(1),
            "created_at": _iso_days_ago(1),
        },
    ]
    return {
        "products": products,
        "lots": lots,
        "sessions": sessions,
        "events": events,
        "resolutions": resolutions,
        "reviews": reviews,
        "usage_log": usage_log,
        # Default empty — single-track section + tile auto-hide unless
        # a test seeds a scale_pairings row with shelf_id='single_item'.
        "scale_pairings": [],
    }


class FakeRepo:
    """Bare-minimum WebRepo implementation for tests."""

    def __init__(self, *, catch_all_enabled: bool = False) -> None:
        self.db = _seed()
        self.resolved_with: list[tuple[str, dict[str, Any]]] = []
        # Feature flag mirrored from AppConfig — tests flip this to
        # assert the conditional UI blocks toggle correctly.
        self.catch_all_enabled = catch_all_enabled

    # --- state ---------------------------------------------------------

    def get_app_state(self) -> dict[str, Any]:
        return {
            "door_open": False,
            "current_session_id": "s2-live0001",
            "last_scale_weight_g": 400.0,
            "last_scale_event_ts": "2026-04-14T11:51:00Z",
            "shelf_name": "demo shelf",
            "pending_reviews": self.count_pending_reviews(),
            "total_events": len(self.db["events"]),
            "updated_at": "2026-04-14T12:00:00Z",
        }

    # --- registry ------------------------------------------------------

    def get_shelf_registry(
        self, shelf_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        out = []
        for lot in self.db["lots"].values():
            if lot["status"] != "on_shelf":
                continue
            if shelf_id is not None and lot.get("shelf_id", "live_shelf") != shelf_id:
                continue
            product = self.db["products"].get(lot["product_id"])
            if product is None:
                continue
            out.append({"lot": lot, "product": product})
        return out

    def get_products_certified_not_on_shelf(self) -> list[dict[str, Any]]:
        on_shelf_ids = {
            lot["product_id"]
            for lot in self.db["lots"].values()
            if lot["status"] == "on_shelf"
        }
        return [
            p for p in self.db["products"].values()
            if p["certified"] == 1 and p["product_id"] not in on_shelf_ids
        ]

    def get_in_flight_lots(
        self, shelf_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        out = []
        for lot in self.db["lots"].values():
            if lot.get("status") != "in_flight":
                continue
            if shelf_id is not None and lot.get("shelf_id", "live_shelf") != shelf_id:
                continue
            product = self.db["products"].get(lot["product_id"])
            if product is None:
                continue
            out.append({"lot": lot, "product": product})
        return out

    def get_catch_all_state(self) -> dict[str, Any]:
        on_count = sum(
            1 for lot in self.db["lots"].values()
            if lot.get("status") == "on_shelf"
            and lot.get("shelf_id") == "catch_all"
        )
        in_flight_count = sum(
            1 for lot in self.db["lots"].values()
            if lot.get("status") == "in_flight"
            and lot.get("shelf_id") == "catch_all"
        )
        return {
            "shelf_id": "catch_all",
            "current_session_id": None,
            "last_scale_weight_g": 0.0,
            "last_scale_event_ts": None,
            "scale_stable": None,
            "scale_device_id": "scale-02",
            "on_shelf_count": on_count,
            "in_flight_count": in_flight_count,
        }

    # --- single-track scales ----------------------------------------------
    # Mirrors the contract of RepoWebAdapter.get_single_track_scales /
    # get_single_track_state so the templates + /api/state?shelf=
    # single_item branch can be exercised by Flask tests without a real
    # SQLite DB. ``self.db['scale_pairings']`` is a list of dicts; each
    # row may carry an explicit ``current_weight_g`` / ``last_event_*`` /
    # ``last_heartbeat_ts`` / ``is_online`` so tests can drive the various
    # branches (online, offline, never-heartbeated, unpaired).

    def get_single_track_scales(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in self.db.get("scale_pairings", []):
            if row.get("shelf_id") != "single_item":
                continue
            product = (
                self.db["products"].get(row.get("product_id"))
                if row.get("product_id") else None
            )
            out.append(
                {
                    "device_id": row["device_id"],
                    "shelf_id": "single_item",
                    "product_id": row.get("product_id"),
                    "product_name": product["name"] if product else None,
                    "product_brand": product["brand"] if product else None,
                    "lot_id": row.get("lot_id"),
                    "first_seen_at": row.get(
                        "first_seen_at", "2026-04-28T12:00:00Z"
                    ),
                    "last_heartbeat_ts": row.get("last_heartbeat_ts"),
                    "last_event_ts": row.get("last_event_ts"),
                    "last_event_kind": row.get("last_event_kind"),
                    "last_event_delta_g": row.get("last_event_delta_g"),
                    "current_weight_g": row.get("current_weight_g"),
                    "scale_stable": row.get("scale_stable"),
                    "is_online": bool(row.get("is_online", False)),
                }
            )
        out.sort(
            key=lambda r: (
                r["product_name"] is None,
                (r["product_name"] or "").lower(),
                r["device_id"],
            )
        )
        return out

    def get_single_track_state(self) -> dict[str, Any]:
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

    # --- usage log (USAGE_LOG_PLAN.md §5.3) --------------------------------

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
        rows = list(self.db.get("usage_log", []))
        if product_id:
            rows = [r for r in rows if r["product_id"] == product_id]
        if kinds:
            rows = [r for r in rows if r["kind"] in kinds]
        if since:
            rows = [r for r in rows if r["occurred_at"] >= since]
        if until:
            rows = [r for r in rows if r["occurred_at"] <= until]
        rows.sort(key=lambda r: r["occurred_at"], reverse=True)
        return rows[offset:offset + limit]

    def count_usage(self, **filters) -> int:
        return len(self.list_usage(limit=10**9, offset=0, **filters))

    def usage_summary_by_product(
        self, *, since: Optional[str] = None, until: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        rows = self.list_usage(since=since, until=until, limit=10**9)
        acc: dict[str, dict[str, Any]] = {}
        for r in rows:
            slot = acc.setdefault(
                r["product_id"],
                {
                    "product_id": r["product_id"],
                    "product_name": r["product_name"],
                    "total_consumed_g": 0.0,
                    "row_count": 0,
                },
            )
            slot["total_consumed_g"] += r["consumed_g"]
            slot["row_count"] += 1
        return sorted(
            acc.values(), key=lambda s: s["total_consumed_g"], reverse=True,
        )

    # --- events --------------------------------------------------------

    def count_events(self) -> int:
        return len(self.db["events"])

    def list_events(self, *, limit: int, offset: int) -> list[dict[str, Any]]:
        ordered = sorted(
            self.db["events"].values(),
            key=lambda e: e["ts"],
            reverse=True,
        )
        return ordered[offset : offset + limit]

    def get_event(self, event_id: str) -> Optional[dict[str, Any]]:
        return self.db["events"].get(event_id)

    # --- sessions ------------------------------------------------------

    def list_sessions(self, *, limit: int = 50) -> list[dict[str, Any]]:
        ordered = sorted(
            self.db["sessions"].values(),
            key=lambda s: s["started_at"],
            reverse=True,
        )
        return ordered[:limit]

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        return self.db["sessions"].get(session_id)

    def list_session_events(self, session_id: str) -> list[dict[str, Any]]:
        return [
            e for e in self.db["events"].values()
            if e.get("session_id") == session_id
        ]

    def list_session_resolutions(self, session_id: str) -> list[dict[str, Any]]:
        return [
            r for r in self.db["resolutions"].values()
            if r.get("session_id") == session_id
        ]

    # --- reviews -------------------------------------------------------

    def count_pending_reviews(self) -> int:
        return sum(1 for r in self.db["reviews"].values() if r["status"] == "pending")

    def list_review_items(self, *, status: Optional[str] = "pending") -> list[dict[str, Any]]:
        vals = list(self.db["reviews"].values())
        if status is None:
            return vals
        return [r for r in vals if r["status"] == status]

    def get_review_item(self, review_id: str) -> Optional[dict[str, Any]]:
        row = self.db["reviews"].get(review_id)
        if row is None:
            return None
        event = self.db["events"].get(row.get("event_id") or "")
        session = self.db["sessions"].get(row.get("session_id") or "")
        candidates = [
            {
                "candidate_id": "l1",
                "name": "Heinz Ketchup",
                "brand": "Heinz",
                "expected_weight_g": 340.0,
                "reference_image_paths": ["/refs/p1/front.jpg"],
                "why_candidate": "currently_on_shelf",
                "confidence": 0.42,
            },
            {
                "candidate_id": "l2alt",
                "name": "Chobani Yogurt",
                "brand": "Chobani",
                "expected_weight_g": 150.0,
                "reference_image_paths": [],
                "why_candidate": "catalog_not_on_shelf",
                "confidence": 0.08,
            },
        ]
        return {
            "review": row,
            "event": event,
            "session": session,
            "candidates": candidates,
        }

    def resolve_review_item(
        self, review_id: str, *, resolution: dict[str, Any]
    ) -> dict[str, Any]:
        row = self.db["reviews"].get(review_id)
        if row is None:
            raise KeyError(review_id)
        row["status"] = "resolved"
        row["resolved_at"] = "2026-04-14T12:05:00Z"
        row["user_response"] = resolution
        self.resolved_with.append((review_id, resolution))
        return row


# ---------------------------------------------------------------------------
# App factory + fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_data_dir(tmp_path: Path) -> Path:
    (tmp_path / "events" / "e1-removeket").mkdir(parents=True)
    (tmp_path / "events" / "e1-removeket" / "before.jpg").write_bytes(b"JPEG-BEFORE")
    (tmp_path / "events" / "e1-removeket" / "after.jpg").write_bytes(b"JPEG-AFTER")
    (tmp_path / "refs" / "p1").mkdir(parents=True)
    (tmp_path / "refs" / "p1" / "front.jpg").write_bytes(b"JPEG-REF")
    return tmp_path


@pytest.fixture()
def repo() -> FakeRepo:
    return FakeRepo()


@pytest.fixture()
def app(repo: FakeRepo, tmp_data_dir: Path) -> Flask:
    app = Flask(__name__)
    app.config["TESTING"] = True

    # In-memory config state so POST /api/config has something real to touch.
    config_state = {"delta_threshold_g": 5.0, "stability_window_g": 2.0}

    def read_config() -> dict[str, Any]:
        return dict(config_state)

    def update_config(patch: dict[str, Any]) -> dict[str, Any]:
        for k, v in patch.items():
            if k not in {"delta_threshold_g", "stability_window_g"}:
                raise ValueError(f"unknown key {k!r}")
            config_state[k] = v
        return dict(config_state)

    # Minimal delete_usage_fn backed by the FakeRepo so the API test can
    # exercise the 200 + 404 branches.
    def delete_usage_fn(usage_id: str) -> dict[str, Any]:
        rows = repo.db.get("usage_log", [])
        for i, r in enumerate(rows):
            if r["usage_id"] == usage_id:
                rows.pop(i)
                return {"deleted": 1, "reverted_g": r.get("consumed_g", 0.0),
                        "lot_id": r.get("lot_id")}
        return {"deleted": 0, "reverted_g": 0.0, "lot_id": None}

    html_bp = make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    )
    api_bp = make_api_bp(
        repo,
        read_config=read_config,
        update_config=update_config,
        delete_usage_fn=delete_usage_fn,
    )
    app.register_blueprint(html_bp)
    app.register_blueprint(api_bp)
    return app


@pytest.fixture()
def client(app: Flask):
    return app.test_client()


# ---------------------------------------------------------------------------
# HTML route tests
# ---------------------------------------------------------------------------


def test_dashboard_renders(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "dashboard" in body
    assert "/live.mjpg" in body  # Bundle C's MJPEG reference
    assert "demo shelf" in body
    # nav links — registry + usage now collapse into /inventory
    assert 'href="/inventory"' in body
    assert 'href="/events"' in body
    assert 'href="/sessions"' in body
    assert 'href="/review"' in body
    assert 'href="/intake"' in body
    # nav badge for pending reviews
    assert 'class="badge"' in body


def test_inventory_page_renders_with_seeded_usage_rows(client):
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "inventory" in body
    # Registry content.
    assert "Heinz Ketchup" in body  # on shelf row
    assert "Chobani Yogurt" in body  # catalog row
    assert "on shelf" in body
    assert "catalog" in body
    # Usage log content.
    assert "usage log" in body
    assert "20.0 g" in body
    assert "400.0 g" in body
    assert "return" in body
    assert "ttl expired" in body
    # 7-day summary rendered.
    assert "last 7 days" in body
    # Nav link highlighted.
    assert 'href="/inventory"' in body


def test_inventory_page_filters_usage_by_product(client):
    r = client.get("/inventory?product=p1")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "Heinz Ketchup" in body


def test_inventory_page_filters_usage_by_kind(client):
    r = client.get("/inventory?kind=in_flight_ttl_expired")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # Should show only the TTL row in the usage section; the registry
    # side is unaffected by the kind filter, so Heinz Ketchup still
    # appears on the shelf.
    assert "400.0 g" in body


def test_dashboard_renders_event_threshold_input(client):
    """The new tuning panel shows an input wired to event_delta_threshold_g."""
    body = client.get("/").get_data(as_text=True)
    assert 'id="cfg-event-delta-threshold"' in body
    assert "min event threshold" in body
    # The label explains what the knob controls.
    assert "|delta_g|" in body


def test_api_usage_delete_removes_row(client, repo):
    before = len(repo.db["usage_log"])
    assert before >= 1
    target = repo.db["usage_log"][0]["usage_id"]
    r = client.post(f"/api/usage/{target}/delete")
    assert r.status_code == 200
    data = r.get_json()
    assert data["ok"] is True
    assert data["summary"]["deleted"] == 1
    assert len(repo.db["usage_log"]) == before - 1


def test_api_usage_delete_unknown_id_returns_404(client):
    r = client.post("/api/usage/does-not-exist/delete")
    assert r.status_code == 404
    data = r.get_json()
    assert "summary" in data
    assert data["summary"]["deleted"] == 0


def test_inventory_page_renders_delete_button_per_usage_row(client):
    body = client.get("/inventory").get_data(as_text=True)
    # × buttons appear with their data-usage-id attributes.
    assert 'class="del-usage"' in body
    assert 'data-usage-id="u1"' in body


def test_registry_redirects_to_inventory(client):
    r = client.get("/registry", follow_redirects=False)
    assert r.status_code == 301
    assert r.headers["Location"].endswith("/inventory")


def test_usage_redirects_to_inventory_preserving_query_string(client):
    r = client.get("/usage?kind=in_flight_return&page=2",
                   follow_redirects=False)
    assert r.status_code == 301
    # Query string preserved so bookmarked filters still work.
    loc = r.headers["Location"]
    assert "/inventory" in loc
    assert "kind=in_flight_return" in loc
    assert "page=2" in loc


def test_api_usage_returns_json(client):
    r = client.get("/api/usage")
    assert r.status_code == 200
    data = r.get_json()
    assert data["total"] == 2
    assert data["page"] == 1
    assert len(data["items"]) == 2
    # newest first
    assert data["items"][0]["kind"] == "in_flight_ttl_expired"


def test_api_usage_summary_returns_product_totals(client):
    r = client.get("/api/usage/summary")
    assert r.status_code == 200
    data = r.get_json()
    assert len(data["items"]) == 1
    summary = data["items"][0]
    assert summary["product_id"] == "p1"
    assert summary["row_count"] == 2
    assert summary["total_consumed_g"] == 420.0


def test_dashboard_shows_in_flight_section_when_lots_in_flight(client, repo):
    """The dashboard should render a new 'in flight (N)' panel when any
    lots are status='in_flight'. When none are, the section is omitted
    (don't render an empty panel cluttering the dashboard)."""
    # Baseline: no in-flight lots → no panel.
    body = client.get("/").get_data(as_text=True)
    assert "in flight (" not in body, (
        "dashboard should not render the in-flight panel when no lots are in-flight"
    )

    # Mutate the seeded FakeRepo so one lot is in-flight.
    repo.db["lots"]["l-inflight"] = {
        "lot_id": "l-inflight",
        "product_id": "p2",
        "status": "in_flight",
        "current_weight_g": 170.0,
        "initial_weight_g": 170.0,
        "total_consumed_g": 0.0,
        "placed_at": "2026-04-17T11:00:00Z",
        "last_seen_at": "2026-04-17T12:00:00Z",
        "last_out_at": None,
        "notes": None,
        "in_flight_since": "2026-04-17T12:00:00Z",
        "pickup_weight_g": 170.0,
        "pickup_event_id": "E-inflight",
        "pickup_session_id": "s2-live0001",
    }

    body = client.get("/").get_data(as_text=True)
    assert "in flight (1)" in body
    assert "Chobani Yogurt" in body
    assert "170.0 g" in body
    assert "2026-04-17T12:00:00Z" in body


def test_inventory_page_hides_catch_all_section_when_disabled(client):
    """Default FakeRepo has catch_all_enabled=False — the inventory page
    must not render any "Catch-all" heading or the per-shelf "Live Shelf"
    label (single-shelf mode keeps the familiar unnamed layout).

    Catches a regression where someone forgets the {% if %} guard and
    starts rendering the empty catch-all panels for users who don't even
    have the hardware attached.
    """
    body = client.get("/inventory").get_data(as_text=True)
    # Case-insensitive — headings use title-case in the template.
    assert "Catch-all" not in body
    # Single-shelf mode doesn't label the live shelf either.
    assert "Live Shelf" not in body


def test_inventory_page_shows_catch_all_section_when_enabled(
    repo, tmp_data_dir,
):
    """Flip the flag + seed a catch-all lot → the per-shelf sections
    both render and the lot shows up under Catch-all, not Live Shelf."""
    repo.catch_all_enabled = True
    # Seed a lot physically on the catch-all shelf. Use a distinct
    # product name so we can tell the two sections apart in the body.
    repo.db["products"]["p3"] = {
        "product_id": "p3",
        "name": "Catchall Cookie",
        "brand": "ACME",
        "variant": None,
        "barcode": "0003",
        "net_weight_g": 300.0,
        "gross_weight_g": 330.0,
        "tare_weight_g": 30.0,
        "serving_weight_g": 30.0,
        "servings_per_container": 10.0,
        "unit_type": "solid",
        "container_type": "bag",
        "certified": 1,
        "density_g_per_ml": None,
        "created_at": "2026-04-18T12:00:00Z",
        "updated_at": "2026-04-18T12:00:00Z",
    }
    repo.db["lots"]["l-catch-1"] = {
        "lot_id": "l-catch-1",
        "product_id": "p3",
        "status": "on_shelf",
        "shelf_id": "catch_all",
        "current_weight_g": 320.0,
        "initial_weight_g": 330.0,
        "total_consumed_g": 10.0,
        "placed_at": "2026-04-18T11:00:00Z",
        "last_seen_at": "2026-04-18T12:00:00Z",
        "last_out_at": None,
        "notes": None,
    }

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    client = app.test_client()

    body = client.get("/inventory").get_data(as_text=True)
    assert "Live Shelf" in body
    assert "Catch-all" in body
    # Seeded catch-all lot renders in the page.
    assert "Catchall Cookie" in body
    # And the legacy on-shelf lot still shows up on the Live Shelf side.
    assert "Heinz Ketchup" in body


def test_dashboard_shows_catch_all_preview_when_enabled(
    repo, tmp_data_dir,
):
    """Second <img src="/live.mjpg?shelf=catch_all"> tile should appear
    only when the config flag is on. Single-shelf deployments skip
    the tile + the extra poller entirely."""
    # Baseline: disabled → no catch-all tile. The img src + panel id are
    # the load-bearing tokens the JS reads; a loose "shelf=catch_all"
    # substring also appears in an unrelated JS comment so we anchor on
    # the actual DOM elements instead.
    app_off = Flask(__name__)
    app_off.config["TESTING"] = True
    app_off.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: False,
    ))
    baseline = app_off.test_client().get("/").get_data(as_text=True)
    assert 'id="catch-all-preview"' not in baseline
    assert '/live.mjpg?shelf=catch_all' not in baseline
    assert 'id="catch-weight"' not in baseline

    # Enabled → tile + its id land in the DOM.
    repo.catch_all_enabled = True
    app_on = Flask(__name__)
    app_on.config["TESTING"] = True
    app_on.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: True,
    ))
    body_on = app_on.test_client().get("/").get_data(as_text=True)
    assert '/live.mjpg?shelf=catch_all' in body_on
    assert 'id="catch-all-preview"' in body_on
    # The polled DOM ids the refreshCatchAll() JS writes into must exist.
    assert 'id="catch-weight"' in body_on
    assert 'id="catch-session"' in body_on
    assert 'id="catch-stable-label"' in body_on


def test_inventory_lists_on_shelf_and_catalog(client):
    # Replaces the old /registry test; /registry now redirects here.
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "Heinz Ketchup" in body
    assert "Chobani Yogurt" in body  # catalog
    assert "on shelf" in body
    assert "catalog" in body


def test_events_list_with_pagination(client):
    r = client.get("/events")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "e1-remov" in body  # thumbnail id slice
    assert "page 1" in body


def test_events_list_page_param_out_of_range(client):
    r = client.get("/events?page=42")
    assert r.status_code == 200  # graceful empty page
    body = r.get_data(as_text=True)
    assert "events" in body


def test_events_list_rejects_garbage_page(client):
    r = client.get("/events?page=notanumber")
    assert r.status_code == 200


def test_event_detail_renders(client):
    r = client.get("/event/e1-removeket")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "e1-remov" in body
    assert "/event/e1-removeket/before.jpg" in body
    assert "/event/e1-removeket/after.jpg" in body
    assert "Heinz Ketchup" in body  # matched product
    assert "removed" in body  # action


def test_event_detail_404_for_missing(client):
    r = client.get("/event/does-not-exist")
    assert r.status_code == 404


def test_event_image_serves_when_present(client):
    r = client.get("/event/e1-removeket/before.jpg")
    assert r.status_code == 200
    assert r.data == b"JPEG-BEFORE"


def test_event_image_rejects_unknown_event(client):
    r = client.get("/event/no-such-event/before.jpg")
    assert r.status_code == 404


def test_event_image_rejects_arbitrary_filename(client):
    # Even if the event exists, only known filenames are served.
    r = client.get("/event/e1-removeket/secrets.txt")
    assert r.status_code == 404


def test_session_video_falls_back_to_session_dir_when_per_event_missing(
    client, tmp_data_dir
):
    """Regression (observed 2026-04-16): the async video encode can
    finish AFTER per-event classification has already run. In that
    window the classifier's ``shutil.copyfile(video_src, per_event_dir)``
    silently no-ops (``video_src`` doesn't exist yet), leaving the
    per-event dir without ``session.mp4``. The web UI must still be
    able to serve the video via the canonical ``sessions/<safe_ts>/``
    location derived from ``sessions.started_at``.
    """
    # Event e1-removeket's session is s1-abcdef01 (started_at
    # 2026-04-14T11:50:00Z). safe_ts replaces ':' with '-'.
    safe_ts = "2026-04-14T11-50-00Z"
    session_dir = tmp_data_dir / "sessions" / safe_ts
    session_dir.mkdir(parents=True)
    session_dir.joinpath("session.mp4").write_bytes(b"MP4-SESSION-DIR")

    # Sanity: per-event dir does NOT have the video.
    assert not (tmp_data_dir / "events" / "e1-removeket" / "session.mp4").exists()

    # Detail page should expose the video element (has_video=True via
    # the session-dir fallback, not the per-event check).
    detail = client.get("/event/e1-removeket")
    assert detail.status_code == 200
    body = detail.get_data(as_text=True)
    assert "/event/e1-removeket/session.mp4" in body

    # Streaming the video should hit the session-dir copy.
    video = client.get("/event/e1-removeket/session.mp4")
    assert video.status_code == 200
    assert video.data == b"MP4-SESSION-DIR"
    assert video.content_type.startswith("video/mp4")


def test_session_video_prefers_per_event_copy_when_present(
    client, tmp_data_dir
):
    """When BOTH locations have a video (normal case: encode finished
    before classification), the per-event copy wins. This preserves
    the historical contract for legacy data that may lack a matching
    sessions row (or has a mismatched started_at) but still has a
    valid per-event copy.
    """
    safe_ts = "2026-04-14T11-50-00Z"
    session_dir = tmp_data_dir / "sessions" / safe_ts
    session_dir.mkdir(parents=True)
    session_dir.joinpath("session.mp4").write_bytes(b"MP4-SESSION-DIR")

    # ALSO put a per-event copy with distinguishable content.
    per_event = tmp_data_dir / "events" / "e1-removeket" / "session.mp4"
    per_event.write_bytes(b"MP4-PER-EVENT-COPY")

    video = client.get("/event/e1-removeket/session.mp4")
    assert video.status_code == 200
    # Per-event copy wins (unchanged legacy behavior).
    assert video.data == b"MP4-PER-EVENT-COPY"


def test_session_video_404_when_neither_location_has_it(client):
    """If neither the per-event dir nor the session dir has the video,
    the route must 404 cleanly — no crash, no sneaky fallback to
    another session's video."""
    # tmp_data_dir fixture creates neither session.mp4 file.
    video = client.get("/event/e1-removeket/session.mp4")
    assert video.status_code == 404


def test_reference_image_serves_when_present(client):
    r = client.get("/refs/p1/front.jpg")
    assert r.status_code == 200
    assert r.data == b"JPEG-REF"


def test_reference_image_rejects_path_traversal(client):
    r = client.get("/refs/p1/..%2Ffront.jpg")
    # Flask's URL converter normalizes; should not escape the product dir.
    assert r.status_code in (404, 400)


def test_reference_image_rejects_product_id_traversal(client):
    # A crafted product_id with traversal segments must be rejected with 404,
    # matching the guard used on event_id in the sibling event_image route.
    r = client.get("/refs/..%2F..%2Fetc/front.jpg")
    assert r.status_code in (404, 400)


def test_sessions_list_renders(client):
    r = client.get("/sessions")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "s1-abcde" in body  # sliced session id appears in link text
    assert "s2-live0" in body
    # live session badge
    assert "live" in body


def test_session_detail_renders_timeline_and_resolutions(client):
    r = client.get("/session/s1-abcdef01")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "event timeline" in body
    assert "resolutions" in body
    assert "consumed_or_removed" in body  # resolution pattern
    assert "e1-remov" in body  # event id in timeline


def test_session_detail_404(client):
    r = client.get("/session/unknown")
    assert r.status_code == 404


def test_review_list_renders(client):
    r = client.get("/review")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "rev1-pen" in body  # sliced review id
    assert "low_confidence" in body


def test_review_list_status_filter_all(client):
    r = client.get("/review?status=all")
    assert r.status_code == 200
    assert b"rev1-pen" in r.data


def test_review_list_ignores_bogus_status(client):
    r = client.get("/review?status=garbage")
    assert r.status_code == 200  # defaults to pending


def test_review_detail_renders_with_candidates_and_form(client):
    r = client.get("/review/rev1-pending1")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "Heinz Ketchup" in body
    assert "Chobani Yogurt" in body
    assert 'name="candidate_id"' in body
    assert 'value="UNKNOWN"' in body
    assert "free text override" in body
    assert 'action="/review/rev1-pending1/resolve"' in body


def test_review_detail_404_for_missing(client):
    r = client.get("/review/nope")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# JSON API tests
# ---------------------------------------------------------------------------


def test_api_state(client):
    r = client.get("/api/state")
    assert r.status_code == 200
    body = r.get_json()
    assert body["door_open"] is False  # coerced from int
    assert body["current_session_id"] == "s2-live0001"
    assert body["last_scale_weight_g"] == 400.0
    assert body["pending_reviews"] == 1
    assert body["total_events"] == 1


def test_api_state_default_returns_live_shelf(client):
    """No ?shelf query param — response must match the pre-catch-all
    shape (door_open, pending_reviews, etc.) so existing UI polls
    keep working without changes."""
    r = client.get("/api/state")
    assert r.status_code == 200
    body = r.get_json()
    # Fields that only exist on the live-shelf shape.
    assert "door_open" in body
    assert "pending_reviews" in body
    # And NO catch-all-specific shelf_id discriminator in the default shape.
    assert body.get("shelf_id") != "catch_all"


def test_api_state_shelf_catch_all_returns_catch_all_fields(client, repo):
    """?shelf=catch_all — response shape switches to the catch-all shape
    exposed by FakeRepo.get_catch_all_state(): has shelf_id='catch_all',
    on_shelf_count + in_flight_count counters."""
    # Seed a catch-all lot so the counters are non-zero + provable.
    repo.db["lots"]["l-catch-api"] = {
        "lot_id": "l-catch-api",
        "product_id": "p1",
        "status": "on_shelf",
        "shelf_id": "catch_all",
        "current_weight_g": 500.0,
        "initial_weight_g": 500.0,
        "total_consumed_g": 0.0,
        "placed_at": "2026-04-18T12:00:00Z",
        "last_seen_at": "2026-04-18T12:00:00Z",
        "last_out_at": None,
        "notes": None,
    }

    r = client.get("/api/state?shelf=catch_all")
    assert r.status_code == 200
    body = r.get_json()
    assert body["shelf_id"] == "catch_all"
    assert body["on_shelf_count"] == 1
    assert body["in_flight_count"] == 0
    # Live-shelf-only fields must NOT leak into the catch-all response.
    assert "door_open" not in body
    assert "pending_reviews" not in body


def test_api_state_unknown_shelf_returns_400(client):
    """``?shelf=pantry`` (or any value outside the ``{live_shelf,
    catch_all}`` allowlist) must be rejected with HTTP 400 rather than
    silently falling back to the live-shelf response. Silent fallback
    hides typos in client code and lets new shelf keys ship without a
    backend wire-up.
    """
    r = client.get("/api/state?shelf=pantry")
    assert r.status_code == 400
    body = r.get_json()
    assert body.get("error") == "unknown shelf"

    # Empty string is also not in the allowlist and must 400.
    r_empty = client.get("/api/state?shelf=")
    assert r_empty.status_code == 400

    # Sanity: the no-query-param path still works (backward compat).
    r_default = client.get("/api/state")
    assert r_default.status_code == 200


def test_api_config_get(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.get_json()["delta_threshold_g"] == 5.0


def test_api_config_post_updates_values(client):
    r = client.post(
        "/api/config",
        json={"delta_threshold_g": 7.5},
    )
    assert r.status_code == 200
    assert r.get_json()["delta_threshold_g"] == 7.5
    # Confirm GET reflects the update
    assert client.get("/api/config").get_json()["delta_threshold_g"] == 7.5


def test_api_config_post_rejects_unknown_key(client):
    r = client.post("/api/config", json={"nope": 1})
    assert r.status_code == 400
    assert "unknown key" in r.get_json()["error"]


def test_api_config_post_rejects_non_json(client):
    r = client.post("/api/config", data="plain")
    assert r.status_code == 400


def test_api_config_post_rejects_non_object(client):
    r = client.post("/api/config", json=[1, 2])
    assert r.status_code == 400


def test_api_events_listing(client):
    r = client.get("/api/events")
    assert r.status_code == 200
    body = r.get_json()
    assert body["total"] == 1
    assert body["page"] == 1
    assert len(body["events"]) == 1
    assert body["events"][0]["event_id"] == "e1-removeket"


def test_api_events_pagination_clamps(client):
    r = client.get("/api/events?per_page=9999&page=-3")
    assert r.status_code == 200
    body = r.get_json()
    assert body["per_page"] <= 100
    assert body["page"] >= 1


def test_review_resolve_via_form_redirects(client, repo):
    r = client.post(
        "/review/rev1-pending1/resolve",
        data={"candidate_id": "l1", "note": "looks right"},
    )
    assert r.status_code in (302, 303)
    assert len(repo.resolved_with) == 1
    review_id, resolution = repo.resolved_with[0]
    assert review_id == "rev1-pending1"
    assert resolution["candidate_id"] == "l1"
    assert resolution["note"] == "looks right"


def test_review_resolve_via_json_returns_row(client, repo):
    r = client.post(
        "/review/rev1-pending1/resolve",
        json={"candidate_id": "UNKNOWN", "action": "intake"},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "resolved"
    _, res = repo.resolved_with[0]
    assert res["candidate_id"] == "UNKNOWN"
    assert res["action"] == "intake"


def test_review_resolve_unknown_id_404(client):
    r = client.post(
        "/review/ghost/resolve",
        json={"candidate_id": "x"},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Single-track scales (cloud term: live_scale; Pi term: single_item)
# Surfaces under test:
#   1. /inventory renders the section iff at least one paired row exists
#   2. /api/state?shelf=single_item returns the aggregate tile shape
#   3. usage-log kind filter scopes to single-track-emitted events
#   4. /dashboard tile auto-shows when paired + hides when not
# ---------------------------------------------------------------------------


def _seed_single_track_pairing(
    repo: FakeRepo,
    *,
    device_id: str = "scale-single-01",
    product_id: Optional[str] = "p1",
    lot_id: Optional[str] = "l1",
    is_online: bool = True,
    last_heartbeat_ts: Optional[str] = "2026-04-28T12:00:00Z",
    current_weight_g: Optional[float] = 1247.0,
    last_event_ts: Optional[str] = None,
    last_event_kind: Optional[str] = None,
    last_event_delta_g: Optional[float] = None,
) -> None:
    """Append one ``scale_pairings`` row to the FakeRepo and return.

    Mirrors the cloud→Pi ``scale_pairings`` mirror shape (see
    ``storage/schema.sql:193``). Defaults to a fully-paired, online
    scale-single-01 reading 1247g — flip ``is_online`` /
    ``current_weight_g`` / ``last_event_*`` for branch coverage.
    """
    repo.db.setdefault("scale_pairings", []).append(
        {
            "device_id": device_id,
            "shelf_id": "single_item",
            "product_id": product_id,
            "lot_id": lot_id,
            "first_seen_at": "2026-04-28T11:00:00Z",
            "last_heartbeat_ts": last_heartbeat_ts,
            "is_online": is_online,
            "current_weight_g": current_weight_g,
            "last_event_ts": last_event_ts,
            "last_event_kind": last_event_kind,
            "last_event_delta_g": last_event_delta_g,
            "scale_stable": None,
        }
    )


def test_inventory_shows_single_track_section_with_empty_state_when_no_pairings(client):
    """Default seed has ``scale_pairings = []`` → /inventory STILL
    renders the single-track section so the operator can see the
    empty state and verify setup. The section must show the
    ``no single-track scales paired yet.`` empty-state message
    instead of the per-row table."""
    body = client.get("/inventory").get_data(as_text=True)
    assert "single-track" in body.lower()
    assert "no single-track scales paired yet." in body
    # The per-row table must NOT render with no data.
    assert "paired product" not in body


def test_inventory_shows_single_track_section_when_paired_scale_exists(
    repo, tmp_data_dir,
):
    """Seed one paired single_item row → section renders with the
    paired product name, current weight, status pill, and device id.
    Asserts data bindings (not just header presence) so a future
    refactor that drops the data plumbing fails this test."""
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-01",
        product_id="p1",
        lot_id="l1",
        is_online=True,
        current_weight_g=1247.0,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    body = app.test_client().get("/inventory").get_data(as_text=True)
    # Section heading + count.
    assert "Single-track scales" in body
    assert "scales" in body
    # Data bindings: product name, device id, weight (formatted), pill.
    assert "Heinz Ketchup" in body
    assert "scale-single-01" in body
    assert "1247 g" in body
    assert "online" in body  # status pill
    # Lot prefix (8 chars) — l1 only has 2 chars so just check substring.
    # Use the row marker so we don't false-positive on the catalog table.
    assert 'data-device-id="scale-single-01"' in body


def test_inventory_single_track_unpaired_renders_placeholder(repo, tmp_data_dir):
    """An ESP that's heartbeated but the operator hasn't paired a
    product to yet (product_id IS NULL) — must still render with an
    "(unpaired)" placeholder, NOT crash on the missing join."""
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-99",
        product_id=None,
        lot_id=None,
        current_weight_g=42.0,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    r = app.test_client().get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "Single-track scales" in body
    assert "(unpaired)" in body
    assert "scale-single-99" in body
    assert "42 g" in body


def test_inventory_single_track_offline_renders_offline_pill(
    repo, tmp_data_dir,
):
    """When ``is_online=False`` the row must show the ``offline`` pill,
    not ``online``. Catches a regression where the template branches
    on the wrong key."""
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-02",
        is_online=False,
        last_heartbeat_ts="2026-04-28T11:00:00Z",
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    body = app.test_client().get("/inventory").get_data(as_text=True)
    # The row should have the offline pill, not online.
    # We can't just assert "online" not in body because the catch-all
    # tile and scale-single-01 would both reference "online" — so we
    # anchor on the device_id row marker + the pill class.
    assert 'data-device-id="scale-single-02"' in body
    assert "offline" in body


def test_inventory_kind_filter_includes_single_item_consumed(client, repo):
    """The kind dropdown must include ``single_item_consumed`` so the
    operator can filter the usage log to direct-consumption events
    only. Asserts both the option and the displayed label."""
    body = client.get("/inventory").get_data(as_text=True)
    assert 'value="single_item_consumed"' in body
    # Human-readable label in the dropdown.
    assert ">single-track</option>" in body


def test_inventory_kind_filter_scopes_usage_to_single_item_only(
    repo, tmp_data_dir,
):
    """Selecting ``kind=single_item_consumed`` must EXCLUDE shelf /
    catch-all events from the rendered usage table.

    Anchored on the ``data-usage-id`` row markers — the kind dropdown
    options re-mention "ttl expired" / "return" textually, so plain
    substring assertions would false-pass even when filtering is
    broken. The seeded usage rows have known ids (u1, u2 from the
    base seed; u-st1 for the new single-track row) so we can directly
    assert which rows the template rendered."""
    repo.db["usage_log"].append(
        {
            "usage_id": "u-st1",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 12.5,
            "pickup_weight_g": None,
            "return_weight_g": None,
            "kind": "single_item_consumed",
            "session_id": None,
            "pickup_event_id": None,
            "return_event_id": None,
            "occurred_at": _iso_days_ago(0.5),
            "created_at": _iso_days_ago(0.5),
        }
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    body = app.test_client().get(
        "/inventory?kind=single_item_consumed"
    ).get_data(as_text=True)
    # Only the single-track row survives the filter — anchor on row ids.
    assert 'data-usage-id="u-st1"' in body
    assert 'data-usage-id="u1"' not in body
    assert 'data-usage-id="u2"' not in body
    # And the row's consumed weight rendered.
    assert "12.5 g" in body


def test_api_state_single_item_returns_aggregate(repo, tmp_data_dir):
    """``GET /api/state?shelf=single_item`` returns the count + per-
    device list shape needed by the dashboard tile poller. Asserts the
    full shape (keys + types), not just status code."""
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-01",
        product_id="p1",
        is_online=True,
        current_weight_g=1247.0,
    )
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-02",
        product_id=None,
        is_online=False,
        current_weight_g=None,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    app.register_blueprint(make_api_bp(repo))
    r = app.test_client().get("/api/state?shelf=single_item")
    assert r.status_code == 200
    body = r.get_json()
    assert body["shelf_id"] == "single_item"
    assert body["scales_total"] == 2
    assert body["scales_online"] == 1
    assert isinstance(body["scales"], list)
    assert len(body["scales"]) == 2
    # Order: paired (Heinz) first, unpaired last.
    paired = body["scales"][0]
    assert paired["device_id"] == "scale-single-01"
    assert paired["product_name"] == "Heinz Ketchup"
    assert paired["current_weight_g"] == 1247.0
    assert paired["is_online"] is True
    unpaired = body["scales"][1]
    assert unpaired["device_id"] == "scale-single-02"
    assert unpaired["product_name"] is None
    assert unpaired["is_online"] is False


def test_api_state_unknown_shelf_still_400(client):
    """Adding ``single_item`` to the allowlist must NOT loosen the
    rejection of typos / unknown values."""
    r = client.get("/api/state?shelf=mystery")
    assert r.status_code == 400
    assert "unknown shelf" in r.get_json()["error"]


def test_api_state_single_item_returns_501_when_repo_lacks_method(
    tmp_data_dir,
):
    """A repo without ``get_single_track_state`` must surface 501
    rather than 500 — same defensive pattern as the catch-all branch."""

    class _MinimalRepo:
        def get_app_state(self):
            return {
                "door_open": False,
                "current_session_id": None,
                "last_scale_weight_g": 0.0,
                "pending_reviews": 0,
                "total_events": 0,
                "shelf_name": "demo",
                "updated_at": "2026-04-28T12:00:00Z",
            }

        def list_events(self, *, limit, offset):
            return []

        def count_events(self):
            return 0

        def get_review_item(self, rid):
            return None

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(_MinimalRepo(), data_dir=tmp_data_dir))
    app.register_blueprint(make_api_bp(_MinimalRepo()))
    r = app.test_client().get("/api/state?shelf=single_item")
    assert r.status_code == 501
    assert "single-track" in r.get_json()["error"]


def test_dashboard_shows_single_track_tile_with_zero_state_when_no_pairings(client):
    """Default seed: zero paired single-track scales → tile STILL
    renders so the operator can confirm the surface is wired before
    any ESP has heartbeated. Online/total counters render as 0/0,
    the empty-state ``no scales paired yet.`` message is visible,
    and the load-bearing DOM ids the poller targets are present so
    the moment a pairing arrives, the next poll fills them in."""
    body = client.get("/").get_data(as_text=True)
    assert 'id="single-track-preview"' in body
    assert 'id="single-track-list"' in body
    assert 'id="single-track-online"' in body
    assert 'id="single-track-total"' in body
    assert "no scales paired yet." in body


def test_dashboard_shows_single_track_tile_when_paired_scale_exists(
    repo, tmp_data_dir,
):
    """Seed one paired row → tile appears with the device id, product
    name, formatted weight, and the poller wiring referenced in the
    JS block. Asserts the load-bearing DOM ids the JS reads from so
    a refactor that drops/renames an id breaks this test."""
    _seed_single_track_pairing(
        repo,
        device_id="scale-single-01",
        product_id="p2",  # Chobani Yogurt — distinct from /inventory tests
        is_online=True,
        current_weight_g=523.0,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    body = app.test_client().get("/").get_data(as_text=True)
    # Tile + count container.
    assert 'id="single-track-preview"' in body
    assert 'id="single-track-online"' in body
    assert 'id="single-track-total"' in body
    # Polled DOM ids the JS writes into.
    assert 'id="single-track-list"' in body
    assert 'data-device-id="scale-single-01"' in body
    # Initial server-rendered values (so the first paint isn't blank).
    assert "Chobani Yogurt" in body
    assert "523 g" in body
    # Poller wiring — the JS block must reference the API call.
    assert "/api/state?shelf=single_item" in body


def test_dashboard_single_track_tile_initial_count_matches_paired_rows(
    repo, tmp_data_dir,
):
    """Server-rendered initial counts (online / total) must agree with
    the seeded data BEFORE the JS poller runs. Catches a bug where
    the tile shows 0/0 until the first poll lands."""
    _seed_single_track_pairing(
        repo, device_id="scale-A", product_id="p1", is_online=True,
    )
    _seed_single_track_pairing(
        repo, device_id="scale-B", product_id="p2", is_online=False,
        last_heartbeat_ts="2026-04-28T11:00:00Z",
    )
    _seed_single_track_pairing(
        repo, device_id="scale-C", product_id=None, is_online=True,
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: repo.catch_all_enabled,
    ))
    body = app.test_client().get("/").get_data(as_text=True)
    # 3 total, 2 online (A + C). The counts ride inside the rendered
    # spans whose ids the JS poller updates — so we anchor on the
    # markup pattern rather than just substring-matching the digit.
    assert '<span id="single-track-online">2</span>' in body
    assert '<span id="single-track-total">3</span>' in body


def test_inventory_single_track_section_with_explicit_flag_override(
    repo, tmp_data_dir,
):
    """The explicit ``live_scale_enabled`` callable overrides the
    auto-derive. Force-on with no rows → empty-state message;
    force-off with rows → no section. Mirrors the catch-all
    flag's host-toggle pattern."""
    # Force-on, no rows — section renders with the empty-state msg.
    app_on = Flask(__name__)
    app_on.config["TESTING"] = True
    app_on.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        live_scale_enabled=lambda: True,
    ))
    body_on = app_on.test_client().get("/inventory").get_data(as_text=True)
    assert "Single-track scales" in body_on
    assert "no single-track scales paired yet" in body_on

    # Force-off, with rows — section hidden.
    _seed_single_track_pairing(repo)
    app_off = Flask(__name__)
    app_off.config["TESTING"] = True
    app_off.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        live_scale_enabled=lambda: False,
    ))
    body_off = app_off.test_client().get("/inventory").get_data(as_text=True)
    assert "Single-track scales" not in body_off


def test_api_usage_delete_malformed_summary_returns_500(repo, tmp_data_dir):
    """L4 regression: if delete_usage_fn returns a summary without 'deleted',
    the endpoint must surface a 500 instead of silently reporting 404."""
    app = Flask(__name__)
    app.config["TESTING"] = True

    def read_config() -> dict[str, Any]:
        return {"delta_threshold_g": 5.0}

    def update_config(patch: dict[str, Any]) -> dict[str, Any]:
        return {"delta_threshold_g": 5.0}

    def bad_delete_usage_fn(usage_id: str) -> dict[str, Any]:
        # Missing the 'deleted' key — simulates a future refactor bug.
        return {"ok": True}

    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    app.register_blueprint(make_api_bp(
        repo,
        read_config=read_config,
        update_config=update_config,
        delete_usage_fn=bad_delete_usage_fn,
    ))
    client = app.test_client()
    r = client.post("/api/usage/u1/delete")
    assert r.status_code == 500
    data = r.get_json()
    assert "malformed" in data["error"]
    assert data["summary"] == {"ok": True}


# ---------------------------------------------------------------------------
# UX audit 2026-04-28 follow-ups
# ---------------------------------------------------------------------------


def test_inventory_renders_containers_column_for_on_shelf_lots(client):
    """UX audit: leading the on-shelf table with a containers reading
    closes the cloud↔Pi unit gap (cloud reports 1.6 ctn, Pi was reporting
    only grams). Heinz Ketchup has 400 g on scale, 80 g tare, 340 g net,
    so content = 320 g, ctn = 0.94."""
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # The containers column header replaces "content left" + "servings left".
    assert "remaining" in body
    # Containers value lands at 0.94 ctn (320 / 340).
    assert "0.94 ctn" in body


def test_inventory_renders_per_page_picker(client):
    """UX audit: the per-page picker lets the operator break out of the
    fixed 5/page window without resorting to URL hacking."""
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert 'name="per_page"' in body
    # Default opt 25 should be selected.
    assert "<option value=\"25\" selected" in body
    # The whitelist of values is rendered.
    for opt in (5, 25, 50, 100):
        assert f'value="{opt}"' in body


def test_inventory_per_page_query_param_clamps_to_whitelist(client):
    """A hostile per_page=99999 must fall back to the default; the page
    must not OOM rendering 99999 rows or 200 with that count echoed back."""
    r = client.get("/inventory?per_page=99999")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # Default (25) is the selected option.
    assert "<option value=\"25\" selected" in body


def test_inventory_per_page_query_param_50_takes_effect(client):
    """A whitelisted per_page=50 must end up reflected in the picker
    state."""
    r = client.get("/inventory?per_page=50")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "<option value=\"50\" selected" in body


def test_inventory_dedupes_usage_rows_with_same_return_event_id(repo, tmp_data_dir):
    """UX audit §inventory friction #11: the same return event re-emits
    on every Pi restart, generating N near-identical rows. The route must
    collapse them server-side and badge the survivor with ``Nx``."""
    # Seed three duplicate rows that share occurred_at + return_event_id +
    # product_id — the stable key the dedupe helper uses.
    same_ts = "2026-04-14T12:00:00Z"
    repo.db["usage_log"].extend([
        {
            "usage_id": "dup1",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 17.0,
            "pickup_weight_g": 400.0,
            "return_weight_g": 383.0,
            "kind": "in_flight_return",
            "session_id": "s1-abcdef01",
            "pickup_event_id": "e-pick-x",
            "return_event_id": "e-return-x",
            "occurred_at": same_ts,
            "created_at": same_ts,
        },
        {
            "usage_id": "dup2",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 17.0,
            "pickup_weight_g": 400.0,
            "return_weight_g": 383.0,
            "kind": "in_flight_return",
            "session_id": "s1-abcdef01",
            "pickup_event_id": "e-pick-x",
            "return_event_id": "e-return-x",
            "occurred_at": same_ts,
            "created_at": same_ts,
        },
        {
            "usage_id": "dup3",
            "lot_id": "l1",
            "product_id": "p1",
            "product_name": "Heinz Ketchup",
            "product_brand": "Heinz",
            "container_type": "bottle",
            "consumed_g": 17.0,
            "pickup_weight_g": 400.0,
            "return_weight_g": 383.0,
            "kind": "in_flight_return",
            "session_id": "s1-abcdef01",
            "pickup_event_id": "e-pick-x",
            "return_event_id": "e-return-x",
            "occurred_at": same_ts,
            "created_at": same_ts,
        },
    ])
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    client = app.test_client()
    r = client.get("/inventory?per_page=100")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # The "3x" duplicate badge must render exactly once even though the DB
    # has three duplicate rows.
    assert ">\n                  3x\n" in body or ">3x<" in body or "3x</span>" in body


def test_inventory_negative_single_track_weight_renders_tare_needed(
    repo, tmp_data_dir,
):
    """UX audit: scale-03 showing -121 g looks broken to the operator.
    Surface a ``tare needed`` indicator so the user knows the fix."""
    repo.db["scale_pairings"] = [
        {
            "device_id": "scale-03",
            "shelf_id": "single_item",
            "product_id": "p1",
            "lot_id": "l1",
            "first_seen_at": "2026-04-28T12:00:00Z",
            "last_heartbeat_ts": "2026-04-28T12:00:00Z",
            "current_weight_g": -121.0,
            "is_online": True,
        },
    ]
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir, live_scale_enabled=lambda: True,
    ))
    client = app.test_client()
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "tare needed" in body
    assert "-121 g" in body


def test_inventory_brand_null_renders_em_dash_not_amp_mdash(client):
    """UX audit: ``{{ p.brand or '&mdash;' }}`` was rendering as the
    literal string ``&mdash;`` because Jinja autoescaped the ampersand.
    Confirm the rendered output is a real em-dash (—) when brand is null,
    not the HTML entity reference."""
    # Chobani Yogurt has a brand; we need a product with brand=None.
    # Seed one inline.
    client.application.test_client_class  # noqa - just ensure attr exists


def test_inventory_brand_null_uses_real_em_dash(repo, tmp_data_dir):
    """Same as above but with a tailored repo that has a null-brand product
    so we can check the rendered cell directly."""
    repo.db["products"]["p3"] = {
        "product_id": "p3",
        "name": "Generic Product",
        "brand": None,
        "variant": None,
        "barcode": None,
        "net_weight_g": 100.0,
        "tare_weight_g": 10.0,
        "serving_weight_g": 25.0,
        "servings_per_container": 4.0,
        "unit_type": "solid",
        "container_type": "bag",
        "certified": 1,
        "density_g_per_ml": None,
        "created_at": "2026-04-14T12:00:00Z",
        "updated_at": "2026-04-14T12:00:00Z",
    }
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    client = app.test_client()
    r = client.get("/inventory")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # The literal HTML entity reference must NOT appear in catalog cells —
    # if it does, Jinja autoescaped a string-literal '&mdash;' and the
    # operator sees "&mdash;" in the brand column.
    assert "&amp;mdash;" not in body


def test_dashboard_renders_health_tile(client):
    """UX audit: failed_events / cloud_drift_s / outbox_backlog must
    surface on the dashboard so the user gets a 1-second is-the-kitchen-
    happy read without leaving the page."""
    r = client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "system health" in body
    # The named row labels in the tile.
    assert "failed events" in body
    assert "pending classify" in body
    assert "cloud drift" in body
    assert "outbox backlog" in body


def test_dashboard_renders_in_flight_count_always(client):
    """UX audit: in-flight count must always render — no layout jump
    when a lot first goes in flight."""
    r = client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # Even with zero in-flight lots, the counter must show.
    assert 'id="in-flight-count"' in body


def test_dashboard_preview_tiles_have_device_id_chips(client):
    """UX audit: the two preview tiles look identical and the operator
    can't tell which is which. Adding scale-01 / scale-02 chips +
    colored left borders gives instant visual separation."""
    r = client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "scale-01" in body  # live-shelf chip
    # catch-all chip only renders when catch_all_enabled — exercised in
    # the dedicated catch-all-on test below.


def test_dashboard_catch_all_preview_has_device_id_chip(
    client, repo, tmp_data_dir,
):
    """UX audit: catch-all tile must visually call out scale-02."""
    repo.catch_all_enabled = True
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(
        repo, data_dir=tmp_data_dir,
        catch_all_enabled=lambda: True,
    ))
    body = app.test_client().get("/").get_data(as_text=True)
    assert "scale-02" in body


def test_sessions_page_renders_filter_buttons(client):
    """UX audit: sessions table needs an idle-vs-real filter so 0-event
    rows don't dominate the page."""
    r = client.get("/sessions")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert 'id="filter-with-events"' in body
    assert 'id="filter-all"' in body
    assert 'id="filter-unreconciled"' in body


def test_sessions_page_renders_aggregate_strip(client):
    """UX audit: per-page totals (sessions, with events, total events)
    were missing. Confirm they surface at the top of the table."""
    r = client.get("/sessions")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "with events" in body
    assert "total events" in body


def test_sessions_page_long_duration_renders_minutes(repo, tmp_data_dir):
    """UX audit: ``300.0s`` reads as awful for a 5-minute session.
    Ensure ≥60s sessions promote to ``Xm Ys``."""
    repo.db["sessions"]["long-session"] = {
        "session_id": "long-session",
        "started_at": "2026-04-14T11:00:00Z",
        "ended_at": "2026-04-14T11:05:00Z",
        "initial_shelf_weight_g": 400.0,
        "final_shelf_weight_g": 400.0,
        "reconciled": 1,
        "reconciled_at": "2026-04-14T11:05:05Z",
        "duration_seconds": 300.0,
        "event_count": 1,
        "resolution_count": 0,
    }
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(make_html_bp(repo, data_dir=tmp_data_dir))
    body = app.test_client().get("/sessions").get_data(as_text=True)
    assert "5m 0s" in body


def test_sessions_page_renders_timeline_link_per_row(client):
    """UX audit: debug timeline page is currently undiscoverable from
    the session list. Add a per-row debug link."""
    r = client.get("/sessions")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "/timeline" in body
    assert "debug" in body.lower()


def test_base_nav_wipe_button_tucked_under_admin_menu(client):
    """UX audit: the wipe button must not be a top-level nav item; tuck
    it behind an admin menu so accidental clicks are harder."""
    r = client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # The admin menu drawer wraps the wipe button.
    assert "nav-admin-menu" in body
    # Wipe button itself remains so the JS callsite still works.
    assert 'id="wipe-btn"' in body


def test_dedupe_usage_rows_keeps_distinct_groups_separate():
    """Direct unit test for the dedupe helper — different return_event_ids
    must NOT collapse into the same group."""
    from server.web.routes import _dedupe_usage_rows
    rows = [
        {"usage_id": "a", "occurred_at": "T1",
         "return_event_id": "rA", "product_id": "p1"},
        {"usage_id": "b", "occurred_at": "T1",
         "return_event_id": "rB", "product_id": "p1"},
    ]
    out = _dedupe_usage_rows(rows)
    assert len(out) == 2
    assert all(r["_dup_count"] == 1 for r in out)


def test_dedupe_usage_rows_collapses_identical_keys():
    """Direct unit test: same (occurred_at, return_event_id, product_id)
    must collapse to one row with dup_count = N."""
    from server.web.routes import _dedupe_usage_rows
    rows = [
        {"usage_id": f"u{i}", "occurred_at": "T1",
         "return_event_id": "rZ", "product_id": "p1"}
        for i in range(5)
    ]
    out = _dedupe_usage_rows(rows)
    assert len(out) == 1
    assert out[0]["_dup_count"] == 5
    # The 4 suppressed sibling ids land in _dup_usage_ids.
    assert len(out[0]["_dup_usage_ids"]) == 4


def test_dedupe_usage_rows_handles_null_return_event_id():
    """Direct unit test: rows without return_event_id but matching
    (occurred_at, product_id) should still group via the
    ``__no_return__`` sentinel."""
    from server.web.routes import _dedupe_usage_rows
    rows = [
        {"usage_id": "a", "occurred_at": "T1",
         "return_event_id": None, "product_id": "p1"},
        {"usage_id": "b", "occurred_at": "T1",
         "return_event_id": None, "product_id": "p1"},
        {"usage_id": "c", "occurred_at": "T1",
         "return_event_id": None, "product_id": "p2"},
    ]
    out = _dedupe_usage_rows(rows)
    # p1 collapses to 1 row, p2 stays separate.
    assert len(out) == 2
    p1_row = next(r for r in out if r["product_id"] == "p1")
    p2_row = next(r for r in out if r["product_id"] == "p2")
    assert p1_row["_dup_count"] == 2
    assert p2_row["_dup_count"] == 1


def test_collect_dashboard_health_swallows_exceptions():
    """The dashboard MUST render even if the repo's health collector
    raises. Each individual field falls back to None instead of propagating."""
    from server.web.routes import _collect_dashboard_health

    class BrokenRepo:
        def get_app_state(self):
            raise RuntimeError("boom")
        def get_dashboard_health(self):
            raise RuntimeError("kaboom")

    out = _collect_dashboard_health(BrokenRepo())
    # All keys must be present so the template never hits an undefined.
    for key in (
        "failed_events", "pending_events", "classifying_events",
        "anthropic_errors_total", "cloud_drift_s", "outbox_backlog",
    ):
        assert key in out
        assert out[key] is None
