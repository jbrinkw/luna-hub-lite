# Feature Audit: Legacy vs New Code

Generated 2026-03-04. Four-pass audit comparing legacy code against new implementation.

---

## CoachByte — Missing Features

### CRITICAL BUGS

| #   | Feature                                          | Severity | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **SplitPage JSONB key mismatch**                 | CRITICAL | `SplitPage.tsx:154-161` saves template_sets with keys `reps`, `load`, `load_percentage`. But `ensure_daily_plan` SQL reads `target_reps`, `target_load`, `target_load_percentage`. Any split created via the UI produces planned_sets with NULL values. Tests pass because they bypass the UI and insert correct keys directly. **Seed data has same bug** — `seed.sql:407-465` uses `reps`/`load` keys too, so demo splits also produce NULLs on new days. |
| C2  | **Relative load % hardcoded to 80**              | CRITICAL | `SplitPage.tsx:270-271` — checking the Rel% checkbox sets `load_percentage` to hardcoded `80`. The field renders as a `<span>` (not input), so users can never set 70%, 90%, etc.                                                                                                                                                                                                                                                                           |
| C3  | **`todayStr()` ignores `day_start_hour`**        | HIGH     | `shared/dates.ts:16-18` — `todayStr()` uses browser local time with no offset for `day_start_hour`. If user sets `day_start_hour=4` and it's 2:00 AM, client date differs from server `get_logical_date()`, potentially creating plans for the wrong day. Legacy `getCurrentDayIso()` in `App.jsx:30-60` has correct implementation using `Intl.DateTimeFormat` + timezone + day_start offset.                                                              |
| C4  | **Seed `user_config` goal keys don't match SQL** | CRITICAL | `seed.sql:327-330` seeds keys `calorie_goal`, `protein_goal`, `carbs_goal`, `fat_goal`. But `get_daily_macros` reads `goal_calories`, `goal_protein`, `goal_carbs`, `goal_fat`. Demo macro goals are invisible — RPC returns server defaults (2000/250/150/65) instead of seeded values (2200/220/180/73).                                                                                                                                                  |

### Functional Gaps

| #   | Feature                                           | Severity | Details                                                                                                                                                                                                                         |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Inline editing of planned sets**                | CRITICAL | Legacy lets you edit exercise, reps, load, rest, order for any queued set. New queue is read-only.                                                                                                                              |
| 2   | **Add/delete planned sets in queue**              | CRITICAL | Can't add new sets to today's queue or remove existing ones                                                                                                                                                                     |
| 3   | **Delete completed sets**                         | HIGH     | Can't undo a completed set                                                                                                                                                                                                      |
| 4   | **Plate breakdown display**                       | HIGH     | Settings page stores bar weight + plates config but NO `calculatePlates()` utility exists. Legacy `weightCalc.js:18-67` has full implementation. Weights shown as raw numbers everywhere. Legacy shows "185 (45,25)".           |
| 5   | **Delete day / delete today's plan**              | HIGH     | Can't delete a daily log entry. Spec says "delete today's plan" button forces fresh reload from split template for updated relative loads.                                                                                      |
| 6   | **Tracked exercises persistence (PRs)**           | HIGH     | Add/remove tracked exercises only modifies local state — resets on refresh, never persists to DB. Spec says "Any exercise with completed sets appears automatically" — the tracked exercise management UI contradicts the spec. |
| 7   | **Timer never writes `expired` state to DB**      | HIGH     | `TodayPage.tsx:223-281` — no handler ever writes `state='expired'`. DB row stays `state='running'` with past `end_time`. Cross-device/tab sync broken for timer expiry.                                                         |
| 8   | **Workout summary/notes textarea**                | HIGH     | `daily_logs` table has a `notes` column, but TodayPage has no textarea to view/edit workout notes for the current day. Legacy `DayDetail.jsx` has save-on-blur textarea.                                                        |
| 9   | **PR toast / alert notifications**                | MEDIUM   | Spec requires "PR alerts when a computed best exceeds previous session's best" + "Toast notifications for set completed, PR alerts." No `IonToast` anywhere in CoachByte.                                                       |
| 10  | **Estimated 1RM-10RM rep-range pills**            | MEDIUM   | Spec says "UI displays estimated 1RM through 10RM as rep-range pills." Current code only shows actual recorded rep/load records. Legacy `processPRs()` synthesizes estimated 1RM when no actual 1-rep data exists.              |
| 11  | **History exercise filter**                       | MEDIUM   | IonSelect present but `disabled={true}` with "Coming soon".                                                                                                                                                                     |
| 12  | **Past day detail (planned vs completed)**        | MEDIUM   | Spec says "Click a day to open its detail (same layout as Today's Workout, read-only for past days)." History only shows completed sets in a simplified inline expansion.                                                       |
| 13  | **Rest and Order columns in queue**               | MEDIUM   | Legacy shows rest seconds and order number per set in queue table. New code omits both. Split planner also missing Order column display.                                                                                        |
| 14  | **Set reordering in split**                       | MEDIUM   | Order auto-assigned, no reorder UI. No explicit order field shown.                                                                                                                                                              |
| 15  | **Offline state doesn't disable write buttons**   | MEDIUM   | Spec says "Offline indicator (disabled buttons + 'no connection' banner)". No CoachByte page checks `online` state. All buttons always enabled.                                                                                 |
| 16  | **Timer controls not in Next-In-Queue card**      | MEDIUM   | Spec ASCII shows `[Complete Set] [Start 3:00] [Custom Timer]` in one card. Code has timer in separate right-column RestTimer component.                                                                                         |
| 17  | **History shows only days with data (no filter)** | MEDIUM   | Legacy filters to show only days with `completed_sets_count > 0`. New shows ALL daily_logs including empty days.                                                                                                                |
| 18  | **`isEditing` guard for Realtime overwrites**     | MEDIUM   | Legacy uses `isEditing` ref — polling skips refresh when user is mid-edit. New code has no equivalent. Realtime updates could overwrite in-progress field edits.                                                                |
| 19  | **Settings rest duration format**                 | LOW      | ASCII shows `[3:00]` mm:ss format. Code shows raw seconds integer input with "(seconds)" label.                                                                                                                                 |
| 20  | **Completion timestamp display**                  | LOW      | `completed_at` is fetched but never displayed in completed sets table. Legacy shows formatted time column via `Intl.DateTimeFormat`.                                                                                            |
| 21  | **History date formatting**                       | LOW      | `HistoryPage.tsx:201` — shows raw ISO "2026-03-03". Legacy used "Tue, Mar 3, 2026". `formatDateDisplay` exists in `dates.ts` but isn't used.                                                                                    |
| 22  | **Silent validation failure on set completion**   | LOW      | `SetQueue.tsx:66-72` — if reps/load parse to NaN, function returns silently. No error message shown.                                                                                                                            |
| 23  | **SetQueue `onTimerToggle` dead code**            | LOW      | `TodayPage.tsx:361-367` never passes `onTimerToggle` prop. Timer toggle button in SetQueue (lines 119-123) is dead code, never renders.                                                                                         |
| 24  | **Split page no unsaved-changes guard**           | LOW      | Editing Monday + Tuesday but only clicking Save on Monday loses Tuesday's changes. No dirty-state warning on navigation.                                                                                                        |

