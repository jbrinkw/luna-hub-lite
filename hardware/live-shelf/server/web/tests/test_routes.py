"""Flask test-client tests for Live Shelf web UI (Bundle G).

Uses a FakeRepo implementing WebRepo. Confirms every HTML route renders a
200 with the expected landmark text + pagination + image-serving behaves
correctly with path traversal attempts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import pytest
from flask import Flask

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
            "occurred_at": "2026-04-17T12:05:00Z",
            "created_at": "2026-04-17T12:05:01Z",
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
            "occurred_at": "2026-04-17T16:00:00Z",
            "created_at": "2026-04-17T16:00:01Z",
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
