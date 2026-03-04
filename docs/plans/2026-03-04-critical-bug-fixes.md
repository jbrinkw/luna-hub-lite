# Critical & High Bug Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix all 10 critical/high data bugs from the feature audit that silently break existing functionality.

**Architecture:** Targeted fixes to existing files — no new features, no new pages. Each task is a surgical code change with a test to prevent regression.

**Tech Stack:** React/TypeScript (frontend), plpgsql (migrations), pgTAP (DB tests)

---

## Task 1: Fix JSONB Key Mismatch — SplitPage + Seed (C1/C2/D2)

**Files:**

- Modify: `apps/web/src/pages/coachbyte/SplitPage.tsx:22-30,154-162,267-275`
- Modify: `supabase/seed.sql:404-465`

**Step 1: Fix SplitPage TemplateSet interface and key usage**

Change the `TemplateSet` interface (lines 22-30) from:

```typescript
interface TemplateSet {
  exercise_id: string;
  exercise_name: string;
  reps: number | null;
  load: number | null;
  load_percentage: number | null;
  rest_seconds: number;
  order: number;
}
```

to:

```typescript
interface TemplateSet {
  exercise_id: string;
  exercise_name: string;
  target_reps: number | null;
  target_load: number | null;
  target_load_percentage: number | null;
  rest_seconds: number;
  order: number;
}
```

Update ALL references in the file: `reps` → `target_reps`, `load` → `target_load`, `load_percentage` → `target_load_percentage`. This includes:

- `addSet` function (~line 154): `reps: 5` → `target_reps: 5`, `load: null` → `target_load: null`, `load_percentage: null` → `target_load_percentage: null`
- JSX template rendering: all `s.reps`, `s.load`, `s.load_percentage` references
- Input onChange handlers: `...s, reps: val` → `...s, target_reps: val`, etc.

**Step 2: Fix C2 — Make target_load_percentage an editable input**

Find the Rel% checkbox handler (~line 267-275). Change hardcoded `80` to keep existing value or default to `80`, and change the `<span>` display to an `<IonInput>` so users can type 70%, 90%, etc.

Before:

```typescript
// Rel% toggle sets hardcoded 80
load_percentage: checked ? 80 : null;
// Display is <span>{s.load_percentage}%</span>
```

After:

```typescript
// Rel% toggle sets default 80, user can edit
target_load_percentage: checked ? (s.target_load_percentage ?? 80) : null;
// Display is <IonInput type="number" value={s.target_load_percentage} min={1} max={200} />
```

**Step 3: Fix seed.sql template_sets JSONB keys**

Change all `jsonb_build_object` calls in seed.sql (~lines 404-465) from:

```sql
jsonb_build_object('exercise_id', v_bench, 'sets', 4, 'reps', 8, 'load', 185)
```

to:

```sql
jsonb_build_object('exercise_id', v_bench, 'target_reps', 8, 'target_load', 185, 'rest_seconds', 90, 'order', 1)
```

Remove the `sets` key (not used by ensure_daily_plan). Add `rest_seconds` (90s default) and `order` to every template set. Add `target_load_percentage` where appropriate (e.g., accessory exercises at 60-70%).

**Step 4: Run `supabase db reset` and verify**

```bash
supabase db reset
supabase test db
```

Expected: All pgTAP tests pass. Demo user's splits have correct keys.

**Step 5: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: Clean (no references to old `reps`/`load` keys in SplitPage)

**Step 6: Commit**

```bash
git add apps/web/src/pages/coachbyte/SplitPage.tsx supabase/seed.sql
git commit -m "fix: JSONB key mismatch in SplitPage + seed (C1/C2/D2)

SplitPage now saves target_reps/target_load/target_load_percentage
matching what ensure_daily_plan reads. Rel% is now editable.
Seed template_sets updated with correct keys + rest_seconds."
```

---

## Task 2: Fix Seed user_config Goal Keys (C4/D1)

