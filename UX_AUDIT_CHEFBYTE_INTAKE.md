# UX Audit — ChefByte Web (Scanner + Inventory + Recipes)

## Overall impression

The intake surfaces are **dense with capability** — four scan modes, two inventory views, expired-discard section, three live-data badge systems (Certified / On Scale / In Flight), source pills, persisted recipe filters. But the design assumes Jeremy already has the mental model in his head. The scanner is fast, hardware-friendly, and has thoughtful affordances (red-vs-green confirmed-state, dropped-scan toast, focus indicator) but its **mode names ("Buy" / "Eat (Track)" / "Eat (Skip)" / "Add to List")** force a translation step every time. The inventory page does almost everything right _for the live-shelf user_ but is overweight for the manual-scan user, and **mobile usability is fragile** at the moment that matters most: standing at the fridge after a Walmart run.

## Per-flow

### Scan a barcode → add to inventory

**Goal.** Pull groceries out of a bag and have inventory reflect what's in the kitchen with as little thought as possible.

**Today's experience.** `/chef/scanner`. Mode defaults to "Buy". Barcode input auto-focuses; green "Scanner active" pill confirms focus (`ScannerPage.tsx:1289`). `useScannerDetection` captures rapid digits + Enter from USB scanners; manual typing works. Each scan = a queue card. Known products: green border + nutrition prefilled. New products: pending-amber → AI normalize (5–25s) → red `[!NEW]` placeholder if AI fails. Right-column keypad auto-focuses Srv/Ctn after each scan for mid-rapid-fire corrections. Undo is per-row, type-aware (`ScannerPage.tsx:1004-1090`).

**Friction.**

1. **Mode names force decoding.** "Eat (Track)" vs "Eat (Skip)". Scanning chicken in Eat-Track mode silently consumes a container the user meant to add. No preview-before-commit.
2. **No camera scanner.** Header `Camera` icon but no `getUserMedia` / video pipeline. Phone-at-fridge means hand-typing 12 digits.
3. **AI wait is 5–25s, queue card sits amber the entire time.** "Processing 0123456789..." doesn't change. Six rapid scans = six identical amber rows for half a minute.
4. **Hard-AI-error copy is useless.** `"AI service has no credits — top up billing"` (`analyze-product/index.ts:398`) reads to the user with no top-up button or fallback path.
5. **No "I'm done" signal.** Scanned 30 items — what now? No batch-confirm, no rollup count.
6. **Cross-item state contamination is patched but fragile** (`ScannerPage.tsx:1374-1381`). Architecture is one tweak from regression.

**Missing.** Camera scanner; review-batch stage; success-confirm pulse / haptic; mode pre-selection by intent (URL param + dashboard mega-button).

**Suggestions (ranked).**

1. **Rename + re-rank modes.** `Buy → "Add to fridge"` (dominant default); `Eat (Track) → "I just ate this"`; collapse `Eat (Skip)` into a sub-toggle; `Add to List → "Shopping list"`. Mode-confusion silent-failure is the biggest intake-error source.
2. **Camera scanner.** A minimal `BarcodeDetector` wedge feeding `handleBarcodeSubmit` unlocks the phone-at-fridge flow without re-architecture.
3. **Per-row progress + done-state pulse.** Replace static amber with a 3-dot animation; flash green + scale-in check on commit. Same code path, much higher trust.

---

### View inventory

**Goal.** Answer "what do I have, what's about to spoil, what's running low?"

**Today's experience.** `/chef/inventory` defaults to **grouped view** — one row per product with nearest expiry, expand for lots. Expired-discard banner with two-button rows ("Log as discarded" / "Consumed anyway"). Search, Lots-view toggle, "Review (N)" deep-link to Pi classifier. Per-product badges: ✓ Certified, ⚖ On Scale, ✋ In Flight (clickable for close-out), source pill (live shelf / scale / catch-all). Stock dot: red ≤0, amber <min, green ≥min. Realtime invalidation across `stock_lots`, `products`, `live_shelf_devices`, `scale_pairings`.

**Friction.**

1. **Badge legend is invisible.** Five badge meanings with zero explanation surface. Tooltips work on desktop, fail on mobile.
2. **Default-grouped is right for live-shelf, heavy for manual-scan.** Re-upping = 4 taps (row → expand → Add Container → modal → confirm). Re-scanning is faster. Modal's only unique value: setting explicit expiry.
3. **"(picked up)" without context looks like an error** when the user isn't running a live shelf (`InventoryPage.tsx:1305-1309`).
4. **"Log as discarded" is judgment-loaded.** "Tossed" reads lighter.
5. **Color overload.** Amber drives stock dot, In-Flight badge, expired chip, AND warning toasts.
6. **No bulk operations.** 3 expired yogurts = 3 separate clicks.
7. **Lots-view desktop table** crams badges into Product cell; on a 13" laptop with DevTools, they wrap.
8. **Zero-stock without `min_stock_amount` disappears** from grouped view (`InventoryPage.tsx:597`). Confusing if you just consumed the last.

**Missing.** Badge legend (one-time); inline quick-edit ±qty; "Recently added/consumed" sort; row-level toast on Realtime push (Pi-driven inserts appear silently); a "synced N s ago" stamp.

**Suggestions (ranked).**

1. **Inline quick-edit on each row.** Tap qty → ±buttons fire existing mutations. Removes ~80% of modal opens.
2. **One-time badge legend** the first time any badge appears; persist a "got it" flag.
3. **Filter chips: Recently added | Expiring soon | Below min | All.** Replaces implicit sort heuristic with explicit user intent.

---

### Recipe library + editor

**Goal.** "Show me what I can make right now" or "design a meal that fits today's macros."

