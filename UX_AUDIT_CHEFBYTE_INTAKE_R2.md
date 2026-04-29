# UX Audit R2 — ChefByte Web (Scanner + Inventory + Recipes)

## What changed since round 1

Round 1's salvage-commit (`34dc1a5`) shipped real progress on **two** of the three intake surfaces. Net effect:

- **InventoryPage** got the `aria-live` toast region (`InventoryPage.tsx:1085-1106`), the one-time dismissible badge legend (`InventoryPage.tsx:1108-1166`), inline `±` quick-edit buttons (`InventoryPage.tsx:1510-1543`), `Log as discarded → Mark as tossed` rename (`InventoryPage.tsx:1262`), and a `(picked up)` label that now carries a hand emoji + tooltip (`InventoryPage.tsx:1489-1495`).
- **RecipesPage** got Realtime invalidation on `stock_lots` + `recipes` + `recipe_ingredients` (`RecipesPage.tsx:338-342`), promoted `Cookable now` + `Uses expiring stock` chips above the search row (`RecipesPage.tsx:651-682`), `PARTIAL (N missing)` badge with tooltipped names (`RecipesPage.tsx:782-790`), and a `EXPIRING_WINDOW_DAYS = 7` constant + helper (`RecipesPage.tsx:64`).
- **ScannerPage was not touched** — round 1's call-out stands word-for-word. No mode rename, no camera, no batch-confirm, no pulse on commit.
- New unit test `recipe-missing-ingredients.test.ts` exercises the two new pure helpers but no integration test covers the chip-row interaction or that Realtime actually re-renders the cards.

The inventory work covers ~3 of round 1's 5 top items (legend, quick-edit, status announce). Recipes work covers ~2 of 3 (chip promotion, missing-count). Scanner and "Trust signals everywhere" are largely unfixed.

---

## Per-flow

### Scanner (untouched since R1)

`ScannerPage.tsx:1428-1431` still hardcodes the four mode labels `Buy / Eat (Track) / Eat (Skip) / Add to List`. No camera affordance — `grep BarcodeDetector|getUserMedia|video` returns empty across the file. No commit pulse, no batch confirm. R1's #1 ranked finding ("Rename + re-rank scanner modes") and #4 ("Camera-based barcode scanner") are open. Not a regression — a no-op.

### Inventory — new findings after R2

1. **Quick-edit toast announces "item" instead of the product name in two of four expanded-panel paths.** `Add Container` / `Remove Container` / `Add Serving` / `Remove Serving` inside the expanded detail panel call `consumeStockMutation.mutate({ productId, qty, unit })` (`InventoryPage.tsx:1585-1589, 1607-1609`) without passing `productName`. The mutation's `onSuccess` (`InventoryPage.tsx:832`) falls back to `'item'`, so the user gets "Removed 1 container of item." The new `±` buttons DO pass it (`InventoryPage.tsx:1342`), so the same action announces correctly from one place and incorrectly from another.

2. **The legend renders ABOVE the view-toggle and search box.** `InventoryPage.tsx:1112-1166` then `1168-1213`. On a fresh-account first paint, the user sees a 6-line legend before they see "Grouped / Lots" or the search box — pushing the actual data below the fold on a phone in the kitchen. Should sit collapsed-by-default OR below the toggle.

3. **The legend is missing the lot-detail expanded panel "(picked up — awaiting reunite)" wording** (`InventoryPage.tsx:1557`). Round 1's only-bare-(picked up) finding is fixed in the collapsed row but the expanded panel introduced a slightly different long-form copy that was added without ever appearing in the legend, creating a third explanation surface that contradicts the brevity the legend aims for.

4. **Quick-add fires `addStockMutation` with `expiresOn: null` silently** (`InventoryPage.tsx:1335`). The button label is "Add 1 container" — fine — but the user has no signal that this skips the modal's expiry-date entry. For a pantry item that's fine; for milk it's a slow-drip data quality bug. The audit's #2 explicitly framed quick-edit as removing modal opens — but the modal's _only unique value_ (per R1: "setting explicit expiry") is silently lost when the user takes the new path. A subtle "expiry: not set" indicator on the row, OR a one-time tooltip the first time the button creates a lot would mitigate.

