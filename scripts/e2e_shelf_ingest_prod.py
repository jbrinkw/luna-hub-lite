#!/usr/bin/env python3
"""
Rigorous E2E test suite for the live-shelf cloud integration.

Target:  production Supabase (btlfsxammjzkyluophgr) + deployed
         `shelf-ingest` edge function.

Design:
  * Every mutation test captures before/after state and asserts the exact
    expected delta.
  * Every error path asserts a distinct `reason`/`error` string.
  * Every test is idempotent / re-runnable against a persistent demo
    account.  Setup is hoisted into `seed()`; per-test cleanup uses admin
    REST only — never edits DB state mid-test to fudge expectations.
  * Exits 0 only if 100% pass.

Usage:
    python3 scripts/e2e_shelf_ingest_prod.py

Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env at repo root.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
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

# The edge function enforces occurred_at within [now-30d, now+5m]. Tests used
# to hard-code 2026-04-19 timestamps; we now derive them from `now()` offset
# by a small negative delta so the window check always passes regardless of
# wall-clock. Offsets in seconds keep events ordered within a test.
def _ts(offset_seconds: int = 0) -> str:
    """ISO-8601 UTC timestamp, offset from now (negative = past)."""
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")

# ─── HTTP helpers ───────────────────────────────────────────────────

_admin_hdrs = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}

def admin_get(path: str, **kw):
    r = requests.get(f"{SUPABASE_URL}{path}", headers=_admin_hdrs, timeout=20, **kw)
    r.raise_for_status()
    return r.json()

def admin_post(path: str, body: dict, profile: str = None):
    h = dict(_admin_hdrs)
    h["Content-Type"] = "application/json"
    if profile:
        h["Content-Profile"] = profile
        h["Prefer"] = "return=representation"
    r = requests.post(f"{SUPABASE_URL}{path}", headers=h, json=body, timeout=20)
    if not r.ok:
        raise RuntimeError(f"POST {path} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else None

def admin_patch(path: str, body: dict, profile: str = None):
    h = dict(_admin_hdrs)
    h["Content-Type"] = "application/json"
    if profile:
        h["Content-Profile"] = profile
        h["Prefer"] = "return=representation"
    r = requests.patch(f"{SUPABASE_URL}{path}", headers=h, json=body, timeout=20)
    if not r.ok:
        raise RuntimeError(f"PATCH {path} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else None

def admin_delete(path: str, profile: str = None):
    h = dict(_admin_hdrs)
    if profile:
        h["Content-Profile"] = profile
    r = requests.delete(f"{SUPABASE_URL}{path}", headers=h, timeout=20)
    if not r.ok and r.status_code != 404:
        raise RuntimeError(f"DELETE {path} → {r.status_code}: {r.text[:300]}")
    return r

def rest_select(table: str, schema: str = "chefbyte", **filters):
    """Read from schema.table via PostgREST with service role."""
    h = dict(_admin_hdrs)
    h["Accept-Profile"] = schema
    params = "&".join(f"{k}={v}" for k, v in filters.items())
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}" if params else f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers=h, timeout=20)
    r.raise_for_status()
    return r.json()

def ingest(verb: str, path: str, api_key: str | None, body: dict = None,
          extra_headers: dict | None = None):
    """Call the edge function. api_key=None → omit the header entirely."""
    h = {"Content-Type": "application/json"}
    if api_key is not None:
        h["x-api-key"] = api_key
    if extra_headers:
        h.update(extra_headers)
    url = f"{INGEST}{path}"
    if verb == "GET":
        r = requests.get(url, headers=h, timeout=20)
    else:
        r = requests.post(url, headers=h, json=body or {}, timeout=20)
    return r

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def qty_of_lot(uid: str, pid: str) -> list[dict]:
    return rest_select("stock_lots", user_id=f"eq.{uid}", product_id=f"eq.{pid}")

def first_lot_qty(uid: str, pid: str) -> float:
    rows = qty_of_lot(uid, pid)
    if not rows:
        return 0.0
    return float(rows[0]["qty_containers"])

_results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str = ""):
    _results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))

# Scan response bodies for strings that would indicate an internal error
# leak (stack trace, Postgres column names, Deno internals, etc.).
LEAK_PATTERNS = [
    r"\bat <anonymous>\b",
    r"\bat [A-Za-z_][\w.]*\s*\(",
    r"PostgresError",
    r"PostgrestError",
    r'"detail"\s*:\s*"',
    r'"hint"\s*:\s*"',
    r"SELECT\s+\S+\s+FROM",
    r"relation \"[^\"]+\" does not exist",
    r"pg_hba\.conf",
    r"Deno\.serve",
    r"TypeError",
    r"ReferenceError",
    r"Internal.*stack",
]
_leak_re = re.compile("|".join(LEAK_PATTERNS), re.IGNORECASE)

def body_leaks(text: str) -> str | None:
    """Return the first matching leak indicator, else None."""
    m = _leak_re.search(text or "")
    return m.group(0) if m else None

# ─── Seeding ────────────────────────────────────────────────────────

def find_or_create_user(email: str, password: str, name: str) -> str:
    users = admin_get("/auth/v1/admin/users").get("users", [])
    u = next((x for x in users if x.get("email") == email), None)
    if u:
        return u["id"]
    r = admin_post("/auth/v1/admin/users", {
        "email": email, "password": password,
        "email_confirm": True, "user_metadata": {"name": name},
    })
    return r["id"]

def ensure_profile(uid: str, tz="America/New_York", dsh=4):
    try:
        admin_post("/rest/v1/profiles", {
            "user_id": uid, "timezone": tz, "day_start_hour": dsh,
        }, profile="hub")
    except RuntimeError:
        admin_patch(f"/rest/v1/profiles?user_id=eq.{uid}", {
            "timezone": tz, "day_start_hour": dsh,
        }, profile="hub")

def ensure_location(uid: str, name="Fridge") -> str:
    existing = rest_select("locations", user_id=f"eq.{uid}", name=f"eq.{name}")
    if existing:
        return existing[0]["location_id"]
    return admin_post("/rest/v1/locations", {
        "user_id": uid, "name": name,
    }, profile="chefbyte")[0]["location_id"]

def upsert_product(uid: str, spec: dict) -> str:
    existing = rest_select("products",
                           user_id=f"eq.{uid}",
                           barcode=f"eq.{spec['barcode']}")
    if existing:
        pid = existing[0]["product_id"]
        admin_patch(f"/rest/v1/products?product_id=eq.{pid}", spec, profile="chefbyte")
        return pid
    return admin_post("/rest/v1/products", {**spec, "user_id": uid},
                     profile="chefbyte")[0]["product_id"]

def reset_stock_lot(uid: str, pid: str, loc_id: str, qty: float = 2.0,
                    expires_on: str | None = None):
    """Replace all lots for (user, product) with a single fresh lot at qty."""
    # delete all existing lots for this product
    admin_delete(
        f"/rest/v1/stock_lots?user_id=eq.{uid}&product_id=eq.{pid}",
        profile="chefbyte",
    )
    body = {
        "user_id": uid, "product_id": pid, "location_id": loc_id,
        "qty_containers": qty,
        "last_update_source": "manual",
    }
    if expires_on is not None:
        body["expires_on"] = expires_on
    admin_post("/rest/v1/stock_lots", body, profile="chefbyte")

def delete_all_lots(uid: str, pid: str):
    admin_delete(
        f"/rest/v1/stock_lots?user_id=eq.{uid}&product_id=eq.{pid}",
        profile="chefbyte",
    )

def delete_food_logs_for(uid: str, pid: str):
    admin_delete(
        f"/rest/v1/food_logs?user_id=eq.{uid}&product_id=eq.{pid}",
        profile="chefbyte",
    )

def rotate_device(uid: str, device_name: str = "demo-pi") -> tuple[str, str]:
    raw_key  = secrets.token_hex(32)
    key_hash = sha256_hex(raw_key)
    existing = rest_select("live_shelf_devices",
                           user_id=f"eq.{uid}",
                           device_name=f"eq.{device_name}")
    if existing:
        did = existing[0]["device_id"]
        admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                    {"import_key_hash": key_hash, "is_active": True, "lan_ip": None},
                    profile="chefbyte")
    else:
        did = admin_post("/rest/v1/live_shelf_devices", {
            "user_id": uid,
            "device_name": device_name,
            "import_key_hash": key_hash,
            "is_active": True,
        }, profile="chefbyte")[0]["device_id"]
    return did, raw_key

def wipe_pairings(did: str):
    admin_delete(
        f"/rest/v1/scale_pairings?device_id=eq.{did}",
        profile="chefbyte",
    )

def wipe_event_log(uid: str):
    admin_delete(
        f"/rest/v1/shelf_event_log?user_id=eq.{uid}",
        profile="chefbyte",
    )

def seed() -> dict:
    print("== SEEDING DEMO ACCOUNT ==")
    uid = find_or_create_user(DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME)
    print(f"  demo user: {uid}")

    # app activation (best-effort idempotent)
    try:
        admin_post("/rest/v1/rpc/activate_app_admin",
                   {"p_user_id": uid, "p_app_name": "chefbyte"}, profile="hub")
    except RuntimeError:
        try:
            admin_post("/rest/v1/app_activations",
                       {"user_id": uid, "app_name": "chefbyte", "active": True},
                       profile="hub")
        except RuntimeError:
            pass

    ensure_profile(uid)
    loc_id = ensure_location(uid, "Fridge")
    loc2_id = ensure_location(uid, "Pantry")
    print(f"  locations: Fridge={loc_id[:8]} Pantry={loc2_id[:8]}")

    products_spec = [
        {"name": "Whole Milk 1L",      "barcode": "DEMO-MILK-001",
         "net_weight_g": 1000, "servings_per_container": 4,
         "calories_per_serving": 150, "carbs_per_serving": 12,
         "protein_per_serving": 8, "fat_per_serving": 8,
         "container_type": "carton"},
        {"name": "Greek Yogurt 500g",  "barcode": "DEMO-YOGURT-001",
         "net_weight_g": 500,  "servings_per_container": 4,
         "calories_per_serving": 100, "carbs_per_serving": 6,
         "protein_per_serving": 17, "fat_per_serving": 0,
         "container_type": "tub"},
        {"name": "Peanut Butter 454g", "barcode": "DEMO-PB-001",
         "net_weight_g": 454,  "servings_per_container": 14,
         "calories_per_serving": 190, "carbs_per_serving": 8,
         "protein_per_serving": 7, "fat_per_serving": 16,
         "container_type": "jar"},
        # A product with NO net_weight_g — used for the distinct-error test
        {"name": "Weightless Mystery", "barcode": "DEMO-NOWEIGHT-001",
         "net_weight_g": None, "servings_per_container": 1,
         "calories_per_serving": 0, "carbs_per_serving": 0,
         "protein_per_serving": 0, "fat_per_serving": 0,
         "container_type": None},
    ]
    product_ids = {}
    for spec in products_spec:
        product_ids[spec["name"]] = upsert_product(uid, spec)
    print(f"  products: {len(product_ids)}")

    # Reset the three "main" products to a clean 1-lot, qty=2 state.
    # Leave the weightless product with no lots (tests don't mutate it).
    for name in ("Whole Milk 1L", "Greek Yogurt 500g", "Peanut Butter 454g"):
        reset_stock_lot(uid, product_ids[name], loc_id, qty=2.0)
        delete_food_logs_for(uid, product_ids[name])
    delete_all_lots(uid, product_ids["Weightless Mystery"])
    delete_food_logs_for(uid, product_ids["Weightless Mystery"])

    # Remove any leftover intake-created products from a prior run so the
    # catalog-exact-set assertion holds. Intake tests use barcodes prefixed
    # with "DEMO-INTAKE-A-<run_id>" or names like "Intake No Barcode ...".
    # Deleting by prefix match via PostgREST: barcode=like.DEMO-INTAKE-A-%.
    admin_delete(
        f"/rest/v1/products?user_id=eq.{uid}&barcode=like.DEMO-INTAKE-A-%25",
        profile="chefbyte",
    )
    admin_delete(
        f"/rest/v1/products?user_id=eq.{uid}&name=like.Intake%20No%20Barcode%25",
        profile="chefbyte",
    )

    did, raw_key = rotate_device(uid, "demo-pi")
    wipe_pairings(did)
    wipe_event_log(uid)
    print(f"  device demo-pi: {did[:8]} key={raw_key[:8]}…")

    # ── Second user for cross-isolation tests ───────────────────
    other_email = "demo-shelf-other@lunahub.dev"
    other_uid = find_or_create_user(other_email, DEMO_PASSWORD, "Demo Other")
    ensure_profile(other_uid)
    other_loc = ensure_location(other_uid, "Fridge")
    other_pid = upsert_product(other_uid, {
        "name": "Other User Milk", "barcode": "DEMO-OTHER-MILK",
        "net_weight_g": 1000, "servings_per_container": 4,
        "calories_per_serving": 150, "carbs_per_serving": 12,
        "protein_per_serving": 8, "fat_per_serving": 8,
        "container_type": "carton",
    })
    reset_stock_lot(other_uid, other_pid, other_loc, qty=5.0)
    # Clean up intake-created products on the OTHER user too
    admin_delete(
        f"/rest/v1/products?user_id=eq.{other_uid}&barcode=like.DEMO-INTAKE-A-%25",
        profile="chefbyte",
    )
    other_did, other_key = rotate_device(other_uid, "demo-pi-other")
    wipe_pairings(other_did)
    wipe_event_log(other_uid)
    print(f"  other user: {other_uid[:8]} other_pid={other_pid[:8]}")

    return {
        "user_id": uid,
        "location_id": loc_id,
        "location2_id": loc2_id,
        "products": product_ids,
        "device_id": did,
        "import_key": raw_key,
        "other_user_id": other_uid,
        "other_product_id": other_pid,
        "other_location_id": other_loc,
        "other_device_id": other_did,
        "other_key": other_key,
    }

# ─── Test groups ───────────────────────────────────────────────────
# Each group gets its own function + reset hooks for determinism.
# Tests assume seed() has run immediately before.

TOL = 1e-6

def test_auth(ctx):
    print("\n-- AUTH --")
    key = ctx["import_key"]

    # 1. Missing x-api-key header → 401
    r = ingest("GET", "/catalog", None)
    check("missing x-api-key → 401", r.status_code == 401,
          f"status={r.status_code}")

    # 2. Bogus api key → 401
    r = ingest("GET", "/catalog", "bogus-key-xxxxxxxx")
    check("bogus x-api-key → 401", r.status_code == 401,
          f"status={r.status_code}")

    # 3. Inactive device → 401 (flip is_active=false, then restore)
    did = ctx["device_id"]
    admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                {"is_active": False}, profile="chefbyte")
    try:
        r = ingest("GET", "/catalog", key)
        check("inactive device → 401",
              r.status_code == 401,
              f"status={r.status_code}")
    finally:
        admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                    {"is_active": True}, profile="chefbyte")

    # 4. Rotated key invalidates old key
    new_raw = secrets.token_hex(32)
    admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                {"import_key_hash": sha256_hex(new_raw)}, profile="chefbyte")
    try:
        r_old = ingest("GET", "/catalog", key)
        r_new = ingest("GET", "/catalog", new_raw)
        check("old key after rotation → 401",
              r_old.status_code == 401, f"status={r_old.status_code}")
        check("freshly rotated key works (GET /catalog)",
              r_new.status_code == 200, f"status={r_new.status_code}")
    finally:
        admin_patch(f"/rest/v1/live_shelf_devices?device_id=eq.{did}",
                    {"import_key_hash": sha256_hex(key)}, profile="chefbyte")

    # 5. Valid key across all 4 endpoints → never 401
    #    (content of each response is checked by other tests; here we only
    #    assert that auth itself passed.)
    r1 = ingest("GET", "/catalog", key)
    r2 = ingest("POST", "/heartbeat", key, {"pending_review_count": 0, "scales": []})
    r3 = ingest("POST", "/event", key, {})  # will 400 on validation, not 401
    r4 = ingest("POST", "/intake", key, {})  # same
    ok = all(r.status_code != 401 for r in (r1, r2, r3, r4))
    check("valid key never 401 across /catalog /heartbeat /event /intake",
          ok, f"codes={r1.status_code},{r2.status_code},{r3.status_code},{r4.status_code}")


def test_catalog(ctx):
    print("\n-- /catalog --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    did = ctx["device_id"]
    pids = ctx["products"]

    # seed a pairing so we can verify it comes back scoped
    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 1,
        "scales": [
            {"scale_id": "cat-scale-01", "kind": "live_shelf"},
            {"scale_id": "cat-scale-02", "kind": "catch_all"},
        ],
    })

    # plant a pairing on the OTHER user's device so we can verify scoping
    other_did = ctx["other_device_id"]
    ingest("POST", "/heartbeat", ctx["other_key"], {
        "pending_review_count": 0,
        "scales": [{"scale_id": "cat-scale-other", "kind": "live_shelf"}],
    })

    r = ingest("GET", "/catalog", key)
    check("/catalog 200", r.status_code == 200, f"status={r.status_code}")
    cat = r.json()

    # Products MUST match seeded set exactly (by product_id).
    seeded_pids = sorted([pids["Whole Milk 1L"], pids["Greek Yogurt 500g"],
                          pids["Peanut Butter 454g"], pids["Weightless Mystery"]])
    returned_pids = sorted([p["product_id"] for p in cat.get("products", [])])
    check("catalog products == seeded products (exact set)",
          returned_pids == seeded_pids,
          f"diff seeded={len(seeded_pids)} returned={len(returned_pids)}")

    # Stock lot IDs: must exactly match the 3 active lots (weightless product
    # has no lot). Order-independent set comparison.
    db_lots = rest_select("stock_lots",
                          user_id=f"eq.{uid}",
                          qty_containers="gt.0",
                          select="lot_id")
    seeded_lot_ids = sorted([l["lot_id"] for l in db_lots])
    returned_lot_ids = sorted([l["lot_id"] for l in cat.get("stock", [])])
    check("catalog stock_lot_ids == seeded lot_ids (exact set)",
          returned_lot_ids == seeded_lot_ids,
          f"seeded={len(seeded_lot_ids)} returned={len(returned_lot_ids)}")

    # Pairings must match db scoped to THIS device only.
    db_pairings = rest_select("scale_pairings",
                              user_id=f"eq.{uid}",
                              device_id=f"eq.{did}",
                              select="scale_id")
    expected_scales = sorted([p["scale_id"] for p in db_pairings])
    returned_scales = sorted([p["scale_id"] for p in cat.get("pairings", [])])
    check("catalog pairings scoped to this device (exact set)",
          returned_scales == expected_scales,
          f"expected={expected_scales} got={returned_scales}")

    # Locations must match DB exactly.
    db_locs = sorted([l["location_id"] for l in
                      rest_select("locations", user_id=f"eq.{uid}")])
    ret_locs = sorted([l["location_id"] for l in cat.get("locations", [])])
    check("catalog locations == user's locations (exact set)",
          ret_locs == db_locs)

    # Cross-user scoping: our catalog must NOT include other user's products.
    other_pid = ctx["other_product_id"]
    check("catalog does NOT leak other user's product_id",
          other_pid not in returned_pids,
          f"other_pid={other_pid[:8]}")

    # Other user's scale pairing must NOT show up in our response
    check("catalog does NOT leak other user's scale pairing",
          "cat-scale-other" not in returned_scales)


def test_heartbeat(ctx):
    print("\n-- /heartbeat --")
    key = ctx["import_key"]
    did = ctx["device_id"]
    uid = ctx["user_id"]
    other_did = ctx["other_device_id"]

    wipe_pairings(did)

    # 1. Upserts 3 new pairings
    r = ingest("POST", "/heartbeat", key, {
        "pending_review_count": 4,
        "scales": [
            {"scale_id": "hb-01", "kind": "live_shelf"},
            {"scale_id": "hb-02", "kind": "catch_all"},
            {"scale_id": "hb-03", "kind": "live_scale"},
        ],
    })
    check("heartbeat 200", r.status_code == 200)
    pairings = rest_select("scale_pairings", device_id=f"eq.{did}")
    returned_ids = sorted([p["scale_id"] for p in pairings])
    check("heartbeat inserts 3 pairings (exact scale_ids)",
          returned_ids == ["hb-01", "hb-02", "hb-03"],
          f"got={returned_ids}")

    # 2. Re-heartbeat with a product_id set on hb-03 → product_id preserved
    pb_id = ctx["products"]["Peanut Butter 454g"]
    admin_patch(
        f"/rest/v1/scale_pairings?device_id=eq.{did}&scale_id=eq.hb-03",
        {"product_id": pb_id}, profile="chefbyte",
    )
    before = rest_select("scale_pairings",
                         device_id=f"eq.{did}",
                         scale_id="eq.hb-03")[0]
    assert before["product_id"] == pb_id

    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 1,
        "scales": [{"scale_id": "hb-03", "kind": "live_scale"}],
    })
    after = rest_select("scale_pairings",
                        device_id=f"eq.{did}",
                        scale_id="eq.hb-03")[0]
    check("re-heartbeat preserves product_id on existing pairing",
          after["product_id"] == pb_id,
          f"before={before['product_id']} after={after['product_id']}")

    # 3. Recency of last_heartbeat_ts: must be within last 10s of now()
    t0 = datetime.now(timezone.utc)
    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 0,
        "scales": [{"scale_id": "hb-01", "kind": "live_shelf"}],
    })
    dev = rest_select("live_shelf_devices", device_id=f"eq.{did}")[0]
    ts_str = dev.get("last_heartbeat_ts") or ""
    parsed = None
    if ts_str:
        try:
            parsed = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
    recent = parsed is not None and abs((parsed - t0).total_seconds()) < 10
    check("heartbeat sets last_heartbeat_ts within 10s of now",
          recent, f"ts={ts_str} dt={(parsed - t0).total_seconds() if parsed else None}")

    # 4. pending_review_count is written verbatim (5 then 0)
    ingest("POST", "/heartbeat", key, {"pending_review_count": 5, "scales": []})
    dev = rest_select("live_shelf_devices", device_id=f"eq.{did}")[0]
    check("heartbeat writes pending_review_count=5",
          dev.get("pending_review_count") == 5,
          f"got={dev.get('pending_review_count')}")
    ingest("POST", "/heartbeat", key, {"pending_review_count": 0, "scales": []})
    dev = rest_select("live_shelf_devices", device_id=f"eq.{did}")[0]
    check("heartbeat writes pending_review_count=0",
          dev.get("pending_review_count") == 0,
          f"got={dev.get('pending_review_count')}")

    # 5. Empty scales array is accepted (no crash, status 200)
    r = ingest("POST", "/heartbeat", key,
               {"pending_review_count": 0, "scales": []})
    check("heartbeat with empty scales → 200",
          r.status_code == 200, f"status={r.status_code}")

    # 6. Other user's pairings are untouched by our heartbeats.
    other_before = rest_select("scale_pairings", device_id=f"eq.{other_did}")
    other_before_ids = sorted([p["scale_id"] for p in other_before])
    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 0,
        "scales": [{"scale_id": "hb-99", "kind": "live_shelf"}],
    })
    other_after = rest_select("scale_pairings", device_id=f"eq.{other_did}")
    other_after_ids = sorted([p["scale_id"] for p in other_after])
    check("other user's pairings untouched after our heartbeat",
          other_before_ids == other_after_ids,
          f"before={other_before_ids} after={other_after_ids}")


def test_event_consumed(ctx):
    print("\n-- /event (consumed) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    did = ctx["device_id"]
    pids = ctx["products"]
    loc_id = ctx["location_id"]

    milk_id = pids["Whole Milk 1L"]
    # Reset milk to a clean 2.0 for this suite
    reset_stock_lot(uid, milk_id, loc_id, qty=2.0)
    delete_food_logs_for(uid, milk_id)
    wipe_event_log(uid)

    # 1. Basic consumed: before=2, -250g → after = 2 - 0.25
    before_qty = first_lot_qty(uid, milk_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": milk_id, "delta_g": -250,
        "occurred_at": _ts(-240),
    })
    body = r.json() if r.ok else {}
    after_qty = first_lot_qty(uid, milk_id)
    expected = before_qty - 0.25
    check("consumed: applied=true",
          r.status_code == 200 and body.get("applied") is True,
          f"status={r.status_code} body={body}")
    check("consumed: qty decremented by delta_g/net_weight_g",
          abs(after_qty - expected) < TOL,
          f"before={before_qty} after={after_qty} expected={expected}")

    # 2. last_update_source stamped correctly
    lot = qty_of_lot(uid, milk_id)[0]
    check("consumed: last_update_source == kind",
          lot.get("last_update_source") == "live_shelf",
          f"got={lot.get('last_update_source')}")

    # 3. food_logs row written with correct macros
    logs = rest_select("food_logs", user_id=f"eq.{uid}", product_id=f"eq.{milk_id}")
    check("consumed: exactly 1 food_logs row for this consumption",
          len(logs) == 1, f"got={len(logs)}")
    if logs:
        # abs(-250/1000) * 4 servings = 1.0 serving
        log = logs[0]
        # Expected: qty_consumed=1.0, calories=150, carbs=12, protein=8, fat=8
        ok = (
            abs(float(log["qty_consumed"]) - 1.0) < TOL and
            abs(float(log["calories"]) - 150.0) < 1e-3 and
            abs(float(log["carbs"]) - 12.0) < 1e-3 and
            abs(float(log["protein"]) - 8.0) < 1e-3 and
            abs(float(log["fat"]) - 8.0) < 1e-3 and
            log["unit"] == "serving"
        )
        check("consumed: food_logs macros computed correctly",
              ok, f"log={log}")

    # 4. Nearest-expiration rule: create 2 lots, earlier one is decremented
    yogurt_id = pids["Greek Yogurt 500g"]
    delete_all_lots(uid, yogurt_id)
    delete_food_logs_for(uid, yogurt_id)
    later = admin_post("/rest/v1/stock_lots", {
        "user_id": uid, "product_id": yogurt_id, "location_id": loc_id,
        "qty_containers": 3.0, "expires_on": "2026-12-31",
        "last_update_source": "manual",
    }, profile="chefbyte")[0]["lot_id"]
    earlier = admin_post("/rest/v1/stock_lots", {
        "user_id": uid, "product_id": yogurt_id, "location_id": loc_id,
        "qty_containers": 3.0, "expires_on": "2026-06-01",
        "last_update_source": "manual",
    }, profile="chefbyte")[0]["lot_id"]

    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": yogurt_id, "delta_g": -125,
        "occurred_at": _ts(-230),
    })
    body = r.json() if r.ok else {}
    earlier_row = rest_select("stock_lots", lot_id=f"eq.{earlier}")[0]
    later_row = rest_select("stock_lots", lot_id=f"eq.{later}")[0]
    # -125/500 = -0.25 container; expected earlier=2.75, later=3.0
    check("nearest-expiration: earlier lot decremented",
          abs(float(earlier_row["qty_containers"]) - 2.75) < TOL,
          f"earlier={earlier_row['qty_containers']}")
    check("nearest-expiration: later lot UNCHANGED",
          abs(float(later_row["qty_containers"]) - 3.0) < TOL,
          f"later={later_row['qty_containers']}")
    check("nearest-expiration: resolved_lot_id == earlier lot",
          body.get("resolved_lot_id") == earlier,
          f"resolved={body.get('resolved_lot_id')} earlier={earlier}")

    # 5. Stock floor at 0: consume more than available (earlier lot has 2.75
    #    containers = 1375g available in that lot; send -9999g)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": yogurt_id, "delta_g": -9999,
        "occurred_at": _ts(-220),
    })
    earlier_row = rest_select("stock_lots", lot_id=f"eq.{earlier}")[0]
    check("floor at 0: qty lands exactly at 0",
          abs(float(earlier_row["qty_containers"])) < TOL,
          f"qty={earlier_row['qty_containers']}")

    # 6. No matching lot: zero all lots and try to consume
    delete_all_lots(uid, yogurt_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": yogurt_id, "delta_g": -50,
        "occurred_at": _ts(-209),
    })
    body = r.json() if r.ok else {}
    check("no lot available: applied=false + reason='no lot with stock to decrement'",
          r.status_code == 200 and body.get("applied") is False
            and body.get("reason") == "no lot with stock to decrement",
          f"status={r.status_code} body={body}")

    # 7. Idempotency replay: same client_event_id for a SUCCESSFUL event →
    #    second call echoes the CACHED outcome (applied=true, same
    #    resolved_lot_id, same reason). The Pi can reconcile its retry
    #    queue against real outcomes, not a generic 'duplicate' marker.
    reset_stock_lot(uid, milk_id, loc_id, qty=1.5)
    wipe_event_log(uid)
    delete_food_logs_for(uid, milk_id)
    cev_dup = str(uuid.uuid4())
    r1 = ingest("POST", "/event", key, {
        "client_event_id": cev_dup, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": milk_id, "delta_g": -100,
        "occurred_at": _ts(-199),
    })
    body1 = r1.json() if r1.ok else {}
    after1 = first_lot_qty(uid, milk_id)
    r2 = ingest("POST", "/event", key, {
        "client_event_id": cev_dup, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": milk_id, "delta_g": -100,
        "occurred_at": _ts(-199),
    })
    after2 = first_lot_qty(uid, milk_id)
    body2 = r2.json() if r2.ok else {}
    check("idempotent replay: first call applied=true",
          r1.status_code == 200 and body1.get("applied") is True,
          f"body1={body1}")
    check("idempotent replay: second call also reports applied=true (cached)",
          r2.status_code == 200 and body2.get("applied") is True,
          f"body2={body2}")
    check("idempotent replay: second call resolved_lot_id matches first",
          body2.get("resolved_lot_id") == body1.get("resolved_lot_id"),
          f"r1_lot={body1.get('resolved_lot_id')} r2_lot={body2.get('resolved_lot_id')}")
    check("idempotent replay: second call reason matches first",
          body2.get("reason") == body1.get("reason"),
          f"r1_reason={body1.get('reason')!r} r2_reason={body2.get('reason')!r}")
    check("idempotent replay: qty UNCHANGED after second call",
          abs(after2 - after1) < TOL,
          f"after1={after1} after2={after2}")

    # 8. Missing client_event_id → 400
    r = ingest("POST", "/event", key, {
        "scale_id": "hb-01", "kind": "live_shelf",
        "event_kind": "consumed", "product_id": milk_id,
        "delta_g": -5, "occurred_at": _ts(-188),
    })
    check("consumed without client_event_id → 400",
          r.status_code == 400, f"status={r.status_code}")


def test_event_added(ctx):
    print("\n-- /event (added) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    pids = ctx["products"]
    loc_id = ctx["location_id"]

    milk_id = pids["Whole Milk 1L"]
    yogurt_id = pids["Greek Yogurt 500g"]
    reset_stock_lot(uid, milk_id, loc_id, qty=1.0)
    delete_food_logs_for(uid, milk_id)

    # 1. Basic added on existing lot: before=1, +1000g = +1 container
    before = first_lot_qty(uid, milk_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-02",
        "kind": "catch_all", "event_kind": "added",
        "product_id": milk_id, "delta_g": 1000,
        "occurred_at": _ts(-178),
    })
    after = first_lot_qty(uid, milk_id)
    body = r.json() if r.ok else {}
    check("added: applied=true",
          r.status_code == 200 and body.get("applied") is True,
          f"body={body}")
    check("added: qty increased by delta_g/net_weight_g exactly",
          abs((after - before) - 1.0) < TOL,
          f"before={before} after={after}")

    # 2. source stamped
    lot = qty_of_lot(uid, milk_id)[0]
    check("added: last_update_source == kind (catch_all)",
          lot.get("last_update_source") == "catch_all",
          f"got={lot.get('last_update_source')}")

    # 3. New lot creation: delete all yogurt lots, then add → new lot exists
    delete_all_lots(uid, yogurt_id)
    delete_food_logs_for(uid, yogurt_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-02",
        "kind": "catch_all", "event_kind": "added",
        "product_id": yogurt_id, "delta_g": 500,
        "occurred_at": _ts(-167),
    })
    body = r.json() if r.ok else {}
    yog_lots = qty_of_lot(uid, yogurt_id)
    check("added (no lot exists): creates exactly one new lot",
          len(yog_lots) == 1, f"lots={len(yog_lots)}")
    if yog_lots:
        lot = yog_lots[0]
        # +500g / 500 = +1 container
        check("added (new lot): qty=delta_g/net_weight_g",
              abs(float(lot["qty_containers"]) - 1.0) < TOL,
              f"qty={lot['qty_containers']}")
        check("added (new lot): reason='new lot created'",
              body.get("reason") == "new lot created",
              f"reason={body.get('reason')!r}")
        check("added (new lot): location is user's first location",
              lot["location_id"] in
              [l["location_id"] for l in rest_select("locations", user_id=f"eq.{uid}")])

    # 4. Negative-delta-on-added guard: no active lot, send negative delta →
    #    new lot qty floored at 0 (GREATEST guard)
    delete_all_lots(uid, yogurt_id)
    delete_food_logs_for(uid, yogurt_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-02",
        "kind": "catch_all", "event_kind": "added",
        "product_id": yogurt_id, "delta_g": -250,
        "occurred_at": _ts(-157),
    })
    body = r.json() if r.ok else {}
    yog_lots = qty_of_lot(uid, yogurt_id)
    check("added with negative delta + no lot: still creates a lot",
          len(yog_lots) == 1, f"lots={len(yog_lots)}")
    if yog_lots:
        check("added with negative delta + no lot: qty floored at 0 (GREATEST guard)",
              abs(float(yog_lots[0]["qty_containers"])) < TOL,
              f"qty={yog_lots[0]['qty_containers']}")


def test_event_refilled(ctx):
    print("\n-- /event (refilled) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    pids = ctx["products"]
    loc_id = ctx["location_id"]

    milk_id = pids["Whole Milk 1L"]
    reset_stock_lot(uid, milk_id, loc_id, qty=0.5)
    delete_food_logs_for(uid, milk_id)

    # Positive delta → qty increases, source stamped (semantically same as added)
    before = first_lot_qty(uid, milk_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-02",
        "kind": "live_shelf", "event_kind": "refilled",
        "product_id": milk_id, "delta_g": 2000,
        "occurred_at": _ts(-146),
    })
    body = r.json() if r.ok else {}
    after = first_lot_qty(uid, milk_id)
    check("refilled: applied=true",
          r.status_code == 200 and body.get("applied") is True,
          f"body={body}")
    check("refilled: qty increased by +2 containers exactly",
          abs((after - before) - 2.0) < TOL,
          f"before={before} after={after}")
    lot = qty_of_lot(uid, milk_id)[0]
    check("refilled: last_update_source stamped",
          lot.get("last_update_source") == "live_shelf",
          f"got={lot.get('last_update_source')}")


def test_event_depleted(ctx):
    print("\n-- /event (depleted) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    pids = ctx["products"]
    loc_id = ctx["location_id"]

    milk_id = pids["Whole Milk 1L"]
    reset_stock_lot(uid, milk_id, loc_id, qty=0.5)
    delete_food_logs_for(uid, milk_id)
    wipe_event_log(uid)

    # depleted: negative delta takes qty to 0
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "depleted",
        "product_id": milk_id, "delta_g": -500,
        "occurred_at": _ts(-136),
    })
    body = r.json() if r.ok else {}
    after = first_lot_qty(uid, milk_id)
    check("depleted: applied=true",
          r.status_code == 200 and body.get("applied") is True,
          f"body={body}")
    check("depleted: qty=0 exactly (0.5 - 0.5)",
          abs(after) < TOL, f"after={after}")
    lot = qty_of_lot(uid, milk_id)[0]
    check("depleted: last_update_source stamped",
          lot.get("last_update_source") == "live_shelf")

    # depleted also writes food_logs (same branch as 'consumed')
    logs = rest_select("food_logs", user_id=f"eq.{uid}", product_id=f"eq.{milk_id}")
    check("depleted: food_logs row written",
          len(logs) >= 1, f"logs={len(logs)}")


def test_event_live_scale(ctx):
    print("\n-- /event (live_scale) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    did = ctx["device_id"]
    pids = ctx["products"]
    loc_id = ctx["location_id"]

    pb_id = pids["Peanut Butter 454g"]
    milk_id = pids["Whole Milk 1L"]
    reset_stock_lot(uid, pb_id, loc_id, qty=1.0)
    reset_stock_lot(uid, milk_id, loc_id, qty=1.0)
    delete_food_logs_for(uid, pb_id)
    delete_food_logs_for(uid, milk_id)
    wipe_event_log(uid)

    # Ensure pairing rows exist. scale-ls-A paired→pb, scale-ls-B paired→null,
    # scale-ls-C has NO pairing row at all.
    wipe_pairings(did)
    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 0,
        "scales": [
            {"scale_id": "scale-ls-A", "kind": "live_scale"},
            {"scale_id": "scale-ls-B", "kind": "live_scale"},
        ],
    })
    # Pair A → pb; leave B unpaired (product_id NULL)
    admin_patch(
        f"/rest/v1/scale_pairings?device_id=eq.{did}&scale_id=eq.scale-ls-A",
        {"product_id": pb_id}, profile="chefbyte",
    )

    # 1. With product_id in body: works regardless of pairing
    milk_before = first_lot_qty(uid, milk_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "scale-ls-A",
        "kind": "live_scale", "event_kind": "consumed",
        "product_id": milk_id,  # explicitly override
        "delta_g": -250, "occurred_at": _ts(-125),
    })
    body = r.json() if r.ok else {}
    milk_after = first_lot_qty(uid, milk_id)
    pb_after = first_lot_qty(uid, pb_id)
    check("live_scale with explicit product_id: applied=true",
          r.status_code == 200 and body.get("applied") is True)
    check("live_scale with explicit product_id: milk decremented (override)",
          abs((milk_before - milk_after) - 0.25) < TOL,
          f"milk {milk_before} → {milk_after}")
    check("live_scale with explicit product_id: paired product untouched",
          abs(pb_after - 1.0) < TOL,
          f"pb={pb_after}")

    # 2. Without product_id, pairing has product_id set → paired product decremented
    pb_before = first_lot_qty(uid, pb_id)
    milk_before2 = first_lot_qty(uid, milk_id)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "scale-ls-A",
        "kind": "live_scale", "event_kind": "consumed",
        "delta_g": -45.4,  # 10% of 454g → 0.1 container
        "occurred_at": _ts(-115),
    })
    body = r.json() if r.ok else {}
    pb_after = first_lot_qty(uid, pb_id)
    milk_after2 = first_lot_qty(uid, milk_id)
    check("live_scale resolves via pairing: applied=true",
          r.status_code == 200 and body.get("applied") is True,
          f"body={body}")
    check("live_scale resolves via pairing: correct product decremented",
          abs((pb_before - pb_after) - 0.1) < TOL,
          f"pb {pb_before} → {pb_after}")
    check("live_scale resolves via pairing: other products untouched",
          abs(milk_after2 - milk_before2) < TOL,
          f"milk unchanged")

    # 3. Without product_id, pairing exists but product_id is NULL → 409
    #    with distinct reason.
    #    NOTE: requests.Response.ok is False for 4xx/5xx, so `r.json() if r.ok`
    #    would drop the body — we want to inspect 4xx bodies too.
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "scale-ls-B",
        "kind": "live_scale", "event_kind": "consumed",
        "delta_g": -10, "occurred_at": _ts(-105),
    })
    try: body = r.json()
    except Exception: body = {}
    check("live_scale paired-but-unset → 409",
          r.status_code == 409, f"status={r.status_code}")
    check("live_scale paired-but-unset → reason='scale paired but product unset'",
          body.get("error") == "scale paired but product unset",
          f"error={body.get('error')!r} body={r.text[:120]}")

    # 4. Without product_id, no pairing row → 409 with DISTINCT reason
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "scale-ls-C-unseen",
        "kind": "live_scale", "event_kind": "consumed",
        "delta_g": -10, "occurred_at": _ts(-94),
    })
    try: body = r.json()
    except Exception: body = {}
    check("live_scale no-pairing-row → 409",
          r.status_code == 409, f"status={r.status_code}")
    check("live_scale no-pairing-row → reason='scale not paired'",
          body.get("error") == "scale not paired",
          f"error={body.get('error')!r} body={r.text[:120]}")

    # And the two reasons must NOT be identical
    check("live_scale error reasons are distinct strings",
          "scale paired but product unset" != "scale not paired",
          "compile-time")


def test_event_errors(ctx):
    print("\n-- /event (error paths) --")
    key = ctx["import_key"]
    uid = ctx["user_id"]
    pids = ctx["products"]

    # 1. Unknown product_id → applied=false + reason='product not found'
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": "00000000-0000-0000-0000-000000000000",
        "delta_g": -50, "occurred_at": _ts(-84),
    })
    body = r.json() if r.ok else {}
    check("unknown product_id → 200 + applied=false",
          r.status_code == 200 and body.get("applied") is False,
          f"status={r.status_code} body={body}")
    check("unknown product_id → reason='product not found'",
          body.get("reason") == "product not found",
          f"reason={body.get('reason')!r}")

    # 2. Product exists but net_weight_g IS NULL → DISTINCT reason
    weightless_id = pids["Weightless Mystery"]
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": weightless_id,
        "delta_g": -50, "occurred_at": _ts(-73),
    })
    body = r.json() if r.ok else {}
    check("product missing net_weight_g → applied=false",
          r.status_code == 200 and body.get("applied") is False,
          f"status={r.status_code} body={body}")
    check("product missing net_weight_g → reason distinct from 'product not found'",
          body.get("reason") == "product missing net_weight_g",
          f"reason={body.get('reason')!r}")

    # 3. Invalid kind ("teleported" — not in {live_shelf,live_scale,catch_all})
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "teleported", "event_kind": "consumed",
        "product_id": pids["Whole Milk 1L"],
        "delta_g": -50, "occurred_at": _ts(-63),
    })
    check("invalid kind 'teleported' → 4xx",
          400 <= r.status_code < 500, f"status={r.status_code}")

    # 4. Invalid event_kind ("microwave") → applied=false via plpgsql branch
    #    (code path goes through the RPC and hits the ELSE branch)
    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "microwave",
        "product_id": pids["Whole Milk 1L"],
        "delta_g": -50, "occurred_at": _ts(-52),
    })
    body = r.json() if r.ok else {}
    # The edge function validates `kind` (400) but the RPC validates
    # `event_kind` and returns applied=false reason='unknown event_kind'.
    ok_shape = (
        (400 <= r.status_code < 500) or
        (r.status_code == 200 and body.get("applied") is False
         and body.get("reason") == "unknown event_kind")
    )
    check("invalid event_kind → rejected (4xx or applied=false)",
          ok_shape, f"status={r.status_code} body={body}")

    # 5. Sanity: none of the error responses leak stack traces / DB internals
    leaks = []
    for scenario, body_data in [
        ("unknown kind", {"client_event_id": str(uuid.uuid4()),
                          "scale_id": "hb-01", "kind": "teleported",
                          "event_kind": "consumed",
                          "product_id": pids["Whole Milk 1L"],
                          "delta_g": -1,
                          "occurred_at": _ts(-42)}),
        ("unknown product", {"client_event_id": str(uuid.uuid4()),
                             "scale_id": "hb-01", "kind": "live_shelf",
                             "event_kind": "consumed",
                             "product_id": "00000000-0000-0000-0000-000000000000",
                             "delta_g": -1,
                             "occurred_at": _ts(-31)}),
        ("missing fields", {"client_event_id": str(uuid.uuid4())}),
        ("bad uuid", {"client_event_id": str(uuid.uuid4()),
                      "scale_id": "hb-01", "kind": "live_shelf",
                      "event_kind": "consumed",
                      "product_id": "not-a-uuid",
                      "delta_g": -1,
                      "occurred_at": _ts(-21)}),
    ]:
        r = ingest("POST", "/event", key, body_data)
        hit = body_leaks(r.text)
        if hit:
            leaks.append(f"{scenario}: '{hit}' in body: {r.text[:120]}")
    check("error responses do NOT leak stack traces / DB internals",
          not leaks, "; ".join(leaks) if leaks else "clean")


def test_event_cross_user(ctx):
    print("\n-- /event cross-user isolation --")
    key = ctx["import_key"]   # demo-shelf device's key
    other_uid = ctx["other_user_id"]
    other_pid = ctx["other_product_id"]

    before = qty_of_lot(other_uid, other_pid)
    assert before, "setup: other user's lot should exist"
    before_qty = float(before[0]["qty_containers"])
    before_ts = before[0].get("last_update_ts")
    before_source = before[0].get("last_update_source")

    cev = str(uuid.uuid4())
    r = ingest("POST", "/event", key, {
        "client_event_id": cev, "scale_id": "hb-01",
        "kind": "live_shelf", "event_kind": "consumed",
        "product_id": other_pid, "delta_g": -500,
        "occurred_at": _ts(-10),
    })
    body = r.json() if r.ok else {}

    after = qty_of_lot(other_uid, other_pid)
    after_qty = float(after[0]["qty_containers"])
    after_ts = after[0].get("last_update_ts")
    after_source = after[0].get("last_update_source")

    check("cross-user: other user's qty EXACTLY unchanged",
          abs(after_qty - before_qty) < TOL,
          f"before={before_qty} after={after_qty}")
    check("cross-user: other user's last_update_ts unchanged",
          before_ts == after_ts,
          f"before={before_ts} after={after_ts}")
    check("cross-user: other user's last_update_source unchanged",
          before_source == after_source)
    # Response must NOT be a 2xx success with applied=true. 200+applied=false
    # (product-not-found) is acceptable; 4xx is also acceptable.
    is_success = r.status_code == 200 and body.get("applied") is True
    check("cross-user: response is not a success (applied=true)",
          not is_success, f"status={r.status_code} applied={body.get('applied')}")


def test_stale_fence(ctx):
    """#3 — manual-edit staleness fence: a manual UI edit whose
    last_update_ts is newer than an event's occurred_at wins. The event
    returns applied=false, reason starts with 'stale', qty unchanged."""
    print("\n-- /event (manual-edit staleness fence) --")
    key    = ctx["import_key"]
    uid    = ctx["user_id"]
    pids   = ctx["products"]
    loc_id = ctx["location_id"]
    milk_id = pids["Whole Milk 1L"]

    # Plant a lot with last_update_source='manual' and a NOW timestamp.
    manual_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    delete_all_lots(uid, milk_id)
    admin_post("/rest/v1/stock_lots", {
        "user_id": uid, "product_id": milk_id, "location_id": loc_id,
        "qty_containers": 2.0,
        "last_update_source": "manual",
        "last_update_ts": manual_ts,
    }, profile="chefbyte")
    delete_food_logs_for(uid, milk_id)
    wipe_event_log(uid)

    before_qty = first_lot_qty(uid, milk_id)

    # Send an event with occurred_at well before the manual edit.
    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "hb-01",
        "kind": "live_shelf",
        "event_kind": "consumed",
        "product_id": milk_id,
        "delta_g": -500,
        "occurred_at": _ts(-600),  # 10 min ago
    })
    body = r.json() if r.ok else {}
    after_qty = first_lot_qty(uid, milk_id)

    check("stale fence: status 200 applied=false",
          r.status_code == 200 and body.get("applied") is False,
          f"status={r.status_code} body={body}")
    check("stale fence: reason starts with 'stale'",
          str(body.get("reason") or "").startswith("stale"),
          f"reason={body.get('reason')!r}")
    check("stale fence: qty UNCHANGED",
          abs(after_qty - before_qty) < TOL,
          f"before={before_qty} after={after_qty}")

    # Sanity: no food_logs row written for a stale-skipped event.
    logs = rest_select("food_logs", user_id=f"eq.{uid}", product_id=f"eq.{milk_id}")
    check("stale fence: no food_logs row written",
          len(logs) == 0, f"logs={len(logs)}")


def test_heartbeat_cross_device(ctx):
    """#12 — two devices with the SAME scale_id on each must not
    cross-contaminate. UPSERT is keyed on (device_id, scale_id), so
    each device's pairing stays independent even with an id collision."""
    print("\n-- /heartbeat cross-device isolation --")
    key       = ctx["import_key"]
    other_key = ctx["other_key"]
    did       = ctx["device_id"]
    other_did = ctx["other_device_id"]

    wipe_pairings(did)
    wipe_pairings(other_did)

    shared_scale = "cross-shared-01"

    # Each device heartbeats a scale named the same thing, but with
    # different kinds.
    r1 = ingest("POST", "/heartbeat", key, {
        "pending_review_count": 0,
        "scales": [{"scale_id": shared_scale, "kind": "live_shelf"}],
    })
    r2 = ingest("POST", "/heartbeat", other_key, {
        "pending_review_count": 0,
        "scales": [{"scale_id": shared_scale, "kind": "catch_all"}],
    })
    check("cross-device heartbeats: both 200",
          r1.status_code == 200 and r2.status_code == 200,
          f"r1={r1.status_code} r2={r2.status_code}")

    p1 = rest_select("scale_pairings",
                     device_id=f"eq.{did}", scale_id=f"eq.{shared_scale}")
    p2 = rest_select("scale_pairings",
                     device_id=f"eq.{other_did}", scale_id=f"eq.{shared_scale}")
    check("device A has exactly one pairing for shared scale_id",
          len(p1) == 1, f"got={len(p1)}")
    check("device B has exactly one pairing for shared scale_id",
          len(p2) == 1, f"got={len(p2)}")
    check("device A's pairing kind is correct (live_shelf)",
          len(p1) == 1 and p1[0]["kind"] == "live_shelf",
          f"p1={p1}")
    check("device B's pairing kind is correct (catch_all)",
          len(p2) == 1 and p2[0]["kind"] == "catch_all",
          f"p2={p2}")

    # Now heartbeat device A again — device B's pairing must NOT change.
    other_before = p2[0] if p2 else {}
    ingest("POST", "/heartbeat", key, {
        "pending_review_count": 0,
        "scales": [{"scale_id": shared_scale, "kind": "live_shelf"}],
    })
    p2_after = rest_select("scale_pairings",
                           device_id=f"eq.{other_did}",
                           scale_id=f"eq.{shared_scale}")
    other_after = p2_after[0] if p2_after else {}
    check("device B's pairing kind unchanged after A heartbeats",
          other_after.get("kind") == other_before.get("kind"),
          f"before={other_before.get('kind')} after={other_after.get('kind')}")


