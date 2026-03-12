# Phase 07a: ChefByte UI — Scanner + Dashboard

> Previous: phase-06e.md | Next: phase-07b.md

## Skills

test-driven-development, test-quality-review, frontend-design, context7 (Ionic React, Supabase)

## Build

- ChefByte layout shell with top nav: Scanner (default) / Home / Inventory / Shopping / Meal Plan / Recipes / Walmart / Settings
- ChefByte routes in `apps/web/src/App.tsx`: `/chef/*` paths
- `apps/web/src/pages/chefbyte/Scanner.tsx` — two-column layout:
  - Left panel: barcode text input + filter buttons (All/New) + scrollable transaction queue
  - Right panel: mode selector (Purchase / Consume+Macros / Consume-NoMacros / Add to Shopping), meal plan toggle, quantity screen + number keypad (calculator layout with backspace + unit toggle)
  - Purchase mode: nutrition editor row (servings/container, calories, carbs, fats, protein with 4-4-9 auto-scaling)
  - Queue items color-coded: red=new product, green=success, orange=pending
  - Each queue item: product name, transaction details, stock levels, undo/delete button
- `apps/web/src/pages/chefbyte/Dashboard.tsx`:
  - Macro summary cards (consumed / planned / goal for calories, protein, carbs, fats)
  - Status badge row: Missing Walmart Links, Missing Prices, Placeholder Items, Below Min Stock, Cart Value
  - Action buttons: Open Shopping Links, Import Shopping, Meal Plan -> Cart, Taste Profile, Target Macros
  - Modals: Target Macros (protein/carbs/fats inputs, calories auto-calc via 4-4-9), Taste Profile (freeform textarea), Liquid Log (name, amount, calories, refill checkbox — writes to `liquidtrack_events` with `device_id='manual'`, `weight_before=0`, `weight_after=0`; refill sets `is_refill=true`)
  - Recent New Items (inline-editable latest scans)
  - Consumed items list + planned items preview (meal-prep excluded)
  - TempItemForm for logging off-inventory meals
- Components: `ScannerModeSelector`, `TransactionQueue`, `NutritionEditor`, `MacroCard`, `TempItemForm`

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/chefbyte/ScannerModeSelector.test.tsx`

- Mode selection updates parent state via callback
- Purchase mode selected -> shows nutrition editor (renders editor slot)
- Consume+Macros mode -> hides nutrition editor
- Consume-NoMacros mode -> hides nutrition editor
- Add to Shopping mode -> hides nutrition editor
- Active mode button visually distinguished (aria-pressed)

### Unit: `apps/web/src/__tests__/unit/chefbyte/TransactionQueue.test.tsx`

- Red border on items with `status='new'`
- Green border on items with `status='success'`
- Orange border on items with `status='pending'`
- Each item displays product name and transaction details
- Undo button calls onUndo callback with correct item ID
- Delete button calls onDelete callback with correct item ID
- Filter "All" shows all items; filter "New" shows only red items

### Unit: `apps/web/src/__tests__/unit/chefbyte/NutritionEditor.test.tsx`

- Edit calories -> macros scale proportionally (maintaining ratios)
- Edit protein -> calories recalculate via 4-4-9 (protein*4 + carbs*4 + fats\*9)
- Edit carbs -> calories recalculate via 4-4-9
- Edit fats -> calories recalculate via 4-4-9
- servings_per_container adjustment updates display
- Non-numeric input rejected (validation error shown)
- Negative values rejected

### Unit: `apps/web/src/__tests__/unit/chefbyte/MacroCard.test.tsx`

- Progress bar width = (consumed / goal) \* 100 percent
- Consumed and goal labels rendered correctly
- Bar color changes when consumed > goal (over-target state)
- Zero goal renders 0% width (no division by zero)

### Unit: `apps/web/src/__tests__/unit/chefbyte/TempItemForm.test.tsx`

- Name field required: submit with empty name -> validation error
- Macro inputs reject non-numeric values
- Calories auto-calculate via 4-4-9 when macros entered
- Submit with valid data calls onLog callback with name + macros
- Cancel button calls onCancel and closes form
- Protein/carbs/fats default to 0

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/chefbyte-vercel/apps/web/src/pages/Scanner.tsx` — 4-mode scanner layout, queue rendering
- `legacy/chefbyte-vercel/apps/web/src/pages/Home.tsx` — dashboard macro cards, status badges, modals
- `legacy/chefbyte-vercel/apps/web/src/hooks/useScannerDetection.ts` — barcode input detection
- `legacy/chefbyte-vercel/apps/web/src/lib/api-supabase.ts` — Supabase query patterns

## Commit

`feat: chefbyte UI — scanner + dashboard`

## Acceptance

- [ ] ChefByte layout shell with working top nav renders all routes
- [ ] Scanner page renders two-column layout with mode selector, keypad, queue
- [ ] Purchase mode shows nutrition editor; other modes hide it
- [ ] Dashboard shows macro cards, status badges, action buttons, modals
- [ ] Liquid Log writes to liquidtrack_events with device_id='manual'
- [ ] TempItemForm validates inputs and logs temp items
- [ ] All unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/chefbyte/ScannerModeSelector src/__tests__/unit/chefbyte/TransactionQueue src/__tests__/unit/chefbyte/NutritionEditor src/__tests__/unit/chefbyte/MacroCard src/__tests__/unit/chefbyte/TempItemForm`
- [ ] `pnpm typecheck` passes