5. **Quick-sub button is disabled when `isPickedUp || isZeroStock`** (`InventoryPage.tsx:1524`). Correct logic, but the disabled state has no tooltip — disabled buttons in Tailwind with `disabled:opacity-30` look broken-not-disabled-on-purpose. `aria-disabled` plus a `title="No stock to remove"` would close the loop.

6. **`addStockMutation`'s success message says "Added N ctn of X"** (`InventoryPage.tsx:790`) but in the legend, the user just learned the unit is "ctn." Two conventions in two different surfaces minutes apart — once you've internalized that "ctn = container," the toast is fine; until then it reads like a typo. Use the word "container(s)" in the toast OR list `ctn` as an abbreviation in the legend.

7. **The legend's "got it" bit is keyed to `chefbyte_inv_legend_dismissed`** (`InventoryPage.tsx:347`) without scoping by user-id. On a shared device with multiple Supabase accounts (Jeremy + family member), one user's dismissal hides the legend from everyone. Low blast radius given single-user MVP, but the file already has `user.id` in scope.

8. **`Realtime` events on `stock_lots` invalidate inventory queries but the new `aria-live` toast only fires on user-initiated mutations** (`InventoryPage.tsx:788, 832, 858`). A live-shelf consume from the Pi silently appears — no row-level confirmation, no "+1 from Pi shelf" announce. R1 explicitly called out "row-level toast on Realtime push (Pi-driven inserts appear silently)" and that's still open.

### Recipes — new findings after R2

1. **Filter chips don't persist.** `canBeMadeOnly` (`RecipesPage.tsx:228`) and `usesExpiringOnly` (`RecipesPage.tsx:230`) are plain `useState(false)` — every page reload resets them, but the macro thresholds DO persist (`RecipesPage.tsx:236-249`). Asymmetric. The two highest-intent filters reset, the two lowest-intent ones survive. Add `localStorage` keys `chefbyte_recipes_cookable` and `chefbyte_recipes_expiring` mirroring the threshold pattern.

2. **`PARTIAL (N missing)` tooltip is the **only** way to see the missing names.** On mobile, `title=""` doesn't render. `RecipesPage.tsx:786` is still desktop-only. Surface the names as a small text line below the badge OR open an expandable affordance. R1 specifically called out tooltips fail on mobile — and the chosen fix is exactly a tooltip.

3. **`Uses expiring stock` chip uses `≤ today + 7 days` AND `≥ today`** (`RecipesPage.tsx:312`). This excludes lots that are _already past today's date_ — i.e., the expired-discard section. A user looking at the "expired — discard" banner with 4 yogurts and toggling "Uses expiring stock" will see zero recipes that match those yogurts. Either widen the lower bound to "yesterday minus 7 days" or alias the chip's tooltip to clarify "expiring soon" excludes already-expired.

4. **Realtime + chip + filter is genuinely live but invisible.** `useRealtimeInvalidation` fires `invalidateQueries({..., refetchType: 'all'})` (`useRealtimeInvalidation.ts:157`), so a Pi consume DOES re-render the card with an updated `PARTIAL (3 missing)` count. But there's no animation, no flash, and the badge is small text — the user staring at the page will not see the change. Combined with the recipe card being a `<Link>` (`RecipesPage.tsx:727`), the only on-card hover signal is a border color change, no pulse. R1's "trust signals everywhere" applies here directly — the data IS live, the user just can't tell.

5. **`PARTIAL (3 missing)` badge says nothing about how short the recipe is.** A recipe that needs 1 more container of 1 ingredient and a recipe that needs 4 containers of 4 ingredients both render `PARTIAL (4 missing)`-ish. `computeMissingIngredients` already returns `required` and `haveContainers` (`RecipesPage.tsx:171-182`) — they're discarded at the badge layer. Tooltip could be `Eggs (need 2, have 0); Milk (need 1, have 0.5)`.

6. **Recipe card `<Link>` swallows the badge tooltip on touch.** Tap-and-hold to reveal native `title` on iOS Safari triggers context menu instead of tooltip. Desktop-only.

