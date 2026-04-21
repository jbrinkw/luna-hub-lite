# CATCH_ALL_TARE_CAPTURE_PLAN

## 1. Summary

Add a human-in-the-loop tare-capture flow: the operator clicks a "Tare" button on any row in the certified-products catalog on `/inventory`, which arms a one-shot listener keyed to the catch-all scale (`device_id=scale-02`). The next non-noise catch-all event is intercepted — its `after_weight_g` is written to `products.tare_weight_g` (column already exists) and the event is NOT fed into the normal delta-detection pipeline. Arming state is persisted in a new single-row SQLite table so it survives Flask restarts and is trivially atomic under the existing `_db_lock`.

## 2. Files to read before writing code

- `hardware/live-shelf/server/handlers/scale_events.py` — `ScaleHandler.handle_scale_event` (line 1518) is where the branch goes; `_db_lock` + `_dedup_set` contracts must be preserved.
- `hardware/live-shelf/server/shelves.py` — confirms `scale-02` → `catch_all` mapping and the `get_shelf_for_device` helper the branch re-uses.
- `hardware/live-shelf/server/storage/schema.sql` — confirms `products.tare_weight_g REAL` already exists (line 13). No product-side migration needed.
- `hardware/live-shelf/server/storage/migrations.py` — the `_apply_idempotent_migrations` pattern is where the new `tare_arm` table's `CREATE TABLE IF NOT EXISTS` goes.
- `hardware/live-shelf/server/storage/repo.py` — add `tare_arm_*` helpers and a `set_product_tare(product_id, tare_g)` helper here (existing `set_product_certified` at line 309 is the pattern).
- `hardware/live-shelf/server/web/api_routes.py` — `make_api_bp` is where `/api/product/<id>/tare/arm` and `/api/product/<id>/tare/status` and `/api/tare/cancel` routes go; follows the `api_product_delete` pattern (line 397).
- `hardware/live-shelf/server/web/routes.py` — `inventory()` at line 303 is already rendering `catalog`; pass `tare_arm_state` into the template.
- `hardware/live-shelf/server/web/templates/inventory.html` — the catalog table at line 411 gets a new `<th>` + per-row button; the JS section at line 474 gets a new handler.
- `hardware/live-shelf/firmware/scale-catch-all.ino` — lines 981–986 confirm firmware emits `before_weight_g` (prior stable plateau) and `after_weight_g` (new stable plateau) both in absolute grams relative to the ESP's own zero; `delta_g = after - before`. Confirms tare-capture uses `after_weight_g` (absolute) not `delta_g`. See §5 below for rationale.
- `hardware/live-shelf/server/intake/ai_tare.py` — reference for how a tare value is produced and persisted through the wizard; the manual flow ends up writing the same column (`products.tare_weight_g`) so downstream lot-depletion math is unchanged.

## 3. Schema changes

No changes to existing tables. One new SQLite table via idempotent migration in `storage/migrations.py`:

```sql
CREATE TABLE IF NOT EXISTS tare_arm (
  id                 INTEGER PRIMARY KEY CHECK(id = 1),
  product_id         TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  device_id          TEXT NOT NULL DEFAULT 'scale-02',
  armed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at         TEXT NOT NULL,
  min_weight_g       REAL NOT NULL DEFAULT 5.0,
  max_weight_g       REAL NOT NULL DEFAULT 5000.0,
  last_error         TEXT
);
```

Single-row (id=1) table chosen over a row-per-arm because the feature is explicitly one-shot and owner UX is "one product at a time." Re-arming on a different product is an `INSERT OR REPLACE`.

## 4. Backend changes (in order of implementation)

1. **`storage/migrations.py`** — append a block in `_apply_idempotent_migrations` that runs the `CREATE TABLE IF NOT EXISTS tare_arm` above. No default row — arming writes, cancelling deletes.