**Files:**

- Modify: `supabase/seed.sql:327-330`

**Step 1: Fix seed.sql user_config keys**

Change:

```sql
('aaaaaaaa-7001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'calorie_goal', '2200'),
('aaaaaaaa-7002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'protein_goal', '180'),
('aaaaaaaa-7003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'carbs_goal', '220'),
('aaaaaaaa-7004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'fat_goal', '73')
```

to:

```sql
('aaaaaaaa-7001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_calories', '2200'),
('aaaaaaaa-7002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_protein', '180'),
('aaaaaaaa-7003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_carbs', '220'),
('aaaaaaaa-7004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_fat', '73')
```

These keys now match what `get_daily_macros` reads (`goal_calories`, `goal_protein`, `goal_carbs`, `goal_fat`).

**Step 2: Also fix pgTAP test that uses wrong key**

Check `supabase/tests/hub/activation_chefbyte.test.sql:128` — uses `daily_calorie_goal`. Change to `goal_calories`.

**Step 3: Run `supabase db reset && supabase test db`**

Expected: All pgTAP tests pass. Demo user macros show 2200/180/220/73 goals.

**Step 4: Commit**

```bash
git add supabase/seed.sql supabase/tests/hub/activation_chefbyte.test.sql
git commit -m "fix: seed user_config uses correct goal keys (C4/D1)

Changed calorie_goal→goal_calories, protein_goal→goal_protein,
carbs_goal→goal_carbs, fat_goal→goal_fat to match get_daily_macros."
```

---

## Task 3: Fix Extension Credential Keys (M1)

**Files:**

- Modify: `apps/web/src/pages/hub/ExtensionsPage.tsx:8-30`

**Step 1: Fix credential field keys to match handler expectations**

Change the EXTENSIONS constant from:

```typescript
const EXTENSIONS = [
  {
    name: 'obsidian',
    displayName: 'Obsidian',
    description: 'Sync notes and data with your Obsidian vault',
    credentialFields: [{ key: 'vault_path', label: 'Vault Path' }],
  },
  {
    name: 'todoist',
    displayName: 'Todoist',
    description: 'Sync tasks and shopping lists with Todoist',
    credentialFields: [{ key: 'api_token', label: 'API Token' }],
  },
  {
    name: 'homeassistant',
    displayName: 'Home Assistant',
    description: 'Control smart home devices and automations',
    credentialFields: [
      { key: 'url', label: 'Home Assistant URL' },
      { key: 'token', label: 'Long-Lived Access Token' },
    ],
  },
];
```

to:

```typescript
const EXTENSIONS = [
  {
    name: 'obsidian',
    displayName: 'Obsidian',
    description: 'Sync notes and data with your Obsidian vault',
    credentialFields: [
      { key: 'obsidian_url', label: 'Obsidian Local REST API URL' },
      { key: 'obsidian_api_key', label: 'API Key' },
    ],
  },
  {
    name: 'todoist',
    displayName: 'Todoist',
    description: 'Sync tasks and shopping lists with Todoist',
    credentialFields: [{ key: 'todoist_api_key', label: 'API Token' }],
  },
  {
    name: 'homeassistant',
    displayName: 'Home Assistant',
    description: 'Control smart home devices and automations',
    credentialFields: [
      { key: 'ha_url', label: 'Home Assistant URL' },
      { key: 'ha_api_key', label: 'Long-Lived Access Token' },
    ],
  },
];
```

**Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

**Step 3: Commit**

```bash
git add apps/web/src/pages/hub/ExtensionsPage.tsx
git commit -m "fix: extension credential keys match handler expectations (M1)

Obsidian: vault_path→obsidian_url+obsidian_api_key
Todoist: api_token→todoist_api_key
Home Assistant: url→ha_url, token→ha_api_key"
```

---

## Task 4: Fix ToolsPage Tool Names (M2)

**Files:**

- Modify: `apps/web/src/pages/hub/ToolsPage.tsx:8-20`

