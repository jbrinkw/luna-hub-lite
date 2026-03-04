# Batch 4: Remaining HIGH Functional Gaps — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix 7 remaining HIGH-severity functional gaps across ChefByte, CoachByte, Infrastructure, and MCP.

**Architecture:** Small targeted changes per task. No new pages. Minimal migrations.

---

## Task 1: Delete Food Logs / Temp Items on MacroPage

**Files:**

- Modify: `apps/web/src/pages/chefbyte/MacroPage.tsx`

**Design:** Add a delete button (small "x") to each consumed item row. The `ConsumedItem` has `id` (UUID) and `source` (tells us which table). Handler:

```typescript
const deleteConsumedItem = async (item: ConsumedItem) => {
  if (item.source === 'Meal Plan') {
    await chefbyte().from('food_logs').delete().eq('log_id', item.id);
  } else if (item.source === 'Temp Item') {
    await chefbyte().from('temp_items').delete().eq('temp_id', item.id);
  }
  // LiquidTrack events should not be deletable (IoT data)
  await loadData();
};
```

Add the delete button in the consumed items table as a new column, disabled for LiquidTrack rows.

**Commit after this task.**

---

## Task 2: Expiry Date Input on Inventory

**Files:**

- Modify: `apps/web/src/pages/chefbyte/InventoryPage.tsx`

**Design:** When adding stock, show a popover/modal with:

- Quantity input (default: 1 container)
- Expiry date input (`<IonInput type="date">`)
- Add button

Change `addStock(productId, qty)` to `addStock(productId, qty, expiresOn?)`. The merge logic checks `expires_on` match too (only merge when both null, or both same date). Different expiry = new lot.

Add an "Add Stock" button per product that opens the modal instead of just `+1 Ctn`.

**Commit after this task.**

---

## Task 3: Wire Walmart Price Refresh

**Files:**

- Modify: `apps/web/src/pages/chefbyte/WalmartPage.tsx`

**Design:** Enable "Refresh All Prices" button. Handler:

```typescript
const refreshAllPrices = async () => {
  setRefreshing(true);
  const products = walmartProducts.filter((p) => p.walmart_url);
  for (const p of products) {
    const { data, error } = await supabase.functions.invoke('walmart-scrape', {
      body: { url: p.walmart_url, userId: user.id },
    });
    if (!error && data?.price) {
      await chefbyte().from('products').update({ price: data.price }).eq('product_id', p.product_id);
    }
  }
  setRefreshing(false);
  await loadProducts();
};
```

Add loading spinner and progress counter ("Refreshing 3/15...").

**Commit after this task.**

---

## Task 4: PR Tracked Exercises Persistence

**Files:**

- Modify: `apps/web/src/pages/coachbyte/PrsPage.tsx`

**Design:** Persist tracked exercises via `coachbyte.user_settings`. On load, read `pr_tracked_exercises` from user_settings. On add/remove, update the setting. If no setting exists, default to all exercises (current behavior).

```typescript
// Load
const { data: settings } = await coachbyte()
  .from('user_settings')
  .select('setting_value')
  .eq('setting_key', 'pr_tracked_exercises')
  .single();
const trackedIds = settings?.setting_value ?? allExercises.map((e) => e.exercise_id);

// Save
const savePrTracked = async (ids: string[]) => {
  await coachbyte().from('user_settings').upsert(
    {
      user_id: user.id,
      setting_key: 'pr_tracked_exercises',
      setting_value: ids,
    },
    { onConflict: 'user_id,setting_key' },
  );
};
```

**Commit after this task.**

---

## Task 5: Regenerate DB Types

**Files:**

- Modify: `packages/db-types/src/database.ts`

**Design:** Run `supabase gen types typescript` to regenerate types. Delete the stale `database.types.ts` if it exists. This captures new columns/functions from recent migrations.

**Commit after this task.**

---

## Task 6: Atomic MCP update_plan

**Files:**

- Modify: `packages/app-tools/src/handlers/coachbyte.ts`

**Design:** Change `update_plan` handler from non-atomic (INSERT new + DELETE old) to:

1. DELETE old planned_sets first (only uncompleted ones)
2. INSERT new planned_sets

Wrap in an RPC if needed, or just order operations correctly (delete before insert avoids FK issues since completed_sets reference planned_sets).

**Commit after this task.**

---

## Task 7: PrsPage Pagination

**Files:**

- Modify: `apps/web/src/pages/coachbyte/PrsPage.tsx`

**Design:** Instead of fetching ALL completed_sets, only fetch sets from the last 90 days by default. Add a "Load More" button or date range selector. Use `.gte('completed_at', ninetyDaysAgo)` filter.

For PR calculation, keep the approach of finding max Epley 1RM but limit the dataset.

**Commit after this task.**

---

## Execution Order

Tasks 1-4 are independent, can be parallelized.
Task 5 should run after tasks that touch DB.
Tasks 6-7 are independent of 1-4.