2. **`storage/repo.py`** — add four helpers:
   - `arm_tare(conn, product_id, *, device_id='scale-02', ttl_s=60, min_weight_g=5.0, max_weight_g=5000.0) -> None` — `INSERT OR REPLACE` into `tare_arm` with id=1 and `expires_at = datetime('now', '+{ttl_s} seconds')`. Re-arming overwrites (owner preference: simplest mental model — there is always at most one target).
   - `get_active_tare_arm(conn, *, device_id='scale-02', now_iso=None) -> Optional[TareArm]` — selects the row when `expires_at > now`, returns None otherwise. Rows past expiry are left in-place; next `arm_tare` overwrites, or a housekeeping pass clears them.
   - `consume_tare_arm(conn, *, product_id, tare_g) -> bool` — within a single transaction: UPDATE `products.tare_weight_g = ?, updated_at = datetime('now')` WHERE product_id; DELETE FROM tare_arm WHERE id=1. Returns True on row-affected.
   - `cancel_tare_arm(conn) -> None` — DELETE FROM tare_arm WHERE id=1.
   - `clear_stale_tare_arm(conn, *, older_than_s=600) -> int` — called once at app startup (idempotent cleanup of stale arm rows from a crashed prior session).

3. **`handlers/scale_events.py`** — in `handle_scale_event` (line 1518), **before the dedup check** (so duplicate retries don't fire the tare twice) and **after the `shelf` resolution** (we need the shelf_id):

   ```python
   # Tare-arm interception (catch-all only). Must short-circuit BEFORE the
   # normal session/dedup pipeline so a legit but-arming-active event
   # doesn't leak into reconciliation.
   if shelf_id == "catch_all" and direction != "noise":
       with self._db_lock:
           arm = storage_repo.get_active_tare_arm(
               self._conn, device_id=device_id,
           )
           if arm is not None:
               tare_g = float(after_weight_g)
               if tare_g < arm.min_weight_g or tare_g > arm.max_weight_g:
                   storage_repo.set_tare_arm_error(
                       self._conn,
                       f"implausible reading {tare_g:.1f}g",
                   )
                   return {
                       "ok": True, "tare_captured": False,
                       "reason": "implausible_weight",
                       "weight_g": tare_g,
                   }, 200
               storage_repo.consume_tare_arm(
                   self._conn,
                   product_id=arm.product_id,
                   tare_g=tare_g,
               )
               self._lc_event(
                   "n/a", actor="tare_capture",
                   reason_code="TARE_CAPTURE",
                   payload={
                       "product_id": arm.product_id,
                       "device_id": device_id,
                       "weight_g": tare_g,
                       "esp_ts": ts, "pi_ts": pi_received_ts,
                   },
               )
       # If we captured, short-circuit before recording scale_events row.
       if arm is not None:
           return {
               "ok": True, "tare_captured": True,
               "product_id": arm.product_id, "tare_g": tare_g,
           }, 200
   ```

   `direction == "noise"` events are never intercepted — those are sub-threshold and meaningless as tare values. `direction in {"add","remove"}` are both acceptable (the user may be removing the container from the scale, in which case we use `before_weight_g` — but for v1 we use `after_weight_g` and require the user to place the container and leave it. See §5.)

4. **`web/api_routes.py`** — add three routes to `make_api_bp`:
   - `POST /api/product/<product_id>/tare/arm` — validates product exists and is `certified=1`; calls `storage_repo.arm_tare`; returns `{ok, expires_at, product_id}`.
   - `POST /api/tare/cancel` — calls `storage_repo.cancel_tare_arm`; returns `{ok}`.
   - `GET /api/tare/status` — returns `{armed: bool, product_id, product_name, expires_at, seconds_remaining, last_error}`. Consumed by the inventory page for polling.

5. **`web/routes.py`** — in `inventory()` (line 303), call `repo.get_active_tare_arm()` and pass as `tare_arm=` into `render_template`. Add a read-through on `WebRepo` (class at top of `web/routes.py`): `get_active_tare_arm(self) -> Optional[dict]`.

6. **`app.py`** — at startup (right after `_apply_idempotent_migrations` completes), call `storage_repo.clear_stale_tare_arm(conn, older_than_s=600)` so a crash-mid-arm doesn't leave a ghost row that steals the next catch-all event after restart.

## 5. UI changes

### 5.1 `inventory.html` — catalog table (line 411 section)

Add a new column header `<th>action</th>` before the existing `<th></th>` delete-cell.
In each catalog row add a `<td>` with:

```html
<button
  class="arm-tare"
  data-product-id="{{ p.product_id }}"
  data-product-name="{{ p.name }}"
  {% if tare_arm and tare_arm.product_id == p.product_id %}
    data-armed="1"
  {% endif %}
>
  {% if tare_arm and tare_arm.product_id == p.product_id %}
    ARMED — place container...
  {% else %}
    Tare
  {% endif %}
</button>
```

A sticky top banner (inserted above the catalog `<div class="panel">`) renders when `tare_arm` is not None: "Tare capture armed for **{name}**. Place the empty container on the catch-all scale. Expires in <span id=tare-countdown>…</span>. [Cancel]".

### 5.2 JS additions (inside the existing `{% block scripts %}`)

- Handler on `.arm-tare[data-armed="1"]` → no-op (button is visually armed; clicking it again means "reconfirm", no backend call).
- Handler on `.arm-tare:not([data-armed])` → `POST /api/product/<id>/tare/arm`. On success: re-render the banner + button inline, start a 1 Hz poll of `/api/tare/status`. On the first poll that returns `{armed: false}` **and** the product's stored `tare_weight_g` has flipped non-null (fetch catalog row via `/api/state` extension — simpler: a new tiny `GET /api/product/<id>` returning the product row), show success toast "tare set to {X}g" and refresh the row. If `{armed: false}` with `last_error` present, show error toast. On timeout (expires_at passed with still `{armed: true}`), show a timeout toast and reset button.
- Banner Cancel button → `POST /api/tare/cancel`, clear banner.

### 5.3 Visual states

| State       | Button label              | Banner |
|-------------|---------------------------|--------|
| disarmed    | "Tare"                    | none |
| armed (this row) | "ARMED — place container" | sticky |
| armed (other row) | "Tare" (dimmed)           | sticky (for the other product) |
| success     | "Tare" (row refreshes with new tare column value) | toast + banner clears |
| timeout     | "Tare"                    | error toast |
| error       | "Tare"                    | error toast with `last_error` |

## 6. State machine for the arming lifecycle

```
                              (no row in tare_arm)
                              ┌──────────────┐
                              │   IDLE       │◄──────────────────┐
                              └──────┬───────┘                   │
                                     │                           │
                         POST arm/product_id=A                   │
                                     │                           │
                                     ▼                           │
                              ┌──────────────┐                   │
                              │  ARMED(A)    │                   │
                              └─┬────────┬───┘                   │
              ┌─────────────────┘        │                       │
              │                          │                       │
    catch_all event arrives          POST arm/B                  │
    with direction != noise               │                      │
              │                           ▼                      │
              │                    ┌──────────────┐              │
              │                    │  ARMED(B)    │───┐          │
              │                    │ (replaces A) │   │          │
              │                    └──────────────┘   │          │
              │                                       │          │
              ▼                                       │          │
   ┌────────────────────────┐  valid ──► consume_tare_arm + DELETE tare_arm
   │ weight in min..max?    │                                    │
   └────┬──────────────┬────┘                                    │
        │ no           │ yes                                     │
        ▼              ▼                                         │
   set last_error  write products.tare_weight_g                  │
   keep row        DELETE tare_arm row                           │
   (still armed)                                                 │
        │                                                        │
        └──►  UI polling shows last_error, user can cancel or retry
                                                                 │
    expires_at passes with no event:                             │
      next POST arm or clear_stale_tare_arm deletes ────────────┘
      (scale-event handler stops intercepting because
       get_active_tare_arm now returns None.)
```

Re-arming on product B cancels the A arm (owner asked: "re-targets" vs "cancel + re-arm — you decide"). Justification: mental model is "there is always one current target"; implementation is trivially `INSERT OR REPLACE id=1`; no risk of ambiguous "which one did my next weigh apply to." This matches the owner's UX description — "click, and then it will use the next event."

## 7. Test plan

Add `hardware/live-shelf/server/tests/test_tare_capture.py` (following `test_catch_all_scale_routing.py` scaffolding). Also extend `server/web/tests/test_api_extra.py` for the new routes.

1. **test_arm_intercepts_next_catch_all_event** — seed a certified product; POST to `/api/product/<id>/tare/arm`; call `handler.handle_scale_event({device_id:"scale-02", delta_g: 300, before_weight_g: 0, after_weight_g: 300, ...})`; assert `products.tare_weight_g == 300`, assert no row inserted into `scale_events`, assert `tare_arm` table is empty, response is `{ok:true, tare_captured:true}`.

2. **test_rearm_replaces_prior_arm** — arm on product A, then arm on product B without firing an event; fire one catch-all event; assert product B has tare set, product A still NULL, table empty.

3. **test_arm_expired_does_not_intercept_legit_event** — arm product A with `ttl_s=0` (or freeze-time patch); fire a catch-all `add` event; assert it went through the normal `scale_events` record path (row in DB), `products.tare_weight_g` still NULL, and the `tare_arm` row is either gone (after the `arm` INSERT OR REPLACE overwrite) or ignored because expired.

4. **test_implausible_reading_keeps_arm_active** — arm; fire event with `after_weight_g = 9000`; assert `tare_arm` row still present, `last_error` populated, `products.tare_weight_g` unchanged, response `{tare_captured:false, reason:"implausible_weight"}`.

5. **test_noise_event_does_not_consume_arm** — arm; fire event with `direction="noise"` (`delta_g` below threshold); assert arm row still present, product tare unchanged, scale_events noise row still recorded by the normal path.

6. **test_live_shelf_event_does_not_trigger_tare** — arm a product; fire a `scale-01` (`live_shelf`) event; assert arm still active, product tare unchanged, event recorded normally. (The `shelf_id == "catch_all"` guard is load-bearing.)

## 8. Open questions

1. **Cloud sync direction.** The existing sync is cloud → Pi (`cloud.integration.sync_products_from_cloud`). There is no Pi → cloud product-field push. Should a locally-captured tare propagate back to `chefbyte.products.tare_weight_g` in Supabase? Column exists in `packages/db-types/src/database.ts`. Flagged — out of scope per owner's instruction.
2. **TTL.** Plan uses 60 s default. Is this enough? The AI-tare flow has no analogous TTL because it's wizard-synchronous.
3. **Which weight to use: `after_weight_g` vs `delta_g`?** Plan uses `after_weight_g` (absolute). Rationale: if the user has been recently using the catch-all scale, `before_weight_g` may be non-zero drift but the HX711 auto-zero is slow; `after_weight_g` reflects the ESP's zero-referenced reading when the container is sitting stable. Needs owner confirm: for repeatable results, should the UX banner instruct "clear the scale, wait for zero-stable, then place the container" to guarantee `before_weight_g ≈ 0` and `delta_g ≈ after_weight_g`?
4. **Remove-direction events during arming.** If the user places the container *before* arming (so the scale is already non-zero), then clicks arm, then removes the container, the next event is a `remove` with `before_weight_g=container, after_weight_g≈0`. Should we use `before_weight_g` in that case, or require user to lift-then-replace? Plan uses `after_weight_g` unconditionally, which gets this wrong. Options: (a) document the lift-then-replace flow; (b) detect `direction=="remove"` and use `before_weight_g`.
5. **Multi-worker Flask.** Current app is single-process Gunicorn-less Flask (from reading `app.py`). If that ever changes to multi-worker, the SQLite-backed state works unchanged; an in-memory dict would not. Worth confirming the deploy model stays single-process.

## 9. Out of scope

- Firmware changes to `scale-catch-all.ino` — the `after_weight_g` field is already in the payload.
- Schema additions to `chefbyte.products` on Supabase (`tare_weight_g` already present).
- Cloud push path for the captured tare value (flagged in open questions).
- Replacing or deprecating `intake/ai_tare.py` — this is an alternative entry point, not a replacement.
- UI polish (icon, colors, animations) beyond the state-to-label table in §5.3.
- Auto-retry or debounce logic on implausible readings — the arm row keeps `last_error`, user reads it and re-places the container or cancels.
- Reset-to-null for a product's existing tare (owner asked about *capture*, not edit/clear).
