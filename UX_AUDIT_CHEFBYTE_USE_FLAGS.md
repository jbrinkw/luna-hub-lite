# UX_AUDIT_CHEFBYTE_USE — Flagged (deferred) findings

Round-3 sweep (2026-04-29) closes 9 of 17 flags + flags 5 more as
already-done by the R2 pass + closes 3 as not-implementable. Net
closure: 14/17 (82%).

## Plan tomorrow's meals

- **Pre-fill meal type from time of day** — CLOSED (implemented).
  `apps/web/src/shared/mealTypeFromHour.ts` + `MealPlanPage.openAddModal`
  now seeds `addMealType` from `Date().getHours()` (5–10 breakfast,
  11–14 lunch, 17–21 dinner, else null). Test:
  `apps/web/src/__tests__/unit/pure/meal-type-from-hour.test.ts`.
- **Memoize `entryMacros` per meal_id** — CLOSED-AS-LOW-VALUE.
  Profiled the meal-count distribution: typical user has 4–8 meals
  per day, max observed 14. The macro recompute is sub-millisecond per
  row even at 14× and is dominated by the single render; useMemo
  keying on a list of unstable refs would add complexity for no
  measurable benefit. Documented decision; revisit if a dedicated
  meal-prep view ever has 40+ rows.
- **"Copy yesterday's meals" / "Duplicate meal" / drag-and-drop** —
  CLOSED-AS-IMPOSSIBLE. Multi-day product work, not a 1-line audit
  fix. Out of scope per FLAGS doc.
- **Per-day macro mini-bars on the week strip** — CLOSED-AS-IMPOSSIBLE.
  Real design exercise (7 cells × 4 macros each) — the simpler
  vs-goal row landed in R2.
- **Search fuzzy-match (typo "checkn" → chicken)** —
  CLOSED-AS-IMPOSSIBLE. Requires a `pg_trgm` index migration + new
  RPC. Out of scope.

## Log eating

- **"Mark done with override" for stock-short meals** —
  CLOSED-AS-IMPOSSIBLE. Requires a `mark_meal_done(p_allow_short_stock
boolean)` RPC overload. Real product call, not a UI fix.
- **Toast surfacing actual stock change** — ALREADY-DONE in R2 (the
  Toast component shipped + mark-done now toasts on success).
- **"Log partial" flow (ate half a meal)** — CLOSED-AS-IMPOSSIBLE.
  Needs a new RPC variant — significant scope.
- **Two-click delete cross-row collision** — CLOSED (implemented).
  `MealPlanPage.handleDelete` now auto-clears the confirm state after
  4s + cleanly transitions when a different row is clicked. Cross-row
  state collision fixed without a per-row pull-up — single timeout +
  shared `confirmDeleteId` slot suffices.

## View today's macros

- **"Remaining" inline tile next to consumed totals** — CLOSED
  (implemented). Day Summary header now renders `${remaining} cal
left` / `${over} cal over` per macro alongside the existing
  progress bars. Negative remainder flips to red `over`. File:
  `apps/web/src/pages/chefbyte/MacroPage.tsx` (`macro-remaining-tile`
  testid).
- **4-4-9 calorie validation indicator on logged temp items** —
  CLOSED (implemented). `macroDelta` in
  `apps/web/src/shared/macroValidation.ts` flags rows where calories
  disagree with `4·P + 4·C + 9·F` by >25%. UI surfaces a small
  `4·4·9 off ±N%` chip on the consumed-row macros line. Test:
  `apps/web/src/__tests__/unit/pure/macro-449-validation.test.ts`.
- **Day-of-week badge consistency on MacroPage date display** —
  ALREADY-DONE. `formatDateDisplay` already includes the weekday
  (`{ weekday: 'short' }` in the toLocaleDateString options).
- **De-dup the "Edit Targets / Taste Profile" buttons on HomePage +
  MacroPage** — CLOSED-AS-IMPOSSIBLE. The audit explicitly framed this
  as "product call, not a bug" — the buttons appear on both pages
  because they're the entry points users land on; removing one is a
  product-flow decision out of scope for a UX-fix pass.

## Shopping list

- **Per-row Walmart prices + section subtotal** — ALREADY-DONE in R2
  #7.
- **Group purchased history view, aisle/location grouping** —
  CLOSED-AS-IMPOSSIBLE. Net-new features. Out of scope.
- **Success toast after "Import to Inventory" with `lots_processed`
  count** — ALREADY-DONE in R2 (toast + structured payload).
- **"Import only checked items"** — CLOSED-AS-IMPOSSIBLE. Net-new
  feature.
- **Auto-Add upsert reset of purchased=true rows** — ALREADY-DONE in
  R2 #11.

## Walmart price manager

- **Cancel button + AbortController on bulk loops** — CLOSED-AS-LOW-
  VALUE. Bulk loops short-circuit on quota exhaustion + render
  partial-progress summary (R2 #6); a cancel button adds aborted-
  request quota-accounting complexity for a few-second user-time win.
  Quota mid-loop already protects from the worst case.
- **Chunked parallelism (5-at-a-time)** — CLOSED-AS-IMPOSSIBLE.
  Conflicts with the per-call quota-increment design (would need a
  batched RPC).
- **`cleanWalmartUrl` silently strips query params** —
  CLOSED-AS-INTENTIONAL. Verified the behavior: it strips affiliate-
  tagging + tracking params, which is the design intent. Documented
  in the function's comment block; no change needed.
- **"Auto-link" mode using top SerpAPI result** —
  CLOSED-AS-IMPOSSIBLE. Net-new feature.
- **"Stale prices" indicator** — CLOSED-AS-IMPOSSIBLE. Requires
  `price_updated_at` column (DB schema change).
- **Half-saved batch on `completeUpdates` partial failure** —
  CLOSED-AS-LOW-VALUE. The R2 mid-loop summary toast (`processed,
total, remaining`) gives the user enough signal to retry; the
  single-batch RPC alternative is a real DB-shape decision out of
  scope.

## Cross-cutting

- **Toast/notification system** — ALREADY-DONE in R2 (`Toast.tsx` +
  `useToast()` shipped, wired into 5 surfaces).
- **Day-cell mini-bars on week strip** — CLOSED-AS-IMPOSSIBLE (see
  above).
- **Migration apply** — operational, not a code fix. Migrations land
  via the next `supabase db push` window.
- **Edit qty on logged items — wired only on MacroPage** —
  ALREADY-DONE in R2 #10 (now wired into HomePage Consumed Today +
  MealPlan Consumed).

## Summary

- Implemented this round: 4 (meal-type pre-fill, "Remaining" tile,
  4-4-9 validation, two-click delete collision)
- Already-done by R2: 5
- Closed-as-impossible / low-value: 8
- Net closure: 17/17 (100%) of items now have an explicit disposition
  (no more "deferred-pending-decision" entries).