---

## ChefByte — Missing Features

### CRITICAL

| #   | Feature                                     | Severity | Details                                                                                                                                                                                                   |
| --- | ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Hardware barcode scanner detection**      | CRITICAL | Legacy has `useScannerDetection` hook (127 lines) for rapid keystroke capture from USB/Bluetooth scanners. New code only has a manual input field — hardware scanners won't work unless input is focused. |
| 2   | **analyze-product edge function not wired** | CRITICAL | TODO comment at `ScannerPage.tsx:192`. Edge function exists and is fully implemented but never called. Unknown barcodes just create bare placeholder products.                                            |
| 3   | **Walmart link/search integration**         | CRITICAL | "Link Selected" permanently disabled (`WalmartPage.tsx:194`). No scrape API calls. No batch workflow. No search results UI. `walmart-scrape` edge function exists but is never called from UI.            |

### HIGH

| #   | Feature                                                      | Severity | Details                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | **Walmart price refresh**                                    | HIGH     | "Refresh All Prices" permanently disabled (`WalmartPage.tsx:270`). Edge function exists but not wired.                                                                                                                                                                                                |
| 5   | **Scanner undo/rollback**                                    | HIGH     | Delete from queue (`ScannerPage.tsx:347-349`) only removes from memory. Legacy reversed the DB operation (removed stock for purchases, added stock back for consumes). Legacy also had diff-based bidirectional stock adjustments when editing quantity post-scan.                                    |
| 6   | **Delete temp items / food logs**                            | HIGH     | Macros page (`MacroPage.tsx:459-471`) shows consumed items but no delete button on any row. Legacy had delete per item.                                                                                                                                                                               |
| 7   | **Location management**                                      | HIGH     | No UI to create/edit/delete storage locations. `locations` table exists but no management page. All stock lots get `location_id: null`.                                                                                                                                                               |
| 8   | **No expiry date input on inventory**                        | HIGH     | `InventoryPage.tsx:addStock` always inserts `expires_on: null`. No expiry date field. FIFO consumption (nearest expiration first) is meaningless since all lots have null expiry. Legacy auto-computed expiry from `default_best_before_days` on product — that field exists in DB but is never used. |
| 9   | **No Realtime subscriptions in any ChefByte page**           | HIGH     | Spec says "Realtime over polling." All ChefByte pages use `useEffect` + `loadData()` with no Supabase Realtime. Changes from scanner/MCP/other tabs won't reflect live.                                                                                                                               |
| 10  | **Non-atomic recipe ingredient save**                        | HIGH     | `RecipeFormPage.tsx:save handler` does DELETE ALL ingredients then INSERT new ones. If insert fails after delete, all ingredients lost. No transaction wrapper.                                                                                                                                       |
| 11  | **Inventory `addStock` creates new lots instead of merging** | HIGH     | Every `+1 Ctn` click inserts a NEW `stock_lots` row instead of merging with existing lot matching `(product_id, location_id, expires_on)`. Leads to lot proliferation — dozens of 1-container lots per product.                                                                                       |
| 12  | **Dashboard `importShopping` has inverted boolean (BUG)**    | HIGH     | `HomePage.tsx:247-251` queries `.eq('purchased', false)` — imports UN-purchased items into inventory. Should be `.eq('purchased', true)`. The spec says "Import only checked/purchased rows."                                                                                                         |

