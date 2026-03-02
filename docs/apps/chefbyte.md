# ChefByte

## Purpose

AI-powered nutrition system: meal planning, inventory management, macro tracking, barcode scanning, price intelligence, IoT scale integration.

## Features

### Dashboard
- Status cards: Missing Prices, Placeholder Items, Below Minimum Stock, Shopping Cart Value
- Macro day summary: progress bars for Calories, Protein, Carbs, Fats with percentage of goal
- Quick actions: Import Shopping List (imports checked purchased rows), Target Macros editor, Taste Profile, Meal Plan → Cart sync
- Recent New Items: inline-editable list of latest scans

### Barcode Scanner
- **Physical barcode scanner** (Bluetooth/USB HID) as input device. Camera scanning deferred to post-MVP Capacitor build.
- Four scan modes:
  1. **Purchase** — add to stock (in containers)
  2. **Consume (with macros)** — remove from stock + log macros
  3. **Consume (no macros)** — remove from stock only (e.g., discarded, given away)
  4. **Add to Shopping** — add to shopping list
- Barcode lookup chain: check existing products → query OpenFoodFacts → Claude Haiku 4.5 normalization (platform-paid, no user API key needed)
- OpenFoodFacts: 100 req/min rate limit. Products not found or with null/zero macros fall through to Claude analysis.
- If any step in the pipeline fails after local product check (OFF down, Claude error), the scan errors and the user enters the product manually. No partial auto-creation.
- The barcode pipeline handles general product data only (identity, nutrition, naming). Walmart is a separate system for pricing and ordering.
- Per-user daily quota on `analyze-product` calls (100/day). "Limit reached — enter product manually" when exceeded. BYOK option is a future feature.
- Barcode is nullable — products can exist without barcodes (manual creation, bulk items, homemade products). Unique constraint: `UNIQUE(user_id, barcode) WHERE barcode IS NOT NULL`.
- Keypad with context-aware units: Containers for purchase, Servings for consume (toggleable)
- Nutrition editor: auto-scaling (edit calories → macros scale proportionally, edit macro → calories recalculate via 4-4-9 rule)
- Red-highlight for new/unacknowledged scans

### Inventory Management
- Product catalog with search and filtering
- Storage locations (Fridge, Pantry, Freezer) — each lot assigned to a location; the same product can span multiple locations via separate lots
- Stock is tracked at the **lot level** in `chefbyte.stock_lots`. Each lot has its own `lot_id` and references a root `product_id`.
- Each lot stores `expires_on DATE` (nullable). `NULL` means "no expiration" and sorts last for consumption/display.
- Lot merge rule: quantities merge only when `(user_id, product_id, location_id, expires_on)` match. Different expiration or location creates a separate lot.
- Inventory UI defaults to **grouped by product** (total containers, servings equivalent, nearest expiration, lot count) with a toggle to view raw lots.
- Quantity display defaults to **containers**. Mutations accept **containers or servings**; serving inputs are converted server-side via `servings_per_container`.
- Inventory adjustments (`+/-`, `+S/-S`, `Consume All`) are stock-only operations and never log macros.
- Manual product creation (full control without barcode)
- Minimum stock thresholds per product
- Placeholder products (`is_placeholder = true`) for planning before purchase — shopping and ordering logic checks this explicitly
- Product deletion cascades to recipe ingredients: `ON DELETE CASCADE` on the recipe_ingredients FK. Recipes that lose ingredients show as incomplete until re-linked.

### Recipe Search & Planning
- Recipe ingredients reference products via FK, with quantity specified as a number + unit (containers or servings, extensible enum)
- **Recipe macros computed dynamically at query time** — sum of (ingredient product macros × quantity) with unit conversion. No separate recompute job needed. Always reflects current product nutrition data.
- Macro density rankings (protein per 100 cal, carbs per 100 cal) with percentile scores
- "Can Be Made" filter: recipes where current stock covers all ingredients after unit conversion via `servings_per_container`
- Active time and total time filters
- Recipe search/filter controls live on the main **Recipes** page (no separate Recipe Finder route)
- Per-serving and total macro display
- Add to meal plan from recipe card

