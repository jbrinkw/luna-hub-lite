# ChefByte UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build all ChefByte UI pages — the largest module in Luna Hub Lite — with unit tests.

**Architecture:** Same patterns as CoachByte: `ChefLayout` wraps all pages with `ChefNav` tab bar. Pages use local `useState` + `useEffect` + direct Supabase SDK calls (`.schema('chefbyte').from(...)` for CRUD, `.rpc(...)` for multi-step operations). No state management library. Edge Function calls (analyze-product, walmart-scrape) stubbed with TODO comments for Phase 8.

**Tech Stack:** React 18 + TypeScript, Ionic React components, Supabase JS SDK, React Router 6

---

## Context

### Navigation
Top nav tabs: Scanner | Home | Inventory | Shopping | Meal Plan | Recipes | Macros | Walmart | Settings

Routes under `/chef/*`:
- `/chef` → ScannerPage (index)
- `/chef/home` → HomePage
- `/chef/inventory` → InventoryPage
- `/chef/shopping` → ShoppingPage
- `/chef/meal-plan` → MealPlanPage
- `/chef/recipes` → RecipesPage
- `/chef/recipes/new` → RecipeFormPage (create)
- `/chef/recipes/:id` → RecipeFormPage (edit)
- `/chef/macros` → MacroPage
- `/chef/walmart` → WalmartPage
- `/chef/settings` → SettingsPage

### DB Tables (chefbyte schema)
locations, products, stock_lots, recipes, recipe_ingredients, meal_plan_entries, food_logs, temp_items, shopping_list, liquidtrack_devices, liquidtrack_events, user_config

### RPC Functions
- `chefbyte.consume_product(p_product_id, p_qty, p_unit, p_log_macros, p_logical_date)` → JSONB
- `chefbyte.mark_meal_done(p_meal_id)` → JSONB
- `chefbyte.get_daily_macros(p_logical_date)` → JSONB

### Patterns (from CoachByte)
- Layout: `ChefLayout` wraps page in IonPage + IonHeader + IonContent + ModuleSwitcher
- Nav: `ChefNav` uses IonSegment with tab buttons, useLocation for active detection
- Data: `supabase.schema('chefbyte').from('table').select('...').eq('user_id', user.id)`
- RPC: `(supabase.schema('chefbyte') as any).rpc('function_name', { params })`
- Loading: Show IonSpinner while data loads
- Errors: Show IonText with error message

### Legacy Reference
Match UI patterns from `legacy/chefbyte-vercel/apps/web/src/pages/` — same React+Supabase stack. Key files: Home.tsx, Scanner.tsx, Inventory.tsx, MealPlan.tsx, Recipes.tsx, RecipeCreate.tsx, ShoppingList.tsx, Walmart.tsx, Settings.tsx.

---

## Task 1: ChefLayout + ChefNav + Routes

**Files:**
- Create: `apps/web/src/components/chefbyte/ChefLayout.tsx`
- Create: `apps/web/src/components/chefbyte/ChefNav.tsx`
- Modify: `apps/web/src/modules/chefbyte/routes.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/ChefNav.test.tsx`

**What to build:**
- `ChefNav`: IonSegment with tabs matching nav structure above. Follow CoachNav pattern exactly (useLocation, useNavigate, IonSegmentButton).
- `ChefLayout`: IonPage + IonHeader (title "CHEFBYTE" + logout button) + second IonToolbar with ChefNav + IonContent with ModuleSwitcher + children. Follow CoachLayout pattern.
- Update `routes.tsx`: Import all page components (use placeholder components for now — just the page name in an IonText), wire up all routes with React Router.
- Unit tests: Verify ChefNav renders all tabs, active tab detection works, navigation fires on click.

**Reference:** `apps/web/src/components/coachbyte/CoachNav.tsx`, `apps/web/src/components/coachbyte/CoachLayout.tsx`, `apps/web/src/modules/coachbyte/routes.tsx`

---

## Task 2: SettingsPage (Products + LiquidTrack tabs)

**Files:**
- Create: `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/SettingsPage.test.tsx`

**What to build:**
Settings page with two IonSegment tabs: Products and LiquidTrack.

