#!/usr/bin/env python3
"""
Seed a demo account on prod + run E2E tests against the live shelf-ingest
edge function. Safe to re-run — uses stable email, idempotent where possible.

Output: pass/fail per scenario + leaves the demo account populated for
manual click-through at https://lunahub.dev.

Usage:
    python3 scripts/demo_live_shelf_prod.py

Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env at repo root.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import time
import uuid
from pathlib import Path

import requests

# ─── Config ─────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = REPO_ROOT / ".env"
if not ENV_FILE.exists():
    sys.exit(f"missing {ENV_FILE}")

env = {}
for line in ENV_FILE.read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

SUPABASE_URL = env.get("SUPABASE_URL")
SERVICE_KEY  = env.get("SUPABASE_SERVICE_ROLE_KEY")
if not (SUPABASE_URL and SERVICE_KEY):
    sys.exit("need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")

INGEST = f"{SUPABASE_URL}/functions/v1/shelf-ingest"

DEMO_EMAIL    = "demo-shelf@lunahub.dev"
DEMO_PASSWORD = "DemoLuna2026!"
DEMO_NAME     = "Demo User"

# ─── Utilities ──────────────────────────────────────────────────────

_admin_hdrs = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}

def admin_get(path: str, **kw):
    r = requests.get(f"{SUPABASE_URL}{path}", headers=_admin_hdrs, timeout=15, **kw)
    r.raise_for_status()
    return r.json()

def admin_post(path: str, body: dict, profile: str = None):
    h = dict(_admin_hdrs)
    h["Content-Type"] = "application/json"
    if profile:
        h["Content-Profile"] = profile
        h["Prefer"] = "return=representation"
    r = requests.post(f"{SUPABASE_URL}{path}", headers=h, json=body, timeout=15)
    if not r.ok:
        raise RuntimeError(f"POST {path} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else None

def admin_patch(path: str, body: dict, profile: str = None):
    h = dict(_admin_hdrs)
    h["Content-Type"] = "application/json"
    if profile:
        h["Content-Profile"] = profile
        h["Prefer"] = "return=representation"
    r = requests.patch(f"{SUPABASE_URL}{path}", headers=h, json=body, timeout=15)
    if not r.ok:
        raise RuntimeError(f"PATCH {path} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else None

def rest_select(table: str, schema: str = "chefbyte", **filters):
    """Read from schema.table via PostgREST with service role."""
    h = dict(_admin_hdrs)
    h["Accept-Profile"] = schema
    params = "&".join(f"{k}={v}" for k, v in filters.items())
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}" if params else f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers=h, timeout=15)
    r.raise_for_status()
    return r.json()

def ingest(verb: str, path: str, api_key: str, body: dict = None):
    h = {"x-api-key": api_key, "Content-Type": "application/json"}
    url = f"{INGEST}{path}"
    if verb == "GET":
        r = requests.get(url, headers=h, timeout=15)
    else:
        r = requests.post(url, headers=h, json=body or {}, timeout=15)
    return r

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

_results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str = ""):
    _results.append((name, ok, detail))
    mark = "✓" if ok else "✗"
    print(f"  {mark} {name}" + (f" — {detail}" if detail else ""))

# ─── Seed demo account + baseline data ──────────────────────────────

def seed() -> dict:
    print("== SEEDING DEMO ACCOUNT ==")

    # 1. Find or create user
    users = admin_get("/auth/v1/admin/users").get("users", [])
    user = next((u for u in users if u.get("email") == DEMO_EMAIL), None)
    if user:
        print(f"  user exists: {user['id']}")
        user_id = user["id"]
    else:
        r = admin_post("/auth/v1/admin/users", {
            "email": DEMO_EMAIL,
            "password": DEMO_PASSWORD,
            "email_confirm": True,
            "user_metadata": {"name": DEMO_NAME},
        })
        user_id = r["id"]
        print(f"  user created: {user_id}")

    # 2. Activate chefbyte app (idempotent)
    try:
        admin_post(
            "/rest/v1/rpc/activate_app_admin",
            {"p_user_id": user_id, "p_app_name": "chefbyte"},
            profile="hub",
        )
    except RuntimeError:
        # rpc may not exist under that name — try direct app_activations insert
        try:
            admin_post("/rest/v1/app_activations", {
                "user_id": user_id, "app_name": "chefbyte", "active": True,
            }, profile="hub")
        except RuntimeError:
            pass  # already active
    print("  chefbyte app activated")

    # 3. Profile (timezone + day_start_hour) — needed by apply_shelf_event
    try:
        admin_post("/rest/v1/profiles", {
            "user_id": user_id, "timezone": "America/New_York", "day_start_hour": 4,
        }, profile="hub")
    except RuntimeError:
        admin_patch(f"/rest/v1/profiles?user_id=eq.{user_id}", {
            "timezone": "America/New_York", "day_start_hour": 4,
        }, profile="hub")
    print("  profile set")

    # 4. Default location
    existing = rest_select("locations", user_id=f"eq.{user_id}")
    if existing:
        loc_id = existing[0]["location_id"]
    else:
        loc_id = admin_post("/rest/v1/locations", {
            "user_id": user_id, "name": "Fridge",
        }, profile="chefbyte")[0]["location_id"]
    print(f"  location: {loc_id[:8]}")

    # 5. Products — with net_weight_g so events can decrement
    products_spec = [
        {"name": "Whole Milk 1L",       "barcode": "DEMO-MILK-001",  "net_weight_g": 1000, "servings_per_container": 4,  "calories_per_serving": 150, "carbs_per_serving": 12, "protein_per_serving": 8, "fat_per_serving": 8, "container_type": "carton"},
        {"name": "Greek Yogurt 500g",   "barcode": "DEMO-YOGURT-001","net_weight_g": 500,  "servings_per_container": 4,  "calories_per_serving": 100, "carbs_per_serving": 6,  "protein_per_serving": 17,"fat_per_serving": 0, "container_type": "tub"},
        {"name": "Peanut Butter 454g",  "barcode": "DEMO-PB-001",    "net_weight_g": 454,  "servings_per_container": 14, "calories_per_serving": 190, "carbs_per_serving": 8,  "protein_per_serving": 7, "fat_per_serving": 16,"container_type": "jar"},
    ]
    product_ids = {}
    for spec in products_spec:
        existing = rest_select("products",
                               user_id=f"eq.{user_id}",
                               barcode=f"eq.{spec['barcode']}")
        if existing:
            pid = existing[0]["product_id"]
        else:
            pid = admin_post("/rest/v1/products", {**spec, "user_id": user_id},
                             profile="chefbyte")[0]["product_id"]
        product_ids[spec["name"]] = pid
    print(f"  products: {len(product_ids)}")

    # 6. Initial stock — 1 lot per product with qty=2
    for pid in product_ids.values():
        existing = rest_select("stock_lots",
                               user_id=f"eq.{user_id}",
                               product_id=f"eq.{pid}")
        if not existing:
            admin_post("/rest/v1/stock_lots", {
                "user_id": user_id,
                "product_id": pid,
                "location_id": loc_id,
                "qty_containers": 2.0,
                "last_update_source": "manual",
            }, profile="chefbyte")
    print(f"  seed stock lots ready (2 containers each)")

    # 7. Device + import key. Always rotate the key so tests see a clean state.
    raw_key  = secrets.token_hex(32)
    key_hash = sha256_hex(raw_key)
    existing = rest_select("live_shelf_devices",
                           user_id=f"eq.{user_id}",
                           device_name=f"eq.demo-pi")
    if existing:
        did = existing[0]["device_id"]
        admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                    {"import_key_hash": key_hash, "is_active": True, "lan_ip": None},
                    profile="chefbyte")
    else:
        did = admin_post("/rest/v1/live_shelf_devices", {
            "user_id": user_id,
            "device_name": "demo-pi",
            "import_key_hash": key_hash,
            "is_active": True,
        }, profile="chefbyte")[0]["device_id"]

    # clear any stale pairings so the heartbeat-upsert test starts fresh
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/scale_pairings?device_id=eq.{did}",
        headers={**_admin_hdrs, "Content-Profile": "chefbyte"},
        timeout=15,
    )
    print(f"  device: demo-pi, key={raw_key[:8]}…")

    return {
        "user_id": user_id,
        "location_id": loc_id,
        "products": product_ids,
        "device_id": did,
        "import_key": raw_key,
    }

# ─── E2E scenarios ─────────────────────────────────────────────────

def run_tests(ctx: dict) -> None:
    print("\n== RUNNING E2E ==")
    key   = ctx["import_key"]
    pids  = ctx["products"]
    uid   = ctx["user_id"]
    did   = ctx["device_id"]

    # 1. Auth: bad key → 401
    r = ingest("GET", "/catalog", "bogus-key")
    check("reject bogus api key", r.status_code == 401)

    # 2. Catalog: valid key → products + stock scoped to user
    r = ingest("GET", "/catalog", key)
    cat = r.json()
    check("catalog returns products",
          r.status_code == 200 and len(cat.get("products", [])) == 3,
          f"status={r.status_code} products={len(cat.get('products', []))}")
    check("catalog returns initial stock",
          len(cat.get("stock", [])) == 3,
          f"stock={len(cat.get('stock', []))}")

    # 3. Heartbeat: upserts scale_pairings + bumps device last_heartbeat_ts
    r = ingest("POST", "/heartbeat", key, {
        "pending_review_count": 2,
        "scales": [
            {"scale_id": "scale-01", "kind": "live_shelf"},
            {"scale_id": "scale-02", "kind": "catch_all"},
            {"scale_id": "scale-03", "kind": "live_scale"},
        ],
    })
    check("heartbeat accepted", r.status_code == 200)
    pairings = rest_select("scale_pairings", device_id=f"eq.{did}")
    check("heartbeat upserts 3 pairings", len(pairings) == 3,
          f"found {len(pairings)}")
    dev = rest_select("live_shelf_devices", device_id=f"eq.{did}")[0]
    check("heartbeat bumps last_heartbeat_ts", bool(dev.get("last_heartbeat_ts")))
    check("heartbeat carries review count", dev.get("pending_review_count") == 2)

    # 4. Consumed event: live_shelf scale decrements stock + logs macros
    milk_id = pids["Whole Milk 1L"]
    lot_before = rest_select("stock_lots",
                             user_id=f"eq.{uid}",
                             product_id=f"eq.{milk_id}")[0]
    qty_before = float(lot_before["qty_containers"])
    event1_id = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": event1_id,
        "scale_id": "scale-01", "kind": "live_shelf",
        "event_kind": "consumed", "product_id": milk_id,
        "delta_g": -250,  # quarter-carton consumed
        "occurred_at": "2026-04-19T20:00:00Z",
    })
    check("consumed event applied", r.status_code == 200 and r.json().get("applied"))
    lot_after = rest_select("stock_lots",
                            user_id=f"eq.{uid}",
                            product_id=f"eq.{milk_id}")[0]
    expected = qty_before + (-250 / 1000)  # 2.0 - 0.25 = 1.75
    check("stock decremented",
          abs(float(lot_after["qty_containers"]) - expected) < 0.001,
          f"{qty_before} → {lot_after['qty_containers']}")
    check("last_update_source stamped",
          lot_after.get("last_update_source") == "live_shelf")

    # 5. Idempotency: replay same client_event_id → not applied again
    r = ingest("POST", "/event", key, {
        "client_event_id": event1_id,
        "scale_id": "scale-01", "kind": "live_shelf",
        "event_kind": "consumed", "product_id": milk_id,
        "delta_g": -250, "occurred_at": "2026-04-19T20:00:00Z",
    })
    body = r.json()
    lot_replay = rest_select("stock_lots",
                             user_id=f"eq.{uid}",
                             product_id=f"eq.{milk_id}")[0]
    check("duplicate event_id skipped",
          r.status_code == 200 and abs(float(lot_replay["qty_containers"]) - expected) < 0.001,
          f"reason={body.get('reason')} qty={lot_replay['qty_containers']}")

    # 6. Live_scale event resolves product_id via scale_pairings
    pb_id = pids["Peanut Butter 454g"]
    admin_patch(
        f"/rest/v1/scale_pairings?device_id=eq.{did}&scale_id=eq.scale-03",
        {"product_id": pb_id}, profile="chefbyte",
    )
    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "scale-03", "kind": "live_scale",
        "event_kind": "consumed",  # no product_id — should resolve via pairing
        "delta_g": -45.4,  # ~10% of container
        "occurred_at": "2026-04-19T20:05:00Z",
    })
    check("live_scale resolves product via pairing",
          r.status_code == 200 and r.json().get("applied"))
    pb_lot = rest_select("stock_lots",
                        user_id=f"eq.{uid}",
                        product_id=f"eq.{pb_id}")[0]
    check("live_scale stamps source tag",
          pb_lot.get("last_update_source") == "live_scale")

    # 7. Live_scale without pairing → 409
    # clear the pairing first
    admin_patch(
        f"/rest/v1/scale_pairings?device_id=eq.{did}&scale_id=eq.scale-03",
        {"product_id": None}, profile="chefbyte",
    )
    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "scale-03", "kind": "live_scale",
        "event_kind": "consumed",
        "delta_g": -10,
        "occurred_at": "2026-04-19T20:06:00Z",
    })
    check("unpaired live_scale rejected 409",
          r.status_code == 409,
          f"status={r.status_code} body={r.text[:80]}")

    # 8. Added event: catch_all increments stock
    yogurt_id = pids["Greek Yogurt 500g"]
    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "scale-02", "kind": "catch_all",
        "event_kind": "added", "product_id": yogurt_id,
        "delta_g": 500,  # +1 container
        "occurred_at": "2026-04-19T20:07:00Z",
    })
    check("added event applied", r.status_code == 200 and r.json().get("applied"))
    yog_lot = rest_select("stock_lots",
                          user_id=f"eq.{uid}",
                          product_id=f"eq.{yogurt_id}")[0]
    check("added event tags catch_all",
          yog_lot.get("last_update_source") == "catch_all")

    # 9. Unknown product_id → clean 4xx-ish response (not 500)
    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "scale-01", "kind": "live_shelf",
        "event_kind": "consumed",
        "product_id": "00000000-0000-0000-0000-000000000000",
        "delta_g": -50, "occurred_at": "2026-04-19T20:08:00Z",
    })
    body = r.json() if r.ok else {}
    check("unknown product clean response",
          r.status_code == 200 and not body.get("applied"),
          f"status={r.status_code} reason={body.get('reason')!r}")

    # 10. Missing client_event_id → 400
    r = ingest("POST", "/event", key, {
        "scale_id": "scale-01", "kind": "live_shelf",
        "event_kind": "consumed", "product_id": milk_id,
        "delta_g": -10, "occurred_at": "2026-04-19T20:09:00Z",
    })
    check("missing client_event_id rejected 400", r.status_code == 400,
          f"status={r.status_code}")

    # 11. Cross-user isolation: use this device's key to try mutating another user's product_id.
    # We pick any user other than demo; skip if none exist.
    other_products = rest_select(
        "products",
        select="product_id,user_id",
        user_id=f"neq.{uid}",
        limit=1,
    )
    if other_products:
        other_pid = other_products[0]["product_id"]
        other_uid = other_products[0]["user_id"]
        r = ingest("POST", "/event", key, {
            "client_event_id": str(uuid.uuid4()),
            "scale_id": "scale-01", "kind": "live_shelf",
            "event_kind": "consumed", "product_id": other_pid,
            "delta_g": -10, "occurred_at": "2026-04-19T20:10:00Z",
        })
        body = r.json() if r.ok else {}
        # Expect either 4xx or 200-with-applied=false; must NOT mutate the other user's stock
        after = rest_select("stock_lots",
                            user_id=f"eq.{other_uid}",
                            product_id=f"eq.{other_pid}")
        mutated = any(l.get("last_update_source") in ("live_shelf","live_scale","catch_all")
                      and l.get("last_update_ts") and "2026-04-19T20:10:00" in l.get("last_update_ts","")
                      for l in after)
        check("cross-user event does not mutate other user's stock",
              not mutated and (r.status_code != 500),
              f"status={r.status_code} mutated={mutated}")
    else:
        check("cross-user test skipped (no other users)", True, "skipped")

# ─── Report ────────────────────────────────────────────────────────

def report(ctx):
    passed = sum(1 for _, ok, _ in _results if ok)
    total  = len(_results)
    print("\n" + "=" * 60)
    print(f"  RESULT: {passed}/{total} pass")
    print("=" * 60)
    if passed < total:
        print("\nFailures:")
        for n, ok, d in _results:
            if not ok:
                print(f"  ✗ {n} — {d}")
        sys.exit(1)

    print(f"\nDemo account ready for click-through:")
    print(f"  URL:      https://lunahub.dev")
    print(f"  Email:    {DEMO_EMAIL}")
    print(f"  Password: {DEMO_PASSWORD}")
    print(f"\nSeeded:")
    print(f"  3 products (Whole Milk, Greek Yogurt, Peanut Butter)")
    print(f"  3 stock lots (2 containers each, adjusted by tests)")
    print(f"  1 device: demo-pi (heartbeated, 3 scales paired)")
    print(f"  device import_key: {ctx['import_key']}")

if __name__ == "__main__":
    ctx = seed()
    run_tests(ctx)
    report(ctx)