**Step 1: Replace hardcoded tool definitions with real names**

Replace the `TOOL_DEFINITIONS` constant with all 41 actual tool names grouped by module:

```typescript
const TOOL_GROUPS: { label: string; tools: { name: string; description: string }[] }[] = [
  {
    label: 'CoachByte',
    tools: [
      { name: 'COACHBYTE_complete_next_set', description: 'Complete the next planned set' },
      { name: 'COACHBYTE_get_today_plan', description: "Get today's workout plan" },
      { name: 'COACHBYTE_log_set', description: 'Log an ad-hoc set' },
      { name: 'COACHBYTE_get_history', description: 'View workout history' },
      { name: 'COACHBYTE_get_prs', description: 'View personal records' },
      { name: 'COACHBYTE_update_split', description: 'Update weekly split template' },
      { name: 'COACHBYTE_get_split', description: 'Get split template' },
      { name: 'COACHBYTE_get_timer', description: 'Get rest timer state' },
      { name: 'COACHBYTE_set_timer', description: 'Start rest timer' },
      { name: 'COACHBYTE_update_plan', description: "Update today's plan" },
      { name: 'COACHBYTE_update_summary', description: 'Update workout summary' },
    ],
  },
  {
    label: 'ChefByte',
    tools: [
      { name: 'CHEFBYTE_consume', description: 'Consume stock (logs macros)' },
      { name: 'CHEFBYTE_get_inventory', description: 'View current inventory' },
      { name: 'CHEFBYTE_add_stock', description: 'Add stock to inventory' },
      { name: 'CHEFBYTE_get_macros', description: 'View daily macro totals' },
      { name: 'CHEFBYTE_create_product', description: 'Create a new product' },
      { name: 'CHEFBYTE_get_products', description: 'List products' },
      { name: 'CHEFBYTE_get_recipes', description: 'Browse recipes' },
      { name: 'CHEFBYTE_create_recipe', description: 'Create a recipe' },
      { name: 'CHEFBYTE_get_meal_plan', description: 'View meal plan' },
      { name: 'CHEFBYTE_add_meal', description: 'Add meal to plan' },
      { name: 'CHEFBYTE_get_shopping_list', description: 'View shopping list' },
      { name: 'CHEFBYTE_mark_done', description: 'Mark meal as done' },
      { name: 'CHEFBYTE_add_to_shopping', description: 'Add item to shopping list' },
      { name: 'CHEFBYTE_below_min_stock', description: 'Auto-add below-min items' },
      { name: 'CHEFBYTE_log_temp_item', description: 'Log a temporary food item' },
      { name: 'CHEFBYTE_set_price', description: 'Set product price' },
      { name: 'CHEFBYTE_clear_shopping', description: 'Clear shopping list' },
      { name: 'CHEFBYTE_get_product_lots', description: 'View product stock lots' },
      { name: 'CHEFBYTE_get_cookable', description: 'Get cookable recipes' },
    ],
  },
  {
    label: 'Obsidian',
    tools: [
      { name: 'OBSIDIAN_search_notes', description: 'Search Obsidian notes' },
      { name: 'OBSIDIAN_create_note', description: 'Create a note' },
      { name: 'OBSIDIAN_get_note', description: 'Get a note' },
      { name: 'OBSIDIAN_update_note', description: 'Update a note' },
    ],
  },
  {
    label: 'Todoist',
    tools: [
      { name: 'TODOIST_get_tasks', description: 'Get tasks' },
      { name: 'TODOIST_create_task', description: 'Create a task' },
      { name: 'TODOIST_complete_task', description: 'Complete a task' },
      { name: 'TODOIST_get_projects', description: 'Get projects' },
    ],
  },
  {
    label: 'Home Assistant',
    tools: [
      { name: 'HOMEASSISTANT_get_entity_state', description: 'Get entity state' },
      { name: 'HOMEASSISTANT_call_service', description: 'Call a service' },
      { name: 'HOMEASSISTANT_get_entities', description: 'List entities' },
    ],
  },
];
```

