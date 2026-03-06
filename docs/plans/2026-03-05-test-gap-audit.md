# Test Gap Audit — 2026-03-05

Full deep audit across 6 areas. Prioritized by severity (CRITICAL = shipped-bug class, HIGH = untested feature, MEDIUM = edge case).

## CRITICAL Gaps (17)

### Scanner & Edge Functions (3)

1. **Scanner OFF fallback path** — suggestion=null + OFF nutriments present → creates product from raw data. THE BUG. Zero tests.
2. **Scanner AI suggestion path** — entire analyzed-product-creation flow via `supabase.functions.invoke` untested. No mock, no E2E.
3. **analyze-product response shape** — No test asserts `{source: 'ai', suggestion: null, off: {nutriments: ...}}` when ANTHROPIC_API_KEY missing.

### ChefByte Pages (5)

4. **Two-click delete pattern** — Untested on HomePage (consumed items + meals) and MealPlanPage (meals + consumed items). 4 locations, 0 tests.
5. **Consumed items display** — food_logs + temp_items rendering untested on both HomePage and MealPlanPage.
6. **Zero-stock filtering** — InventoryPage `filteredGrouped` filter for `totalStock > 0` untested.
7. **Undo mark meal done** — `unmark_meal_done` RPC call from UI untested.
8. **Consume all stock** — window.confirm flow on InventoryPage untested.

### MCP Tools (5)

9. **updateProduct** — Zero tests. All update paths missing.
10. **deleteShoppingItem** — Zero tests.
11. **togglePurchased** — Zero tests.
12. **importShoppingToInventory** — Zero tests. Complex multi-step operation.
13. **deleteMealEntry** — Zero tests.

### Hub & Auth (2)

14. **ResetPassword.tsx** — Entire page has zero test coverage at any layer (7 code paths).
15. **ActivationGuard redirect** — "app not activated → redirect to /hub/apps" never explicitly tested.

### CoachByte (2)

16. **TodayPage load error state** — No test for `ensure_daily_plan` failure with retry button.
17. **SplitPage relative load % toggle** — Rel% checkbox never tested.

## HIGH Gaps (23)

### Scanner (4)

18. Edge function returns error (efError truthy) → placeholder fallback untested.
19. analyze-product CORS preflight (OPTIONS) untested.
20. analyze-product method not allowed (GET/PUT → 405) untested.
21. Scanner top-level error handler (queue item → error status) untested.

### MCP Tools (4)

22. **pauseTimer** — Zero tests.
23. **resumeTimer** — Zero tests.
24. **resetTimer** — Zero tests.
25. **getExercises** — Zero tests.

### ChefByte Pages (6)

26. Meal prep execute confirmation (two-step flow) untested.
27. Recipe threshold editing (protein/carbs density) + localStorage persistence untested.
28. [MEAL] product exclusion in SettingsPage untested.
29. Location delete blocking when stock_lots exist untested.
30. Consume by serving unit path untested.
31. Stock badge color function untested.

### CoachByte (5)

32. "First record!" PR toast branch untested (only "NEW PR!" tested).
33. History toggle collapse (click Hide) untested.
34. History detail empty state (0 completed sets) untested.
35. PRs filtered cards after removing tracked exercise untested.
36. Settings toggle plate checkbox + persistence untested.

### Hub (4)

37. OfflineIndicator.tsx — zero test coverage.
38. Login: forgot password form submission untested.
39. Login: demo login failure ("Demo account unavailable") untested.
40. Login: `reset_demo_dates` RPC call untested.

## MEDIUM Gaps (30+)

### DB Functions

- consume_product: zero qty, NULL-expiry ordering, NULL macros
- mark_meal_done: product-based meal prep, no-storage-locations exception
- get_daily_macros: negative remaining (over-consumed)
- complete_next_set: negative reps, zero load (bodyweight)
- get_logical_date: DST transitions

### RLS

- 14 tables without dedicated RLS test files (daily_plans, planned_sets, completed_sets, splits, user_settings, locations, recipes, recipe_ingredients, meal_plan_entries, food_logs, temp_items, shopping_list, liquidtrack_devices/events, user_config)

### UI Edge Cases

- Keypad: double-decimal prevention, decimal with overwriteNext, backspace to '0'
- Unit toggle container→serving reverse conversion
- CoachByte: confirm timeout auto-dismiss, Realtime subscriptions, isEditingRef
- Hub: loading spinners across all pages, error states, form validation gaps
- E2E: ~20 waitForTimeout calls that are flaky risks

## Implementation Priority

**Phase 1 — Fix the bug class** (items 1-3): Scanner integration tests with mocked edge function responses.
**Phase 2 — Untested MCP tools** (items 9-13, 22-25): 9 tool handlers need tests.
**Phase 3 — Untested UI features** (items 4-8): Two-click delete, consumed items, zero-stock, undo.
**Phase 4 — Auth gaps** (items 14-15): ResetPassword, ActivationGuard.
**Phase 5 — CoachByte & remaining HIGH** (items 16-17, 32-40): Various UI paths.
**Phase 6 — MEDIUM gaps**: DB edge cases, RLS tests, UI edge cases.
