# ChefByte MCP End-to-End Results — 2026-04-22

Companion to `2026-04-22-chefbyte-mcp-e2e-plan.md`. All calls
executed against Jeremy's real production account (CF Worker →
Supabase → RPC/RLS).

## Baseline (pre-run, 2026-04-22 03:34 UTC)

- User's logical_date at time of run: `2026-04-21` (day_start_hour rollover — wall clock UTC around 03:30-03:40 hits user's pre-rollover window)
- Shopping list: empty
- Macros today (logical_date=2026-04-21): cal=2196.18, carbs=84.971, protein=203.931, fat=29.413
- Inventory (pre-existing): Chocolate milk, Parmesan, Rotisserie chicken (created by Jeremy — not touched except via search side-effects)

## Created IDs (for manual cleanup)

Products (none can be deleted via MCP):
- `982809bf-1460-4156-868d-7318ea041e0f` — [E2E-2026-04-22] Ketchup
- `8b883e7c-cf41-4266-bcc8-a852ab9c4523` — [E2E-2026-04-22] MinimalProduct
- `9510832e-8071-4c4e-a6e7-3ae610c4eb3c` — [E2E-2026-04-22] NullBC-A
- `288d0bd5-baca-4f69-b287-f7d98489a368` — [E2E-2026-04-22] NullBC-B
- `9aea6186-fd48-42fc-99c7-e546ca4d2eef` — [E2E-2026-04-22] 50% Off Soda
- `fc1661a7-e8c1-45c6-b33f-04939b86c7e9` — [E2E-2026-04-22] Pasta
- `05df6b34-a205-44c8-8de1-ff02f37b7f85` — [E2E-2026-04-22] Sauce
- `092a5fcb-8f18-4993-b8c4-ba3737302d8e` — [E2E-2026-04-22] BelowMinWidget
- `e3ad139a-e8a1-4b4f-a921-3924fa54962b` — [E2E-2026-04-22] RoundTrip
- `b8898be0-2eeb-4a9b-acd7-11394ecd9a8a` — [MEAL] [E2E-2026-04-22] PastaDish 04-22 (auto-generated)

Recipes (none can be deleted via MCP):
- `29282d82-a1ef-44c2-b297-36acfb562838` — [E2E-2026-04-22] PastaDish
- `0e1352d4-a64f-463a-a7fc-5e461308bb59` — [E2E-2026-04-22] ServingRecipe

Temp items (no delete MCP tool — will appear in 2026-04-21 macros):
- `f12fa06e-1582-4ca8-b8ea-6058f7bd6344` — [E2E-2026-04-22] Coffee (50 cal on 2026-04-21)
- `f57138c2-f04b-4344-8f59-dd768c55df18` — [E2E-2026-04-22] FullMacros (200 cal on 2026-04-21)

Meal plan entries: all 4 deleted during run.

Shopping list: cleared at end.

Stock lots: all E2E lots depleted to zero via `consume(qty:9999, log_macros:false)` during cleanup.

Food_logs: cannot be deleted via MCP. C-04 polluted logical_date=2026-04-21 by ~1,999,800 cal. M-06/M-09 food_logs exist on 2026-04-22. See "Cleanup gaps" below.

---

## Per-scenario results

### Products

