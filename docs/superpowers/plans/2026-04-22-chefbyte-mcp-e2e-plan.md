# ChefByte MCP End-to-End Coverage Plan — 2026-04-22

## Purpose

Exercise every CHEFBYTE\_\* MCP tool end-to-end against production
(real CF Worker → real Supabase → real RPC/RLS) to build confidence
that the full tool surface works for a real user session. Each
mutation is cross-verified by a read so drift between write-path
and read-path is detectable.

## Conventions

- **Test-data prefix:** `[E2E-2026-04-22]` on every product name, recipe name, and temp-item name so Jeremy can grep and so live-hardware writes stay visibly distinct.
- **Scenario IDs:** `TOOL-NN` (e.g., `P-01` for the first product scenario). Phase 2 results reference these.
- **Verdict keys:** PASS / FAIL / SKIP / PARTIAL. PARTIAL = tool succeeded but observable behavior diverged from spec.
- **Cleanup:** Track every created `product_id`, `recipe_id`, `meal_id`, temp_item name, and food_log meal tag in a running list for Phase 2 teardown.

## Tool Inventory (24 tools)

| #   | Tool                                    | Purpose                                       |
| --- | --------------------------------------- | --------------------------------------------- |
| 1   | `CHEFBYTE_get_products`                 | Catalog read                                  |
| 2   | `CHEFBYTE_create_product`               | Product insert                                |
| 3   | `CHEFBYTE_update_product`               | Product field update                          |
| 4   | `CHEFBYTE_set_price`                    | Price-only update                             |
| 5   | `CHEFBYTE_get_inventory`                | Grouped lots read                             |
| 6   | `CHEFBYTE_get_product_lots`             | Per-product lots read                         |
| 7   | `CHEFBYTE_add_stock`                    | Create/merge lot                              |
| 8   | `CHEFBYTE_consume`                      | FIFO-by-expiry deduction + optional macro log |
| 9   | `CHEFBYTE_get_recipes`                  | Recipe catalog read                           |
| 10  | `CHEFBYTE_create_recipe`                | Recipe + ingredients insert                   |
| 11  | `CHEFBYTE_get_cookable`                 | Stock-filtered recipe list                    |
| 12  | `CHEFBYTE_get_meal_plan`                | Date-range plan read                          |
| 13  | `CHEFBYTE_add_meal`                     | Insert meal entry (recipe or product)         |
| 14  | `CHEFBYTE_delete_meal_entry`            | Delete meal entry                             |
| 15  | `CHEFBYTE_mark_done`                    | Execute meal (consume + macros or [MEAL] lot) |
| 16  | `CHEFBYTE_get_macros`                   | Daily macro aggregate                         |
| 17  | `CHEFBYTE_log_temp_item`                | Off-inventory macro log                       |
| 18  | `CHEFBYTE_get_shopping_list`            | Cart read                                     |
| 19  | `CHEFBYTE_add_to_shopping`              | Cart upsert                                   |
| 20  | `CHEFBYTE_toggle_purchased`             | Flip purchased bool                           |
| 21  | `CHEFBYTE_delete_shopping_item`         | Remove single cart row                        |
| 22  | `CHEFBYTE_clear_shopping`               | Wipe cart                                     |
| 23  | `CHEFBYTE_below_min_stock`              | Deficit query + optional auto-add             |
| 24  | `CHEFBYTE_import_shopping_to_inventory` | Move purchased rows into lots                 |

Read ↔ Write pairs for cross-verification (Phase 2 double-calls):