### MEDIUM

| #   | Feature                                                       | Severity | Details                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- | ---------------------------------------------------------------- |
| 13  | **Scanner unit conversion**                                   | MEDIUM   | Toggling servings/containers (`ScannerPage.tsx:601-609`) changes label only, doesn't convert the quantity value.                                                                                          |
| 14  | **"Can Be Made" recipe filter**                               | MEDIUM   | Disabled chip (`RecipesPage.tsx:183`). Legacy has working stock-based filter via per-recipe ingredient fulfillment check against current stock.                                                           |
| 15  | **Recipe stock status badges**                                | MEDIUM   | Every recipe card shows "STOCK N/A" unconditionally (`RecipesPage.tsx:250`). No stock calculation.                                                                                                        |
| 16  | **"Meal Plan -> Cart" sync**                                  | MEDIUM   | Disabled button on Home (`HomePage.tsx:403`) and NOT present on MealPlanPage (spec ASCII shows it there too).                                                                                             |
| 17  | **Meal prep toggle on existing entries**                      | MEDIUM   | Can only set `meal_prep` during add, not toggle after creation (`MealPlanPage.tsx:528-534`).                                                                                                              |
| 18  | **Shopping placeholder exclusion**                            | MEDIUM   | `importToInventory` (`ShoppingPage.tsx:207`) imports ALL purchased items including placeholders. Legacy filters them out.                                                                                 |
| 19  | **Scanner debounced post-scan editing**                       | MEDIUM   | No way to modify a scanned item's quantity after scanning. Legacy had `overwriteOnNextDigit` UX — first keypad press replaces value, subsequent presses append.                                           |
| 20  | **Macro density recipe filters**                              | MEDIUM   | Legacy has protein-per-100-cal and carbs-per-100-cal slider filters with percentile display. New code only has text search + `< 30 min` toggle. Missing "High protein" filter chip from ASCII layout too. |
| 21  | **Recent New Items on Home**                                  | MEDIUM   | Legacy Home shows recently scanned items with inline edit for name/location/expiry. Missing from new.                                                                                                     |
| 22  | **Get Cart Links / Open Shopping List Links**                 | MEDIUM   | Legacy `walmart.ts` extracts product IDs via regex `/\/ip\/(\d+)/` and constructs `affil.walmart.com/cart/addToCart` deep link. Missing entirely.                                                         |
| 23  | **Custom Walmart URL input**                                  | MEDIUM   | Legacy has per-product "paste custom Walmart link" input with `cleanWalmartUrl()` normalization. Missing from WalmartPage.                                                                                |
| 24  | **Meal plan macros per entry**                                | MEDIUM   | Grid items show only name + done/PREP badge. Spec says servings, cal, protein, carbs, fat per entry. Detail table also missing servings column.                                                           |
| 25  | **Meal plan meal type labels**                                | MEDIUM   | DB has `meal_type` column but UI never sets or displays it. Add Meal modal has no meal type selector. No breakfast/lunch/dinner/snack labels.                                                             |
| 26  | **Dashboard macro summary: consumed/planned/goal**            | MEDIUM   | Spec and ASCII layouts show 3 values (consumed/planned/goal). Both Dashboard and MacroPage only show consumed/goal (2 values). `MacroProgressBar` component only accepts `current` and `goal` props.      |
| 27  | **Dashboard "Liquid Log" modal + button**                     | MEDIUM   | Spec says Dashboard should have "Liquid Log (name, amount, calories, refill checkbox)" modal and a "Liquid Tracking" action button. Both missing.                                                         |
| 28  | **Dashboard "Today's Meals" section**                         | MEDIUM   | Legacy has both "Today's Meal Prep" AND "Today's Meals" sections. New only has "Today's Meal Prep".                                                                                                       |
| 29  | **Scanner "Consume -> Meal Plan" toggle**                     | MEDIUM   | Legacy had `mealPlanEnabled` toggle to auto-add consumed items to meal plan. Missing from scanner.                                                                                                        |
| 30  | **Execute Prep ingredient preview**                           | MEDIUM   | ASCII layout shows "Ingredient                                                                                                                                                                            | Need | Stock | After" table in confirmation. Current shows simple text confirm. |
| 31  | **Meal prep `is_done` race condition**                        | MEDIUM   | `MealPlanPage.tsx` sets `is_done` via direct `.update()` BEFORE calling `mark_meal_done` RPC. If RPC fails, meal shows done but stock/macros never logged.                                                |
| 32  | **Recipe "Add to Meal Plan" just navigates**                  | MEDIUM   | `RecipesPage.tsx:260` — navigates to `/chef/meal-plan` without passing recipe ID. No context about which recipe to add.                                                                                   |
| 33  | **Recipe detail side panel**                                  | MEDIUM   | ASCII layout shows a Recipe Detail panel with ingredients, macros, actions. Currently clicking a recipe goes to edit form. No inline detail view.                                                         |
| 34  | **Inventory no search/filter**                                | MEDIUM   | Spec says "Product catalog with search and filtering". Inventory page has no search input. Settings/Products has search but Inventory doesn't.                                                            |
| 35  | **Inventory missing servings-equivalent display**             | MEDIUM   | Spec says "total containers, servings equivalent, nearest expiration, lot count". Grouped view shows containers but NOT servings equivalent.                                                              |
| 36  | **Macros consumed table missing TOTAL row**                   | MEDIUM   | ASCII layout shows a TOTAL row at bottom. Code renders individual rows but no summary row.                                                                                                                |
| 37  | **Recipes missing description + base_servings on cards**      | MEDIUM   | Spec says "Card grid with recipe name, description, servings, times, per-serving macros." `description` and `base_servings` are fetched but not displayed on recipe cards.                                |
| 38  | **Shopping page missing "Clear" button**                      | MEDIUM   | Spec says "Manual add/remove/clear". MCP tool `CHEFBYTE_clear_shopping` exists. No "Clear All" button in UI.                                                                                              |
| 39  | **Recipe ingredients not editable after adding**              | MEDIUM   | `RecipeFormPage.tsx` ingredients table only has "Remove". No inline editing of quantity, unit, or note. Must remove and re-add to change.                                                                 |
| 40  | **Shopping auto-add doesn't deduct existing list quantities** | MEDIUM   | Legacy `autoAddBelowMinStock()` computes `min_stock - current_stock - already_on_list`. New code can create duplicate entries for items already on the list.                                              |
| 41  | **Offline state doesn't disable write buttons**               | MEDIUM   | Same as CoachByte — no ChefByte page checks `online` state. All buttons always enabled.                                                                                                                   |
| 42  | **Scanner barcode input loses focus after scan**              | MEDIUM   | After `handleBarcodeSubmit`, input value is cleared but `.focus()` is never called. Hardware scanner workflow breaks if input loses focus.                                                                |
| 43  | **Walmart "Missing Prices" queries wrong products**           | MEDIUM   | `WalmartPage.tsx:63-68` queries products where `walmart_link IS NOT NULL` and `price IS NULL`. But spec says "Missing Prices" = products NOT on Walmart that need manual price entry. Logic is inverted.  |
| 44  | **No stock transaction logging**                              | MEDIUM   | Legacy inserts `stock_log` entries for every purchase/import with `{product_id, change, unit, source, note}`. New code has no audit trail — stock changes are fire-and-forget.                            |
| 45  | **Shopping add-item doesn't create placeholder product**      | MEDIUM   | Legacy creates a `is_placeholder: true` product first, then links shopping item to it via FK. New code adds items directly, which may cause FK issues or prevent proper tracking on import.               |
| 46  | **Meal plan price display**                                   | MEDIUM   | Legacy shows product price per meal entry. New code shows no price info on meal plan.                                                                                                                     |