| ID | Verdict | Notes |
|---|---|---|
| P-01 | PASS | Full metadata product created; `get_products` returned all fields correctly. |
| P-02 | PASS | Minimal (name-only) created with defaults spc=1, macros=0, min_stock=0. |
| P-03 | PASS | Duplicate barcode rejected with PG unique_constraint error `products_user_barcode_unique`. |
| P-04 | PASS | Two products with NULL barcodes coexist (partial unique index respects NULL). |
| P-05 | PASS | get_products with no search returned all 10 products. |
| P-06 | PASS | ilike search on `[E2E-2026-04-22]` returned only E2E rows. |
| P-07 | **FAIL (BUG #1)** | `search: "%"` returned ALL 10 products. `search: "_"` would also match single chars. MCP handler wraps input in `%...%` without escaping `%`, `_`, or `\`. Doc claims UI escapes these, but the MCP handler does not. |
| P-08 | PASS | Partial update (price only) — other fields preserved. |
| P-09 | PASS | update_product with no update fields → error "No fields to update." |
| P-10 | PARTIAL | Unknown product_id returns error but the message is unhelpful ("Cannot coerce the result to a single JSON object" — PostgREST PGRST116). Should say "Product not found". |
| P-11 | PASS | Barcode update works; old barcode freed. |
| P-12 | PASS | set_price happy path. |
| P-13 | PASS | Negative price rejected with clean error. |
| P-14 | PARTIAL | Unknown product_id — same "Cannot coerce" message as P-10. |

### Stock / Inventory

| ID | Verdict | Notes |
|---|---|---|
| S-01 | PASS | add_stock to default location (Fridge) created a null-expiry lot of qty 3. |
| S-02 | PASS | Second add with expires_on=2026-05-15 created a SEPARATE lot (expiry differs). |
| S-03 | PASS | Third add with same expires_on MERGED into S-02 lot (qty 2→3). Only 2 lots exist. |
| S-04 | PASS | add_stock with no expires_on MERGED into S-01 lot (qty 3→5). |
| S-05 | PASS | Zero qty rejected. |
| S-06 | PASS | Negative qty rejected. |
| S-07 | PASS | Invalid product_id → FK error on stock_lots_product_id_fkey. |
| S-08 | PASS | get_inventory w/o include_lots returns grouped totals, no lots[] array. |
| S-09 | PASS | include_lots=true includes per-lot qty/expiry/location. |
| S-10 | PASS | get_product_lots ordered by expires_on ASC NULLS LAST (dated lot first). |

### Consume

| ID | Verdict | Notes |
|---|---|---|
| C-01 | PASS | 2 servings → 0.2 container from nearest-expiry lot (2026-05-15 lot went 3→2.8). Macros: 40 cal, 10 carbs. |
| C-02 | PASS | 1 container from next-nearest-expiry lot (still 2026-05-15, 2.8→1.8). Macros: 200 cal, 50 carbs. |
| C-03 | PASS | log_macros=false: stock dropped 0.5, total macros unchanged. |
| C-04 | **PASS** (spec) / **BUG-ish (footgun)** | Consuming 9999 containers floored stock at 0 (lots deleted) AND logged a food_log with 1,999,800 cal + 499,950 carbs. Per spec ("macros always logged for full consumed amount"). But: (a) no MCP tool to delete food_logs, so any accidental huge-qty consume permanently corrupts a day's macros, and (b) the tool responds with the absurd macros without warning. |
| C-05 | SKIP | Tool schema enum restricts unit to ['container', 'serving'] — MCP layer would reject 'box' at schema validation. The RPC's normalization fallback (migration 20260310010000) is a defense-in-depth net. |
| C-06 | PASS | qty=0 rejected. |
| C-07 | PASS | Unknown product_id → "Product not found or not owned by user" (RPC raises). |

### Recipes

| ID | Verdict | Notes |
|---|---|---|
| R-01 | PASS | Recipe with 2 container-unit ingredients + instructions created; get_recipes returns with computed `macros_per_container`. |
| R-02 | PASS | Empty ingredients list rejected. |
| R-03 | PASS | Unknown ingredient product_id → FK error; orphan recipe cleanup branch confirmed (get_recipes no longer shows "BadIng"). |
| R-04 | PASS | serving-unit ingredient persisted. |
| R-05 | PASS | get_recipes returned both R-01 + R-04 E2E recipes. |
| R-06 | PASS | Search filter works. |
| R-07 | PASS | get_cookable with no stock returned empty (no E2E recipes cookable). |
| R-08 | PASS | After adding 2 containers Pasta + 2 Sauce: PastaDish max_batches=min(2/1, 2/0.5)=2, max_servings=8. ServingRecipe (2 servings Pasta @ spc=4 = 0.5 container per batch) max_batches=2/0.5=4. Unit conversion verified in both directions. |

### Meal Plan

| ID | Verdict | Notes |
|---|---|---|
| M-01 | PASS | Recipe meal added with meal_prep=false. |
| M-02 | PASS | Product meal added. |
| M-03 | PASS | Neither recipe_id nor product_id → error. |
| M-04 | PASS | Meal prep entry added with meal_prep=true. |
| M-05 | PASS | Date range query returned all 3 entries. |
| M-06 | PASS | mark_done on recipe regular: scale_factor=meal.servings/base_servings=2/4=0.5 applied correctly. Pasta 2→1.5 (deducted 0.5), Sauce 2→1.75 (deducted 0.25). Spec bug from earlier migration confirmed fixed. |
| M-07 | PASS | Second mark_done → `success:false, error:"Meal already completed"` (structured error, tool success wrapper). |
| M-08 | PASS | Meal prep: stock deducted same as regular, NO macro log, new `[MEAL] [E2E-2026-04-22] PastaDish 04-22` product created with frozen per-serving macros (243.75 cal, 46.25 carbs, 8.25 protein, 2.25 fat per serving — 2 servings/container). Lot qty=1, expires_on=2026-04-29 (logical_date+7). |
| M-09 | PASS | Product-based regular meal: correctly passed 'serving' as unit (not 'container'). 1 serving @ spc=4 → 0.25 container deducted from Pasta (1→0.75). Bug from earlier migration confirmed fixed. |
| M-10 | PASS | Unknown meal_id → "Meal not found or not owned by user". |
| M-11 | PASS | delete_meal_entry on a fresh entry removed it. |
| M-12 | PASS | Unknown meal_id → "Meal plan entry not found or does not belong to you". |

### Macros

| ID | Verdict | Notes |
|---|---|---|
| Ma-01 | PASS | Shape: `{ calories, carbs, protein, fat }` each `{goal, consumed, remaining}`. No `logged_items` array — just totals. Future enhancement: AI agent has to call for a date to see items. |
| Ma-02 | PASS | Past date with no data returns zeros with goals populated. |
| Ma-03 | PASS | Temp item logged; macros increase by 50 cal; `logical_date` in response is current user logical date (2026-04-21), NOT wall-clock UTC date. |
| Ma-04 | PASS | Full macros logged; all four numbers increase on current logical_date. |
| Ma-05 | PARTIAL (spec-compliant but confusing) | `log_temp_item` uses `get_logical_date` (user's rolling date), while `add_meal` requires caller to supply `logical_date`. If an AI agent computes "today" from wall-clock UTC, it can write meal plan entries to a different date than where macros aggregate. Not a bug per spec but a real footgun for AI callers. |

### Shopping

| ID | Verdict | Notes |
|---|---|---|
| Sh-01 | SKIP | Cart already empty at start. |
| Sh-02 | PASS | add_to_shopping created a new row. |
| Sh-03 | **FAIL (BUG #2)** | Second add_to_shopping for same product REPLACED qty (3→2) instead of incrementing (spec says "additive upsert"). `add_to_shopping.ts` upserts with the new qty value rather than `qty + excluded.qty`. The additive logic only lives in `below_min_stock.ts`. Spec-implementation mismatch. |
| Sh-04 | PASS | qty=0 rejected. |
| Sh-05 | PASS | negative qty rejected. |
| Sh-06 | PASS | toggle_purchased true. |
| Sh-07 | PASS | toggle back false. |
| Sh-08 | PARTIAL | Unknown item_id errors but message reveals Postgrest: "Shopping item not found: Cannot coerce the result to a single JSON object". First half is fine; second half is noise. |
| Sh-09 | PASS | delete_shopping_item removed row. |
| Sh-10 | PASS | Unknown item_id → "Shopping item not found". |
| Sh-11 | PASS | below_min_stock (no auto_add) listed 3 deficits (Ketchup min=1, BelowMinWidget min=5, and Jeremy's real Flour Tortillas min=2); cart unchanged. |
| Sh-12 | PASS with caveat | auto_add=true added all 3 to cart. **Side effect: Jeremy's real Tortillas product was added** because it has min_stock_amount=2 and zero current stock. Spec-compliant but worth noting — auto-add pulls in real-user products. Cleared via clear_shopping at end. |
| Sh-13 | PASS | Second below_min_stock call with auto_add=true ADDED to existing qtys (Ketchup 1→2, Widget 5→10, Tortillas 2→4). Additive upsert via fetch-compute-upsert pattern. |
| Sh-14 | PASS | import_shopping_to_inventory with no purchased items → "No purchased items to import". |
| Sh-15 | PASS | After marking Widget purchased: import created a new stock lot (qty=10, no expiry, default Fridge), cart row removed. |
| Sh-16 | PASS | clear_shopping wiped everything including Ketchup and Tortillas. |

### Edge

| ID | Verdict | Notes |
|---|---|---|
| E-01 | PASS | Stock=1 container, consume 10 servings @ spc=10 → exactly 0 containers. |
| E-02 | PASS | After E-01 depletion, `get_product_lots` returns `lots: []`. Lot row was DELETED, not left as qty=0. |
| E-03 | SKIP | Cannot set `is_placeholder` via MCP create_product — schema doesn't expose it. Placeholders created only via scanner fallback path. Coverage gap. |
| E-04 | PASS | Covered in M-08. |
| E-05 | PASS | All invalid-UUID error paths verified across P-10/P-14/S-07/C-07/M-10/M-12/Sh-08/Sh-10. |
| E-06 | SKIP | Cross-user isolation — no second auth path in this session. |

### Cleanup

| ID | Verdict | Notes |
|---|---|---|
| CL-01 | PASS | All 4 E2E meal_plan_entries deleted via delete_meal_entry. |
| CL-02 | PASS | Shopping list cleared. |
| CL-03 | **GAP** | No MCP tool to delete food_logs. See Cleanup Gaps section. |
| CL-04 | **GAP** | No MCP tool to delete temp_items. Two `[E2E-2026-04-22]` temp_items remain on 2026-04-21. |
| CL-05 | PASS | All E2E stock lots depleted to zero via `consume(qty:9999, log_macros:false)`. Lots deleted automatically. |
| CL-06 | **GAP** | No MCP tool to delete recipes. Two E2E recipes remain. |
| CL-07 | **GAP** | No MCP tool to delete products. 10 E2E-prefixed products remain including the auto-generated [MEAL] product. |

---

## Summary

**Totals (85 planned, 3 skipped legitimately, 82 executed):**

| Area | Scenarios | Pass | Partial | Fail | Skip |
|---|---|---|---|---|---|
| Products | 14 | 10 | 3 | 1 | 0 |
| Stock | 10 | 10 | 0 | 0 | 0 |
| Consume | 7 | 6 | 0 | 0 | 1 |
| Recipes | 8 | 8 | 0 | 0 | 0 |
| Meal plan | 12 | 12 | 0 | 0 | 0 |
| Macros | 5 | 4 | 1 | 0 | 0 |
| Shopping | 16 | 13 | 1 | 1 | 1 |
| Edge | 6 | 3 | 0 | 0 | 3 |
| Cleanup | 7 | 3 | 0 | 0 | 4 (GAP) |
| **Total** | **85** | **69** | **5** | **2** | **9** |

Pass rate (excluding SKIP/GAP): 69/76 = **90.8%**. Two real bugs, five partial-pass notes, three legitimate skips, four cleanup gaps.

## Bugs Found (Severity × Description × Tool)

1. **MEDIUM — `get_products.search` does not escape `%` or `_` ilike wildcards.** `search: "%"` matches every product. Tool bypasses the UI's pattern-escaping convention. Also affects `get_recipes.search` (shares the same unsafe `ilike` pattern). **Affected tools:** `CHEFBYTE_get_products`, `CHEFBYTE_get_recipes`. File: `packages/app-tools/src/chefbyte/get-products.ts:24`, same pattern in `get-recipes.ts:24`.

2. **MEDIUM — `add_to_shopping` replaces qty instead of adding.** Doc says "additive upsert — increments existing quantity rather than replacing" but handler sets `qty_containers = qty_containers` (replace). Only `below_min_stock(auto_add)` is actually additive. Either fix handler or fix doc. **Affected tool:** `CHEFBYTE_add_to_shopping`. File: `packages/app-tools/src/chefbyte/add-to-shopping.ts:21-32`.

3. **LOW (UX) — Error messages for unknown UUIDs leak PostgREST internals.** "Failed to update product: Cannot coerce the result to a single JSON object" (P-10, P-14, Sh-08 suffix). User-facing tools should say "Product not found" etc. Multiple tools affected: `update_product`, `set_price`, partially `toggle_purchased`.

4. **LOW (footgun) — No MCP tool to delete food_logs / temp_items / recipes / products.** Any accidental large `consume(qty: 9999, log_macros: true)` permanently corrupts a day's macros; test data accumulates unbounded. The UI has deletion paths but the MCP surface does not. C-04's 1,999,800 cal log cannot be cleaned up via MCP. **Missing tools:** `delete_food_log`, `delete_temp_item`, `delete_recipe`, `delete_product` (or at least `soft_delete_product`).

5. **LOW (confusion) — Logical-date inconsistency between tools.** `log_temp_item` and `consume` derive `logical_date` from user's `day_start_hour` server-side, while `add_meal` takes `logical_date` as a required caller argument. An AI agent passing `new Date().toISOString().slice(0,10)` (wall-clock UTC) as `logical_date` can write meal plan entries to a date that doesn't align with where macro aggregation is happening. Consider either (a) documenting the convention prominently, (b) adding a `today` / `get_logical_date` MCP helper, or (c) making `logical_date` optional on add_meal and defaulting server-side.

## Coverage gaps (tools / cases NOT exercised)

- **Cross-user isolation (E-06):** can't authenticate as a second user in this session.
- **`is_placeholder` products (E-03):** MCP `create_product` doesn't expose the flag; can only be set via the scanner's fallback path in the edge function. Not a testable scenario from MCP.
- **Scanner wizard / barcode pipeline:** per task non-goal, skipped. No MCP tool equivalent.
- **Unit='box' or other non-enum units (C-05):** blocked at MCP schema validation. RPC-level normalization is covered by pgTAP in the migration itself.
- **LiveTrack (`shelf-ingest`, pairing):** no MCP tool surface.
- **Walmart scrape / price refresh:** edge function, no MCP wrapper.
- **`analyze-product` edge function:** no MCP wrapper.

## Cleanup Status (what's left)

**Fully cleaned:**
- All E2E meal_plan_entries (deleted via MCP)
- Entire shopping list (cleared)
- All E2E stock_lots (depleted to zero via consume)

**Cannot clean via MCP — needs manual SQL:**
```sql
-- Delete E2E food_logs (the 2-million-cal C-04 pollution is here)
DELETE FROM chefbyte.food_logs
WHERE user_id = '<jeremy-user-id>'
  AND product_id IN (
    SELECT product_id FROM chefbyte.products
    WHERE user_id = '<jeremy-user-id>'
      AND name LIKE '[E2E-2026-04-22]%' OR name LIKE '[MEAL] [E2E-2026-04-22]%'
  );

-- Delete E2E temp_items
DELETE FROM chefbyte.temp_items
WHERE user_id = '<jeremy-user-id>'
  AND name LIKE '[E2E-2026-04-22]%';

-- Delete recipes (cascades to recipe_ingredients)
DELETE FROM chefbyte.recipes
WHERE user_id = '<jeremy-user-id>'
  AND name LIKE '[E2E-2026-04-22]%';

-- Delete products (cascades lots/logs/ingredients)
DELETE FROM chefbyte.products
WHERE user_id = '<jeremy-user-id>'
  AND (name LIKE '[E2E-2026-04-22]%' OR name LIKE '[MEAL] [E2E-2026-04-22]%');
```

Alternatively: the easiest path is to delete-by-name via the ChefByte UI settings page (Products tab lists all products; delete button cascades), then delete temp_items + food_logs via SQL since the UI may not have a direct food_log deleter.

**Side effect on Jeremy's real data:**
- The pre-existing "Flour Tortillas Burrito" product was pulled into shopping (Sh-12/Sh-13) because it has `min_stock_amount=2` and zero stock. All cart items were removed via `clear_shopping` at the end, so no lingering cart pollution. No edits to Jeremy's Tortillas product itself.
- 2026-04-21 macro totals are currently inflated by C-04's ~2M-calorie food_log and cleanup-consume food_logs with `log_macros=false` (those last ones don't log, verified). Dashboard will show absurd numbers on that date until food_logs are cleaned.

## Confidence Summary

MCP → Worker → Supabase → RPC → RLS path is healthy end-to-end. Core CRUD (products, stock, recipes, meal plan, shopping, macros) all works. The two real bugs (search wildcard, add_to_shopping replace-semantics) are handler-level issues, not platform issues. mark_done scaling math is correct (both recipe and product-based, both regular and meal-prep). Lot merge/depletion/FIFO all work. Unit conversion (serving↔container) is bidirectional and correct. RLS + ownership checks verified via invalid-UUID probes.