**Products tab:**
- Searchable product list from `chefbyte.products`
- Each product shows: name, barcode, servings_per_container, macros per serving, min_stock, price
- Edit inline or in expandable card
- Delete button (only for user-created products)
- Add Product form: name, barcode, servings_per_container, calories/carbs/protein/fat_per_serving, min_stock_amount, price

**LiquidTrack tab:**
- Device table from `chefbyte.liquidtrack_devices`: device_name, product name (joined), is_active status
- Add Device form: device_name, product_id (select), generates UUID device_id + random import_key. Insert device with hashed key.
- Per-device event log from `chefbyte.liquidtrack_events`: created_at, weight_before, weight_after, consumption, macros
- Revoke button (sets is_active = false)

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Settings.tsx`, `legacy/chefbyte-vercel/apps/web/src/pages/Products.tsx`, `legacy/chefbyte-vercel/apps/web/src/pages/LiquidTrack.tsx`

**Unit tests:** Tab switching, product list renders, add product form fields present, device table renders, add device form present.

---

## Task 3: InventoryPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/InventoryPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/InventoryPage.test.tsx`

**What to build:**
Inventory page with grouped-by-product default view and raw lots toggle.

**Grouped view (default):**
- Query products + aggregate stock_lots per product (total qty_containers, nearest expires_on, lot count)
- Table columns: Product name (+ barcode, srvg/ctn below), Total Stock, Nearest Expiry, Lots count, Min Stock, Actions
- StockBadge color: red if stock=0, orange if below min_stock_amount, green otherwise
- Actions: +1 ctn, -1 ctn, +1 srv, -1 srv (via consume_product RPC with appropriate unit/qty), Consume All

**Lots view:**
- Toggle to show raw stock_lots with: lot_id, product name, location name, qty_containers, expires_on
- Sorted by expires_on ASC NULLS LAST

**Stock adjustments:**
- +ctn/-ctn: Call consume_product with negative/positive qty? No — for adding stock, insert/update lot directly. For consuming, use consume_product RPC.
- +ctn: Insert new lot (location = first location, no expiry) or update existing
- -ctn: consume_product(product_id, 1, 'container', false, logical_date)
- +srv/-srv: Same but unit='serving'
- Consume All: consume_product with total stock quantity

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Inventory.tsx`, ASCII layout line 757

**Unit tests:** Grouped view renders with product rows, stock badge colors, lots toggle, action buttons present.

---

## Task 4: ShoppingPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/ShoppingPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/ShoppingPage.test.tsx`

**What to build:**
Shopping list with To Buy / Purchased sections.

- Query `chefbyte.shopping_list` joined with products for names
- To Buy section: items where purchased=false, checkbox to mark purchased, Remove button
- Purchased section: items where purchased=true, strikethrough, Remove button
- Add Item form: product search (autocomplete from products table) + quantity + Add button
- Auto-Add Below Min Stock button: query products where total stock < min_stock_amount, insert into shopping_list with qty = ceil(min_stock_amount - current_stock)
- Import Shopping button: calls server-side function or inserts stock lots for all purchased items, then removes from shopping_list

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/ShoppingList.tsx`, ASCII layout line 727

**Unit tests:** Both sections render, add item form, checkbox toggle, auto-add button present.

---

## Task 5: RecipesPage + RecipeFormPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/RecipesPage.tsx`
- Create: `apps/web/src/pages/chefbyte/RecipeFormPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/RecipesPage.test.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/RecipeFormPage.test.tsx`

**What to build:**

**RecipesPage:**
- Card grid from `chefbyte.recipes` joined with recipe_ingredients → products for macro calculation
- Each card: name, active_time, total_time, per-serving macros (computed from ingredients), [+ Meal Plan] button
- Filters: search bar, Can Be Made (sufficient stock for all ingredients), active time filter
- Click card → navigate to `/chef/recipes/:id` for editing
- [+ New Recipe] button → navigate to `/chef/recipes/new`