### Meal Plan
- Day-by-day meal schedule using `logical_date` computed from `day_start_hour`
- Two execution modes:
  - **Regular** (`meal_prep = false`): Mark Done consumes ingredients and counts macros for the meal entry's `logical_date` (if completed later, it still logs to the planned day)
  - **Meal Prep** (`meal_prep = true`): Execute consumes ingredients and creates a `[MEAL]` lot for that prep run. Execution itself does **not** log macros. `[MEAL]` root products are auto-generated per recipe in the background and used as the product definition. Each prep run carries its own expiration; standard lot merge rules apply only when `(product_id, location_id, expires_on)` are identical. Named as `[MEAL] Recipe Name MM-DD`. Nutrition is frozen at execution time for the lot, so later recipe edits do not change existing prepped meal lots.
- Meal plan entries count toward macros only when actually consumed: regular entries at Mark Done, and meal-prep entries only when the resulting `[MEAL]` lot is later consumed in a macro-logging flow.
- Toggle between regular and meal prep per entry
- Entries linked to recipes auto-calculate ingredient requirements

### Macro Tracking
- Centralized function: `private.get_daily_macros(p_user_id, p_logical_date)` aggregates food_logs + temp_items + consumed meal_plan_items. Single source of truth.
- Day summary with progress bars (Calories, Protein, Carbs, Fats)
- Consumed items list: regular meal plan completions, Consume+Macros events (including `[MEAL]` lot consumption), and temp items
- Planned items preview: upcoming regular plan entries (meal-prep entries excluded because prep execution creates inventory rather than direct macro logs)
- Temp items: log off-inventory meals by name + macros (coffee, restaurant food, snacks)
- Target macros editor: set goals, calories auto-calculate via `(carbs×4) + (protein×4) + (fats×9)`
- Taste profile: freeform dietary preferences for recipe filtering
- Day history with pagination
- Day boundary determined by `logical_date` stored at insert time

### Shopping List
- **Meal Plan → Cart sync:** Scans the next 7 days of meal plan from today's `logical_date`. For each recipe entry, calculates required ingredients in the recipe's specified unit (containers or servings), converts everything to containers using `servings_per_container`, subtracts current inventory totals aggregated across lots, rounds up to whole containers for purchase. Flags placeholder products that need to be created or linked before ordering.
- **Add Below Minimum Stock:** Scans catalog for products below their minimum threshold. Subtracts items already on the shopping list. Adds the deficit. This is a query behind a button — no separate automation job.
- **Shopping list uniqueness:** `UNIQUE(user_id, product_id)`. Adding a product that's already on the list merges quantities (ON CONFLICT DO UPDATE SET qty = qty + excluded.qty).
- **Import Shopping List:** Import only checked/purchased, non-placeholder shopping rows into inventory. Adds the full checked amount (rounded-up containers) to stock — the surplus stays in inventory naturally.
- Walmart cart links: generates product-by-product Walmart URLs for ordering
- Manual add/remove/clear

### Walmart Price Manager (Simplified)
- Walmart scraping via third-party scraper API (already implemented). Not all products need Walmart links — Walmart is for automated ordering convenience only.
- Missing links workflow: batch products with Walmart search results, user picks best match or marks "Not Walmart"
- Missing prices workflow: manual price entry for non-Walmart items
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

## ChefByte UX (Ionic)

Desktop-first with responsive design. Matching the legacy ChefByte layout.

**Navigation:** Top navigation bar with links: Scanner (default landing) / Home / Inventory / Shopping / Meal Plan / Recipes / Walmart / Settings. Hamburger menu on mobile.

**Pages:**