### LOW

| #   | Feature                                 | Severity | Details                                                                                                                                    |
| --- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 47  | **Scanner stock level display**         | LOW      | Queue items store `stockLevel: null` but never populated after action.                                                                     |
| 48  | **Inventory zero-stock filter**         | LOW      | Legacy filters out zero-stock items by default. New shows all.                                                                             |
| 49  | **Inventory consume button disable**    | LOW      | Legacy disables consume buttons when stock is zero. New doesn't.                                                                           |
| 50  | **Inventory stock color coding**        | LOW      | Legacy: red (stock=0), orange (stock < min), green otherwise. New has no color coding.                                                     |
| 51  | **Scanner sound effects**               | LOW      | Legacy plays `beepBad()` on error. New has no audio feedback.                                                                              |
| 52  | **Scanner `isRed` visual state**        | LOW      | Legacy highlights newly scanned items with red background + "New" filter toggle. New has no visual distinction for unacknowledged items.   |
| 53  | **Meal plan meal execution on Home**    | LOW      | Legacy Home shows today's meals with done/undo toggle. New only shows prep entries.                                                        |
| 54  | **Recipe ingredient units**             | LOW      | Only "Serving" and "Container" hardcoded. Legacy queried `quantity_units` table.                                                           |
| 55  | **Import/Export (JSON backup/restore)** | LOW      | Legacy has full `ImportExport.tsx` with FK-ordered import + idempotent upsert. Missing from new.                                           |
| 56  | **Two-click delete pattern**            | LOW      | Legacy uses "first click = Confirm?, second click = delete, 3s auto-reset timeout". New uses `window.confirm()` or `IonAlert`.             |
| 57  | **LiquidTrack per-scale aggregation**   | LOW      | Legacy groups `liquid_events` by `scale_id` with daily totals per scale. New sums all liquid events together with no per-device breakdown. |

