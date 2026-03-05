# ChefByte Navigation Redesign

## Problem

The current ChefByte nav is 8 horizontal links in a bar — flat, no hierarchy, Scanner buried among equals. Need intuitive navigation with Scanner as the fastest-to-reach screen.

## Decision

**Option A: Scanner-First with Tabbed Sections** — Scanner gets a dedicated always-visible button in the header. Remaining screens organized into 5 tabs. Walmart folds into Settings with a notification dot for pending items.

## Navigation Structure

### Global Shell

```
+--------------------------------------------------------------+
| ChefByte                               [Scanner btn]    [=]  |
+--------------------------------------------------------------+
| [Dashboard] [Meal Plan] [Recipes] [Shopping] [Inventory] [Settings *] |
+--------------------------------------------------------------+
|                                                              |
|  (page content)                                              |
|                                                              |
+--------------------------------------------------------------+

* = notification dot when Walmart has pending items
Scanner btn = always visible, accent-colored, 1-click access
Mobile: tabs become bottom bar, Scanner centered/larger
```

### Tab Mapping

| Tab       | Route             | Content                                                        |
| --------- | ----------------- | -------------------------------------------------------------- |
| Dashboard | `/chef`           | Macro summary, today's meals, alerts, quick actions, meal prep |
| Meal Plan | `/chef/meal-plan` | Week grid, day detail, add meal                                |
| Recipes   | `/chef/recipes`   | Card grid, filters, search                                     |
| Shopping  | `/chef/shopping`  | To buy / purchased lists                                       |
| Inventory | `/chef/inventory` | Grouped/lot stock view, product actions                        |
| Settings  | `/chef/settings`  | Products, Walmart, LiquidTrack, Locations (sub-tabs)           |
| Scanner   | `/chef/scanner`   | Dedicated page via header button (not a tab)                   |

Sub-pages:

- `/chef/macros` — full macro detail (sub-page of Dashboard, back arrow returns)
- `/chef/recipes/:id` — recipe detail view
- `/chef/recipes/new` — create recipe
- `/chef/recipes/:id/edit` — edit recipe

### Mobile Bottom Bar

```
+----+----+------+----+----+----+
| Ho | Pl | SCAN | Rc | Sh | Se |
| me | an |      | pe | op | t* |
+----+----+------+----+----+----+

Scanner: larger, accent-colored, center position
Inventory + Macros: accessible from hamburger menu [=]
Settings: notification dot for Walmart pending
```

Hamburger overflow on mobile: Inventory, Macros, Back to Hub, Logout.

## Page Designs

### 1. Dashboard (`/chef`)

Sections top to bottom:

1. **Date header** — "Today Wed Mar 5" with day boundary times
2. **Macro summary row** — 4 cards (Calories, Protein, Carbs, Fats) with progress bars, consumed/goal, percentage. Entire row clickable -> `/chef/macros`
3. **Today's Meals** — list from meal plan for current logical date. Shows meal type icon, recipe/product name, macros, done status. Click undone entry -> mark done confirmation modal. "[see plan]" link to `/chef/meal-plan`
4. **Today's Meal Prep** — prep entries for today with [Execute Prep] button. Or "No meal prep scheduled"
5. **Alerts** — badge cards: Below Min Stock (-> inventory), No Price (-> settings?tab=walmart), Placeholders (-> settings?tab=products), Cart Value (-> shopping). Each clickable.
6. **Quick Actions** — buttons: Import Shopping List, Meal Plan -> Cart, Target Macros, Taste Profile, Log Liquid

Dashboard modals:

- **Target Macros** — protein/carbs/fats inputs, calories auto-calculated. [Save] [Cancel]
- **Taste Profile** — freeform textarea (~6 rows). [Save] [Cancel]
- **Log Liquid** — name, amount (ml), calories, refill checkbox. [Log] [Cancel]
- **Mark Meal Done** — shows meal name + macros, confirms consume + log. [Mark Done] [Cancel]
- **Execute Meal Prep** — ingredient consumption table (need/stock/after), [MEAL] lot preview, macro behavior note. [Execute Meal Prep] [Cancel]
- **Import Shopping List** — lists purchased items to import, confirms action. [Import] [Cancel]