**RecipeFormPage:**
- Single page for create (no :id param) and edit (with :id param)
- Form fields: name, description, base_servings, active_time, total_time, instructions (textarea)
- Ingredient section: ProductSearch autocomplete + quantity + unit (container/serving) + note + Add button
- Ingredients table showing added ingredients with Remove button
- Dynamic macro calculation: sum each ingredient's macros (quantity * per-serving or per-container macros) / base_servings for per-serving display
- Save: upsert recipe + delete old ingredients + insert new ingredients
- Delete button (edit mode only)

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Recipes.tsx`, `RecipeCreate.tsx`, `RecipeEdit.tsx`, ASCII layout line 502

**Unit tests:** Recipe cards render, filter chips present, form fields present, ingredient add/remove, macro calculation logic.

---

## Task 6: MealPlanPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/MealPlanPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/MealPlanPage.test.tsx`

**What to build:**
7-day week grid with meal entries and day detail.

- Week navigation: prev/today/next buttons. Compute Monday–Sunday for current week.
- Query `chefbyte.meal_plan_entries` for the 7-day range, joined with recipes and products for names
- Week grid: 7 day columns, each showing meal entry names with status badges ([done], [PREP])
- Click day → expand detail table: Entry name, Mode (Regular/Prep), Status (Planned/Done + time), Actions
- Actions: Mark Done (calls `chefbyte.mark_meal_done()`), Delete
- [PREP] entries: Mark Done opens confirmation modal showing ingredient consumption preview (need/stock/after), [MEAL] lot creation details, "no macros until consumed" note
- Add Meal modal: recipe search OR product search, servings input, meal_prep toggle, logical_date (selected day)
- [Meal Plan → Cart] button: for each planned entry's recipe ingredients, add to shopping_list if not already there

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/MealPlan.tsx`, ASCII layout line 564

**Unit tests:** Week grid renders 7 days, navigation buttons, detail table, add meal modal fields, meal prep confirmation.

---

## Task 7: MacroPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/MacroPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/MacroPage.test.tsx`

**What to build:**
Daily macro tracking with consumed/planned items and modals.

- Date navigation: prev/today/next, display current date
- Day Summary: call `chefbyte.get_daily_macros()` RPC → 4 progress bars (Calories, Protein, Carbs, Fats) showing consumed/goal with percentage
- Consumed Items table: query food_logs + temp_items + liquidtrack_events for the date. Columns: Source, Item, Cal, P, C, F
- Planned Items: query meal_plan_entries for date where completed_at IS NULL and meal_prep=false. Show recipe/product name + estimated macros
- Modals:
  - Log Temp Item: name, calories, protein, carbs, fat inputs → insert into temp_items
  - Target Macros editor: protein, carbs, fats inputs → auto-calc calories (P*4 + C*4 + F*9) → save to user_config keys: goal_calories, goal_protein, goal_carbs, goal_fats
  - Taste Profile: textarea → save to user_config key: taste_profile

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Home.tsx` (macro section), ASCII layout line 641

**Unit tests:** Progress bars render, consumed items table, modals open/close, auto-calc calories logic, date navigation.

---

## Task 8: HomePage (Dashboard)

**Files:**
- Create: `apps/web/src/pages/chefbyte/HomePage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/HomePage.test.tsx`

**What to build:**
Dashboard with status cards, macro summary, and quick actions.

- Status cards (count queries):
  - Missing Prices: products where price IS NULL
  - Placeholders: products where is_placeholder = true
  - Below Min Stock: products where total stock < min_stock_amount
  - Cart Value: SUM(price * qty_containers) from shopping_list joined with products
- Macro Day Summary: reuse same get_daily_macros RPC + progress bars as MacroPage (but compact)
- Quick Actions row: buttons for Import Shopping, Target Macros modal, Taste Profile modal, Meal Plan → Cart
- Today's Meal Prep: query meal_plan_entries for today where meal_prep=true and completed_at IS NULL

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Home.tsx`, ASCII layout line ~384

**Unit tests:** Status cards render with counts, macro summary section, quick action buttons, meal prep section.

---

## Task 9: ScannerPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/ScannerPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/ScannerPage.test.tsx`

**What to build:**
Two-column barcode scanner with queue and keypad.

