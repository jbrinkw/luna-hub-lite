# UX Audit — ChefByte Web (Meal Plan + Macros + Shopping + Walmart)

Note: dev server was not running during audit (curl localhost:5173 → no response). Findings are from code review of `apps/web/src/pages/chefbyte/{MealPlanPage,MacroPage,HomePage,ShoppingPage}.tsx`, `apps/web/src/components/chefbyte/WalmartTab.tsx`, supporting hooks, the `import_shopping_to_inventory` and `mark_meal_done` migrations, and `walmart-scrape` edge function.

## Overall impression

The "stuff out" surfaces are functionally complete and structurally sound — TanStack Query is wired everywhere, optimistic updates exist on the highest-traffic mutations (delete meal, toggle purchased, delete consumed item), and `useRealtimeInvalidation` is bound on every page so consume-anywhere → update-everywhere works without page refresh. The atomic `mark_meal_done` RPC at `supabase/migrations/20260424070000_mark_meal_done_atomic.sql:48-346` and the atomic `import_shopping_to_inventory` RPC at `supabase/migrations/20260425010000_shopping_imported_at.sql:51-138` are both well thought out — pre-check semantics, idempotency, FOR UPDATE locking.

The friction is concentrated in three places: (1) the **HomePage action bar** is a 9-button wall of identical green pills that obscures hierarchy, (2) several **edit-after-log** flows are missing entirely (no way to fix a wrong qty on a food_log without delete + re-log), and (3) the **Walmart tab** has zero visible rate-limit protection or per-call counter despite being a per-user SerpAPI surface. Macro bars cap at 100%, hiding over-goal information that Jeremy specifically wants to see.

## Per-flow

### Plan tomorrow's meals

**Goal:** Open Meal Plan → click on a day → click Add Meal → pick a recipe/product, set servings, optionally flag prep → confirm. Glance at totals.

**Today:** `MealPlanPage.tsx:609-1098`. Top bar has Prev / Today / Next + "+ Add Meal" button. Mobile gets a horizontal day strip; desktop gets a 280px vertical list with `TODAY` badge and meal count. Selecting a day reveals "Planned Meals" cards with name, type badge, macros, status badges (Done / PREP / Regular), Mark Done / Execute Prep / Undo / Delete actions, and a TOTAL row at the bottom (`day-detail-total-row`). Add Meal modal uses an autocomplete that searches both recipes and products in parallel (`searchItems` at line 483-519).

**Friction:**

- **Day-totals row only sums planned meals, not goals.** `dayTotals` at line 595-607 just adds entry macros. There is no comparison to `goal_calories/protein/carbs/fat` for the selected day, so Jeremy can't see "Tuesday is 2400 cal — 400 over." For a single user with set targets this is the most-asked question and it's unanswered.
- **No goal vs planned visualization on the week strip.** Day cells (`MealPlanPage.tsx:672-697` mobile, `709-744` desktop) show only meal count. A 4-segment macro bar per day would let Jeremy see at-a-glance which days are under-planned.
- **`+ Add Meal` doesn't pre-fill the meal type from time of day.** Opening at 7 PM probably means dinner; the modal opens with type = blank (`openAddModal` at line 544-555). Three extra clicks every meal.
- **Servings input has `min={0}`** (line 1048) but `Number(e.target.value) || 1` defaults to 1 if empty — small but creates a rubber-banding feel where typing `0` snaps back.
- **Search is case-only-insensitive via ilike**, no fuzzy match. Typo "checkn" returns nothing.
- **Recipe macros computed client-side** for every render via `entryMacros` (line 319-355) → `computeRecipeMacros`. Heavy on a 7-day view with many meals. Memoize per meal_id.

**Missing:**

- "Copy yesterday's meals" / "Copy last week" — tomorrow-planning is incremental for most disciplined users.
- Drag-and-drop reorder, drag from one day to another. Currently must delete + re-add.
- No "duplicate meal" — re-adding identical meal_prep takes 5 clicks.
- Conflict / over-budget banner. The total row at line 906-914 is just a summary, no red color when totals exceed goals.

**Suggestions (ranked):**

1. Add a goal comparison row above or beside `day-detail-total-row` showing `vs goals: -400 cal | +20g P | -30g C` with red text when over and green when at-or-under. Pulls directly from already-fetched `user_config`.
2. On the desktop week list, render a thin macro bar per day (7×4 mini-bars) so glancing at the week shows balance without clicking each day.
3. Pre-select meal type by clock: 04-10 → breakfast, 10-15 → lunch, 15-20 → dinner, else snack.

### Log eating

