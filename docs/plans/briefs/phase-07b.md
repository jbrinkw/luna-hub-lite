# Phase 07b: ChefByte UI — Inventory + Shopping + Meal Plan

> Previous: phase-07a.md | Next: phase-07c.md

## Skills

test-driven-development, test-quality-review, frontend-design, context7 (Ionic React, Supabase Realtime)

## Build

- `apps/web/src/pages/chefbyte/Inventory.tsx`:
  - Grouped-by-product table: Product (name + barcode + servings/container), Stock Total, Nearest Expiry, Lots count, Min, Actions
  - Actions: +1/-1 container, +S/-S serving, Consume All (with confirmation) — all stock-only, never log macros
  - Toggle to lot view: per-lot qty, location, expiration
  - Mobile: card layout with same grouped/lot toggle
- `apps/web/src/pages/chefbyte/ShoppingList.tsx`:
  - Add item form (name + amount + add button)
  - Two sections: "To Buy" (unchecked, with remove button) and "Purchased" (checked, struck-through)
  - "Add Checked to Inventory" bulk action on Purchased section
  - Header button: "Auto-Add Below Min Stock"
- `apps/web/src/pages/chefbyte/MealPlan.tsx`:
  - 7-day week grid with day cards
  - Each day card: meal entries with recipe/product name, servings, macro summary
  - Navigation: Previous Week / Today / Next Week
  - Add Meal modal with recipe/product search
  - Day detail table: entry, mode (regular/prep), status, actions
  - Mark Done button for regular entries; [PREP] execute confirmation for meal-prep entries
- Components: `InventoryGroup`, `ShoppingListItem`, `MealPlanDayCard`
- Realtime subscriptions: macro totals refresh, meal plan status changes, food_log/temp_item changes

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/chefbyte/InventoryGroup.test.tsx`

- Grouped-by-product rendering shows product name + total stock + nearest expiry + lot count
- Expand button reveals individual lot rows with qty, location, expiration
- +1 container button calls onAdjust with (product_id, +1, 'containers')
- -1 container button calls onAdjust with (product_id, -1, 'containers')
- +S button calls onAdjust with (product_id, +1, 'servings')
- -S button calls onAdjust with (product_id, -1, 'servings')
- Consume All button shows confirmation dialog before calling callback
- Stock displayed to 1 decimal place

### Unit: `apps/web/src/__tests__/unit/chefbyte/ShoppingListItem.test.tsx`

- Displays product name and quantity
- Checkbox toggles purchased state via callback
- Remove button calls onRemove with item ID
- Purchased items render with strikethrough text
- Placeholder products show placeholder badge
- Unpurchased items show no strikethrough

### Unit: `apps/web/src/__tests__/unit/chefbyte/MealPlanDayCard.test.tsx`

- Renders meal entries with recipe/product name + servings count
- Shows macro summary (calories, protein, carbs, fats) for the day
- Mark Done button calls onMarkDone with meal_id for regular entries
- [PREP] button calls onExecutePrep with meal_id for meal-prep entries
- Empty day card shows "No meals planned" message
- Status badge: planned/done/prepped

### Integration: `apps/web/src/__tests__/integration/chefbyte/realtime-subscriptions.test.ts`

- Subscribe to food_log channel -> insert food_log row -> callback fires with new row
- Subscribe to temp_items channel -> insert temp_item -> callback fires
- Subscribe to meal_plan channel -> update status to 'done' -> callback fires with updated row
- Unsubscribe -> insert row -> callback does NOT fire

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/chefbyte-vercel/apps/web/src/pages/Inventory.tsx` — grouped-by-product table, lot toggle, stock adjustments
- `legacy/chefbyte-vercel/apps/web/src/pages/ShoppingList.tsx` — add/check/import flow, below-min-stock button
- `legacy/chefbyte-vercel/apps/web/src/pages/MealPlan.tsx` — day grid, execute meals, prep confirmation
- `legacy/chefbyte-vercel/apps/web/src/lib/api-supabase.ts` — Supabase Realtime subscription patterns

## Commit

`feat: chefbyte UI — inventory + shopping + meal plan`

## Acceptance

- [ ] Inventory page renders grouped-by-product with lot toggle, stock adjustments are stock-only
- [ ] Shopping list page has To Buy / Purchased sections, bulk import, below-min-stock button
- [ ] Meal plan page renders 7-day grid with week navigation, Add Meal modal, Mark Done + [PREP] actions
- [ ] Realtime subscriptions update UI on food_log, temp_item, and meal_plan changes
- [ ] All unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/chefbyte/InventoryGroup src/__tests__/unit/chefbyte/ShoppingListItem src/__tests__/unit/chefbyte/MealPlanDayCard`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte/realtime-subscriptions`
- [ ] `pnpm typecheck` passes