**Left column — Queue:**
- Barcode input field (text, auto-focus, captures HID scanner input)
- Filter buttons: All / New
- Transaction queue (local state array of queue items)
- Each queue item: product name, transaction details (purchased/consumed X units), stock level, status indicator (border color), undo/delete buttons

**Right column — Keypad:**
- Mode selector: 4 buttons (Purchase, Consume+Macros, Consume-NoMacros, Add to Shopping)
- Active item display (currently selected queue item name)
- Screen value display (numeric input)
- Nutrition editor row (Purchase mode only): srvg/ctn, cal, carbs, fat, protein — editable, auto-scale when one changes
- Numeric keypad: 3x4 grid (7-8-9, 4-5-6, 1-2-3, .-0-backspace)
- Unit toggle: Servings / Containers (consume modes only)

**Barcode flow:**
1. Scan barcode → look up in products table by barcode
2. If found → add to queue with product info
3. If not found → call analyze-product Edge Function (STUBBED: just create placeholder product with barcode, mark as is_placeholder=true, add [!NEW] badge to queue item)
4. User enters quantity via keypad
5. Based on mode:
   - Purchase: insert/update stock lot + optional nutrition edit
   - Consume+Macros: consume_product RPC with log_macros=true
   - Consume-NoMacros: consume_product RPC with log_macros=false
   - Add to Shopping: insert into shopping_list

**Nutrition auto-scaling:** When user edits one macro field, scale others proportionally based on original ratios. Legacy Scanner.tsx has this logic.

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Scanner.tsx`, ASCII layout line 429

**Unit tests:** Mode selector renders 4 modes, keypad renders digits, barcode input present, queue renders items, nutrition editor shows in purchase mode only, unit toggle in consume modes.

---

## Task 10: WalmartPage

**Files:**
- Create: `apps/web/src/pages/chefbyte/WalmartPage.tsx`
- Test: `apps/web/src/__tests__/unit/chefbyte/WalmartPage.test.tsx`

**What to build:**
Price manager with two sections.

**Missing Walmart Links:**
- Query products where walmart_link IS NULL and is_placeholder=false
- For each product: show name, radio group with search results (STUBBED — walmart-scrape Edge Function not yet available, show "Search results will appear when Walmart integration is enabled" placeholder) + "Not on Walmart" option
- [Link Selected] button: updates product's walmart_link field

**Missing Prices:**
- Query products where walmart_link IS NOT NULL and price IS NULL, OR products marked "Not on Walmart" with no price
- Manual price input per product + [Save Price] button

**[Refresh All Prices] button:** STUBBED — would call walmart-scrape for all linked products to refresh prices.

**Reference:** `legacy/chefbyte-vercel/apps/web/src/pages/Walmart.tsx`, ASCII layout line 791

**Unit tests:** Both sections render, manual price entry works, refresh button present.

---

## Task 11: Wire up routes + integration verification

**Files:**
- Modify: `apps/web/src/modules/chefbyte/routes.tsx` (replace placeholders with real page imports)
- Run: `pnpm typecheck`, `pnpm test`, `supabase test db`

**What to do:**
- Replace all placeholder page components in routes.tsx with real imports
- Verify typecheck passes
- Verify all tests pass (existing + new ChefByte tests)
- Verify dev server renders ChefByte pages
- Commit everything

---

## Decisions Made (flag in decisions.md)

1. **Scanner as index route** — `/chef` lands on Scanner (most-used page per legacy), not Home. Home is at `/chef/home`.
2. **RecipeFormPage shared** — Single page for create + edit (route param determines mode), matching legacy RecipeCreate/RecipeEdit pattern.
3. **MacroPage separate from Home** — Home has compact macro summary; `/chef/macros` has full tracking with consumed/planned lists and modals.
4. **Edge Functions stubbed** — Scanner analyze-product and Walmart walmart-scrape both stubbed with placeholder UI. Phase 8 wires them up.
5. **No ProductSearch shared component** — Product search autocomplete is simple enough to inline (IonSearchbar + filtered results). If 3+ pages need it, extract later.
6. **Stock adjustments via direct lot manipulation for additions** — +ctn/+srv inserts/updates lots directly (no RPC for adding stock). -ctn/-srv and Consume All use consume_product RPC.