- **Scanner** (default landing page): Two-column layout. Left panel (narrower): barcode text input + filter buttons (All / New) + scrollable queue of recent transactions. Right panel (wider): mode selector buttons (Purchase / Consume+Macros / Consume-NoMacros / Add to Shopping) + meal plan toggle + active item display + quantity screen + number keypad (calculator layout with backspace and unit toggle). In Purchase mode: nutrition editor row appears (servings/container, calories, carbs, fats, protein inputs with auto-scaling). Queue items are color-coded: red border for newly created products, green for success, orange for pending. Each queue item shows product name, transaction details, stock levels, and undo/delete button.
- **Home (Dashboard)**: Macro summary for today showing consumed / planned / goal for each macro (calories, protein, carbs, fats). Status row with badge counts: Missing Walmart Links, Missing Prices, Placeholder Items, Below Min Stock, Shopping Cart Value. Action buttons: Open Shopping List Links (Walmart), Import Shopping List (imports checked purchased rows), Meal Plan → Cart, Taste Profile, Target Macros. Today's meal prep items list. Modals for: Target Macros editor (protein/carbs/fats inputs, calories auto-calculated), Taste Profile (freeform textarea), Liquid Log (name, amount, calories, refill checkbox).
- **Inventory**: Desktop defaults to grouped-by-product table with columns: Product (name + barcode + servings/container), Stock Total, Nearest Expiration, Lots, Min, Actions (+1/-1 container, +S/-S serving, Consume All with confirmation). These actions are stock-only adjustments and do not log macros. Toggle switches to lot view showing per-lot quantity, location, and expiration. Mobile uses card layout with same grouped/lot toggle.
- **Shopping List**: Add item form (name + amount + add button). Two sections: "To Buy" (unchecked items with remove button) and "Purchased" (checked items, struck-through, with "Add Checked to Inventory" bulk action). "Import Shopping List" in Dashboard triggers this same checked-item import action. Header button: Auto-Add Below Min Stock.
- **Meal Plan**: 7-day week grid. Each day card shows meal entries with recipe/product name, servings, macro summary. Navigation: Previous Week / Today / Next Week. Add Meal modal with recipe/product search. Day detail table showing entry, mode (regular/prep), status, and actions. `[PREP]` opens the execute-confirmation flow and runs meal-prep execution.
- **Recipes**: Card grid with recipe name, description, servings, times, per-serving macros. Integrated filters (Can Be Made, carbs/protein density percentiles, active/total time sliders) and search live on this page. Cards open detail/edit mode from the same page.
- **Recipe Create/Edit**: Single page supports both create and edit mode. Form includes name, description, base servings, active time, total time, instructions. Ingredient section: product search dropdown, amount, unit (Serving/Container), note, add button. Ingredients table below.
- **Walmart**: Missing Walmart Links section — products listed with radio-button search results (user picks best match or marks "Not Walmart"). Missing Prices section — manual price entry for non-Walmart items. Refresh All Prices button.
- **Settings**: Tab interface (Products / LiquidTrack). Products tab for product CRUD. LiquidTrack tab for device management and event logs.

**Shared across layouts:**
- Progress bars for macro tracking with color-coded fill
- Cards with badges: stock level (containers + servings), placeholder badge, price status
- Offline indicator (disabled buttons + "no connection" banner)

## ChefByte MCP Tools

| Tool | Purpose |
|------|---------|
| `CHEFBYTE_get_inventory` | Grouped inventory by product (total stock, nearest expiration, lot count) with optional lot detail |
| `CHEFBYTE_get_product_lots` | Return lot-level inventory rows for a specific product |
| `CHEFBYTE_add_stock` | Purchase/add quantity to a product (`container` or `serving` input), with location and optional expiration |
| `CHEFBYTE_consume` | Remove quantity from stock using nearest-expiration-first lot depletion (`container` or `serving` input), optionally log macros |
| `CHEFBYTE_get_products` | Product catalog search |
| `CHEFBYTE_create_product` | Create product with full metadata (barcode nullable) |
| `CHEFBYTE_get_shopping_list` | Current shopping list |
| `CHEFBYTE_add_to_shopping` | Add item to shopping list (merges if exists) |
| `CHEFBYTE_clear_shopping` | Clear shopping list |
| `CHEFBYTE_below_min_stock` | Auto-add deficit items to shopping list |
| `CHEFBYTE_get_meal_plan` | Current meal plan |
| `CHEFBYTE_add_meal` | Add entry (with optional meal_prep flag) |
| `CHEFBYTE_mark_done` | Execute meal plan entry (regular: consume + log macros; meal prep: consume + create `[MEAL]` lot, no immediate macro log) |
| `CHEFBYTE_get_recipes` | Recipe catalog |
| `CHEFBYTE_get_cookable` | Recipes makeable with current stock |
| `CHEFBYTE_create_recipe` | Create recipe with ingredients (referencing products by UUID) |
| `CHEFBYTE_get_macros` | Today's macro summary with goals |
| `CHEFBYTE_log_temp_item` | Log off-inventory macro entry |
| `CHEFBYTE_set_price` | Update product price |

## ChefByte Edge Functions

| Function | Purpose | Auth Method |
|----------|---------|-------------|
| `walmart-scrape` | Search and scrape Walmart product data via third-party API | Supabase JWT, per-user rate limiting |
| `liquidtrack` | Ingest ESP8266 scale events | `verify_jwt = false`, runtime lookup by device ID (import key validated once during provisioning) |
| `analyze-product` | OpenFoodFacts lookup + Claude Haiku 4.5 normalization | Supabase JWT, per-user daily quota (100/day), LLM cost paid by platform |