### 2. Macros (`/chef/macros`)

Back-arrow to Dashboard. Day navigation (prev/today/next).

Sections:

1. **Day summary** — full-width progress bars (Calories, Protein, Carbs, Fats) with values and percentages
2. **Consumed items table** — Source (Meal Plan/Scanner/Temp), Item, Cal, P, C, F, delete icon. TOTAL row at bottom. Delete icon on temp items and food logs.
3. **Planned (not yet consumed)** — upcoming regular plan entries
4. **Actions** — [+ Log Temp Item] [Edit Targets] [Taste Profile]

Modals:

- **Log Temp Item** — name, calories, protein, carbs, fats. [Log Item] [Cancel]
- **Delete Consumed Item** — confirms removal with macro values shown. [Delete] [Cancel]

### 3. Meal Plan (`/chef/meal-plan`)

Header with week navigation (prev/today/next) and date range.

Sections:

1. **Week grid** — 7 day cards. Today highlighted. Each card shows meal entries (name, done checkmark, [PREP] badge). Click day to select.
2. **Day detail** — table below grid: Entry, Meal Type, Mode (Regular/Prep), Macros, Status/Action. TOTAL row. Actions: [Done] for regular, [Execute] for prep, [Undo] for completed, [x] to delete. Meal type clickable to change via dropdown. Mode togglable.
3. **Footer actions** — [+ Add Meal] [Meal Plan -> Cart]

Modals:

- **Add Meal** — source toggle (Recipe/Product), search dropdown, servings, meal type dropdown, regular/prep toggle. [Add to Plan] [Cancel]
- **Change Meal Type** — inline dropdown (Breakfast/Lunch/Dinner/Snack), saves immediately
- **Delete Meal Entry** — confirms removal. [Delete] [Cancel]
- **Meal Plan -> Cart** — table showing ingredient needs vs stock vs to-buy, placeholder warnings. [Add to Shopping List] [Cancel]

### 4. Recipes (`/chef/recipes`)

Header with [+ New Recipe] button.

Sections:

1. **Search** — full-width search input
2. **Filter pills** — [Can Be Made] [< 30 min] [High Protein]
3. **Recipe card grid** — auto-fit columns (min 260px). Each card: name, description, servings, active/total time, per-serving macros (cal, P, C, F), stock badge (CAN MAKE green / PARTIAL orange / NO STOCK red), [+ Plan] and [Edit] buttons

Card interactions:

- Click card name -> recipe detail view (`/chef/recipes/:id`)
- [+ Plan] -> Add to Meal Plan modal
- [Edit] -> recipe form (`/chef/recipes/:id/edit`)

**Recipe Detail** (`/chef/recipes/:id`) — back arrow to Recipes. Name, description, servings, times, ingredients table (product, qty, unit, note), per-serving and total macros, instructions, stock status. Actions: [+ Add to Meal Plan] [Delete Recipe]

Modals:

- **Add to Meal Plan** — date picker, servings, meal type, regular/prep toggle. [Add] [Cancel]

### 5. Recipe Form (`/chef/recipes/new`, `/chef/recipes/:id/edit`)

Back arrow to Recipes.

Sections:

1. **Details** — name, description, base servings, active time, total time
2. **Ingredients** — add row (product search, qty, unit dropdown, note, [+ Add]). Table of existing ingredients with inline-editable qty/unit/note and delete button. Zero-ingredient validation on save.
3. **Instructions** — freeform textarea
4. **Computed Macros** — read-only per-serving and total macros from ingredients
5. **Footer** — [Save Recipe] [Cancel] and [Delete Recipe] (edit mode only)

Modals:

- **Delete Recipe** — confirms deletion, warns about recipe ingredient unlinking. [Delete] [Cancel]

### 6. Shopping (`/chef/shopping`)

Header with [Auto-Add Below Min Stock] button.

Sections:

1. **Add item** — product search + qty + [Add] button. Additive upsert.
2. **To Buy** — list with checkbox, product name, qty, price (if available), [Remove]. Cart total shown in section header.
3. **Purchased** — checked items, struck-through styling, [Remove] per item.
4. **Footer actions** — [Import to Inventory] [Open Walmart Links] [Clear All]