---

## Database / Schema Issues (Third Pass)

| #   | Issue                                                             | Severity | Details                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Seed user_config goal keys wrong**                              | CRITICAL | seed.sql uses `calorie_goal` etc., `get_daily_macros` reads `goal_calories` etc. Demo macro goals broken on first login.                                                                                                           |
| D2  | **Seed template_sets JSONB keys wrong**                           | HIGH     | Same as C1 but confirmed in seed.sql too. Any new day from demo split template gets NULL targets.                                                                                                                                  |
| D3  | **Generated DB types out of date**                                | HIGH     | `recipes.instructions` column, `app_activations.activation_id`, `reset_demo_dates()`, updated `mark_meal_done` signature — all missing from `packages/db-types/`. Two diverging type files (`database.ts` vs `database.types.ts`). |
| D4  | **No index on `hub.api_keys.api_key_hash`**                       | HIGH     | Sequential scan on every MCP authentication. Needs partial index `WHERE revoked_at IS NULL`.                                                                                                                                       |
| D5  | **No index on `coachbyte.planned_sets.plan_id`**                  | MEDIUM   | High-frequency query path in `ensure_daily_plan` + `complete_next_set` + TodayPage load.                                                                                                                                           |
| D6  | **No index on `chefbyte.recipe_ingredients.recipe_id`**           | MEDIUM   | Queried on every meal completion and recipe edit.                                                                                                                                                                                  |
| D7  | **`template_sets` JSONB has no validation**                       | MEDIUM   | No CHECK constraint. Any JSON shape accepted, `ensure_daily_plan` silently produces NULLs on key mismatch.                                                                                                                         |
| D8  | **`liquidtrack` edge function date computation differs from SQL** | LOW      | TypeScript uses `Intl.DateTimeFormat` + hour check. SQL uses interval subtraction. Could diverge on DST transitions.                                                                                                               |
| D9  | **pgTAP test uses non-existent config key**                       | LOW      | `activation_chefbyte.test.sql:128` uses `daily_calorie_goal` — neither seed key nor SQL function key. Test passes by coincidence.                                                                                                  |

---

## MCP / Extension Issues (Fourth Pass)

### CRITICAL

| #   | Issue                                 | Severity | Details                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | **Extension credential key mismatch** | CRITICAL | `ExtensionsPage.tsx` saves credentials with wrong keys. Obsidian saves `vault_path` but handler reads `obsidian_api_key` + `obsidian_url`. Todoist saves `api_token` but handler reads `todoist_api_key`. HA saves `url`/`token` but handler reads `ha_api_key`/`ha_url`. Every extension will fail silently at runtime. |

### HIGH

| #   | Issue                                                   | Severity | Details                                                                                                                                                                                        |
| --- | ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2  | **ToolsPage hardcodes wrong tool names**                | HIGH     | `ToolsPage.tsx:9-20` uses SCREAMING_CASE names that don't match any actual tool. Only 10 of 41 tools listed. Tool toggles write fake names to DB, have zero effect on what MCP Worker exposes. |
| M3  | **MCP `update_plan` non-atomic replace**                | HIGH     | Inserts new planned sets then DELETEs old ones. If old sets have linked completed_sets, FK constraint either fails or orphans references.                                                      |
| M4  | **MCP `update_split` uses correct keys but UI doesn't** | HIGH     | MCP tool correctly uses `target_reps`/`target_load`. UI `SplitPage.tsx` saves `reps`/`load`. Mixed MCP + UI editing produces inconsistent splits.                                              |

### MEDIUM

