# UX Audit Round 2 — ChefByte Web (Meal Plan + Macros + Shopping + Walmart)

Note: dev server was not running during this pass (curl localhost:5173 → connection refused). Findings are from code review of the post-`a15f6dd` / post-`24c689d` state of `apps/web/src/pages/chefbyte/{HomePage,MacroPage,MealPlanPage,ShoppingPage}.tsx`, `components/chefbyte/WalmartTab.tsx`, `components/shared/MacroProgressBar.tsx`, the two new migrations (`20260429040000`, `20260429050000`, plus the `20260429070000` chefbyte wrapper from the hot-fix), and `supabase/functions/walmart-scrape/index.ts`.

## What changed since round 1

Ten round-1 findings landed correctly. The over-100% MacroProgressBar work (`MacroProgressBar.tsx:39-90`) shows raw % in the label and a "+N%" red chip + 1px red sliver on the right edge when `overflow > 0`; HomePage's `ProgressBar` (`HomePage.tsx:875-949`) does the same and additionally swaps the percentage text color to red on overflow — nicer signal than MacroPage. `formatDayWindow` (`HomePage.tsx:187-196`) is correct for `dayStartHour ∈ {0..23}`. Mark-done is now optimistic on both `MealPlanPage.tsx:409-436` and `HomePage.tsx:660-687` with rollback. The "vs goal" row on `MealPlanPage.tsx:992-1031` reads from a separately-cached `user_config_goals` query (`MealPlanPage.tsx:224-246`, 5-min staleTime). The `Auto-Add Below Min Stock` billboard collapsed to a small button (`ShoppingPage.tsx:521-528`). 44px touch targets via `<label>` wrappers around 28px checkboxes (`ShoppingPage.tsx:611-629`, `676-689`). Native `alert()` is gone (`ShoppingPage.tsx:478-489`). The new `update_food_log_qty` and `update_temp_item_qty` RPCs (`migrations/20260429050000_update_food_log_qty.sql:21-215`) preserve event overrides via macro-scaling. Walmart quota lives in `chefbyte.walmart_quota` (`migrations/20260429040000_walmart_scrape_quota.sql:23-31`) with the chefbyte wrapper added in the `24c689d` hot-fix.

## Per-flow

### Plan tomorrow's meals — MealPlanPage

The new `vs goal` row (`MealPlanPage.tsx:992-1031`) is the round 1 winner. Findings:

- **Sign convention is unintuitive.** `fmt` at `MealPlanPage.tsx:1008-1018`: `delta = goal - consumed`, so a day under the calorie goal renders `-N cal` in green and a day over renders `+N cal` in red. That's backwards from how every fitness app on the planet shows it: under-budget should read `-` (you have headroom), over should read `+` (over the line). Also the colors invert the text in a non-obvious way — green minus on protein at `protein_consumed=120, goal=180` reads "you're 60g short of protein" but the green "-60g P" looks like "60g protein remaining = good." Fine for calories; misleading for macros where Jeremy wants to _hit_ the protein number, not stay under it.
- **Goals row only renders when `goals` query resolves** (`MealPlanPage.tsx:996`). On a slow-network first paint or when the user has zero `goal_*` rows in `user_config`, the query returns `DEFAULT_MACRO_GOALS` (`MealPlanPage.tsx:237-243`) — the row will render with defaults that may not match the macro-page goal modal. Audit-mismatch: HomePage uses `DEFAULT_MACRO_GOALS` with the same fallback at `HomePage.tsx:837`, so they agree, but the MealPlan vs-goal row will show "vs default goals" silently if the user hasn't set targets yet. No "set your goals" CTA inline.
- **Goals row totals across BOTH meal_prep and regular meals** because `dayTotals` at `MealPlanPage.tsx:670-683` iterates `selectedDayMeals` indiscriminately. So a Sunday with 14 servings of meal-prepped chicken (intended to feed Mon-Fri lunches) shows "vs goal: -2400 cal" red — false alarm. Should likely exclude `meal_prep === true && completed_at === null` rows or compute servings/day. This is a regression-shaped finding because the round-1 fix introduced the comparison without considering the prep-vs-eat distinction.

### Log eating — Mark Done

Optimistic mark-done is correct (matching pattern on both pages). Findings:

