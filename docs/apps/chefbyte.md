# ChefByte

## Purpose

AI-powered nutrition system: meal planning, inventory management, macro tracking, barcode scanning, price intelligence, IoT scale integration.

## Features

### Dashboard

- Status cards: Missing Prices, Placeholder Items, Below Minimum Stock, Shopping Cart Value
- Macro day summary: progress bars for Calories, Protein, Carbs, Fats with percentage of goal
- Quick actions: Import Shopping List (imports checked purchased rows), Target Macros editor, Taste Profile, Meal Plan → Cart sync

### Barcode Scanner

- **Physical barcode scanner** (Bluetooth/USB HID) as input device. Camera scanning deferred to post-MVP Capacitor build.
- Four scan modes:
  1. **Purchase** — add to stock (in containers)
  2. **Consume (with macros)** — remove from stock + log macros
  3. **Consume (no macros)** — remove from stock only (e.g., discarded, given away)
  4. **Add to Shopping** — add to shopping list
- **Hardware scanner detection:** `useScannerDetection` hook detects USB/Bluetooth HID barcode scanners by monitoring rapid sequential keystrokes. Automatically captures scanned barcodes without manual input focus.
- Barcode lookup chain: check existing products → query OpenFoodFacts → Claude Haiku 4.5 normalization (platform-paid, no user API key needed). The `analyze-product` edge function is wired in for unknown barcodes — triggers automatic lookup and nutrition extraction.
- OpenFoodFacts: 100 req/min rate limit. Products not found or with null/zero macros fall through to Claude analysis.
- If any step in the pipeline fails after local product check (OFF down, Claude error), a placeholder product is automatically created with `is_placeholder = true`. The user can edit the product details later.
- The barcode pipeline handles general product data only (identity, nutrition, naming). Walmart is a separate system for pricing and ordering.
- Per-user daily quota on `analyze-product` calls (100/day). When exceeded, the scan falls through to placeholder creation. BYOK option is a future feature.
- Barcode is nullable — products can exist without barcodes (manual creation, bulk items, homemade products). Unique constraint: `UNIQUE(user_id, barcode) WHERE barcode IS NOT NULL`.
- Keypad with context-aware units: Containers for purchase, Servings for consume (toggleable). Unit conversion applies when toggling between servings and containers — values recalculate using `servings_per_container`.
- **Undo/rollback per scan:** Each scan mode provides an undo button that reverses the DB operations (stock additions, stock removals, macro logs, shopping list additions) for the most recent scan.
- **Auto-focus:** Barcode input field automatically regains focus after each scan completes, enabling rapid sequential scanning.
- Nutrition editor: auto-scaling (edit calories → macros scale proportionally, edit macro → calories recalculate via 4-4-9 rule)
- Red-highlight for new/unacknowledged scans

### Inventory Management

- Product catalog with search and filtering. Search input uses `ilike` with special character escaping for safe pattern matching.
- **Servings equivalent display:** Grouped product view shows both container totals and servings equivalent (containers x servings_per_container).
- **Stock color coding:** Stock levels are color-coded — red (zero/critical), orange (below minimum), green (at or above minimum).
- **Realtime subscriptions:** Inventory page subscribes to Supabase Realtime on `stock_lots` and `products` tables for live updates across browser tabs.
- Stock add uses the user's default location (first by creation date); no location selector in the add modal.
- Storage locations (Fridge, Pantry, Freezer) — each lot assigned to a location; the same product can span multiple locations via separate lots
- Stock is tracked at the **lot level** in `chefbyte.stock_lots`. Each lot has its own `lot_id` and references a root `product_id`.
- Each lot stores `expires_on DATE` (nullable). `NULL` means "no expiration" and sorts last for consumption/display.
- Lot merge rule: quantities merge only when `(user_id, product_id, location_id, expires_on)` match. Different expiration or location creates a separate lot.
- Inventory UI defaults to **grouped by product** (total containers, servings equivalent, nearest expiration, lot count) with a toggle to view raw lots.
- Quantity display defaults to **containers**. Mutations accept **containers or servings**; serving inputs are converted server-side via `servings_per_container`.
- **Consume stock logs macros:** All stock removal actions (+/-, +S/-S, Consume All) route through the `consume_product` RPC with `p_log_macros: true`, logging macros for the consumed amount.
- **Expiry date input on stock add:** Adding stock includes an optional expiration date picker. Lots with matching `(user_id, product_id, location_id, expires_on)` merge quantities; different expiration dates create separate lots.
- Manual product creation (full control without barcode)
- Minimum stock thresholds per product
- Placeholder products (`is_placeholder = true`) for planning before purchase — shopping and ordering logic checks this explicitly
- Product deletion cascades to recipe ingredients: `ON DELETE CASCADE` on the recipe_ingredients FK. Recipes that lose ingredients show as incomplete until re-linked.