Update the JSX to render grouped tools instead of flat Record iteration. Each group gets a section header.

Update the toggle handler and loading logic to work with the new structure (the DB query for `tool_toggles` should still work since it stores `tool_name` text).

**Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

**Step 3: Commit**

```bash
git add apps/web/src/pages/hub/ToolsPage.tsx
git commit -m "fix: ToolsPage uses actual 41 tool names grouped by module (M2)"
```

---

## Task 5: Fix importShopping Inverted Boolean (ChefByte #12)

**Files:**

- Modify: `apps/web/src/pages/chefbyte/HomePage.tsx:251`

**Step 1: Fix the boolean**

Change:

```typescript
.eq('purchased', false);
```

to:

```typescript
.eq('purchased', true);
```

Also add placeholder filter as documented in audit finding #18:

```typescript
.eq('purchased', true)
.not('products.is_placeholder', 'is', true);
```

Wait — the `.not()` on a joined table may not work via PostgREST. Instead, filter client-side:

```typescript
const nonPlaceholder = (items ?? []).filter((item: any) => !item.products?.is_placeholder);
```

Then use `nonPlaceholder` for the stock insert loop.

**Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

**Step 3: Commit**

```bash
git add apps/web/src/pages/chefbyte/HomePage.tsx
git commit -m "fix: importShopping filters purchased=true, excludes placeholders (#12)"
```

---

## Task 6: Fix Lot Proliferation — addStock Should Merge (ChefByte #11)

**Files:**

- Modify: `apps/web/src/pages/chefbyte/InventoryPage.tsx:161-176`

**Step 1: Change addStock from INSERT to check-then-upsert**

Replace the blind insert with:

```typescript
const addStock = async (productId: string, qtyContainers: number) => {
  if (!user || !locationId) return;

  // Check for existing lot with same product/location/no-expiry
  const { data: existing } = await chefbyte()
    .from('stock_lots')
    .select('lot_id, qty_containers')
    .eq('user_id', user.id)
    .eq('product_id', productId)
    .eq('location_id', locationId)
    .is('expires_on', null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Merge into existing lot
    const { error: err } = await chefbyte()
      .from('stock_lots')
      .update({ qty_containers: Number(existing.qty_containers) + qtyContainers })
      .eq('lot_id', existing.lot_id);
    if (err) {
      setError(err.message);
      return;
    }
  } else {
    // Create new lot
    const { error: err } = await chefbyte().from('stock_lots').insert({
      user_id: user.id,
      product_id: productId,
      location_id: locationId,
      qty_containers: qtyContainers,
      expires_on: null,
    });
    if (err) {
      setError(err.message);
      return;
    }
  }

  await loadData();
};
```

**Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

**Step 3: Commit**

```bash
git add apps/web/src/pages/chefbyte/InventoryPage.tsx
git commit -m "fix: addStock merges into existing lot instead of creating new (#11)"
```

---

## Task 7: Add Index on api_key_hash (D4)

**Files:**

- Create: `supabase/migrations/YYYYMMDDHHMMSS_add_api_key_hash_index.sql`

**Step 1: Create migration**

```sql
-- Partial unique index for fast API key lookup (only active keys)
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON hub.api_keys (api_key_hash)
  WHERE revoked_at IS NULL;
```

**Step 2: Apply and test**