- **`formatStockShortfallMessage` is imported by `MealPlanPage` from `HomePage`** (`MealPlanPage.tsx:11`). That's an inappropriate cross-page import — `HomePage.tsx` is a route component, not a shared module. If HomePage gets code-split lazily, MealPlanPage's bundle now drags in HomePage. Move to `apps/web/src/shared/`.
- **Stock-shortfall copy is identical regardless of meal_prep state.** Mark Done on a meal*prep entry → "Add the missing item to your shopping list" — but for meal_prep the user \_intends* to make multiple servings; "shopping list" is appropriate, but the message doesn't acknowledge that the prep itself failed mid-execute. (Compare to `executePrepMeal` at `HomePage.tsx:714-717` which doesn't differentiate either.)
- **Optimistic update doesn't seed `food_logs` rows or decrement `stockByProduct`.** `MealPlanPage.tsx:417-427` flips `completed_at` only. Mark Done on Today → "consumed today" section on HomePage stays empty for ~300ms until `onSettled` re-fetches. The stock badge on the meal entry (`HomePage.tsx:1205-1212`) stays "CAN MAKE" even though we just deducted. Visually a partial optimism — the badge implies "still have stock" right after we just spent it.
- **Two-click `DeleteBtn` cross-row collision (R1 flag) is unfixed.** `confirmDeleteId` at `MealPlanPage.tsx:157` is a single string. Click trash on row A → `confirmDeleteId='meal-A'`. Click trash on row B → `handleDelete` sees `confirmDeleteId !== 'meal-B'`, sets it to `'meal-B'` (`MealPlanPage.tsx:633-647`). Row A's button silently flips back from "You sure?" to "Delete" mid-glance. Same pattern in HomePage. Subtle but real.

### View today's macros — Inline qty edit

This is the headline new feature. Walking through it:

- **Inline edit has 28px height for the row buttons** (`MacroPage.tsx:735, 743`: `min-h-[28px]`). 28px < 44px touch target. Round 1 fixed checkboxes on shopping but missed these. On a 375px-wide phone that's one finger-tap target inside a 44px gesture column — repeat misses are likely.
- **Edit affordance only on MacroPage** (audit FLAGS confirmed). HomePage `Consumed Today` (`HomePage.tsx:1339-1450`) and MealPlanPage `Consumed` (`MealPlanPage.tsx:1037-1108`) still show only delete. Cross-page friction: user opens HomePage at lunch, sees a wrong qty, has to navigate to `/chef/macros` to fix it.
- **Temp-item edit interprets the field as raw calories**, scaling everything else by `newQty / item.calories` (`MacroPage.tsx:355-363`). That's an indirect mental model — a user thinks "I logged 200 cal but it should be 300" so types `300`, but anyone who logs by serving count first will type `2` (intending "2 of these snacks") and the macro-row drops to a third of original. The label `Calories (scales protein/carbs/fat)` at `MacroPage.tsx:666` partly mitigates but the field is the same numeric input as for meal-plan items where the same number means qty. Mode-switching field with mode-dependent semantics. Confusing.
- **Optimistic update only scales the row's macros** (`MacroPage.tsx:378-392`). The summary `MacroProgressBar` reads from `consumedTotals = macros?.consumed` (`MacroPage.tsx:543`), which is sourced from the `get_daily_macros` RPC — that field is NOT updated by the optimistic patch. So the per-row macros animate instantly but the top-of-page progress bars don't budge until the `onSettled` invalidation refetches. The audit success criterion — "Does it round-trip update macros live?" — is a partial pass: the cell totals row updates instantly (`MacroPage.tsx:766-770`), the progress bars don't.
- **`commitEditQty` validates `parsed > 0`** (`MacroPage.tsx:417-422`) but doesn't validate against an upper bound. Typing `999999` succeeds and creates a wildly inflated macros row optimistically before the RPC's `NUMERIC(10,3)` storage potentially overflows. Edge case; defer.
- **Mobile (375px wide) layout for the edit form**: Edit/Delete column has `shrink-0` (`MacroPage.tsx:733`) — good. But the `flex-wrap` on the input row (`MacroPage.tsx:698`) means on small phones the Save/Cancel buttons drop below the input, the row grows to ~110px tall, and the user has to scroll past it to see the next consumed item. Not broken, but wastes vertical space.

### Shopping list