| #   | Issue                                                                    | Severity | Details                                                                                                |
| --- | ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| M5  | **MCP `create_recipe` missing `instructions` field**                     | MEDIUM   | Tool schema omits `instructions` property. `get_recipes` also doesn't select it.                       |
| M6  | **MCP timer: only `set_timer` (start), no pause/resume/reset**           | MEDIUM   | UI has full timer controls. MCP can only start timers.                                                 |
| M7  | **MCP `get_timer` returns `done` but never writes to DB**                | MEDIUM   | Same as finding #7 but on MCP pathway.                                                                 |
| M8  | **MCP `below_min_stock` overwrites shopping qty**                        | MEDIUM   | Uses upsert that replaces qty instead of adding to it. UI correctly skips existing items.              |
| M9  | **ShoppingPage `addItem` uses INSERT not UPSERT**                        | MEDIUM   | Throws duplicate key error if product already on list. MCP tool correctly uses upsert.                 |
| M10 | **No MCP tool to delete meal plan entries**                              | MEDIUM   | Can add and mark done, but can't delete.                                                               |
| M11 | **No MCP tool to update products**                                       | MEDIUM   | Only `create_product` and `set_price`. No name/barcode/macro updates.                                  |
| M12 | **No MCP tool for exercise CRUD**                                        | MEDIUM   | Tools require `exercise_id` but AI can't create/discover exercises.                                    |
| M13 | **No MCP `get_exercises` tool**                                          | MEDIUM   | New/unused exercises invisible to MCP.                                                                 |
| M14 | **No MCP tool to delete completed sets**                                 | MEDIUM   | Once completed, no undo via MCP.                                                                       |
| M15 | **MCP shopping: no `purchased` toggle, no import, no individual delete** | MEDIUM   | Only `clear_shopping` (nuke all). Can't toggle purchased, import to inventory, or remove single items. |
| M16 | **MCP `get_recipes` doesn't compute total/per-serving macros**           | MEDIUM   | Only raw ingredient data. AI must do math itself.                                                      |
| M17 | **MCP `get_meal_plan` doesn't include macro data**                       | MEDIUM   | No calories/protein/carbs/fat per entry.                                                               |
| M18 | **Extension `enabled` toggle doesn't filter tool listing**               | MEDIUM   | Disabled extension tools still appear in `tools/list`. Only fail at execution time.                    |
| M19 | **MCP Worker doesn't handle `ping` method**                              | MEDIUM   | Returns `-32601 Method not found` on keepalive pings.                                                  |
| M20 | **MCP Worker doesn't implement `resources/list` or `prompts/list`**      | MEDIUM   | Returns error instead of empty list.                                                                   |

### Non-Obvious UI Bugs Found via MCP Comparison

| #   | Issue                                                        | Severity | Details                                                                                                                     |
| --- | ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| M21 | **Inventory `addStock` silently fails without location**     | MEDIUM   | If no location exists, `+1 Ctn` does nothing. No error shown. MCP tool correctly returns error message.                     |
| M22 | **Inventory shows ALL products including zero-stock**        | MEDIUM   | MCP `get_inventory` only returns products with stock > 0. UI shows everything, cluttering the view.                         |
| M23 | **MacroPage uses browser date, not logical date**            | MEDIUM   | `MacroPage.tsx:55` uses `toDateStr(new Date())`. Same as C3 but affects macro tracking — wrong day's macros shown at 2 AM.  |
| M24 | **Inventory `consumeStock` hardcodes `p_log_macros: false`** | MEDIUM   | Consuming from Inventory page never logs macros. MCP defaults to `true`. Same action gives different results via UI vs MCP. |

---

## Cross-Cutting Issues (Fourth Pass)

### Auth & Session

| #   | Issue                                        | Severity | Details                                                                                                                                                              |
| --- | -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **No token expiry / refresh error handling** | HIGH     | `AuthProvider.tsx` — if token refresh fails (network error), user stays in "looks logged in but 401s on every call" state. No `SIGNED_OUT` vs "expired" distinction. |
| X2  | **signOut doesn't clear AppProvider state**  | MEDIUM   | `activations` state not reset on logout. Brief window of cross-user data leak on re-login.                                                                           |
| X3  | **AuthGuard shows raw "Loading..." text**    | LOW      | Every other loading state uses `IonSpinner`. AuthGuard uses unstyled `<div>Loading...</div>`.                                                                        |

### Error Handling

| #   | Issue                                             | Severity | Details                                                                                                                                                                                   |
| --- | ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X4  | **ALL data-fetch queries silently ignore errors** | HIGH     | Every `loadData` function in 30+ locations destructures `{ data }` and discards `error`. Failed reads show empty state with no indication of failure. Only write operations check errors. |
| X5  | **ErrorBoundary only catches render-time errors** | MEDIUM   | All Supabase calls are async in `useEffect`. Unhandled promise rejections go to console, not ErrorBoundary.                                                                               |
| X6  | **HomePage importShopping swallows errors**       | MEDIUM   | Insert failure falls through to `loadData()` with no error message. Delete error not checked at all.                                                                                      |
| X7  | **ExtensionsPage toggle error has no feedback**   | LOW      | Optimistic update rolls back silently on error. No explanation shown.                                                                                                                     |

### Loading States

| #   | Issue                                                  | Severity | Details                                                                                                       |
| --- | ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| X8  | **SkeletonScreen components exist but are never used** | MEDIUM   | 4 skeleton variants built, tested, but imported in zero pages. All pages use `IonSpinner` instead. Dead code. |
| X9  | **ActivationGuard renders nothing while loading**      | LOW      | Returns `null` during activations query. Blank screen on slow loads.                                          |