```bash
supabase db reset && supabase test db
```

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "perf: add partial unique index on api_keys.api_key_hash (D4)"
```

---

## Task 8: Atomic Recipe Ingredient Save (ChefByte #10)

**Files:**

- Create: `supabase/migrations/YYYYMMDDHHMMSS_atomic_recipe_ingredients.sql`
- Modify: `apps/web/src/pages/chefbyte/RecipeFormPage.tsx:277-302`

**Step 1: Create RPC for atomic save**

```sql
CREATE OR REPLACE FUNCTION private.save_recipe_ingredients(
  p_recipe_id UUID,
  p_ingredients JSONB  -- array of {product_id, quantity, unit, note}
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_ing JSONB;
BEGIN
  -- Verify recipe ownership
  IF NOT EXISTS (
    SELECT 1 FROM chefbyte.recipes WHERE recipe_id = p_recipe_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Recipe not found or not owned by user';
  END IF;

  -- Atomic: delete old + insert new in same transaction
  DELETE FROM chefbyte.recipe_ingredients
  WHERE recipe_id = p_recipe_id AND user_id = v_user_id;

  FOR v_ing IN SELECT * FROM jsonb_array_elements(p_ingredients)
  LOOP
    INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit, note)
    VALUES (
      v_user_id,
      p_recipe_id,
      (v_ing->>'product_id')::uuid,
      (v_ing->>'quantity')::numeric,
      v_ing->>'unit',
      v_ing->>'note'
    );
  END LOOP;
END;
$$;
```

**Step 2: Update RecipeFormPage to call RPC**

Replace the delete-then-insert block (~lines 277-302) with:

```typescript
if (ingredients.length > 0) {
  const { error: ingErr } = await chefbyte().rpc('save_recipe_ingredients', {
    p_recipe_id: id,
    p_ingredients: ingredients.map((ing) => ({
      product_id: ing.product_id,
      quantity: ing.quantity,
      unit: ing.unit,
      note: ing.note || null,
    })),
  });
  if (ingErr) {
    setSaveError(ingErr.message);
    return;
  }
} else {
  // No ingredients — just delete existing
  const { error: delErr } = await chefbyte()
    .from('recipe_ingredients')
    .delete()
    .eq('recipe_id', id)
    .eq('user_id', user.id);
  if (delErr) {
    setSaveError(delErr.message);
    return;
  }
}
```

**Step 3: Apply and test**

```bash
supabase db reset && supabase test db
cd apps/web && pnpm typecheck
```

**Step 4: Commit**

```bash
git add supabase/migrations/ apps/web/src/pages/chefbyte/RecipeFormPage.tsx
git commit -m "fix: atomic recipe ingredient save via RPC (ChefByte #10)"
```

---

## Task 9: Fix todayStr() to Respect day_start_hour (C3/M23)

**Files:**

- Modify: `apps/web/src/shared/dates.ts`
- Modify: pages that call `todayStr()` for date-sensitive operations

**Step 1: Update todayStr() to accept optional offset**

The clean fix: `todayStr()` should subtract `day_start_hour` hours before computing the date. This way, at 2:00 AM with `day_start_hour=4`, it returns yesterday's date (matching the server).

```typescript
/**
 * Get today's logical date string (YYYY-MM-DD).
 * If day_start_hour > 0, dates before that hour count as the previous day.
 */
export function todayStr(dayStartHour = 0): string {
  const now = new Date();
  if (dayStartHour > 0) {
    now.setHours(now.getHours() - dayStartHour);
  }
  return now.toLocaleDateString('sv-SE');
}
```

The `dayStartHour` parameter comes from the user's profile (stored in hub.profiles.day_start_hour). Pages that use `todayStr()` should read this from context.

**Step 2: Typecheck and test**

```bash
cd apps/web && pnpm typecheck && pnpm test
```

**Step 3: Commit**

```bash
git add apps/web/src/shared/dates.ts
git commit -m "fix: todayStr() respects day_start_hour offset (C3/M23)"
```

---

## Task 10: Final Verification + Single Commit for Remaining Small Fixes

Run full verification suite:

```bash
supabase db reset
supabase test db
cd apps/web && pnpm typecheck
cd apps/web && pnpm test
```

All must pass before marking batch complete.

---

## Execution Order

Tasks 1-2 must be done together (both touch seed.sql).
Tasks 3-9 are independent and can be parallelized.
Task 10 is final verification after all others.
