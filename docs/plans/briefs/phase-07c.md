# Phase 07c: ChefByte UI — Recipes + Walmart + Settings + Browser Tests
> Previous: phase-07b.md | Next: phase-08.md

## Skills
test-driven-development, test-quality-review, frontend-design, requesting-code-review (phase boundary)

## Build
- `apps/web/src/pages/chefbyte/Recipes.tsx`:
  - Card grid: recipe name, description, servings, active/total time, per-serving macros
  - Integrated filters: Can Be Made toggle, carbs/protein density percentile sliders, active/total time sliders, search input
  - Cards open detail/edit mode
- `apps/web/src/pages/chefbyte/RecipeCreateEdit.tsx`:
  - Single page for both create and edit modes
  - Form: name, description, base servings, active time, total time, instructions
  - Ingredient section: product search dropdown, amount, unit (Serving/Container), note, add button
  - Ingredients table with dynamic macro computation (sum of ingredient macros)
  - Per-serving and total macro display
- `apps/web/src/pages/chefbyte/Walmart.tsx`:
  - Missing Walmart Links: product list with radio-button search results (pick match or mark "Not Walmart")
  - Missing Prices: manual price entry for non-Walmart items
  - Refresh All Prices button
- `apps/web/src/pages/chefbyte/Settings.tsx`:
  - Tab interface: Products / LiquidTrack
  - Products tab: full product CRUD (create, edit, delete with cascade warning)
  - LiquidTrack tab: device management (add device, generate ID/import key, name, revoke), event logs
- Components: `RecipeIngredientEditor`, `RecipeFilterBar`

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/chefbyte/RecipeIngredientEditor.test.tsx`
- Product search input filters dropdown to matching products
- Quantity input validates numeric (rejects non-numeric)
- Unit toggle switches between containers and servings
- Add button appends ingredient to list and calls onAdd callback
- Empty quantity shows validation error on add
- Duplicate product shows warning

### Unit: `apps/web/src/__tests__/unit/chefbyte/RecipeFilterBar.test.tsx`
- Can Be Made toggle calls onFilter with canBeMade=true/false
- Protein density percentile slider calls onFilter with proteinDensity range
- Carbs density percentile slider calls onFilter with carbsDensity range
- Active time slider calls onFilter with activeTime range
- Total time slider calls onFilter with totalTime range
- Search input calls onFilter with search string
- Reset button clears all filters to defaults
- All filter changes call parent onFilterChange callback

### Browser: `apps/web/e2e/chefbyte/scanner.spec.ts`
- Navigate to /chef/scanner -> page renders two-column layout
- Type barcode in input -> product lookup triggered
- Mode selector buttons switch active mode
- Purchase mode shows nutrition editor row
- Queue items appear with correct color coding
- Keypad enters quantity digits correctly

### Browser: `apps/web/e2e/chefbyte/dashboard.spec.ts`
- Navigate to /chef/home -> macro summary cards render
- Status badges show correct counts
- Target Macros modal opens, edits persist
- Taste Profile modal opens with textarea
- Liquid Log modal: enter name + amount + calories + refill -> save -> logged
- Recent New Items section visible with inline-edit capability
- Temp item form: enter name + macros -> submit -> appears in consumed list

### Browser: `apps/web/e2e/chefbyte/inventory.spec.ts`
- Grouped-by-product table renders with stock totals
- Toggle switches to lot view with per-lot details
- +/- container buttons adjust stock
- Consume All shows confirmation dialog

### Browser: `apps/web/e2e/chefbyte/shopping.spec.ts`
- Add item form creates new shopping list entry
- Checkbox moves item to Purchased section with strikethrough
- "Add Checked to Inventory" imports checked items
- Auto-Add Below Min Stock adds deficit items

### Browser: `apps/web/e2e/chefbyte/meal-plan.spec.ts`
- 7-day grid renders with week navigation
- Add Meal modal opens with recipe/product search
- Mark Done on regular entry changes status
- [PREP] shows execute confirmation

### Browser: `apps/web/e2e/chefbyte/recipes.spec.ts`
- Card grid renders with recipe details and per-serving macros
- Can Be Made filter toggles card visibility
- Density sliders filter recipes
- Search input filters by name

### Browser: `apps/web/e2e/chefbyte/recipe-create-edit.spec.ts`
- Create mode: fill form + add ingredients -> save -> recipe created
- Edit mode: load existing recipe -> modify -> save -> updated
- Dynamic macro calc updates as ingredients change

### Browser: `apps/web/e2e/chefbyte/walmart.spec.ts`
- Missing Links section shows products with radio search results
- Pick match links product to Walmart URL
- Missing Prices section allows manual price entry
- Refresh All Prices button triggers price update

### Browser: `apps/web/e2e/chefbyte/settings.spec.ts`
- Products tab: create product -> appears in list, edit -> updated, delete -> removed
- LiquidTrack tab: add device -> ID generated, revoke -> device removed

### Quality gate
After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference
- `legacy/chefbyte-vercel/apps/web/src/pages/Recipes.tsx` — card grid, search
- `legacy/chefbyte-vercel/apps/web/src/pages/RecipeCreate.tsx` — ingredient editor, macro calc
- `legacy/chefbyte-vercel/apps/web/src/pages/RecipeEdit.tsx` — edit flow
- `legacy/chefbyte-vercel/apps/web/src/pages/RecipeFinder.tsx` — density filters, can-be-made, time sliders
- `legacy/chefbyte-vercel/apps/web/src/pages/Walmart.tsx` — link search, price tracking
- `legacy/chefbyte-vercel/apps/web/src/pages/Products.tsx` — product CRUD
- `legacy/chefbyte-vercel/apps/web/src/pages/LiquidTrack.tsx` — IoT device management

## Commit
`feat: chefbyte UI — recipes + walmart + settings + browser tests`

## Acceptance
- [ ] Recipes page renders card grid with integrated filters and search
- [ ] Recipe Create/Edit single page works for both modes with dynamic macro calc
- [ ] Walmart page shows missing links (radio results) + missing prices + refresh
- [ ] Settings page has Products CRUD tab + LiquidTrack devices tab
- [ ] All unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/chefbyte/RecipeIngredientEditor src/__tests__/unit/chefbyte/RecipeFilterBar`
- [ ] All 9 browser spec files pass: `pnpm --filter web exec playwright test e2e/chefbyte/`
- [ ] Phase boundary full suite passes: `supabase test db && pnpm test && pnpm typecheck && pnpm --filter web exec playwright test e2e/chefbyte/`