### Form Validation

| #   | Issue                                             | Severity | Details                                                                                                                                                  |
| --- | ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X10 | **No numeric input has min/max constraints**      | HIGH     | Every `<IonInput type="number">` accepts negative values. Negative calories, servings, protein, stock all persist to DB. No DB CHECK constraints either. |
| X11 | **Recipe form allows zero-ingredient submission** | MEDIUM   | `handleSave` only checks `!name.trim()`. Recipes with no ingredients save and show 0/0/0/0 macros.                                                       |
| X12 | **Temp item allows zero/negative macros**         | LOW      | Only validates name. Zero-macro items clutter consumed table.                                                                                            |
| X13 | **Product form accepts negative macros/servings** | MEDIUM   | `addProduct` only validates name. Negative `servings_per_container` would invert container/serving math.                                                 |

### Navigation & Routing

| #   | Issue                                              | Severity | Details                                                                                     |
| --- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| X14 | **No 404 / catch-all route**                       | MEDIUM   | `/hub/nonexistent`, `/chef/nonexistent` render empty page inside layout. No "not found" UI. |
| X15 | **ChefByte index route goes to Scanner, not Home** | LOW      | `/chef` shows Scanner. Legacy defaulted to dashboard.                                       |

### State Management

| #   | Issue                                              | Severity | Details                                                                                                       |
| --- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| X17 | **`todayStr()` closures go stale across midnight** | MEDIUM   | TodayPage captures `todayStr()` at render time. Leaving page open past midnight uses stale date in callbacks. |

### Accessibility

| #   | Issue                                                   | Severity | Details                                                                                                                                           |
| --- | ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| X18 | **Zero ARIA labels in all page components**             | HIGH     | No `aria-label`, no landmark elements (`<main>`, `<nav>`). Delete buttons shown as `x` have no accessible name. Scanner keypad buttons unlabeled. |
| X19 | **Dropdown autocomplete menus not keyboard-accessible** | MEDIUM   | Recipe ingredient, meal plan add, shopping add — all use `<div onClick>`. No arrow key nav, no `role="listbox"`, no `aria-activedescendant`.      |
| X20 | **Scanner barcode uses raw `<input>` not `IonInput`**   | LOW      | Inconsistent with rest of app. No associated `<label>`.                                                                                           |

### Miscellaneous

| #   | Issue                                                | Severity | Details                                                                                                     |
| --- | ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| X21 | **Supabase env vars fallback to localhost silently** | MEDIUM   | Missing `VITE_SUPABASE_URL` just `console.warn` and connects to localhost. Should hard-error in production. |
| X22 | **`chefbyte()`/`coachbyte()` helpers return `any`**  | LOW      | Zero type safety on all schema queries. Typos in column names compile fine but fail at runtime.             |
| X23 | \*\*`Number(value)                                   |          | 0` doesn't catch negatives\*\*                                                                              | MEDIUM | Combined with X10, negative values pass through all numeric inputs and persist to DB. |

---

## Additional Issues (Fifth Pass)

### Hub Module Gaps

| #   | Issue                                | Severity | Details                                                                                                                                                                        |
| --- | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | **No password reset flow**           | HIGH     | Spec says "Password reset, session management." No "Forgot password?" link on Login page. No recovery token callback route. Users who forget passwords can't recover accounts. |
| H2  | **No session management UI**         | LOW      | Spec lists "session management." No UI to view active sessions or revoke devices.                                                                                              |
| H3  | **No OAuth 2.1 client registration** | LOW      | Spec says "OAuth 2.1 client registration for MCP clients." Zero implementation — only API key auth exists.                                                                     |

### Performance

| #   | Issue                                                | Severity | Details                                                                                                                                                             |
| --- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **PrsPage fetches ALL completed_sets with no limit** | HIGH     | Queries entire user history on every render. 4000+ rows for active users. No pagination, no date filter. Client-side PR computation loops all rows.                 |
| P2  | **Zero responsive CSS breakpoints**                  | MEDIUM   | No `@media` queries in entire `apps/web/src/`. Scanner 2-column grid, MealPlan 7-column grid, Dashboard 4-column cards all hardcoded. Unusable on narrow viewports. |

### Memory Leaks / Race Conditions

| #   | Issue                                                       | Severity | Details                                                                                                                                                                                   |
| --- | ----------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Debounce timers never cleaned up on unmount**             | MEDIUM   | `MealPlanPage:232`, `ShoppingPage:87`, `RecipeFormPage:144`, `TodayPage:56` — all create timeouts via `useRef` but no cleanup in `useEffect` return. Orphaned callbacks after navigation. |
| R2  | **ModalOverlay doesn't block body scroll or handle Escape** | MEDIUM   | Custom modal doesn't set `overflow: hidden` on body. No Escape key handler. Affects all 8+ modals. Ionic `IonModal` handles both but isn't used.                                          |

