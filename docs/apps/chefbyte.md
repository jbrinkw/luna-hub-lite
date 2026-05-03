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
- Per-user daily quota on `analyze-product` calls (100/day). When exceeded, the scan falls through to placeholder creation. BYOK option is a future feature. Quota is charged only AFTER OFF returns successfully — transient upstream failures (OFF 5xx, malformed body) return `503 { ai_degraded: true, ai_reason: 'off_unavailable' }` and do NOT consume the user's daily budget.
- Barcode is nullable — products can exist without barcodes (manual creation, bulk items, homemade products). Unique constraint: `UNIQUE(user_id, barcode) WHERE barcode IS NOT NULL`.
- Keypad with context-aware units: Containers for purchase, Servings for consume (toggleable). Unit conversion applies when toggling between servings and containers — values recalculate using `servings_per_container`.
- **Undo/rollback per scan:** Each scan mode provides an undo button that reverses the DB operations (stock additions, stock removals, macro logs, shopping list additions) for the most recent scan.
- **Auto-focus:** Barcode input field automatically regains focus after each scan completes, enabling rapid sequential scanning.
- Nutrition editor: auto-scaling (edit calories → macros scale proportionally, edit macro → calories recalculate via 4-4-9 rule)
- Red-highlight for new/unacknowledged scans

### USB Scanner (Pi → cloud forwarder)

Plug a USB barcode scanner into the live-shelf Pi. Each scan forwards
the barcode to the cloud edge function which processes it under your
currently-active scanner mode (purchase / consume / shopping).

**Mode resolution** (`chefbyte.scanner_state` table):

- If you've toggled "Lock scanner to single mode" in Settings → Scanner,
  that mode is used for every Pi USB scan.
- Otherwise the Pi uses the mode the web Scanner page last broadcast
  (default: purchase).

**Persistent transactions**: every scan (web + Pi USB) is logged in
`chefbyte.scan_transactions`. Visit Settings → Scanner Transactions to
view, filter, or void past scans. Voiding reverses the side-effect
(deletes the stock_lot, food_log, or shopping_list row created by the
scan).

**Pi setup**: set `BARCODE_SCANNER_ENABLED=true` and
`BARCODE_SCANNER_DEVICE=/dev/input/eventX` in the Pi env. The scanner
listens via evdev; ENTER terminates each barcode.

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
- **Expired — discard section:** Lots with `expires_on < CURRENT_DATE` and `qty_containers > 0` render in a red-bordered "Expired — discard" section at the top of the grouped view. Each row shows an "X days expired" chip, strikethrough expiration date, and two actions: **Log as discarded** (zeroes the lot without logging macros — food was thrown out) and **Consumed anyway** (consume with macros — food was eaten despite the date). The dashboard exposes an **"X expired"** counter card that links to `/chef/inventory#expired` and scrolls to the section.
- Manual product creation (full control without barcode)
- Minimum stock thresholds per product
- Placeholder products (`is_placeholder = true`) for planning before purchase — shopping and ordering logic checks this explicitly
- Product deletion cascades to recipe ingredients: `ON DELETE CASCADE` on the recipe_ingredients FK. Recipes that lose ingredients show as incomplete until re-linked.
- **Visual unit (display-only):** Each product carries an optional `visual_unit_label` + `visual_units_per_serving` pair on `chefbyte.products` (added in migration `20260430040000_products_visual_unit.sql`). When set, every UI surface that renders a quantity for a human (recipe lines, inventory rows, meal-plan / macro consumed rows) renders the canonical amount as e.g. `2 eggs Cage-Free Eggs` or `0.5 bagels Big Bagel` instead of `2 svg ...`. Math is untouched — `consume_product`, `mark_meal_done`, food-log macros and stock decrement always read canonical `unit` + `quantity`. Both columns NULL = no visual unit; a CHECK constraint (`products_visual_pair_complete`) enforces both-or-neither plus `visual_units_per_serving > 0`. Configured in Settings → Products under **Visual Unit**. (Supersedes the per-ingredient pair previously on `recipe_ingredients`, dropped in migration `20260430050000_drop_recipe_visual_unit.sql`.)

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