Modals:

- **Clear All** — confirms removal of all items. [Clear All] [Cancel]
- **Walmart Links** — list of product URLs with [Copy] per item and [Copy All]. Notes items without links.

### 7. Inventory (`/chef/inventory`)

Header with search input and [+ Product] button.

Sections:

1. **View toggle** — [Grouped] / [Lots] radio
2. **Grouped view** (default) — product cards: name, barcode, srv/ctn, total stock (containers + servings equivalent), stock color dot, nearest expiration, lot count, min stock. Actions per row: [-1] [+1] [-S] [+S] [Consume All]
3. **Lots view** — table: Product, Lot ID, Qty, Location, Expires

Modals:

- **Add Stock** (from [+1] or [+S]) — qty, unit toggle (container/serving), location dropdown, optional expiry date. [Add] [Cancel]
- **Consume All** — confirms consumption, notes no macros logged. [Consume All] [Cancel]
- **Create Product** (from [+ Product]) — name, barcode (optional), servings/container, nutrition (cal/P/C/F), min stock, price, placeholder checkbox. [Create Product] [Cancel]

### 8. Settings (`/chef/settings`)

Sub-tabs: [Products] [Walmart (dot)] [LiquidTrack] [Locations]

**Products tab:**

- Search + product list with name, barcode, nutrition, min stock, price
- [+ New] button, [Edit] and [Delete] per product
- Edit Product modal: all fields editable including walmart link
- Delete Product modal: warns about recipe ingredient cascade

**Walmart tab:**

- Missing Walmart Links section: products with radio-button search results, custom URL input, [Link Selected] / [Mark Not Walmart]
- Missing Prices section: manual price input per product, [Save Price]
- [Refresh All Prices] button

**LiquidTrack tab:**

- Device table: name, linked product, status, [Events] [Revoke]
- [+ Add Device] button
- Add Device modal: name, product search, [Generate Device ID & Key], shows ID + one-time key with copy
- Events modal: timestamp/before/after/consumed/macros table
- Revoke modal: confirms device revocation

**Locations tab:**

- Location list with lot counts, [Delete] per location
- Add location: name input + [Add]
- Delete blocked if lots exist (shows error), confirms if empty

### 9. Scanner (`/chef/scanner`)

Accessed via header button (not a tab). Tabs dimmed or hidden.

Two-column layout:

- **Left (queue):** barcode input (auto-focus), [All]/[New] filter, scrollable queue of transactions
- **Right (keypad):** mode selector (Purchase/Consume+M/Consume-M/Add Shopping), active item display, quantity screen, nutrition editor (purchase mode only: srv/ctn, cal, C, F, P with auto-scaling), number keypad (4-col grid), servings/containers toggle

Queue item states:

- Red border + [!NEW] = newly created product
- Blue outline = active/selected
- Green border = successful
- Orange border = pending
- [undo] = click once -> "Confirm?", second click -> reverses transaction

Unknown barcode: shows loading state -> auto-lookup via analyze-product -> either creates product or shows "not found" with [Create Manually]. Quota exceeded: "Daily limit reached" with [Create Manually].

## Settings Notification Dot

The Settings tab shows a notification dot when ANY of:

- Products with missing Walmart links > 0
- Products with missing prices > 0
- Placeholder products > 0

Dot clears when all issues resolved. On mobile bottom bar, dot appears on the Settings icon.

## Key Changes from Current Layout

| What             | Before                  | After                                           |
| ---------------- | ----------------------- | ----------------------------------------------- |
| Nav style        | 8 horizontal links      | 5 tabs + Scanner button                         |
| Scanner access   | One of 8 equal links    | Dedicated header button                         |
| Macros           | Separate top-level page | Sub-page of Dashboard                           |
| Walmart          | Top-level page          | Settings sub-tab with notification dot          |
| Products CRUD    | Settings only           | Settings + [+ Product] on Inventory             |
| Dashboard alerts | Status text row         | Clickable badge cards linking to relevant pages |
| Today's meals    | Only on Meal Plan       | Also on Dashboard                               |
| Mobile nav       | Hamburger menu          | Bottom tab bar with centered Scanner            |