| Mutation                                                                                                                    | Read to verify                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| create_product / update_product / set_price                                                                                 | get_products                                                                           |
| add_stock                                                                                                                   | get_inventory + get_product_lots                                                       |
| consume                                                                                                                     | get_inventory + get_product_lots + get_macros                                          |
| create_recipe                                                                                                               | get_recipes (+ get_cookable if stock present)                                          |
| add_to_shopping / toggle_purchased / delete_shopping_item / clear_shopping / below_min_stock / import_shopping_to_inventory | get_shopping_list (+ get_inventory for import)                                         |
| add_meal / delete_meal_entry                                                                                                | get_meal_plan                                                                          |
| mark_done                                                                                                                   | get_meal_plan + get_macros + get_inventory (meal-prep → verify [MEAL] product and lot) |
| log_temp_item                                                                                                               | get_macros                                                                             |

---

## Scenarios

### Products (P-##)

**P-01 create_product — happy path, full metadata**

- Setup: none
- Action: `create_product({ name: "[E2E-2026-04-22] Ketchup", barcode: "E2E-0001", servings_per_container: 10, calories_per_serving: 20, carbs_per_serving: 5, protein_per_serving: 0, fat_per_serving: 0, price: 3.49, min_stock_amount: 1, description: "E2E test" })`
- Expected: returns `product_id` + name; `get_products({search:"[E2E-2026-04-22]"})` includes the row with all fields.
- Failure modes: silent field loss; NUMERIC truncation; barcode not persisted.

**P-02 create_product — minimal (name only)**

- Action: `create_product({ name: "[E2E-2026-04-22] MinimalProduct" })`
- Expected: row created with `servings_per_container=1, calories_per_serving=0, ...` defaults.
- Failure modes: required-field validation pretending to be optional.

**P-03 create_product — duplicate barcode**

- Setup: P-01 created with barcode `E2E-0001`.
- Action: `create_product({ name: "[E2E-2026-04-22] DupBarcode", barcode: "E2E-0001" })`
- Expected: **error** from UNIQUE partial index `products_user_barcode_unique`. `isError: true` with a Postgres duplicate-key message.
- Failure modes: silently accepts (UNIQUE bypassed); crashes worker.

**P-04 create_product — null barcode allowed twice**

- Action: two `create_product` calls with no barcode field.
- Expected: both succeed (partial unique index only constrains non-null barcodes).
- Failure modes: false-positive UNIQUE conflict on NULL.

**P-05 get_products — empty search**

- Action: `get_products({})`
- Expected: full product list including our test rows.

**P-06 get_products — name search with ilike**

- Action: `get_products({ search: "[E2E-2026-04-22]" })`
- Expected: only E2E-prefixed rows returned. Assertion: count ≥ number we created so far.

**P-07 get_products — search with special char (%)**

- Action: `get_products({ search: "50%" })` with a pre-created product named `[E2E-2026-04-22] 50% Off`.
- Expected: only rows literally containing `50%` — not every row (would indicate unsafe ilike). Note: spec says UI escapes, but MCP handler does not — document actual behavior.
- Failure probe: if `%` is not escaped server-side, search returns every row (pattern wildcard). Flag as doc/behavior mismatch.

**P-08 update_product — partial update (price only)**

- Action: `update_product({ product_id: P-01_id, price: 4.99 })`
- Expected: `get_products` shows `price: 4.99`; other fields unchanged.

**P-09 update_product — no fields provided**

- Action: `update_product({ product_id: P-01_id })`
- Expected: `isError: true` with "No fields to update..." message.

**P-10 update_product — invalid product_id (random UUID)**

- Action: `update_product({ product_id: "00000000-0000-0000-0000-000000000000", price: 1 })`
- Expected: error (no rows affected, .single() throws PGRST116 or similar).

**P-11 update_product — barcode update**

- Action: `update_product({ product_id: P-01_id, barcode: "E2E-0001-RENAMED" })`
- Expected: `get_products` reflects new barcode; P-01 original barcode freed up.

**P-12 set_price — happy path**

- Action: `set_price({ product_id: P-02_id, price: 2.25 })`
- Expected: get_products shows 2.25.

**P-13 set_price — negative price**

- Action: `set_price({ product_id: P-02_id, price: -1 })`
- Expected: `isError: true` "Price cannot be negative".