### Recipe Search & Planning

- Recipe ingredients reference products via FK, with quantity specified as a number + unit (containers or servings, extensible enum)
- **Recipe macros computed dynamically at query time** — sum of (ingredient product macros × quantity) with unit conversion. No separate recompute job needed. Always reflects current product nutrition data.
- Macro density filters (protein per 100 cal, carbs per 100 cal) with configurable g/100cal thresholds
- **Stock status badges:** Recipe cards display stock availability badges — `CAN MAKE` (green, all ingredients in stock), `PARTIAL` (orange, some ingredients available), `NO STOCK` (red, insufficient stock). Recipe cards also show description and servings count.
- "Can Be Made" filter: recipes where current stock covers all ingredients after unit conversion via `servings_per_container`
- Quick filter toggle (active time < 30 min)
- Recipe search/filter controls live on the main **Recipes** page (no separate Recipe Finder route)
- Per-serving and total macro display
- **Inline ingredient editing:** Recipe form supports editing ingredient quantity, unit, and note inline. Zero-ingredient validation prevents saving recipes without at least one ingredient.

### Meal Plan

- Day-by-day meal schedule using `logical_date` computed from `day_start_hour`
- Two execution modes:
  - **Regular** (`meal_prep = false`): Mark Done consumes ingredients and counts macros for the meal entry's `logical_date` (if completed later, it still logs to the planned day)
  - **Meal Prep** (`meal_prep = true`): Execute consumes ingredients and creates a `[MEAL]` lot for that prep run. Execution itself does **not** log macros. `[MEAL]` root products are auto-generated per recipe in the background and used as the product definition. Each prep run carries its own expiration; standard lot merge rules apply only when `(product_id, location_id, expires_on)` are identical. Named as `[MEAL] Recipe Name MM-DD`. Nutrition is frozen at execution time for the lot, so later recipe edits do not change existing prepped meal lots.
- Meal plan entries count toward macros only when actually consumed: regular entries at Mark Done, and meal-prep entries only when the resulting `[MEAL]` lot is later consumed in a macro-logging flow.
- **Meal type labels:** Each meal plan entry has a `meal_type` label (breakfast, lunch, dinner, snack) for categorization.
- **Macros per entry:** Meal plan grid and day detail views show macro values (calories, protein, carbs, fats) per entry, with a **macros total row** in the day detail table.
- Toggle between regular and meal prep per entry (including toggling on existing entries)
- Entries linked to recipes auto-calculate ingredient requirements. `meal_plan.servings` acts as a batch multiplier: ingredient_needed = recipe_ingredient.quantity × servings. Recipe ingredient quantities represent the total amount for the full recipe (all `base_servings`).
- **Product-based entries** (recipe_id IS NULL, product_id set): Mark Done on regular mode consumes `servings` containers of the product and logs macros. Meal prep mode creates a `[MEAL]` lot from the product directly with frozen nutrition.
- **Undo (unmark done):** Completed meals can be undone via `private.unmark_meal_done`. This reverses the operation: deletes the food_logs tagged with the meal_id, restores consumed stock to the user's default location, and for meal prep entries deletes the `[MEAL]` product and its stock lot. The meal's `completed_at` is set back to NULL. Food_logs are tagged with `meal_id` during `mark_meal_done` for traceability.