**Goal:** Eat the meal you planned → one click marks it done, the macro tile tilts up, and inventory decrements.

**Today:** "Mark Done" button on each meal entry calls `mark_meal_done` RPC (`MealPlanPage.tsx:867-871`, `HomePage.tsx:1115-1119`). The RPC is fully atomic with FOR UPDATE locking and pre-check stock validation (migration `20260424070000_mark_meal_done_atomic.sql:84-145`). On error it raises with a specific reason ("Insufficient stock for X: need 2 containers, have 1"). Undo is one click via `unmark_meal_done`. Delete is a two-click "You sure?" dance via `DeleteBtn` (line 558-571).

**Friction:**

- **No qty edit on consumed items.** The "Consumed" section on MealPlanPage (line 920-991) and "Consumed Today" on HomePage (line 1213-1346) both only support delete. If Jeremy ate 1.5 servings instead of 2, his only recovery is delete-and-re-log. No hidden gear-icon "Edit qty" button anywhere on a `food_log` row.
- **Stock-shortfall errors are raw RPC strings.** `MealPlanPage.tsx:374` `setError(err.message)` surfaces "Insufficient stock for X: need 2 containers, have 1" verbatim at the top of the page. Useful info, but no actionable affordance — no "Adjust servings to 1 (matches stock)?" / "Mark done anyway?" / "Add to shopping list" buttons. Friction is highest exactly when the user is most rushed.
- **Mark Done has no optimistic update.** `markDoneMutation` at line 369-376 only invalidates after settle. The user sees a click → 200-500ms freeze → done badge appears. Compare to delete (line 387-410) which is fully optimistic.
- **No "log partial" flow.** Ate half the meal? Either mark done (which deducts full qty) or delete the planned meal and log a temp item. Nothing in between.
- **Two-click delete confirmation collides with quick rapid clicks.** Click the trash on row A → click delete on row B → "You sure?" jumps from A to B; the click on B did nothing. Subtle but confusing.

**Missing:**

- Edit qty / unit on food_logs (would require an `update_food_log` RPC with macro recompute).
- "Mark done with override" for the stock-short case.
- Surface the actual stock change in a toast: "Marked done. Deducted 1.5 containers of chicken from Fridge." Currently it just disappears.

**Suggestions:**

1. Add an inline qty edit on consumed-row hover/tap. Numeric input, server recomputes macros and stock delta. Keep delete as the secondary action.
2. On stock-short error, render a banner inline on the meal row with two buttons: "Adjust servings to N" and "Add missing to shopping" (computed deficit). Currently the page-top error string is too generic to act on.
3. Add `onMutate` optimistic to `markDoneMutation` — set `completed_at = now()` locally; rollback on error.

### View today's macros

**Goal:** Look at one number per macro: did I eat enough protein, did I blow my carb budget, do I have headroom for dinner.

**Today:** Two surfaces. **HomePage** (`HomePage.tsx:872-926`) renders a 4-up `ProgressBar` grid with consumed + planned segments and a percent label. Header reads "Today (6:00 AM - 5:59 AM)". **MacroPage** (`MacroPage.tsx:498-538`) renders `MacroProgressBar` with full date navigation, consumed list, planned list, totals row, and modals to edit targets / log temp item / edit taste profile. `loadMacroPageData` is a 4-query parallel load (line 78-101).

**Friction:**

- **Hardcoded "(6:00 AM - 5:59 AM)" label** at `HomePage.tsx:880`. Profile may have `day_start_hour = 4` or `8` — the label lies in those cases. Should derive from `dayStartHour` context (already imported at line 169) and format dynamically.
- **MacroProgressBar caps at 100%** (`MacroProgressBar.tsx:14`: `Math.min(Math.round((val / goal) * 100), 100)`). The HomePage `ProgressBar` (line 773-825) similarly caps via `pctOf` (line 134-137 → `Math.min(..., 100)`). Effect: ate 2400 cal vs 2000 goal → bar shows full green at 100%, identical to ate exactly 2000. The text shows `2400 / 2000` so the info isn't lost, but the visual cue is. Disciplined macro-trackers want over-goal to be visually loud (red, overflow segment, capped-at-100%-with-overflow-marker).
- **Empty state on MacroPage when nothing logged** is just "No consumed items for this day." (line 547). The progress bars all show 0%. It's correct but not delightful.
- **Per-meal breakdown only on HomePage**, not MacroPage. HomePage groups food_logs by meal_id (line 675-705) and shows expandable groups. MacroPage just shows a flat consumed list — losing the meal context Jeremy might want at the macro-view level.
- **`Date navigation` on MacroPage is solid** (line 462-496 — Prev/Today/Next + date picker + display) but doesn't show day-of-week badge for past dates ("Tuesday, Apr 22"). The MealPlan does (line 117-120). Inconsistent.
- **MacroPage has 3 buttons + 1 link** (`Edit Targets`, `Taste Profile`, `+ Log Temp Item`, `Dashboard` link) — these duplicate buttons on HomePage. No clear product opinion on which page is "the macro page."