- Centralized function: `private.get_daily_macros(p_user_id, p_logical_date)` aggregates food_logs + temp_items. Single source of truth. (Consumed meal_plan_items are captured via food_logs when `mark_meal_done` executes; LiveTrack scale events write through `shelf-ingest` → `food_logs` and are included automatically.)
- Day summary with progress bars (Calories, Protein, Carbs, Fats)
- Consumed items list: regular meal plan completions, Consume+Macros events (including `[MEAL]` lot consumption), and temp items. Includes a **TOTAL row** showing aggregate macros across all consumed items.
- **Delete consumed items:** Individual food logs and temp items can be deleted from the consumed items table.
- **Realtime subscriptions:** Macro page subscribes to Supabase Realtime on `food_logs` and `temp_items` tables for live updates. Both tables are members of the `supabase_realtime` publication (added by `20260427070000_food_logs_realtime_publication.sql` after a 2026-04-27 regression where Pi shelf-event-driven food_logs INSERTs landed in the cloud DB but never reached open MacroPage tabs because the publication didn't broadcast them).
- Planned items preview: upcoming regular plan entries (meal-prep entries excluded because prep execution creates inventory rather than direct macro logs)
- Temp items: log off-inventory meals by name + macros (coffee, restaurant food, snacks)
- Target macros editor: set goals, calories auto-calculate via `(carbs×4) + (protein×4) + (fats×9)`
- Taste profile: freeform dietary preferences for recipe filtering
- Day boundary determined by `logical_date` stored at insert time

### Shopping List

- **Meal Plan → Cart sync:** Scans today's uncompleted meal plan entries (by logical_date). For each recipe entry, calculates required ingredients in the recipe's specified unit (containers or servings), converts everything to containers using `servings_per_container`, subtracts current inventory totals aggregated across lots, rounds up to whole containers for purchase. Flags placeholder products that need to be created or linked before ordering.
- **Add Below Minimum Stock:** Scans catalog for products below their minimum threshold. Subtracts items already on the shopping list. Adds the deficit. This is a query behind a button — no separate automation job.
- **Shopping list uniqueness:** `UNIQUE(user_id, product_id)`. Adding a product that's already on the list uses additive upsert — increments existing quantity rather than replacing (ON CONFLICT DO UPDATE SET qty = qty + excluded.qty). Auto-add deduplication prevents double-adding the same product.
- **Import Shopping List:** Atomic `chefbyte.import_shopping_to_inventory(p_location_id)` RPC merges purchased rows into stock lots (same `product_id + location_id + NULL expires_on` → merge, otherwise insert) and stamps the source rows with `imported_at = now()` instead of deleting them. The active cart view filters `WHERE imported_at IS NULL`, so imported rows vanish from the To Buy / Purchased sections. A **"Show imported items (last 7 days)"** toggle surfaces recent imports for audit. Calling import twice is a no-op (second call processes 0 rows).
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

### LiveTrack (IoT Scale Integration)

LiquidTrack (the original single-device ESP8266 edge function) was retired
on 2026-04-21 after zero prod rows in `chefbyte.liquidtrack_devices`. It was
replaced by the LiveTrack system:

- **`chefbyte.live_shelf_devices`** — Raspberry Pi rigs (kind=`live_shelf` or
  `catch_all`) plus single-item scales (kind=`live_scale`). Provisioned via
  one-time import key (`import_key_hash`), device-ID-based runtime lookup.
- **`chefbyte.scale_pairings`** — binds a physical scale to a ChefByte product,
  enabling per-shelf or per-scale deduction.
- **Edge function `shelf-ingest`** — accepts weight-delta events via `x-api-key`
  header (SHA-256 → `live_shelf_devices.import_key_hash`), writes `food_logs`
  through `apply_shelf_event`.
- **Edge function `livetrack-session`** — pairing session lifecycle between
  the browser (JWT on `/create`) and the Pi (x-api-key on `/pi-update`).
- Managed in ChefByte Settings → Scales tab.

#### LiveTrack auto-import (catch-all)

When you place a product on the catch-all scale that you already own
(scanned, manually added, or imported any way), the catch-all triggers
the AI classifier to:

1. Pick the product from your full inventory (any qty>0 lot).
2. If the product has no tare yet, estimate the empty container weight
   from the visual + product metadata (container type, net_weight_g).
3. Auto-apply the estimate. No review queue.

The product's LiveTrack tag in `/chef/inventory` reflects calibration:

| Color            | Condition                            | Meaning                                                       |
| ---------------- | ------------------------------------ | ------------------------------------------------------------- |
| Red              | `tare_weight_g IS NULL`              | Delta tracking only — relative weight changes work, no fill % |
| Blue             | tare set, `measured_full_at IS NULL` | Fill % computed from AI estimate, not yet confirmed full      |
| Normal (emerald) | tare set, `measured_full_at` set     | Fully calibrated                                              |

Two paths stamp `measured_full_at`:

- Programmatic: any catch-all placement reading within 5% of
  `tare_weight_g + net_weight_g`.
- Manual: "Item is full" checkbox on a catch-all event in `/chef/events`.

Tare and `measured_full_at` are set-once. Once written, they're never
overwritten programmatically. Manual edit through the products UI is
always allowed.

Auto-tare-on-empty: when an empty container is placed on the catch-all
and `tare_weight_g IS NULL`, the empty-container heuristic captures
`tare = scale_reading` IF the reading is under 30% of `net_weight_g`.
Conservative threshold avoids false positives on partial fills.

### Backup & Restore

User-initiated manual snapshot / rollback of the caller's ChefByte data. Surfaced as a dedicated Settings → Backup tab.

- **Scope (included tables):** `locations`, `products`, `stock_lots`, `recipes`, `recipe_ingredients`, `meal_plan_entries`, `food_logs`, `temp_items`, `shopping_list`, `user_config` (macro goals + per-user prefs). PK UUIDs are preserved so FK references survive the roundtrip.
- **Excluded:** `shelf_event_log`, `event_overrides`, `livetrack_import_sessions`, `live_shelf_devices`, `scale_pairings` (Pi-owned / device state / ephemeral). The Pi regenerates its own log post-restore; the user re-pairs devices if needed.
- **Schema version:** stamped on each backup (currently `20260423010000`). Restore rejects a version mismatch up-front — backups are NOT portable across schema-changing migrations.
- **Restore contract:** wipe-and-replace in a single transaction. All of the caller's rows in the included tables are deleted before any backup row is inserted. FK-safe order (children → parents on wipe, parents → children on insert). Any error rolls back. Any row in the payload whose `user_id` differs from `auth.uid()` aborts the restore without wiping anything.
- **RPCs:** `chefbyte.export_chefbyte_backup()` returns the JSONB envelope; `chefbyte.restore_chefbyte_backup(p_backup jsonb)` applies it. Both are `SECURITY DEFINER` wrappers over `private.*` implementations. Granted EXECUTE to `authenticated` only.
- **UI flow:** download button saves `luna-hub-chefbyte-backup-YYYY-MM-DD.json`. Restore picker parses the file, previews schema_version + per-table row counts, and only enables the Restore button after an "I understand this wipes current data" consent checkbox is ticked. Success panel shows wiped + restored counts per table.
- **Non-goals:** no Pi-side state, no encryption, no auto-schedule, no partial-restore UI.

## ChefByte UX

Desktop-first with responsive design. Matching the legacy ChefByte layout.

**Navigation:** Header bar with brand and Scanner button (always visible, accent-colored). Below the header, a tab bar with 6 tabs: Dashboard (default landing), Meal Plan, Recipes, Shopping, Inventory, Settings. Scanner page hides the tab bar. Walmart is a sub-tab of Settings (accessible via `/chef/settings?tab=walmart`; `/chef/walmart` redirects there). Settings tab shows a red notification dot when products have missing Walmart links, missing prices, or are placeholders (`useSettingsAlerts` hook). Mobile (under 900px): hamburger drawer replaces tab bar, includes Hub and Logout links. Macros is a sub-page of Dashboard (`/chef/macros`). The ChefByte index route (`/chef`) redirects to `/chef/home`.

**Pages:**

- **Scanner** (`/chef/scanner`): Two-column layout. Left panel (narrower): barcode text input (auto-focuses after each scan) + filter buttons (All / New) + scrollable queue of recent transactions. Right panel (wider): mode selector buttons (Purchase / Consume+Macros / Consume-NoMacros / Add to Shopping) + active item display + quantity screen + number keypad (calculator layout with backspace; unit toggle available in consume modes with conversion via servings_per_container). Hardware barcode scanner detection via `useScannerDetection` hook for USB/Bluetooth HID scanners. Unknown barcodes trigger the `analyze-product` edge function for auto-lookup and nutrition extraction. In Purchase mode: nutrition editor row appears (servings/container, calories, carbs, fats, protein inputs with auto-scaling). Queue items are color-coded: red border for newly created products, green for success, orange for pending. Each queue item shows product name, transaction details, stock levels, and undo button (reverses DB operations for that scan). Product name is inline-editable (saves to DB on blur).
- **Home (Dashboard)** (default landing page at `/chef/home`): **SkeletonScreen loading** state while data fetches. Macro summary for today showing consumed / planned / goal for each macro (calories, protein, carbs, fats). **Today's Meals section** showing planned meals for the current logical date. Status row with badge counts: Missing Walmart Links, Missing Prices, Placeholder Items, Below Min Stock, Shopping Cart Value. Action buttons: Import Shopping List (imports checked purchased rows), **Meal Plan → Cart** sync button (syncs next 7 days of meal plan ingredients to shopping list), Taste Profile, Target Macros. Today's meal prep items list. Modals for: Target Macros editor (protein/carbs/fats inputs, calories auto-calculated), Taste Profile (freeform textarea).
- **Inventory**: **Search/filter input** at the top with `ilike` pattern escaping. Desktop defaults to grouped-by-product table with columns: Product (name + barcode + servings/container), Stock Total (with **servings equivalent**), Nearest Expiration, Lots, Min, Actions (+1/-1 container, +S/-S serving, Consume All with confirmation). **Stock color coding:** red (zero/critical), orange (below minimum), green (at or above minimum). Consume actions pass `p_log_macros: true` to log macros. Stock add includes **expiry date input** with date-aware lot merging. Toggle switches to lot view showing per-lot quantity, location, and expiration. **Realtime subscriptions** to `stock_lots` and `products` for live updates. Responsive layout uses the same expandable-row structure for all screen sizes.
- **Shopping List**: Add item form (name + amount + add button) with additive upsert (increments qty if product already on list) and auto-add deduplication. Two sections: "To Buy" (unchecked items with remove button) and "Purchased" (checked items, struck-through, with "Add Checked to Inventory" bulk action). **Clear All button** removes all items. "Import Shopping List" in Dashboard triggers this same checked-item import action. Header button: Auto-Add Below Min Stock. **Realtime subscription** to `shopping_list` for live updates.
- **Meal Plan**: 7-day week grid. Each day card shows meal entries with recipe/product name, servings, **meal_type labels** (breakfast/lunch/dinner/snack), and **macros per entry** (calories, protein, carbs, fats). Navigation: Previous Week / Today / Next Week. Add Meal modal with recipe/product search. Day detail table showing entry, mode (regular/prep), meal type, status, **macros total row**, and actions. **Meal prep toggle on existing entries** allows switching between regular and prep modes. `[PREP]` opens the execute-confirmation flow and runs meal-prep execution.
- **Recipes**: Card grid with recipe name, **description**, **servings**, times, per-serving macros, and **stock status badges** (`CAN MAKE` green / `PARTIAL` orange / `NO STOCK` red). Integrated filters (Can Be Made, carbs/protein density percentiles, active/total time sliders) and search live on this page. Cards open detail/edit mode from the same page.
- **Recipe Create/Edit**: Single page supports both create and edit mode. Form includes name, description, base servings, active time, total time, instructions. Ingredient section: product search dropdown, amount, unit (Serving/Container), note, add button. Ingredient cards below with **inline editing** (quantity, unit, note fields editable in-place). **Zero-ingredient validation** prevents saving recipes without at least one ingredient. Live macro preview (per-serving and total) updates as ingredients are added or modified.
- **Settings**: Tab interface with five sub-tabs: **Products** (product CRUD), **Walmart** (missing Walmart links with custom URL input and "Not on Walmart" marking; missing prices with manual entry; Refresh All Prices via `walmart-scrape` edge function), **Scales** (LiveTrack device management — live_shelf / catch_all / live_scale — with pairings, pending review count, and heartbeat metrics), **Locations** (storage location CRUD — add new locations, delete locations with protection if stock exists in that location), and **Backup** (download a JSON snapshot of all user-scoped ChefByte state, or wipe-and-restore from a prior snapshot — see "Backup & Restore" below). Supports `?tab=` query param for deep linking (e.g., `/chef/settings?tab=walmart`, `/chef/settings?tab=backup`).

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
| `CHEFBYTE_add_to_shopping`              | Add containers to shopping list. **Additive upsert** — calling twice for the same product sums the quantities (qty=3 then qty=2 → final qty=5)                                  |
| `CHEFBYTE_toggle_purchased`             | Toggle the purchased boolean on a shopping list item                                                                                                                            |
| `CHEFBYTE_delete_shopping_item`         | Delete a single item from the shopping list                                                                                                                                     |
| `CHEFBYTE_clear_shopping`               | Clear shopping list                                                                                                                                                             |
| `CHEFBYTE_import_shopping_to_inventory` | Import all purchased shopping items into inventory as stock lots, then remove from shopping list                                                                                |
| `CHEFBYTE_below_min_stock`              | Auto-add deficit items to shopping list (uses additive upsert — adds to existing qty rather than replacing)                                                                     |
| `CHEFBYTE_get_meal_plan`                | Current meal plan                                                                                                                                                               |
| `CHEFBYTE_add_meal`                     | Add entry (with optional meal_prep flag). `logical_date` is **optional** — defaults to the user's current logical date (profile tz + day_start_hour) when omitted               |
| `CHEFBYTE_delete_meal_entry`            | Delete a meal plan entry by meal_id                                                                                                                                             |
| `CHEFBYTE_mark_done`                    | Execute meal plan entry (regular: consume + log macros; meal prep: consume + create `[MEAL]` lot, no immediate macro log)                                                       |
| `CHEFBYTE_unmark_done`                  | **Not yet wired as MCP tool** (DB function exists). Undo a completed meal: reverses food_logs, restores stock, deletes `[MEAL]` product for prep entries, clears `completed_at` |
| `CHEFBYTE_get_recipes`                  | Recipe catalog (includes `instructions` field in response)                                                                                                                      |
| `CHEFBYTE_get_cookable`                 | Recipes makeable with current stock                                                                                                                                             |
| `CHEFBYTE_create_recipe`                | Create recipe with ingredients (referencing products by UUID), supports optional `instructions` field                                                                           |
| `CHEFBYTE_get_macros`                   | Today's macro summary with goals                                                                                                                                                |
| `CHEFBYTE_log_temp_item`                | Log off-inventory macro entry                                                                                                                                                   |
| `CHEFBYTE_set_price`                    | Update product price                                                                                                                                                            |
| `CHEFBYTE_delete_food_log`              | Delete one `food_logs` row by `log_id`. Used to undo accidental `consume` calls                                                                                                 |
| `CHEFBYTE_delete_temp_item`             | Delete one `temp_items` row by `temp_id`. Used to undo a stray `log_temp_item`                                                                                                  |
| `CHEFBYTE_delete_recipe`                | Delete a recipe by `recipe_id`. Cascades to `recipe_ingredients`. Fails if any meal plan entries still reference it                                                             |
| `CHEFBYTE_delete_product`               | **DESTRUCTIVE**: delete a product by `product_id`. Cascades to stock lots, meal plan entries, food logs, shopping list rows, recipe ingredients                                 |

## ChefByte Edge Functions

Edge Functions are implemented as Supabase Edge Functions (Deno/TypeScript) in `supabase/functions/`.

| Function            | Purpose                                                                                                                                                                                                                                                                                                                            | Auth Method                                                                                                                                                            | Env Vars                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `walmart-scrape`    | SerpApi Walmart search — returns up to 6 results with price/URL/image                                                                                                                                                                                                                                                              | Internal JWT validation (`verify_jwt = false` workaround for Supabase CLI ES256 bug; validates via `supabase.auth.getUser()` at runtime)                               | `SERPAPI_KEY`                      |
| `shelf-ingest`      | Ingest LiveTrack scale weight-delta events with server-side macro calculation                                                                                                                                                                                                                                                      | `verify_jwt = false`, API key auth (`x-api-key` header, SHA-256 hashed, lookup in `live_shelf_devices.import_key_hash`)                                                | `SUPABASE_SERVICE_ROLE_KEY` (auto) |
| `livetrack-session` | LiveTrack pairing session lifecycle (browser-initiated create; Pi-initiated update)                                                                                                                                                                                                                                                | `/create` validates browser JWT via `supabase.auth.getUser()`; `/pi-update` uses `x-api-key` hashed against `live_shelf_devices.import_key_hash`                       | `SUPABASE_SERVICE_ROLE_KEY` (auto) |
| `analyze-product`   | OpenFoodFacts lookup + Claude Haiku 4.5 normalization + 4-4-9 calorie validation. Dual-auth: JWT (browser, returns suggestion only) OR service-role bearer + body.user_id (server-to-server, e.g., shelf-ingest forwarding a Pi USB scan; auto-creates the product row scoped to the supplied user_id and returns its product_id). | Internal JWT validation (`verify_jwt = false` workaround; validates via `supabase.auth.getUser()` at runtime), per-user daily quota (100/day) tracked in `user_config` | `ANTHROPIC_API_KEY`                |