### Macro Tracking

- Centralized function: `private.get_daily_macros(p_user_id, p_logical_date)` aggregates food_logs + temp_items + liquidtrack_events. Single source of truth. (Consumed meal_plan_items are captured via food_logs when `mark_meal_done` executes.)
- Day summary with progress bars (Calories, Protein, Carbs, Fats)
- Consumed items list: regular meal plan completions, Consume+Macros events (including `[MEAL]` lot consumption), and temp items. Includes a **TOTAL row** showing aggregate macros across all consumed items.
- **Delete consumed items:** Individual food logs and temp items can be deleted from the consumed items table.
- **Realtime subscriptions:** Macro page subscribes to Supabase Realtime on `food_logs` and `temp_items` tables for live updates.
- Planned items preview: upcoming regular plan entries (meal-prep entries excluded because prep execution creates inventory rather than direct macro logs)
- Temp items: log off-inventory meals by name + macros (coffee, restaurant food, snacks)
- Target macros editor: set goals, calories auto-calculate via `(carbs×4) + (protein×4) + (fats×9)`
- Taste profile: freeform dietary preferences for recipe filtering
- Day boundary determined by `logical_date` stored at insert time

### Shopping List

- **Meal Plan → Cart sync:** Scans today's uncompleted meal plan entries (by logical_date). For each recipe entry, calculates required ingredients in the recipe's specified unit (containers or servings), converts everything to containers using `servings_per_container`, subtracts current inventory totals aggregated across lots, rounds up to whole containers for purchase. Flags placeholder products that need to be created or linked before ordering.
- **Add Below Minimum Stock:** Scans catalog for products below their minimum threshold. Subtracts items already on the shopping list. Adds the deficit. This is a query behind a button — no separate automation job.
- **Shopping list uniqueness:** `UNIQUE(user_id, product_id)`. Adding a product that's already on the list uses additive upsert — increments existing quantity rather than replacing (ON CONFLICT DO UPDATE SET qty = qty + excluded.qty). Auto-add deduplication prevents double-adding the same product.
- **Import Shopping List:** Import only checked/purchased, non-placeholder shopping rows into inventory. Adds the full checked amount (rounded-up containers) to stock — the surplus stays in inventory naturally.
- **Clear All button:** Removes all items from the shopping list in one action.
- **Realtime subscription:** Shopping page subscribes to Supabase Realtime on `shopping_list` table for live updates.
- Walmart cart links: generates product-by-product Walmart URLs for ordering
- Manual add/remove/clear

### Walmart Price Manager (Simplified)

- Walmart scraping via third-party scraper API (already implemented). Not all products need Walmart links — Walmart is for automated ordering convenience only.
- Missing links workflow: batch products with Walmart search results, user picks best match or marks "Not Walmart"
- Missing prices workflow: manual price entry for non-Walmart items. Fixed query logic to correctly identify products with missing prices.
- **Refresh All Prices:** Button wired to the `walmart-scrape` edge function to batch-refresh prices for all products with Walmart links.
- **Custom URL input:** Per-product custom Walmart URL input for manual URL assignment.
- Manual price refresh (no parallel workers, no auto-scheduling)
- Per-user rate limiting with request queuing

### LiquidTrack (IoT Scale Integration)