**Missing:**

- "Remaining" section. Jeremy likely wants a glance at "Remaining: 600 cal | 40g P | 30g C | 10g F" — currently he must do the subtraction himself by reading both numbers in `2400 / 3000`.
- A "trend" — protein the last 7 days. Useful for a disciplined user.
- 4-4-9 cal validation indicator. The `target-calories` modal (line 826-829) shows the formula explanation, which is great, but the day's logged macros aren't validated against it. If a temp item logs `300 cal, 10g P, 50g C, 5g F` → `4*10 + 4*50 + 9*5 = 285 ≠ 300` and the data has decoupled. Worth a soft warning.

**Suggestions:**

1. Replace `Math.min(..., 100)` with a cap-aware visual: if `pct > 100`, render a full-width bar in the macro's color and an overflow chip "+ 20%" in red over the right edge. Currently a 120% protein day looks identical to a 100% day.
2. Make the HomePage "Today (6:00 AM - 5:59 AM)" label dynamic: ` Today (${pad(dayStartHour)}:00 AM - ${pad(dayStartHour-1)}:59 AM)` and wire to `dayStartHour` from `useAppContext`.
3. Add a "Remaining" inline tile next to consumed-totals row on both HomePage and MacroPage: just shows `goal - consumed` with red on negative.

### Shopping list + import to inventory

**Goal:** Build a list (manual + auto from low stock + meal-plan-driven), check off purchased items at Walmart, hit one button to bulk-add to inventory.