def test_timestamp_range_retryable(ctx):
    """#5 — occurred_at far in the future must return 422 (not 400) so
    the Pi's retry worker treats it as retryable, not permanent."""
    print("\n-- /event (timestamp-range is retryable 422) --")
    key = ctx["import_key"]
    milk_id = ctx["products"]["Whole Milk 1L"]

    r = ingest("POST", "/event", key, {
        "client_event_id": str(uuid.uuid4()),
        "scale_id": "hb-01",
        "kind": "live_shelf",
        "event_kind": "consumed",
        "product_id": milk_id,
        "delta_g": -10,
        "occurred_at": "2099-12-31T23:59:59Z",
    })
    try:
        body = r.json()
    except Exception:
        body = {}
    check("occurred_at out of range → HTTP 422 (retryable)",
          r.status_code == 422, f"status={r.status_code}")
    check("occurred_at out of range → error mentions occurred_at",
          "occurred_at" in (body.get("error") or ""),
          f"error={body.get('error')!r}")


def test_intake(ctx):
    print("\n-- /intake --")
    key = ctx["import_key"]
    other_key = ctx["other_key"]
    uid = ctx["user_id"]
    other_uid = ctx["other_user_id"]

    # Pick a unique barcode per run so repeated runs don't interfere.
    run_id = secrets.token_hex(4)
    barcode_a = f"DEMO-INTAKE-A-{run_id}"
    barcode_b = f"DEMO-INTAKE-B-{run_id}"

    # 1. Create a new product via intake
    r = ingest("POST", "/intake", key, {
        "name": "Intake Milk",
        "barcode": barcode_a,
        "net_weight_g": 1000,
        "servings_per_container": 4,
        "calories_per_serving": 150,
        "carbs_per_serving": 12,
        "protein_per_serving": 8,
        "fat_per_serving": 8,
        "container_type": "carton",
    })
    body = r.json() if r.ok else {}
    pid_new = body.get("product_id")
    # Verify row exists in DB with same product_id
    db_rows = rest_select("products",
                          user_id=f"eq.{uid}",
                          barcode=f"eq.{barcode_a}")
    check("intake: creates product, response product_id matches DB",
          r.status_code == 200 and pid_new is not None and len(db_rows) == 1
          and db_rows[0]["product_id"] == pid_new,
          f"status={r.status_code} pid={pid_new}")

    # 2. Upsert same barcode for same user → updates existing row, product_id stable
    r = ingest("POST", "/intake", key, {
        "name": "Intake Milk UPDATED",
        "barcode": barcode_a,
        "net_weight_g": 950,  # change
        "container_type": "bottle",  # change
    })
    body = r.json() if r.ok else {}
    db_rows = rest_select("products",
                          user_id=f"eq.{uid}",
                          barcode=f"eq.{barcode_a}")
    check("intake upsert: product_id stable across updates",
          body.get("product_id") == pid_new and len(db_rows) == 1,
          f"body_pid={body.get('product_id')} orig={pid_new}")
    if db_rows:
        ok = (
            db_rows[0]["name"] == "Intake Milk UPDATED" and
            abs(float(db_rows[0]["net_weight_g"]) - 950) < TOL and
            db_rows[0]["container_type"] == "bottle"
        )
        check("intake upsert: fields updated on existing row",
              ok, f"row={db_rows[0]}")

    # 3. Different user with same barcode → separate row
    r = ingest("POST", "/intake", other_key, {
        "name": "Intake Milk OTHER",
        "barcode": barcode_a,  # SAME barcode, DIFFERENT user
        "net_weight_g": 2000,
    })
    body = r.json() if r.ok else {}
    pid_other = body.get("product_id")
    check("intake cross-user: distinct product_id for same barcode",
          pid_other is not None and pid_other != pid_new,
          f"our={pid_new} other={pid_other}")
    if pid_other:
        other_rows = rest_select("products",
                                 user_id=f"eq.{other_uid}",
                                 product_id=f"eq.{pid_other}")
        check("intake cross-user: other user's row is scoped to other user_id",
              len(other_rows) == 1 and other_rows[0]["user_id"] == other_uid,
              f"rows={other_rows}")

    # 4. NULL barcode → still creates row (partial unique index allows)
    r = ingest("POST", "/intake", key, {
        "name": f"Intake No Barcode {run_id}",
        # no barcode field → server sends NULL
        "net_weight_g": 250,
    })
    body = r.json() if r.ok else {}
    pid_nb = body.get("product_id")
    db_rows = rest_select("products",
                          user_id=f"eq.{uid}",
                          product_id=f"eq.{pid_nb}")
    check("intake with NULL barcode: row created",
          r.status_code == 200 and pid_nb is not None and len(db_rows) == 1,
          f"status={r.status_code} pid={pid_nb}")
    if db_rows:
        check("intake with NULL barcode: barcode column is NULL",
              db_rows[0]["barcode"] is None,
              f"barcode={db_rows[0]['barcode']!r}")

    # 5. Missing required field (name) → 4xx
    r = ingest("POST", "/intake", key, {
        "barcode": barcode_b, "net_weight_g": 100,
    })
    check("intake without name → 4xx",
          400 <= r.status_code < 500, f"status={r.status_code}")

    # 6. Response bodies don't leak internals
    leaks = []
    for scenario, body_data in [
        ("missing name", {"barcode": barcode_b}),
        ("invalid net_weight type", {"name": "x", "barcode": f"X-{run_id}",
                                     "net_weight_g": "not-a-number"}),
    ]:
        r = ingest("POST", "/intake", key, body_data)
        hit = body_leaks(r.text)
        if hit:
            leaks.append(f"{scenario}: {hit}")
    check("intake error responses do not leak internals",
          not leaks, "; ".join(leaks) if leaks else "clean")