- User adds a scale device in the ChefByte UI: sets name, links a product, configures macros
- UI generates a **device ID** and one-time import key associated with that configuration
- Device ID is programmed into the ESP8266 firmware
- Import/provision flow validates the one-time import key (stored hashed) and activates the device record.
- On each weight event, ESP8266 sends: device ID + weight data to the Edge Function endpoint.
- Edge Function resolves device by ID, then resolves owning `user_id` and linked product, calculates macros from weight delta, and inserts the event.
- JWT verification disabled on the IoT endpoint (`verify_jwt = false` in Edge Function config). Runtime auth is the device ID lookup (MVP simplicity).
- Events log: weight before/after, consumption amount, auto-calculated macros
- Device management in ChefByte settings: generate ID/import key, name, revoke

## ChefByte UX

Desktop-first with responsive design. Matching the legacy ChefByte layout.

**Navigation:** Header bar with brand and Scanner button (always visible, accent-colored). Below the header, a tab bar with 6 tabs: Dashboard (default landing), Meal Plan, Recipes, Shopping, Inventory, Settings. Scanner page hides the tab bar. Walmart is a sub-tab of Settings (accessible via `/chef/settings?tab=walmart`; `/chef/walmart` redirects there). Settings tab shows a red notification dot when products have missing Walmart links, missing prices, or are placeholders (`useSettingsAlerts` hook). Mobile (under 900px): hamburger drawer replaces tab bar, includes Hub and Logout links. Macros is a sub-page of Dashboard (`/chef/macros`). The ChefByte index route (`/chef`) redirects to `/chef/home`.

**Pages:**

- **Scanner** (`/chef/scanner`): Two-column layout. Left panel (narrower): barcode text input (auto-focuses after each scan) + filter buttons (All / New) + scrollable queue of recent transactions. Right panel (wider): mode selector buttons (Purchase / Consume+Macros / Consume-NoMacros / Add to Shopping) + active item display + quantity screen + number keypad (calculator layout with backspace; unit toggle available in consume modes with conversion via servings_per_container). Hardware barcode scanner detection via `useScannerDetection` hook for USB/Bluetooth HID scanners. Unknown barcodes trigger the `analyze-product` edge function for auto-lookup and nutrition extraction. In Purchase mode: nutrition editor row appears (servings/container, calories, carbs, fats, protein inputs with auto-scaling). Queue items are color-coded: red border for newly created products, green for success, orange for pending. Each queue item shows product name, transaction details, stock levels, and undo button (reverses DB operations for that scan). Product name is inline-editable (saves to DB on blur).
- **Home (Dashboard)** (default landing page at `/chef/home`): **SkeletonScreen loading** state while data fetches. Macro summary for today showing consumed / planned / goal for each macro (calories, protein, carbs, fats). **Today's Meals section** showing planned meals for the current logical date. Status row with badge counts: Missing Walmart Links, Missing Prices, Placeholder Items, Below Min Stock, Shopping Cart Value. Action buttons: Import Shopping List (imports checked purchased rows), **Meal Plan → Cart** sync button (syncs next 7 days of meal plan ingredients to shopping list), Taste Profile, Target Macros. Today's meal prep items list. Modals for: Target Macros editor (protein/carbs/fats inputs, calories auto-calculated), Taste Profile (freeform textarea), Liquid Log (deferred — currently only available via LiquidTrack IoT devices).
- **Inventory**: **Search/filter input** at the top with `ilike` pattern escaping. Desktop defaults to grouped-by-product table with columns: Product (name + barcode + servings/container), Stock Total (with **servings equivalent**), Nearest Expiration, Lots, Min, Actions (+1/-1 container, +S/-S serving, Consume All with confirmation). **Stock color coding:** red (zero/critical), orange (below minimum), green (at or above minimum). Consume actions pass `p_log_macros: true` to log macros. Stock add includes **expiry date input** with date-aware lot merging. Toggle switches to lot view showing per-lot quantity, location, and expiration. **Realtime subscriptions** to `stock_lots` and `products` for live updates. Responsive layout uses the same expandable-row structure for all screen sizes.
- **Shopping List**: Add item form (name + amount + add button) with additive upsert (increments qty if product already on list) and auto-add deduplication. Two sections: "To Buy" (unchecked items with remove button) and "Purchased" (checked items, struck-through, with "Add Checked to Inventory" bulk action). **Clear All button** removes all items. "Import Shopping List" in Dashboard triggers this same checked-item import action. Header button: Auto-Add Below Min Stock. **Realtime subscription** to `shopping_list` for live updates.
- **Meal Plan**: 7-day week grid. Each day card shows meal entries with recipe/product name, servings, **meal_type labels** (breakfast/lunch/dinner/snack), and **macros per entry** (calories, protein, carbs, fats). Navigation: Previous Week / Today / Next Week. Add Meal modal with recipe/product search. Day detail table showing entry, mode (regular/prep), meal type, status, **macros total row**, and actions. **Meal prep toggle on existing entries** allows switching between regular and prep modes. `[PREP]` opens the execute-confirmation flow and runs meal-prep execution.
- **Recipes**: Card grid with recipe name, **description**, **servings**, times, per-serving macros, and **stock status badges** (`CAN MAKE` green / `PARTIAL` orange / `NO STOCK` red). Integrated filters (Can Be Made, carbs/protein density percentiles, active/total time sliders) and search live on this page. Cards open detail/edit mode from the same page.
- **Recipe Create/Edit**: Single page supports both create and edit mode. Form includes name, description, base servings, active time, total time, instructions. Ingredient section: product search dropdown, amount, unit (Serving/Container), note, add button. Ingredient cards below with **inline editing** (quantity, unit, note fields editable in-place). **Zero-ingredient validation** prevents saving recipes without at least one ingredient. Live macro preview (per-serving and total) updates as ingredients are added or modified.
- **Settings**: Tab interface with four sub-tabs: **Products** (product CRUD), **Walmart** (missing Walmart links with custom URL input and "Not on Walmart" marking; missing prices with manual entry; Refresh All Prices via `walmart-scrape` edge function), **LiquidTrack** (device management and event logs), and **Locations** (storage location CRUD — add new locations, delete locations with protection if stock exists in that location). Supports `?tab=` query param for deep linking (e.g., `/chef/settings?tab=walmart`).