**Today's experience.** `/chef/recipes` shows cards: name, servings, active/total time, per-serving macros, stock-status pill (`CAN MAKE` / `PARTIAL` / `NO STOCK` / `N/A`). Search + Filters popover with Can Be Made, Quick (<30 min), High Protein (persisted g/100cal threshold), High Carbs. Stock status computed against live `stock_lots` joined into the same `useQuery` (`RecipesPage.tsx:188-213`). Editor: single-page form, debounced product-search ingredient dropdown, live-recomputed Per Serving + Total Recipe macro badges. Save atomic via `save_recipe_ingredients` RPC.

**Friction.**

1. **"Can Be Made" is buried in the popover.** This is **the** intent for "what's for dinner?" — three clicks deep is wrong.
2. **No "uses what's about to expire" filter.** Given `default_shelf_life_days` and the expired section, this is the highest-value missing filter.
3. **`PARTIAL` is not actionable.** Badge doesn't say what's missing.
4. **Editor's ingredient search returns ALL products** — placeholders + `[MEAL]` entries + junk all mixed.
5. **Two enforcement paths for "≥1 ingredient"**: disabled save button + banner error (`RecipeFormPage.tsx:408, 686`).
6. **No card-level serving scale or recipe image.**
7. **Recipes page does NOT subscribe to `stock_lots` Realtime** — a live-shelf consume mid-browse leaves Can-Make stale, unlike every other page.

**Missing.** Recipe duplicate/fork; "use this recipe now" CTA (auto-schedule + auto-consume); tags/categories.

**Suggestions (ranked).**

1. **Promote "Cookable now" to a top-level chip** next to search alongside `[All]` and `[Quick]`. Macro thresholds stay in the popover.
2. **"Uses expiring stock" filter** — cross-references `stock_lots.expires_on` and `recipe_ingredients.product_id`.
3. **Show missing-ingredient count on `PARTIAL` badges**: "PARTIAL (3 missing)" with tooltip listing them.

---

## Cross-cutting findings

- **Mobile is half-built.** Tailwind breakpoints + drawer nav + lots-view card fallback exist. But scanner has no camera, modals aren't optimized, and the Filters threshold input is covered by the keyboard. Pi-driven IoT data has the best UX in the app; manual-mobile is second-class.
- **Realtime is mostly correct.** Inventory, Home, Macros, Meal Plan, Shopping, Settings, Events all subscribe via `useRealtimeInvalidation`. **`RecipesPage` does NOT** — a live-shelf consume mid-browse leaves Can-Make stale.
- **Trust signals are weak.** No "last synced" stamp anywhere. No optimistic pulse on most mutations (In-Flight close-out is the exception — `InventoryPage.tsx:827-848` — proving the team knows the pattern). The dropped-scan toast is excellent; the equivalent care isn't applied to commits.
- **Error recovery is honest but heavy.** `analyze-product` 503 copy is correct (`analyze-product/index.ts:357`), but failed scanner rows have no inline retry — user must delete + rescan.
- **Live-shelf badge system is undocumented.** Comment density in `InventoryPage.tsx:198-300` is heroic; user-facing legend density is zero.
- **Two parallel scanners.** `ScannerPage` and `LiveTrackImportPage` both use `useScannerDetection`. ~40% logic overlap split because LiveTrack writes `tare_weight_g`. Two product-creation paths — tech-debt risk.
- **Live-shelf vs manual provenance is genuinely distinguished** via `last_update_source`; `live_scale` is gated on actual `scale_pairings` to suppress stale tags. Works correctly.
- **Day boundary respect is consistent.** `todayStr(dayStartHour)` used everywhere date-sensitive.
- **Dashboard badge row is cramped** at realistic counts.

## Top 5 highest-impact UX changes (prioritized)

1. **Rename + re-rank scanner modes** (`Buy → "Add to fridge"` etc.). Single biggest reduction in silent intake errors.
2. **Inline quick-edit on inventory rows.** Tap qty → ±buttons. Eliminates ~80% of modal opens.
3. **Promote "Cookable now" to a top-level chip on Recipes** + add a "Uses expiring stock" chip. Two-chip default coverage of 90% of recipe-search intent.
4. **Camera-based barcode scanner** (`BarcodeDetector` with fallback message). Enables phone-at-fridge.
5. **Trust signals everywhere.** "Synced N seconds ago" header stamp, green-flash on row commit, `aria-live` toast on every successful mutation. Cheaper than any new feature; biggest perceived-quality lift.

## Things working well

- **Hardware-scanner detection + dropped-scan toast** (`ScannerPage.tsx:1289-1308` + `useScannerDetection`). A complete solution to a class of bugs other apps lose data to.
- **Merge-user-edits-with-AI-response logic.** `userEditedFieldsRef` + `nutritionRef` synced on every render means user corrections during the AI wait win. The detail-level engineering bug-discovery showed up.
- **Expired-section UX.** Two paths (discard / consumed anyway) with strikethrough date and days-expired chip — both legitimate, no judgment.
- **Realtime + scope-tight invalidation.** Per-table query keys mean Pi events refresh only what's affected.
- **Optimistic In-Flight close-out** with full rollback on error. The team understands optimistic UX where it matters.
- **Source-pill suppression for stale `live_scale` tags.** Invisible-when-right correctness that infuriates when wrong.

---

**Files referenced (absolute paths):**

- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/ScannerPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/InventoryPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/RecipesPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/RecipeFormPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/pages/chefbyte/HomePage.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/components/chefbyte/ChefLayout.tsx`
- `/home/jeremy/luna-hub-lite/apps/web/src/hooks/useScannerDetection.ts`
- `/home/jeremy/luna-hub-lite/supabase/functions/analyze-product/index.ts`
