# UX_AUDIT_CHEFBYTE_USE — Flagged (deferred) findings

Items from `UX_AUDIT_CHEFBYTE_USE.md` that were intentionally NOT implemented in this batch. Each entry says why and what would be needed to land it.

## Plan tomorrow's meals

- **Pre-fill meal type from time of day** (line 21–22 of audit). Trivial UI logic but lives inside the `Add Meal` modal, which is intertwined with `RecipesPage` (sibling agent's scope via `computeRecipeMacros` import). Skipping to avoid touching shared search state. Touch points: `MealPlanPage.tsx:openAddModal`. Flag for follow-up.
- **Memoize `entryMacros` per meal_id** (line 24). Requires a `useMemo` keyed on the meal row, low impact at current data sizes. Defer.
- **"Copy yesterday's meals" / "Duplicate meal" / drag-and-drop** — multi-day product work, not a 1-line audit fix. Out of scope.
- **Per-day macro mini-bars on the week strip** — rendering 7 cells × 4 macros each is a real design exercise; the simpler "vs goal" row landed instead.
- **Search fuzzy-match (typo "checkn" → chicken)** — would require a Postgres `pg_trgm` index migration and a new RPC. Out of scope of this UX batch.

## Log eating

- **"Mark done with override" for stock-short meals** — the audit's most-actionable suggestion was already partially addressed: the wrapper now reads "add the missing item to your shopping list, then try again". A real "override and deduct anyway" would require an extra `mark_meal_done` parameter (`p_allow_short_stock`) and is a larger product call — flag.
- **Toast surfacing the actual stock change ("Marked done. Deducted 1.5 containers of chicken from Fridge.")** — needs a toast component (none exists yet) plus a structured payload from `mark_meal_done` (already returns `deducted: [...]`). Building a toast system is a separate task. Flag.
- **"Log partial" flow** (ate half a meal) — would require a new RPC variant of `mark_meal_done` that scales servings. Significant scope. Flag.
- **Two-click delete confusion when clicking trash on row A then row B** — UI fix but requires per-row state pull-up; defer.

## View today's macros

- **"Remaining" inline tile next to consumed totals** — straightforward but adds visual noise; defer pending design pass.
- **4-4-9 calorie validation indicator on logged temp items** — would require comparing `protein*4 + carbs*4 + fat*9` to `calories` per row and rendering a soft warning. Defer.
- **Day-of-week badge consistency on MacroPage date display** — minor; defer.
- **De-dup the "Edit Targets / Taste Profile" buttons that appear on both HomePage and MacroPage** — product call, not a bug. Flag.

## Shopping list

- **Per-row Walmart prices + section subtotal** — the audit's #4 high-impact item. Requires hydrating `products.price` into the row (already in the join) and rendering it; behaviorally simple but visually a small redesign. Flag for follow-up — explicitly called out as a feedback-loop win. The fix in this batch leaves the price column blank.
- **Group purchased history view, aisle/location grouping** — net-new features, not fixes. Out of scope.
- **Success toast after "Import to Inventory" with `lots_processed` count** — needs the toast component (see above). Flag.
- **"Import only checked items" affordance** — net-new feature.
- **Auto-Add upsert reset of purchased=true rows to unpurchased** — real bug per audit (line 92–93). Touches the same `autoAddBelowMinStock` flow. Defer to a focused fix; intentional reset is currently the documented behavior in the page comment, so flipping it without spec input could break existing user mental model.

## Walmart price manager

- **Cancel button + AbortController on bulk loops** — meaningful fix; defer because it interacts with the brand-new quota path (the cancel must NOT release a quota slot since the call already counted). Flag.
- **Chunked parallelism (5-at-a-time)** — would speed up the loops 10× but adds complexity around quota-exhaustion mid-chunk. Defer.
- **`cleanWalmartUrl` silently strips query params** — design intent is unclear (might be deliberate to avoid affiliate-tagging issues). Flag for product input.
- **"Auto-link" mode using top SerpAPI result for clean barcode matches** — net-new feature.
- **"Stale prices" indicator (last refreshed > 30 days)** — requires a `price_updated_at` column. Flag.
- **Half-saved batch on `completeUpdates` partial failure** — real correctness issue but fixing it well needs either a single batched RPC or per-row status indicators. Flag.

## Cross-cutting

- **Toast/notification system** — the audit references it repeatedly (success toasts on import, mark-done, etc.). No such component exists in `components/shared/`. Building one cleanly with React + Tailwind + a-11y is a focused mini-project on its own. **Highest-leverage follow-up.**
- **Day-cell mini-bars on the week strip** — see above.
- **Migration apply** — the two new migrations (`20260429040000_walmart_scrape_quota.sql`, `20260429050000_update_food_log_qty.sql`) are committed but not yet pushed/applied. Apply via `supabase db push` and regenerate `db-types` when the next migration window opens.
- **Edit qty on logged items — wired only on MacroPage**, not on the `Consumed Today` section of `HomePage` or `Consumed` section of `MealPlanPage`. The RPC is shared so wiring those is purely UI work; deferred to keep this PR scoped. Flag.