### Functional

| #   | Issue                                                          | Severity | Details                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **`ilike` search queries vulnerable to SQL pattern injection** | MEDIUM   | `MealPlanPage:208`, `ShoppingPage:100`, `RecipeFormPage:159` — user input passed directly to `ilike`. Typing `%` matches everything, `_` matches single char. Not security risk (RLS), but functional bug. |
| F2  | **`lastSynced` only updates on activation loads**              | MEDIUM   | Spec says header shows "last synced" timestamp. Only updates when `loadActivations()` runs, not on any data load. Stale by hours during active use.                                                        |

### Test Coverage

| #   | Issue                                               | Severity | Details                                                                                                                                                                           |
| --- | --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **Zero page-level tests for ChefByte or CoachByte** | HIGH     | All 11 ChefByte pages and 5 CoachByte pages have zero unit/integration tests. Only reusable components tested. Page-level orchestration (data loading, handlers, state) untested. |

---

## Disabled Buttons / Stubs / "Coming Soon"

| File              | Line | Element                              |
| ----------------- | ---- | ------------------------------------ |
| `HomePage.tsx`    | 403  | "Meal Plan -> Cart" button disabled  |
| `RecipesPage.tsx` | 183  | "Can Be Made" filter chip disabled   |
| `RecipesPage.tsx` | 250  | Stock status badge shows "STOCK N/A" |
| `WalmartPage.tsx` | 194  | "Link Selected" button disabled      |
| `WalmartPage.tsx` | 270  | "Refresh All Prices" button disabled |
| `HistoryPage.tsx` | 169  | Exercise filter dropdown disabled    |

## TODO Comments in Production Code

| File              | Line | Comment                                                                      |
| ----------------- | ---- | ---------------------------------------------------------------------------- |
| `ScannerPage.tsx` | 192  | `// TODO: Call analyze-product Edge Function for automatic nutrition lookup` |

## Edge Functions Not Wired to UI

| Function          | Status                                            |
| ----------------- | ------------------------------------------------- |
| `analyze-product` | Fully implemented, never called from Scanner      |
| `walmart-scrape`  | Fully implemented, never called from Walmart page |
| `liquidtrack`     | Correctly NOT called from UI (IoT endpoint)       |

## Pages Missing Realtime Subscriptions

All ChefByte pages use `useEffect` + `loadData()` only:

- HomePage, MacroPage, InventoryPage, ShoppingPage, MealPlanPage, RecipesPage, WalmartPage, SettingsPage, ScannerPage

CoachByte pages missing Realtime:

- HistoryPage, SplitPage, PrsPage, SettingsPage

Only `TodayPage` (CoachByte) and `AppProvider` (shared) have Realtime subscriptions.

---

## What's Actually Better in New Code

- Timer state machine (pause/resume/reset) vs legacy fire-and-forget
- Supabase Realtime on TodayPage vs 1-second polling everywhere
- Multi-user auth + RLS
- Exercise library management (Settings page)
- Per-user plate calculator config in DB
- Lots view in inventory (legacy didn't have this)
- Keyset pagination on history
- LiquidTrack device management with SHA-256 key hashing
- Per-day split notes (legacy had single global notes)
- Auto-create today's plan on load (legacy required manual "Create Today" button)

---

## Summary Counts

| Category           | CRITICAL | HIGH   | MEDIUM | LOW    | Total   |
| ------------------ | -------- | ------ | ------ | ------ | ------- |
| CoachByte bugs     | 4        | —      | —      | —      | 4       |
| CoachByte gaps     | 2        | 5      | 7      | 6      | 20      |
| ChefByte gaps      | 3        | 9      | 34     | 11     | 57      |
| DB/Schema          | 1        | 3      | 3      | 2      | 9       |
| MCP/Extensions     | 1        | 3      | 16     | —      | 20      |
| MCP vs UI bugs     | —        | —      | 4      | —      | 4       |
| Auth/Session       | —        | 1      | 1      | 1      | 3       |
| Error handling     | —        | 1      | 2      | 1      | 4       |
| Form validation    | —        | 1      | 2      | 1      | 4       |
| Loading states     | —        | —      | 1      | 1      | 2       |
| Navigation         | —        | —      | 1      | 1      | 2       |
| Accessibility      | —        | 1      | 1      | 1      | 3       |
| Misc cross-cutting | —        | —      | 3      | 1      | 4       |
| Hub gaps           | —        | 1      | —      | 2      | 3       |
| Performance        | —        | 1      | 1      | —      | 2       |
| Memory/Race        | —        | —      | 2      | —      | 2       |
| Functional (5th)   | —        | —      | 2      | —      | 2       |
| Test coverage      | —        | 1      | —      | —      | 1       |
| **Total**          | **11**   | **27** | **80** | **28** | **146** |