**Shared across layouts:**

- Progress bars for macro tracking with color-coded fill
- Cards with badges: stock level (containers + servings), placeholder badge, price status
- Offline indicator (disabled buttons + "no connection" banner)
- **ilike search pattern escaping:** All search inputs across ChefByte pages escape special characters (`%`, `_`, `\`) before passing to `ilike` queries to prevent unintended pattern matching

## ChefByte Technical Notes

- **Data fetching:** All pages use TanStack Query (`useQuery`/`useMutation`) for server state. Complex pages (HomePage, MacroPage, MealPlanPage) use `Promise.all` in a single `useQuery` for parallel data loading. Query keys defined in `src/shared/queryKeys.ts`.
- **Realtime invalidation:** `useRealtimeInvalidation` hook subscribes to Supabase Realtime `postgres_changes` and invalidates specific TanStack Query keys when rows change. Replaces the old pattern of full-page refetch on any Realtime event.
- **Optimistic updates:** Shopping list toggles, inventory changes, meal plan deletions, and product deletions use `useMutation` with `onMutate` optimistic cache updates and `onError` rollback.

## ChefByte MCP Tools

| Tool                                    | Purpose                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHEFBYTE_get_inventory`                | Grouped inventory by product (total stock, nearest expiration, lot count) with optional lot detail                                                                              |
| `CHEFBYTE_get_product_lots`             | Return lot-level inventory rows for a specific product                                                                                                                          |
| `CHEFBYTE_add_stock`                    | Purchase/add quantity to a product (`container` or `serving` input), with location and optional expiration                                                                      |
| `CHEFBYTE_consume`                      | Remove quantity from stock using nearest-expiration-first lot depletion (`container` or `serving` input), optionally log macros                                                 |
| `CHEFBYTE_get_products`                 | Product catalog search                                                                                                                                                          |
| `CHEFBYTE_create_product`               | Create product with full metadata (barcode nullable)                                                                                                                            |
| `CHEFBYTE_update_product`               | Update product fields by product_id (name, barcode, nutrition, price, min_stock, walmart_link)                                                                                  |
| `CHEFBYTE_get_shopping_list`            | Current shopping list                                                                                                                                                           |
| `CHEFBYTE_add_to_shopping`              | Add item to shopping list (merges if exists)                                                                                                                                    |
| `CHEFBYTE_toggle_purchased`             | Toggle the purchased boolean on a shopping list item                                                                                                                            |
| `CHEFBYTE_delete_shopping_item`         | Delete a single item from the shopping list                                                                                                                                     |
| `CHEFBYTE_clear_shopping`               | Clear shopping list                                                                                                                                                             |
| `CHEFBYTE_import_shopping_to_inventory` | Import all purchased shopping items into inventory as stock lots, then remove from shopping list                                                                                |
| `CHEFBYTE_below_min_stock`              | Auto-add deficit items to shopping list (uses additive upsert — adds to existing qty rather than replacing)                                                                     |
| `CHEFBYTE_get_meal_plan`                | Current meal plan                                                                                                                                                               |
| `CHEFBYTE_add_meal`                     | Add entry (with optional meal_prep flag)                                                                                                                                        |
| `CHEFBYTE_delete_meal_entry`            | Delete a meal plan entry by meal_id                                                                                                                                             |
| `CHEFBYTE_mark_done`                    | Execute meal plan entry (regular: consume + log macros; meal prep: consume + create `[MEAL]` lot, no immediate macro log)                                                       |
| `CHEFBYTE_unmark_done`                  | **Not yet wired as MCP tool** (DB function exists). Undo a completed meal: reverses food_logs, restores stock, deletes `[MEAL]` product for prep entries, clears `completed_at` |
| `CHEFBYTE_get_recipes`                  | Recipe catalog (includes `instructions` field in response)                                                                                                                      |
| `CHEFBYTE_get_cookable`                 | Recipes makeable with current stock                                                                                                                                             |
| `CHEFBYTE_create_recipe`                | Create recipe with ingredients (referencing products by UUID), supports optional `instructions` field                                                                           |
| `CHEFBYTE_get_macros`                   | Today's macro summary with goals                                                                                                                                                |
| `CHEFBYTE_log_temp_item`                | Log off-inventory macro entry                                                                                                                                                   |
| `CHEFBYTE_set_price`                    | Update product price                                                                                                                                                            |

## ChefByte Edge Functions

All three Edge Functions are implemented as Supabase Edge Functions (Deno/TypeScript) in `supabase/functions/`.

| Function          | Purpose                                                                          | Auth Method                                                                                                                                                            | Env Vars                           |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `walmart-scrape`  | SerpApi Walmart search — returns up to 6 results with price/URL/image            | Internal JWT validation (`verify_jwt = false` workaround for Supabase CLI ES256 bug; validates via `supabase.auth.getUser()` at runtime)                               | `SERPAPI_KEY`                      |
| `liquidtrack`     | Ingest ESP8266 scale events with server-side macro calculation                   | `verify_jwt = false`, API key auth (`x-api-key` header, SHA-256 hashed, lookup in `liquidtrack_devices.import_key_hash`)                                               | `SUPABASE_SERVICE_ROLE_KEY` (auto) |
| `analyze-product` | OpenFoodFacts lookup + Claude Haiku 4.5 normalization + 4-4-9 calorie validation | Internal JWT validation (`verify_jwt = false` workaround; validates via `supabase.auth.getUser()` at runtime), per-user daily quota (100/day) tracked in `user_config` | `ANTHROPIC_API_KEY`                |