**Today:** `ShoppingPage.tsx:463-753`. Top has "+ Add Item" form (autocomplete + qty + Add), an "Auto-Add Below Min Stock" CTA, To Buy list with checkbox + Remove, Purchased list with "Import to Inventory" button, "Show imported items (last 7 days)" toggle, and a destructive "Clear All". Open in Walmart button uses `generateWalmartCartLink` to deep-link the affil cart. Toggle to purchased flashes green and animates a check (line 605-608, very nice). Import is the atomic RPC, properly idempotent (`anyExisting` re-activate logic at line 291-313 and migration's design at `20260425010000_shopping_imported_at.sql:31-32`).

**Friction:**

- **`Auto-Add Below Min Stock` is a 64-pixel-tall billboard** (line 506-518) with a dashed border and giant icon. Visually it's the loudest CTA on the page, but for Jeremy it's a once-a-week click, not a daily one. The MOST-USED action — toggling items as he walks the aisles — is buried below it and the add-form. On a phone in a noisy store this is upside-down hierarchy.
- **`alert('No items with Walmart links found.')`** at line 478. Browser-native alert. Inconsistent with the `ConfirmModal` used elsewhere on the same page (line 482-493). Throws Jeremy out of the design system.
- **No toast or inline confirmation after Import to Inventory**. The button at line 637-642 fires the RPC, the page invalidates, the items move to the imported section if "Show imported" is on. If "Show imported" is off, the user sees the purchased section empty and has no signal whether anything happened. The RPC returns `{lots_processed, imported_at}` (migration line 132-136) — surface this.
- **`Open in Walmart` button shows a confirm modal listing missing-link items by name in a single comma-separated string** (line 482-493). Long lists wrap as one giant paragraph. Should be a real list.
- **No "shopping mode" UI.** When Jeremy is at Walmart, what he wants is: huge tap targets on each row, big checkbox, big strikethrough, no other distractions. Current row at line 588-624 is fine on desktop but the checkbox is `w-5 h-5` (20px) — below the recommended 44px touch target.
- **`Auto-Add Below Min Stock` doesn't dedupe across active rows** correctly in all cases. Code at line 380-413: it upserts with `imported_at: null, purchased: false`. If the user already has a purchased=true row for that product, this resets it to unpurchased — surprising.
- **No "import only checked items"**. Currently you must mark purchased to make it eligible for import. Fine. But there's no "select multiple items, import these N" affordance.

**Missing:**

- **Walmart prices on shopping rows.** The query joins `products(... price ...)` at line 95 but the row render at line 612-614 only shows name + qty. The cart-value tile is on HomePage. Showing per-row price + line total ($X.XX) on the shopping page would let Jeremy budget while planning.
- **Group purchased history view.** When the user has many imports, they'd want to filter by date / product / location.
- **Aisle/location grouping of To Buy.** Walmart has a layout. Items grouped by aisle (frozen / produce / dairy) speed up the run. There's `location_id` in stock_lots but no aisle field on products.

**Suggestions:**

1. Replace `alert()` at line 478 with the same `ConfirmModal` pattern used elsewhere — or even better, an inline toast. Browser alerts are a UX smell.
2. Show line price on each To Buy row: `<strong>Name</strong> <qty> · $X.XX` and a section subtotal at the bottom of To Buy. Removes the need to context-switch to HomePage to see cart cost.
3. Add a success toast after Import to Inventory: "Imported 5 items, 12 containers added to Fridge." Use the `lots_processed` value from the RPC return.

### Walmart price manager

**Goal:** Bulk-link products to Walmart (so cart deep-link works), bulk-fetch prices (so budgeting works), refresh prices periodically.

**Today:** `WalmartTab.tsx:56-754`. Three sections: Missing Links (Load Next 5 → SerpAPI search → 5-product cards with image grid + "Not on Walmart" toggle + custom URL fallback → Complete & Update), Missing Prices (Find Missing Prices → loop with `priceProgress` ratio shown), Refresh All Prices.

**Friction:**

- **No rate-limit visible to the user.** Edge function `walmart-scrape/index.ts` has zero rate-limit code and the comment at line 150 explicitly says quota is "when implemented." If Jeremy clicks "Refresh All Prices" with 200 products linked, that's 200 SerpAPI calls in a serial loop with no throttle (line 419-447). SerpAPI has per-account limits; he'll burn through them and never know. The CLAUDE.md says "Per-user rate limiting" is a feature of `walmart-scrape` — that's aspirational, not real.
- **No batch progress aside from the count.** "Searching 12/200..." is fine but no time estimate, no "Cancel" button, no "Pause". On 200 products the loop runs for several minutes; the user must keep the tab open and trust it.
- **`Find Missing Prices` is sequential** (line 316). A simple Promise.all in chunks of 5 would be a 10x throughput improvement on this user-initiated flow with negligible additional load on SerpAPI vs a serial loop that takes 100x as long.
- **Missing Links search renders 5 product cards in parallel** but if all five fail with the same SerpAPI 503, the UI shows five identical "Search failed" errors with no batch-level retry and no aggregate "service unavailable" banner.
- **`cleanWalmartUrl` regex** (line 222-229) silently strips query params on a custom URL. If a user pastes a link with a useful affiliate / tracking param, it's gone with no notice.
- **No "what happens if I uncheck Not on Walmart later"** affordance. Once you mark a product `NOT_ON_WALMART` (sentinel string at line 246), there's no in-UI way to unmark it back to NULL. Would require going to product settings.
- **Save flow is a serial for-loop of UPDATE queries** (line 241-273) that throws on first error. If product 3 of 5 fails (network blip), products 1 and 2 are saved, products 4 and 5 are skipped, and the page is half-updated. No batch transaction, no per-row status indicator.
- **Value proposition is unclear.** What does Jeremy do with these prices? The shopping page "Open in Walmart" button uses `walmart_link` not the price. The HomePage "Cart Value" tile uses the price. So the price is ONE number on ONE tile and the manual-tying-each-product-to-a-Walmart-URL is a heavy chore for that one payoff. Either expand the use of price data (per-row in shopping list — see suggestion above) or de-emphasize the manual flow.

**Missing:**

- Per-day / per-user SerpAPI call counter. Even something cheap like "X calls today" would build trust.
- An "auto-link" mode that takes the top SerpAPI result for products with a clean barcode match.
- A "stale prices" indicator (last refreshed > 30 days). Refresh All button could prioritize stale rows.
- Cancel button on the Refresh All / Find Missing Prices loops.

**Suggestions:**

1. Add rate-limit to the edge function (per-user count, e.g. 100/day) and surface the remaining count in the tab header. Without it, this surface is a footgun.
2. Show line-level price on the shopping page (already covered) — that turns "manage prices" from a chore into a feedback loop with a clear payoff.
3. Replace serial loops at line 316-377 (`findMissingPrices`) and line 419-447 (`refreshAllPrices`) with chunked parallelism (e.g. 5 at a time) and add a Cancel button bound to an `AbortController`.

## Cross-cutting findings

- **Day boundary trust is mostly good.** `apps/web/src/shared/dates.ts:20-26` mirrors `private.get_logical_date` semantics, and `MealPlanPage.tsx:133`, `MacroPage.tsx:199`, `HomePage.tsx:201` all consistently call `todayStr(dayStartHour)`. **One bug:** `HomePage.tsx:880` hardcodes "(6:00 AM - 5:59 AM)" so users with a non-6 `day_start_hour` see a wrong label. This breaks the "trust the boundary" goal at the exact moment the user notices something funky.
- **Realtime invalidation is wired everywhere.** `useRealtimeInvalidation` calls in MealPlanPage:212, MacroPage:241, HomePage:377, ShoppingPage:117. Heartbeat + auto-reconnect logic in `useRealtimeInvalidation.ts:25-34` is genuinely solid for an SPA. Eat-a-meal-on-phone → desktop dashboard updates within seconds.
- **Mobile usability is inconsistent.** MealPlanPage has explicit mobile and desktop renders (line 664-699 vs 702-747). HomePage progress bars adapt with `grid-cols-2 sm:grid-cols-4`. ShoppingPage rows use 20px checkboxes — well below the 44px tap target. MacroPage stacks fine. WalmartTab options grid `repeat(auto-fill, minmax(150px, 1fr))` works but image cards are not particularly thumbable. Phone-side weakness is the shopping list — the place phone usability matters most.
- **Trust signals are uneven.** Optimistic updates exist on shopping toggle, delete meal, delete consumed. NOT on mark-done (the most-clicked daily action). No success toasts anywhere — completion is silent. Errors land in `setError` text strings at the top of pages with no toast, no auto-dismiss, no actionability. Compare to a tool like Linear that uses persistent, dismissible, actionable toasts.
- **Error recovery is bare.** `MacroPage.tsx:442-451` has a Retry button on the load error card — good. `HomePage.tsx:860-870` similarly. But mutation errors (mark-done failure, import failure, delete failure) just `setError(err.message)` — no retry, no clarify, no undo.
- **No edit-after-write anywhere.** Every consumed item / food_log / temp item is delete-and-re-create. For a disciplined logger this is the friction that decays habit fastest.
- **Native `alert()` at `ShoppingPage.tsx:478`** breaks the design system.

## Top 5 highest-impact UX changes

1. **Edit qty on consumed items.** A new `update_food_log_qty` RPC + an inline numeric input on every food_log/temp row in MacroPage / HomePage / MealPlanPage. Solves the most-cited friction in macro-tracking.
2. **Stop capping macro bars at 100%.** `MacroProgressBar.tsx:14` and `HomePage.tsx:134-137` both cap. Render an over-goal segment in red instead. Disciplined macro-trackers care exactly about over-goal.
3. **Day-totals vs goals on MealPlan.** Add a goal-comparison row alongside `day-detail-total-row` (`MealPlanPage.tsx:906-914`) so planning a day shows budget headroom, not just sum. Pulls existing goals; pure UI work.
4. **Per-row prices and section subtotal on Shopping list.** Show $X.XX per row in `ShoppingPage.tsx:612-614` and a To Buy subtotal. Turns the "manage Walmart prices" chore into a feedback loop with a daily payoff.
5. **Rate-limit + counter on Walmart tab.** Add 100/user/day quota in `walmart-scrape/index.ts` (TODO at line 150) and render `X / 100 today` in `WalmartTab.tsx`. Currently a footgun — user can hit SerpAPI hundreds of times silently.

## Things working well

- Atomic, idempotent server-side RPCs (`mark_meal_done`, `import_shopping_to_inventory`) — no half-state on mid-flow failure, no double-import.
- `imported_at` design with the partial index + `Show imported` toggle is the right shape — keeps the active cart fast and gives audit when needed.
- Realtime invalidation hook with heartbeat + reconnect is a serious piece of infrastructure that just works.
- The HomePage progress bar with planned-segment overlay (line 793-816) is a great pattern — at-a-glance "what I have eaten + what's planned" is exactly what a disciplined user wants.
- Two-click "You sure?" delete pattern via `DeleteBtn` is consistent across MealPlan/Home/Macro and avoids destructive accident without a modal-flow tax.
- Optimistic updates on shopping toggle including the `justPurchasedIds` flash animation (`ShoppingPage.tsx:605-608`) — small touch, high satisfaction.
- Day-strip on mobile / vertical-list on desktop in MealPlan is correctly different per breakpoint, not a scaled-down identical layout.
- Stock-status badges on HomePage's Today's Meals (CAN MAKE / PARTIAL / NO STOCK) at line 1079-1086 surface the most useful inventory question right next to the action button.
- Auth-context-aware date defaults (`todayStr(dayStartHour)`) consistently applied across the four pages.