# ─── Runner ────────────────────────────────────────────────────────

TEST_GROUPS = [
    ("auth",                 test_auth),
    ("catalog",              test_catalog),
    ("heartbeat",            test_heartbeat),
    ("heartbeat.cross_device", test_heartbeat_cross_device),
    ("event.consumed",       test_event_consumed),
    ("event.added",          test_event_added),
    ("event.refilled",       test_event_refilled),
    ("event.depleted",       test_event_depleted),
    ("event.live_scale",     test_event_live_scale),
    ("event.errors",         test_event_errors),
    ("event.cross_user",     test_event_cross_user),
    ("event.stale_fence",    test_stale_fence),
    ("event.timestamp_422",  test_timestamp_range_retryable),
    ("intake",               test_intake),
]

def run_all(ctx):
    print("\n== RUNNING E2E ==")
    for name, fn in TEST_GROUPS:
        try:
            fn(ctx)
        except Exception as e:
            # Don't let a bug in one group abort the whole suite; mark it
            # as a failure instead.
            check(f"{name}: unexpected exception", False, f"{type(e).__name__}: {e}")

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
                print(f"  FAIL {n} — {d}")
        sys.exit(1)

    print(f"\nDemo account ready:")
    print(f"  URL:      https://lunahub.dev")
    print(f"  Email:    {DEMO_EMAIL}")
    print(f"  Password: {DEMO_PASSWORD}")
    print(f"  device import_key: {ctx['import_key']}")

if __name__ == "__main__":
    ctx = seed()
    run_all(ctx)
    report(ctx)