**P-14 set_price — invalid product_id**

- Action: `set_price({ product_id: "00000000-0000-0000-0000-000000000000", price: 5 })`
- Expected: error.

### Inventory / Stock (S-##)

**S-01 add_stock — happy path (default location)**

- Setup: product P-01.
- Action: `add_stock({ product_id: P-01_id, qty_containers: 3 })`
- Expected: returns lot with `qty_containers=3`; `get_inventory({include_lots:true})` shows the product with 3 containers in one lot at the default location (Fridge created at activation).

**S-02 add_stock — with explicit expires_on, no existing lot**

- Action: `add_stock({ product_id: P-01_id, qty_containers: 2, expires_on: "2026-05-15" })`
- Expected: second lot appears for P-01 (distinct from S-01's null-expiry lot); total_containers=5.

**S-03 add_stock — merge (same product/location/expires_on)**

- Action: `add_stock({ product_id: P-01_id, qty_containers: 1, expires_on: "2026-05-15" })`
- Expected: merges into S-02 lot; `get_product_lots({product_id: P-01_id})` shows exactly 2 lots now: one qty=3 no-expiry, one qty=3 expiring 2026-05-15. Catches: if merge fails, 3 lots with 3/2/1.

**S-04 add_stock — null-expiry merge**

- Action: `add_stock({ product_id: P-01_id, qty_containers: 2 })` (no expires_on)
- Expected: merges into S-01 lot (now qty=5). Total containers for P-01 becomes 8.

**S-05 add_stock — zero qty rejected**

- Action: `add_stock({ product_id: P-01_id, qty_containers: 0 })`
- Expected: `isError: true` "qty_containers must be a positive finite number".

**S-06 add_stock — negative qty rejected**

- Action: `add_stock({ product_id: P-01_id, qty_containers: -1 })`
- Expected: error.

**S-07 add_stock — invalid product_id**

- Action: `add_stock({ product_id: "00000000-0000-0000-0000-000000000000", qty_containers: 1 })`
- Expected: FK error (stock_lots.product_id FK to products).

**S-08 get_inventory — no lots flag (default)**

- Action: `get_inventory({})`
- Expected: rows show `total_containers` + `nearest_expiry` but no `lots` array.

**S-09 get_inventory — include_lots=true**

- Action: `get_inventory({ include_lots: true })`
- Expected: each product has `lots` array with per-lot qty/expires/location.

**S-10 get_product_lots — happy path**

- Action: `get_product_lots({ product_id: P-01_id })`
- Expected: sorted by `expires_on ASC NULLS LAST` — so the dated lot first, null lot last.

### Consume (C-##)

**C-01 consume — serving unit, log_macros true**

- Setup: P-01 at 8 containers × 10 servings/container = 80 servings equivalent.
- Action: `consume({ product_id: P-01_id, qty: 2, unit: "serving", log_macros: true })`
- Expected: 0.2 containers deducted (2 / 10) from nearest-expiry lot first (the 2026-05-15 dated lot with 3 → becomes 2.8). `get_macros` includes 2×20=40 cal, 2×5=10 carbs. food_log row with `unit='serving'`, `qty_consumed=2`.
- Failure probe: if servings↔containers math inverts, 0.5 would become 5; if FIFO broken, deducts from null-expiry lot first.

**C-02 consume — container unit**

- Action: `consume({ product_id: P-01_id, qty: 1, unit: "container", log_macros: true })`
- Expected: 1 container gone from next-earliest-expiry lot (still 2026-05-15, now 1.8). Macros add 10×20=200 cal, 10×5=50 carbs.

**C-03 consume — log_macros false**

- Action: `consume({ product_id: P-01_id, qty: 0.5, unit: "container", log_macros: false })`
- Expected: stock drops by 0.5; get_macros sum unchanged from C-02.

**C-04 consume — more than stock (floor at 0)**

- Setup: get current total for P-01.
- Action: `consume({ product_id: P-01_id, qty: 9999, unit: "container", log_macros: true })`
- Expected: all lots deleted; `stock_remaining=0` in response; macros logged for the **full 9999 containers' worth** (macros log even when stock floored — spec rule).
- Failure probe: if macros only logged for actually-depleted amount, totals will be far lower.

**C-05 consume — invalid unit string**

- Action: `consume({ product_id: P-01_id, qty: 1, unit: "box" })` — but tool schema enum restricts to container/serving; the MCP layer may reject at schema validation. If the schema lets this through, the RPC should normalize to 'container' (per migration 20260310010000).
- Expected: either schema-level rejection OR container semantics.

**C-06 consume — zero qty**

- Action: `consume({ product_id: P-01_id, qty: 0, unit: "container" })`
- Expected: `isError: true` (handler guard).

**C-07 consume — unknown product_id**

- Action: `consume({ product_id: "00000000-0000-0000-0000-000000000000", qty: 1, unit: "container" })`
- Expected: RPC raises "Product not found or not owned by user" → `isError: true`.

### Recipes (R-##)

Prereqs: Create product P-R1 `[E2E-2026-04-22] Pasta`, P-R2 `[E2E-2026-04-22] Sauce`.

**R-01 create_recipe — happy path with 2 ingredients**

- Action: `create_recipe({ name: "[E2E-2026-04-22] PastaDish", base_servings: 4, active_time: 10, total_time: 25, instructions: "Boil, mix", ingredients: [{product_id: P-R1_id, quantity: 1, unit: "container"}, {product_id: P-R2_id, quantity: 0.5, unit: "container"}] })`
- Expected: returns recipe_id; `get_recipes({search:"PastaDish"})` returns it with 2 ingredients and computed `macros_per_container`.

**R-02 create_recipe — zero ingredients**

- Action: `create_recipe({ name: "[E2E-2026-04-22] Empty", ingredients: [] })`
- Expected: `isError: true` "At least one ingredient is required".

**R-03 create_recipe — unknown ingredient product_id**

- Action: `create_recipe({ name: "[E2E-2026-04-22] BadIng", ingredients: [{product_id: "00000000-0000-0000-0000-000000000000", quantity: 1}] })`
- Expected: error, and cleanup branch in handler deletes the orphan recipe. Verify via `get_recipes({search:"BadIng"})` → not present.

**R-04 create_recipe — serving-unit ingredient**

- Action: same pattern as R-01 but `unit: "serving"`.
- Expected: stored; get_recipes reflects `unit: "serving"`.

**R-05 get_recipes — no search**

- Action: `get_recipes({})`
- Expected: all user recipes including R-01 and R-04 present.

**R-06 get_recipes — search hit**

- Action: `get_recipes({ search: "PastaDish" })`
- Expected: single row.

**R-07 get_cookable — no stock**

- Setup: after C-04 P-01 is depleted. R-01 needs P-R1/P-R2, both probably zero.
- Action: `get_cookable({})`
- Expected: cookable list does NOT include R-01 (insufficient stock) unless we explicitly add stock.

**R-08 get_cookable — with stock**

- Setup: `add_stock({product_id: P-R1_id, qty_containers: 2})`, `add_stock({product_id: P-R2_id, qty_containers: 2})`
- Action: `get_cookable({})`
- Expected: R-01 in cookable list with `max_batches = min(2/1, 2/0.5) = 2`, `max_servings = 2 * 4 = 8`.
- Failure probe: if unit conversion inverted for serving ingredients, max_batches wrong.

### Meal Plan & mark_done (M-##)

Use today's logical_date. Jeremy's env; assume user timezone — tool uses `get_logical_date` internally.

**M-01 add_meal — recipe entry, regular mode**

- Setup: R-01 created. Compute `today = today's logical date` — derive via `get_macros({})` to see the date string OR just use local YYYY-MM-DD.
- Action: `add_meal({ logical_date: TODAY, recipe_id: R-01_id, servings: 2 })`
- Expected: returns meal_id; `get_meal_plan({ start_date: TODAY, end_date: TODAY })` shows it with `meal_prep=false, completed=false`.

**M-02 add_meal — product entry**

- Setup: stock on P-R1.
- Action: `add_meal({ logical_date: TODAY, product_id: P-R1_id, servings: 1 })`
- Expected: present in plan with product_name filled.

**M-03 add_meal — no recipe or product**

- Action: `add_meal({ logical_date: TODAY })`
- Expected: `isError: true` "At least one of recipe_id or product_id is required".

**M-04 add_meal — meal_prep=true**

- Setup: restock P-R1/P-R2.
- Action: `add_meal({ logical_date: TODAY, recipe_id: R-01_id, servings: 2, meal_prep: true })`
- Expected: row with `meal_prep: true`.

**M-05 get_meal_plan — date range**

- Action: `get_meal_plan({ start_date: TODAY, end_date: (TODAY+3) })`
- Expected: returns all entries we just added.

**M-06 mark_done — regular recipe meal**

- Setup: M-01 exists; P-R1/P-R2 restocked so ingredients cover meal.servings=2. Recipe base_servings=4, scale=2/4=0.5. Needs: 0.5 containers P-R1, 0.25 containers P-R2.
- Action: `mark_done({ meal_id: M-01_id })`
- Expected: stock decrement on P-R1 by 0.5, P-R2 by 0.25; `get_macros` increases by per-serving×(servings×spc) for each ingredient; `get_meal_plan` shows `completed=true`.
- Failure probe: if scale math broken (applies meal.servings directly without /base_servings), deductions would be 2× and 1× (4× too much).

**M-07 mark_done — already completed**

- Action: `mark_done({ meal_id: M-01_id })` again.
- Expected: response `success: false, error: 'Meal already completed'` (structured success content but error flag inside data).

**M-08 mark_done — meal prep mode**

- Setup: M-04 exists.
- Action: `mark_done({ meal_id: M-04_id })`
- Expected: stock decrement on P-R1/P-R2 just like M-06; **no macro log** (NOT v_meal.meal_prep → false); a new `[MEAL] [E2E-2026-04-22] PastaDish MM-DD` product created with frozen nutrition; a stock lot for that new product with qty_containers=1 and expires_on=today+7. `get_products({search:"[MEAL]"})` returns the new product.

**M-09 mark_done — product-based regular meal**

- Setup: M-02 exists, stock on P-R1.
- Action: `mark_done({ meal_id: M-02_id })`
- Expected: stock decremented by servings/spc (e.g., 1 serving / 10 spc = 0.1 containers); macros logged for 1 serving worth; food_log.unit='serving'.
- Failure probe: if handler passes 'container' instead of 'serving', a full container would be deducted.

**M-10 mark_done — invalid meal_id**

- Action: `mark_done({ meal_id: "00000000-0000-0000-0000-000000000000" })`
- Expected: RPC "Meal not found or not owned by user" → `isError: true`.

**M-11 delete_meal_entry — valid**

- Setup: create a fresh entry M-DEL.
- Action: `delete_meal_entry({ meal_id: M-DEL_id })`
- Expected: `get_meal_plan` no longer includes it.

**M-12 delete_meal_entry — invalid**

- Action: `delete_meal_entry({ meal_id: "00000000-0000-0000-0000-000000000000" })`
- Expected: `isError: true` "Meal plan entry not found or does not belong to you".

### Macros (Ma-##)

**Ma-01 get_macros — today**

- Action: `get_macros({})`
- Expected: object with `totals` (calories/carbs/protein/fat), `goals` (or similar), `logged_items` or similar structure. Record actual shape for result doc.

**Ma-02 get_macros — explicit past date (pre-seeded, no data)**

- Action: `get_macros({ date: "2024-01-15" })`
- Expected: zeros (no food_logs or temp_items for that date).

**Ma-03 log_temp_item — minimal**

- Action: `log_temp_item({ name: "[E2E-2026-04-22] Coffee", calories: 50 })`
- Expected: row returned with carbs=0, protein=0, fat=0; `get_macros({})` calories increase by 50.

**Ma-04 log_temp_item — full macros**

- Action: `log_temp_item({ name: "[E2E-2026-04-22] FullMacros", calories: 200, carbs: 20, protein: 15, fat: 5 })`
- Expected: get_macros shows carbs+20, protein+15, fat+5.

**Ma-05 log_temp_item — across logical date boundary**

- Expected behavior: `log_temp_item` stamps today's logical_date. Verified by Ma-04 showing up today but not in Ma-02 date.

### Shopping (Sh-##)

**Sh-01 clear_shopping — starting fresh**

- Action: `clear_shopping({})` → ensure empty start.
- Verify: `get_shopping_list({})` → items=[].

**Sh-02 add_to_shopping — new product**

- Action: `add_to_shopping({ product_id: P-R1_id, qty_containers: 3 })`
- Expected: single item, qty=3. `get_shopping_list` reflects it.

**Sh-03 add_to_shopping — existing product (upsert)**

- Action: `add_to_shopping({ product_id: P-R1_id, qty_containers: 2 })` again
- Expected: UNIQUE(user_id, product_id) causes ON CONFLICT. Handler uses `.upsert({...})` — need to verify: does this SET qty=2 (replace) or ADD? Reading handler: builds `row.qty_containers = qty_containers` then upserts with no merge expression → **replaces**, not adds. So final qty=2, not 5. This contradicts the doc ("additive upsert").
- Failure probe: flag as doc/behavior mismatch if spec says additive. The additive logic lives in `below_min_stock.ts` (which fetches + computes + upserts), not in `add_to_shopping.ts`.

**Sh-04 add_to_shopping — zero qty**

- Action: `add_to_shopping({ product_id: P-R1_id, qty_containers: 0 })`
- Expected: `isError: true`.

**Sh-05 add_to_shopping — negative qty**

- Action: `add_to_shopping({ product_id: P-R1_id, qty_containers: -2 })`
- Expected: `isError: true`.

**Sh-06 toggle_purchased — happy path**

- Action: `toggle_purchased({ item_id: Sh-02 cart_item_id })`
- Expected: purchased: true.

**Sh-07 toggle_purchased — toggle back**

- Action: repeat → purchased: false.

**Sh-08 toggle_purchased — invalid item_id**

- Action: `toggle_purchased({ item_id: "00000000-0000-0000-0000-000000000000" })`
- Expected: `isError: true` "Shopping item not found".

**Sh-09 delete_shopping_item — happy path**

- Setup: Sh-02 still present.
- Action: `delete_shopping_item({ item_id: Sh-02_id })`
- Expected: `get_shopping_list` no longer includes it.

**Sh-10 delete_shopping_item — invalid id**

- Action: delete with random UUID.
- Expected: `isError: true` "Shopping item not found".

**Sh-11 below_min_stock — find only (no auto_add)**

- Setup: create `[E2E-2026-04-22] BelowMinWidget` with `min_stock_amount=5`, no stock.
- Action: `below_min_stock({})`
- Expected: list contains the widget with `deficit=5, current_stock=0`; shopping_list unchanged (check via get_shopping_list).

**Sh-12 below_min_stock — auto_add true**

- Action: `below_min_stock({ auto_add: true })`
- Expected: widget now in shopping_list with qty=5 (or deficit amount). Additive behavior: if row already existed (Sh-03 left P-R1 with qty=2), deficit should add on top.

**Sh-13 below_min_stock — second call (additive on existing shopping row)**

- Setup: widget at min 5, no stock, already in cart qty=5 from Sh-12.
- Action: `below_min_stock({ auto_add: true })` again.
- Expected: widget cart qty becomes 5+5=10 (additive). Catches: if replace-on-conflict, stays 5.

**Sh-14 import_shopping_to_inventory — no purchased items**

- Setup: nothing purchased.
- Action: `import_shopping_to_inventory({})`
- Expected: `isError: true` "No purchased items to import".

**Sh-15 import_shopping_to_inventory — with purchased**

- Setup: add product to cart, toggle_purchased true.
- Action: `import_shopping_to_inventory({})`
- Expected: new stock_lot created (no expires_on); cart row removed; `get_inventory` shows the product with increased containers; `get_shopping_list` no longer includes it.

**Sh-16 clear_shopping — full wipe**

- Action: `clear_shopping({})`
- Verify: `get_shopping_list({})` items=[].

### Cross-cutting / Edge (E-##)

**E-01 Unit conversion round-trip via consume**

- Setup: product with servings_per_container=10, stock 1 container.
- Action: consume 10 servings.
- Expected: stock = 0 (0.0 containers); not 0.1 containers or negative.

**E-02 consume floors at zero leaving no lot row**

- After E-01, `get_product_lots` returns empty.

**E-03 Placeholder products visible via get_products**

- (We can't set `is_placeholder` via create_product — schema doesn't expose it.) Mark as coverage gap.

**E-04 [MEAL] product spec in M-08 verifies meal-prep freeze**

- Already covered in M-08.

**E-05 Invalid UUIDs consistently error**

- Covered across P-10, P-14, S-07, C-07, M-10, M-12, Sh-08, Sh-10.

**E-06 Cross-user isolation**

- Requires a second authenticated user — skip (no second auth path in this session).

### Cleanup (CL-##)

**CL-01 Delete all E2E meal plan entries**

- Iterate get_meal_plan over TODAY±1 and delete any whose `recipe_name` or `product_name` contains `[E2E-2026-04-22]`.

**CL-02 Clear shopping list items referencing E2E products**

- Use delete_shopping_item for each.

**CL-03 Delete food_logs tied to E2E products**

- No MCP tool exists — **coverage gap / cleanup gap**. Food_logs FK CASCADES on product delete.

**CL-04 Delete temp_items**

- No MCP tool for temp_item deletion. **Cleanup gap** — flag for Jeremy. Prefix will let him grep/delete.

**CL-05 Delete stock lots**

- No explicit delete tool. We rely on `consume(..., qty: 9999)` or product-delete cascade. Will zero out lots via consume.

**CL-06 Delete recipes**

- No MCP tool for recipe deletion. **Cleanup gap** — recipes will linger with E2E prefix.

**CL-07 Delete products**

- No MCP tool for product deletion. Products will cascade food_logs/stock_lots/recipe_ingredients/meal_plan_entries on delete, but without the tool we **cannot delete**. Confirmed gap — all created products remain with `[E2E-2026-04-22]` prefix.

Cleanup strategy summary: consume stock to zero, clear shopping, delete meal entries. Products + recipes + temp_items + [MEAL] products cannot be deleted via MCP — Jeremy will need to clean them out manually via SQL or UI.

---

## Execution order for Phase 2

1. Sh-01 clear shopping (baseline)
2. P-## product CRUD (P-01 … P-14)
3. S-## stock (S-01 … S-10)
4. C-## consume (C-01 … C-07)
5. R-## recipes (R-01 … R-08) [create P-R1, P-R2 first]
6. M-## meal plan + mark_done (M-01 … M-12)
7. Ma-## macros (Ma-01 … Ma-05)
8. Sh-## shopping (Sh-02 … Sh-16)
9. E-## edge
10. CL-## cleanup pass

## Expected scenario count

- Products: 14
- Stock: 10
- Consume: 7
- Recipes: 8
- Meal plan: 12
- Macros: 5
- Shopping: 16
- Edge: 6 (one skipped pre-flight)
- Cleanup: 7

**Total: 85 scenarios** (run count excluding skips).