- **The 44px touch wrapper works**, but the `Remove` button (`ShoppingPage.tsx:634-640`) is still tiny (`px-3 py-1`, ~30px tall). On phone-side toggle-while-walking the user can hit it by accident next to the checkbox.
- **No success feedback after `Import to Inventory`** (audit FLAGS #31 — toast system not built yet). The button click → empty Purchased section → no signal. Critical 3-second window where the user wonders if it worked. The RPC returns `lots_processed` (per round-1 audit migration line 132-136) and it's discarded.
- **`autoAddBelowMinStock` reset of purchased=true rows is unfixed** (R1 FLAG #29). The upsert at `ShoppingPage.tsx:404-406` resets `imported_at: null, purchased: false` — clicking Auto-Add now silently un-checks any existing purchased row that happens to also be below-min-stock. Real bug, deferred per FLAGS doc.
- **`autoAddBelowMinStock` no toast after action** — the user clicks the button, items appear in the To Buy section, but if the user has the section scrolled out of view there's no signal at all. Same toast-system gap.

### Walmart price manager — quota counter

Quota chip is at `WalmartTab.tsx:539-550`. Findings:

- **Counter is invisible until the first call.** `quotaUsed === null` displays `—` (`WalmartTab.tsx:549`). On page load, the chip shows "— today" with no context. The user with 2/100 used today won't see it until they click "Load Next 5". `loadData` (`WalmartTab.tsx:81-106`) doesn't read the quota row even though the RLS policy at `migrations/20260429040000_walmart_scrape_quota.sql:36-39` permits the user to SELECT it. Should hydrate on mount: `chefbyte().from('walmart_quota').select('*').single()`.
- **Buttons disable but the chip doesn't say "0 remaining" prominently.** When `quotaExceeded` flips, the chip turns red (`bg-danger-subtle`), buttons disable (`WalmartTab.tsx:569, 739`), but the chip text "100 / 100 today" requires the user to do the subtraction. A more direct "Quota exhausted — resets at midnight UTC" message in or near the chip would be louder.
- **The 429 error is recoverable but unintuitive.** `handleQuotaResponse` (`WalmartTab.tsx:121-137`) sets `error` to "Walmart search quota for today is full" and `quotaExceeded = true`, but the bulk-loop break at `WalmartTab.tsx:366, 472` short-circuits silently. After a 60-product `Find Missing Prices` loop hits the 429 at item 35, the user sees: progress freezes mid-loop, an error banner appears, 25 products were never tried. There's no "35/60 done — try again tomorrow for the rest" summary nor a "save what we have" action. The mid-loop quota exhaustion needs better feedback.
- **`quota_exceeded` from the edge fn is the only signal that matters; `fnError` may not contain it on a transport failure.** `handleQuotaResponse` checks `data?.quota_exceeded || /quota exceeded/i.test(fnError?.message)`. If supabase-js wraps the 429 as a `FunctionsHttpError` without that string, the check could miss. Defensive — the 429 status itself should be matched if available.
- **The chip is in the WalmartTab header only.** A user navigating to ShoppingPage who clicked "Open in Walmart" doesn't see the quota counter. If they're about to do a 200-product refresh batch they should know upfront — surface the count somewhere on the dashboard or inside the Walmart cart-modal copy.

## Cross-cutting

- **Walmart wrapper migration is `20260429070000` but `20260429060000` doesn't exist** in the audited tree. Just an ordering oddity — the hot-fix slotted in after the `mark_meal_done_atomic` and `update_food_log_qty` migrations. Worth a sanity check that all five migrations apply in the right order on a fresh DB.
- **`mutationError` and `loadError` are still rendered as plaintext at the top of the page** on every page (e.g. `MacroPage.tsx:563-567`, `HomePage.tsx:984-993`). No auto-dismiss, no toast, no actionability. Round 1 didn't tackle this and the audit FLAGS doc explicitly defers it.
- **Cross-page consistency is still mostly good.** Mark Done on MealPlanPage → MacroPage's progress bars update via `useRealtimeInvalidation` on `food_logs` (`MacroPage.tsx:260-271`). Inventory page also subscribes to `stock_lots` (`InventoryPage.tsx:515-516`). The chain works; only the optimistic UI on the originating page is incomplete (see "log eating" above).
- **Duplicate "Edit Targets / Taste Profile" buttons remain on both MacroPage (`MacroPage.tsx:843-865`) and HomePage (`HomePage.tsx:1135-1147`).** Per FLAGS doc, deferred as a product call.
- **Migrations not applied yet** (FLAGS doc line 48). Code references `update_food_log_qty` and `walmart_check_and_increment` RPCs that need to land in DB before this batch works in production. Verification in a deployed env requires those migrations run first.

## Things working better than R1

- The over-100% chip + raw-percentage label on HomePage's compact progress bars (`HomePage.tsx:902-917`) is genuinely cleaner than the round-1 audit's suggestion of "render full-width red bar + chip" — the percentage flipping red is a lighter visual that still reads at a glance.
- The dynamic day-window label (`HomePage.tsx:1003-1006`, `formatDayWindow`) handles edge cases correctly (midnight, noon).
- The atomic quota RPC with `FOR UPDATE` lock + UTC-day reset (`migrations/20260429040000_walmart_scrape_quota.sql:67-100`) is shaped right — won't race under concurrent `Refresh All Prices` clicks across tabs.
- The mark-done optimistic rollback path in MealPlanPage and HomePage is consistent (same pattern, same `context.previous` shape).

## Top 5 R2 follow-ups

1. **Fix the vs-goal row sign convention and prep-exclusion.** Sign should mirror "calories remaining" idiom; meal_prep entries shouldn't count toward the day's "vs goal" since they feed multiple days. (`MealPlanPage.tsx:670-683, 1006-1018`).
2. **Hydrate quota chip on WalmartTab mount.** Read `chefbyte.walmart_quota` row in `loadData` so the user sees the counter without clicking. (`WalmartTab.tsx:81-106`).
3. **Wire `update_food_log_qty` into HomePage `Consumed Today` + MealPlanPage `Consumed`** — the RPC exists, only UI work. Avoids cross-page friction.
4. **Update `formatStockShortfallMessage` import path** (move to `apps/web/src/shared/`). Cross-route imports are a code-splitting smell.
5. **Make 429 mid-loop exhaustion show a "X/Y completed, try again tomorrow" summary** instead of silently breaking. (`WalmartTab.tsx:366, 472`).
