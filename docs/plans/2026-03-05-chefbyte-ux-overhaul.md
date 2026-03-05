# ChefByte UX Overhaul

Post-nav-redesign polish pass. Addresses visual hierarchy, consistency, space efficiency, and user-reported pain points.

## Changes by Page

### Dashboard (`/chef/home`) — Major overhaul

**Current problems:** No progress bars on macros, alerts are plain text, action buttons are rainbow colors, can't mark meals done or execute prep from dashboard.

**Changes:**

1. Macro summary cards: add progress bars with color fill (blue=cal, green=protein, orange=carbs, red=fats), show percentage
2. Replace plain-text status row with clickable alert badge cards (colored backgrounds, counts, link to relevant page)
3. Standardize action buttons: blue primary, outlined secondary style
4. Today's Meals: clicking a pending meal opens mark-done confirmation modal (calls `private.mark_meal_done`)
5. Today's Meal Prep: add [Execute] button per prep entry
6. Add "Log Liquid" quick action button

### Meal Plan (`/chef/meal-plan`) — Complete redesign

**Current problems:** Week grid takes entire screen height, day detail only visible by scrolling below. Empty days waste space. Emoji macros inconsistent with rest of app.

**New layout:**

- **Top:** Header with title, week nav (Prev/Today/Next), date range, [+ Add Meal]
- **Left panel (narrow, ~250px):** Compact week list — 7 day rows with day name, date, meal count badge. Today highlighted. Click to select. Scrollable if needed.
- **Right panel (wide):** Selected day detail — table with Entry, Meal Type, Macros (Cal/P/C/F text, not emoji), Status, Actions. Total row. [+ Add Meal] and [Meal Plan -> Cart] below.
- When no day selected or day has no meals, show helpful empty state.
- Macro labels: use "580 cal | 34P | 70C | 19F" format consistently (no emoji).

### Inventory (`/chef/inventory`) — Grouped view redesign

**Current problems:** Each product card is vertically tall (~150px). Lots of wasted space. Barcode shown prominently (not useful). Action buttons bunched together.

**New grouped view — compact table-like rows:**

- Each product is a single row: [Stock dot] Name | Stock (ctn + svgs) | Expiry | Min | [+][-][+S][-S] [Consume All]
- Stock dot: green/orange/red circle based on stock vs min
- Collapse barcode and srv/ctn into a hover tooltip or expandable detail
- Action buttons: grouped as increment/decrement pairs
- Keeps search and Grouped/Lots toggle
- Much more products visible per screen

### Macros (`/chef/macros`) — Back nav

- Add back arrow link to Dashboard at top: "<- Dashboard"

### Recipe Form (`/chef/recipes/new`, `/chef/recipes/:id/edit`) — Minor fixes

- Add back arrow: "<- Recipes" or "<- Back"
- Balance footer buttons: [Save/Create] as normal-width primary button, [Cancel] secondary, side by side. Not full-width green.

### Shopping (`/chef/shopping`) — Minor fixes

- "Remove" buttons: change from bright red to subtle outlined/gray (less visual weight)
- "Clear All" button: add confirmation step before clearing

### Settings > Products — Tighter layout

- Product cards: use a 2-column grid layout showing key info more compactly
- Reduce vertical spacing between product items

### Global Consistency

- **Button palette:** Blue (`--color-primary`) for primary actions, outlined/white for secondary, red only for destructive actions with confirmation
- **Back navigation:** Sub-pages (Macros, Recipe Form) get a back arrow link
- **Macro format:** Consistent "580 cal | 34g P | 70g C | 19g F" across all pages (no emoji)
- **Empty states:** Helpful messages with suggested actions in empty sections

## Files to modify

- `apps/web/src/pages/chefbyte/HomePage.tsx` — Dashboard overhaul
- `apps/web/src/pages/chefbyte/MealPlanPage.tsx` — Complete redesign
- `apps/web/src/pages/chefbyte/InventoryPage.tsx` — Grouped view redesign
- `apps/web/src/pages/chefbyte/MacroPage.tsx` — Back arrow
- `apps/web/src/pages/chefbyte/RecipeFormPage.tsx` — Back arrow, button balance
- `apps/web/src/pages/chefbyte/ShoppingPage.tsx` — Button styling
- `apps/web/src/pages/chefbyte/SettingsPage.tsx` — Tighter product cards
- `apps/web/src/theme/chefbyte.css` — New component styles, button standardization