7. **`RecipeFormPage` ingredient search still surfaces `[MEAL]` carve-out products.** `RecipeFormPage.tsx:156-163` uses `.ilike('name', '%${text}%')` with no `.not('name', 'ilike', '[MEAL]%')` filter. R1's finding stands; a sibling page (`SettingsPage` per `chef-settings.test.ts:319`) already does this exclusion correctly so the pattern exists in the codebase. Stale meal-prep allocations show up as selectable ingredients.

### Scanner-Inventory cross-page consistency

- Scanner mode `Buy` writes a stock_lot. Inventory presents the result under a `Grouped` view that shows `ctn` while Scanner's keypad is labeled `Srv/Ctn`. Same unit-system, three different abbreviations across screens. With the new legend ("Stock OK / Below min") inventory has a fourth layer of vocabulary the scanner never references.
- Scanner mode `Eat (Track)` produces a row in the queue but no row in the inventory `aria-live` toast — different surfaces of the same mutation use different feedback patterns.
- Inventory's `Mark as tossed` button (`InventoryPage.tsx:1262`) does NOT log macros (per the new tooltip on `:1259`). Scanner has no equivalent "tossed without macros" path — if you scan-consume something you didn't eat (mis-scan), there's no way back. Asymmetric data-correction surface.

### Realtime live-update behavior

- `useRealtimeInvalidation` is correctly subscribed on both pages and uses `refetchType: 'all'` (`useRealtimeInvalidation.ts:157`) which guarantees refetch even during route transitions. **The data does flow through within ~1s of a Postgres change.**
- BUT: visually, neither page flashes/pulses/scrolls. A live_shelf scale event hitting `stock_lots` updates the inventory row's `qty_containers` text but the row stays exactly where it is, no transition, no aria-live announce. The mechanism is correct; the UX surfacing is missing.
- Heartbeat is 30s (`useRealtimeInvalidation.ts:25`); a silent-death banner takes up to 90s to appear. Fine for desktop, weird for "phone at fridge" where the user is glancing for 5 seconds at a time.

---

## Top 5 highest-impact UX changes for R3

1. **Pass `productName` to all four expanded-panel mutation calls** (`InventoryPage.tsx:1585-1614`). One-line fix, removes "of item" from half the toasts. **Easy + high-value.**
2. **Persist `canBeMadeOnly` + `usesExpiringOnly` chips to localStorage** mirroring the existing `chefbyte_protein_threshold` pattern. The chips ARE the highest-intent filters per R1 — losing them on every reload is exactly backwards.
3. **Move the legend below the view-toggle + search row + collapse it to a single "What do these badges mean?" link** that expands inline. First-paint clutter is a phone-at-fridge killer.
4. **Animate row updates on Realtime push.** A 200ms green-flash on `stock_lots` events, scoped to the affected row. Cheap to add, finally surfaces the live-data work that's already wired.
5. **Surface `Missing: Eggs (2/0), Milk (1/0.5)` as a small text line below the `PARTIAL` badge** instead of relying on a tooltip. Tooltips fail on mobile — the same finding R1 raised about badges, now repeated by the R1 fix itself.

## Things working well (R2 confirms)

- The `aria-live` polite region (`InventoryPage.tsx:1090-1106`) is implemented correctly — `aria-atomic="true"`, scoped to a transient toast, clears after 4s. Screen-reader correctness is real even if visual signal is weak.
- The chip-row + popover split (`RecipesPage.tsx:497-498`) — including the small "Cookable now and Uses expiring are now top-level chips above" hint inside the popover — is a thoughtful migration that avoids confusion when the popover stays open.
- `EXPIRING_WINDOW_DAYS` is a named constant (`RecipesPage.tsx:64`) and uses `todayStr(dayStartHour)` for the lower bound — day-boundary respect is preserved across the new feature.
- The legend's `localStorage` write is wrapped in `try/catch` for Safari private mode (`InventoryPage.tsx:362-365`) — defensive without being paranoid.
- `productName` carried as a non-RPC param in the consume mutation type (`InventoryPage.tsx:817`) is a clean way to keep the toast string separate from the wire payload.

---

**Files referenced:**

- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/InventoryPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/RecipesPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/RecipeFormPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/ScannerPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/shared/useRealtimeInvalidation.ts`
- `/home/jeremy/luna-hub-lite/apps/web/src/__tests__/unit/pure/recipe-missing-ingredients.test.ts`
