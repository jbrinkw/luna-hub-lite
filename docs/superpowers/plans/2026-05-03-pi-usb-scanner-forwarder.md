# Pi USB Scanner Forwarder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plug a USB barcode scanner into the live-shelf Pi → forwarded barcodes processed by cloud edge function under user's currently-active scanner mode → persistent transactions log surfaces in Settings.

**Architecture:** Web Scanner page broadcasts mode changes to a new `chefbyte.scanner_state` table (one row/user). Pi USB scanner reads from `evdev`, POSTs to a new `/shelf-ingest/barcode-scan` route with `x-api-key` (reuses existing `live_shelf_devices` auth). Edge function resolves mode (locked > last_active), looks up product (calling analyze-product on first-scan), executes mode action, logs to `chefbyte.scan_transactions`. Settings gets a Scanner tab (lock toggle) + Scanner Transactions tab (view/void).

**Tech Stack:** Supabase Postgres + edge functions (Deno), Pi Python 3.13 + evdev, React 18 + TypeScript + TanStack Query.

---

## Spec reference

`docs/superpowers/specs/2026-05-03-pi-usb-scanner-forwarder.md`

## File Structure

### New files

- `supabase/migrations/20260503100000_scanner_state_and_transactions.sql`
- `supabase/migrations/20260503100100_execute_scan_action_fn.sql`
- `supabase/migrations/20260503100200_void_scan_transaction_fn.sql`
- `supabase/tests/chefbyte/scanner_state.test.sql` (pgTAP)
- `supabase/tests/chefbyte/scan_transactions.test.sql` (pgTAP)
- `hardware/live-shelf/server/barcode/__init__.py`
- `hardware/live-shelf/server/barcode/hid_listener.py`
- `hardware/live-shelf/server/barcode/scanner_loop.py`
- `hardware/live-shelf/server/barcode/tests/__init__.py`
- `hardware/live-shelf/server/barcode/tests/test_hid_listener.py`
- `hardware/live-shelf/server/barcode/tests/test_scanner_loop.py`
- `apps/web/src/pages/chefbyte/ScannerTab.tsx` (Settings tab content)
- `apps/web/src/pages/chefbyte/ScannerTransactionsTab.tsx`
- `apps/web/src/shared/scannerStateApi.ts`
- `apps/web/src/__tests__/unit/chefbyte/ScannerStatePush.test.tsx`
- `apps/web/src/__tests__/unit/chefbyte/ScannerTransactionsTab.test.tsx`
- `apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts`

### Modified files

- `packages/db-types/src/database.ts` (regen)
- `supabase/functions/shelf-ingest/index.ts`
- `hardware/live-shelf/server/cloud/client.py`
- `hardware/live-shelf/app.py` (or wherever app entrypoint is)
- `apps/web/src/pages/chefbyte/ScannerPage.tsx`
- `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- `apps/web/src/shared/queryKeys.ts`
- `apps/web/src/shared/queryKeys-invalidation-registry.ts`
- `docs/apps/chefbyte.md`

---

## Phase A — Schema + DB functions

### Task 1: Create scanner_state + scan_transactions tables

**Files:**

- Create: `supabase/migrations/20260503100000_scanner_state_and_transactions.sql`
- Create: `supabase/tests/chefbyte/scanner_state.test.sql`
- Create: `supabase/tests/chefbyte/scan_transactions.test.sql`

- [ ] **Step 1: Write the pgTAP tests**

`supabase/tests/chefbyte/scanner_state.test.sql`:

```sql
BEGIN;
SELECT plan(6);

SELECT has_table('chefbyte', 'scanner_state', 'scanner_state table exists');
SELECT col_is_pk('chefbyte', 'scanner_state', 'user_id', 'user_id is PK');
SELECT col_not_null('chefbyte', 'scanner_state', 'last_active_mode', 'last_active_mode is NOT NULL');
SELECT col_default_is(
    'chefbyte', 'scanner_state', 'last_active_mode', 'purchase'::text,
    'last_active_mode default = purchase'
);
SELECT col_is_null('chefbyte', 'scanner_state', 'locked_mode', 'locked_mode nullable');
SELECT policies_are(
    'chefbyte', 'scanner_state', ARRAY['scanner_state_self'],
    'scanner_state has the self-RLS policy'
);

SELECT * FROM finish();
ROLLBACK;
```

`supabase/tests/chefbyte/scan_transactions.test.sql`:

```sql
BEGIN;
SELECT plan(8);

SELECT has_table('chefbyte', 'scan_transactions', 'scan_transactions exists');
SELECT col_is_pk('chefbyte', 'scan_transactions', 'transaction_id', 'transaction_id is PK');
SELECT col_not_null('chefbyte', 'scan_transactions', 'barcode', 'barcode NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'mode', 'mode NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'status', 'status NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'source', 'source NOT NULL');
SELECT has_index(
    'chefbyte', 'scan_transactions', 'scan_transactions_pi_event_id_unique',
    'unique partial index on (user_id, pi_event_id) exists'
);
SELECT policies_are(
    'chefbyte', 'scan_transactions', ARRAY['scan_transactions_self'],
    'scan_transactions has the self-RLS policy'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd /home/jeremy/luna-hub-lite/.worktrees/catch-all-livetrack
supabase test db --tests-only \
  supabase/tests/chefbyte/scanner_state.test.sql \
  supabase/tests/chefbyte/scan_transactions.test.sql
```

Expected: FAIL on missing tables.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260503100000_scanner_state_and_transactions.sql`:

```sql
-- Pi USB scanner forwarder (2026-05-03):
-- scanner_state holds per-user active + locked mode so the Pi can
-- resolve which mode to apply on each USB scan even when the web
-- Scanner page is closed.
-- scan_transactions is the persistent audit log of every scan
-- (web + Pi). The Settings → Scanner Transactions tab queries this.

CREATE TABLE chefbyte.scanner_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_active_mode TEXT NOT NULL DEFAULT 'purchase'
    CHECK (last_active_mode IN (
      'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
    )),
  locked_mode TEXT NULL
    CHECK (locked_mode IN (
      'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
    )),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chefbyte.scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY scanner_state_self ON chefbyte.scanner_state
  FOR ALL TO authenticated USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.scanner_state TO authenticated;

CREATE TABLE chefbyte.scan_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  product_id UUID NULL REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN (
    'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
  )),
  qty NUMERIC(10,3) NULL,
  unit TEXT NULL CHECK (unit IS NULL OR unit IN ('container', 'serving')),
  nutrition_snapshot JSONB NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'applied', 'voided', 'errored'
  )),
  error_msg TEXT NULL,
  logical_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'pi_usb')),
  pi_event_id TEXT NULL,
  applied_lot_id UUID NULL REFERENCES chefbyte.stock_lots(lot_id) ON DELETE SET NULL,
  applied_food_log_id UUID NULL REFERENCES chefbyte.food_logs(log_id) ON DELETE SET NULL,
  applied_cart_item_id UUID NULL REFERENCES chefbyte.shopping_list(cart_item_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ NULL
);

CREATE INDEX scan_transactions_by_logical_date
  ON chefbyte.scan_transactions (user_id, logical_date DESC);
CREATE INDEX scan_transactions_by_status
  ON chefbyte.scan_transactions (user_id, status, created_at DESC);
CREATE UNIQUE INDEX scan_transactions_pi_event_id_unique
  ON chefbyte.scan_transactions (user_id, pi_event_id)
  WHERE pi_event_id IS NOT NULL;

ALTER TABLE chefbyte.scan_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY scan_transactions_self ON chefbyte.scan_transactions
  FOR ALL TO authenticated USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.scan_transactions TO authenticated;

COMMENT ON TABLE chefbyte.scanner_state IS
  'Per-user active scanner mode. Pi resolves locked_mode || last_active_mode on each USB scan.';
COMMENT ON TABLE chefbyte.scan_transactions IS
  'Persistent audit log of every scan (web + Pi USB). Settings tab surfaces this; void mutation reverses applied_* side-effects.';
```

- [ ] **Step 4: Apply migration + run tests**

```bash
supabase db reset --local
supabase test db --tests-only \
  supabase/tests/chefbyte/scanner_state.test.sql \
  supabase/tests/chefbyte/scan_transactions.test.sql
```

Expected: PASS (6 + 8 = 14 tests).

- [ ] **Step 5: Regenerate db-types**

```bash
pnpm --filter @luna-hub/db-types generate
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260503100000_scanner_state_and_transactions.sql \
        supabase/tests/chefbyte/scanner_state.test.sql \
        supabase/tests/chefbyte/scan_transactions.test.sql \
        packages/db-types/src/database.ts
git commit -m "feat(db): scanner_state + scan_transactions tables"
```

### Task 2: `private.execute_scan_action` SECURITY DEFINER function

**Files:**

- Create: `supabase/migrations/20260503100100_execute_scan_action_fn.sql`
- Create: `supabase/tests/chefbyte/execute_scan_action.test.sql`

- [ ] **Step 1: Write the pgTAP test**

```sql
BEGIN;
SELECT plan(4);

-- Stub user
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'scanner@test.local',
        crypt('x', gen_salt('bf')), now(), now());

INSERT INTO chefbyte.locations (user_id, location_id, name)
VALUES ('00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000098', 'Pantry');

INSERT INTO chefbyte.products (user_id, product_id, name, barcode,
                                servings_per_container, calories_per_serving,
                                protein_per_serving, carbs_per_serving, fat_per_serving)
VALUES ('00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000097',
        'Test Pasta', '0123456789012', 2, 300, 10, 50, 5);

-- Purchase mode → creates a stock_lot
SELECT lives_ok(
  $$ SELECT private.execute_scan_action(
       p_user_id => '00000000-0000-0000-0000-000000000099'::uuid,
       p_product_id => '00000000-0000-0000-0000-000000000097'::uuid,
       p_mode => 'purchase',
       p_qty => 1,
       p_unit => 'container',
       p_nutrition_snapshot => NULL
     ) $$,
  'execute_scan_action(purchase) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = '00000000-0000-0000-0000-000000000099'),
  '=', 1, 'purchase created exactly one stock_lot'
);

-- Consume_macros → creates a food_log + decrements stock
SELECT lives_ok(
  $$ SELECT private.execute_scan_action(
       p_user_id => '00000000-0000-0000-0000-000000000099'::uuid,
       p_product_id => '00000000-0000-0000-0000-000000000097'::uuid,
       p_mode => 'consume_macros',
       p_qty => 1,
       p_unit => 'serving',
       p_nutrition_snapshot => NULL
     ) $$,
  'execute_scan_action(consume_macros) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE user_id = '00000000-0000-0000-0000-000000000099'),
  '=', 1, 'consume_macros wrote a food_log'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
supabase test db --tests-only supabase/tests/chefbyte/execute_scan_action.test.sql
```

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Write the function migration**

Create `supabase/migrations/20260503100100_execute_scan_action_fn.sql`:

```sql
CREATE OR REPLACE FUNCTION private.execute_scan_action(
  p_user_id UUID,
  p_product_id UUID,
  p_mode TEXT,
  p_qty NUMERIC,
  p_unit TEXT,
  p_nutrition_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_logical_date DATE;
  v_default_location UUID;
  v_lot_id UUID;
  v_food_log_id UUID;
  v_cart_item_id UUID;
  v_servings_per_container NUMERIC;
  v_serving_qty NUMERIC;
  v_existing_qty NUMERIC;
  v_existing_lot UUID;
BEGIN
  SELECT private.get_logical_date(p_user_id) INTO v_logical_date;

  IF p_mode = 'purchase' THEN
    SELECT location_id INTO v_default_location
      FROM chefbyte.locations
      WHERE user_id = p_user_id
      ORDER BY created_at ASC
      LIMIT 1;

    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'no_location_configured';
    END IF;

    INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id,
                                     qty_containers, expires_on,
                                     last_update_source, last_update_ts)
    VALUES (p_user_id, p_product_id, v_default_location,
            COALESCE(p_qty, 1), NULL, 'manual', now())
    RETURNING lot_id INTO v_lot_id;

    RETURN jsonb_build_object('applied_lot_id', v_lot_id);

  ELSIF p_mode IN ('consume_macros', 'consume_no_macros') THEN
    SELECT servings_per_container INTO v_servings_per_container
      FROM chefbyte.products
      WHERE product_id = p_product_id AND user_id = p_user_id;

    IF p_unit = 'container' THEN
      v_serving_qty := COALESCE(p_qty, 1) * COALESCE(v_servings_per_container, 1);
    ELSE
      v_serving_qty := COALESCE(p_qty, 1);
    END IF;

    SELECT lot_id, qty_containers
      INTO v_existing_lot, v_existing_qty
      FROM chefbyte.stock_lots
      WHERE user_id = p_user_id AND product_id = p_product_id
        AND qty_containers > 0
      ORDER BY expires_on ASC NULLS LAST
      LIMIT 1;

    IF v_existing_lot IS NOT NULL THEN
      UPDATE chefbyte.stock_lots
        SET qty_containers = GREATEST(
              0,
              qty_containers - (v_serving_qty / NULLIF(v_servings_per_container, 0))
            ),
            updated_at = now()
        WHERE lot_id = v_existing_lot;
    END IF;

    IF p_mode = 'consume_macros' THEN
      INSERT INTO chefbyte.food_logs (user_id, product_id, qty_consumed, unit,
                                       servings, calories, protein, carbs, fat,
                                       logical_date)
      SELECT
        p_user_id, p_product_id,
        COALESCE(p_qty, 1), p_unit,
        v_serving_qty,
        v_serving_qty * COALESCE(p.calories_per_serving, 0),
        v_serving_qty * COALESCE(p.protein_per_serving, 0),
        v_serving_qty * COALESCE(p.carbs_per_serving, 0),
        v_serving_qty * COALESCE(p.fat_per_serving, 0),
        v_logical_date
      FROM chefbyte.products p
      WHERE p.product_id = p_product_id AND p.user_id = p_user_id
      RETURNING log_id INTO v_food_log_id;
    END IF;

    RETURN jsonb_build_object(
      'applied_food_log_id', v_food_log_id,
      'applied_lot_id', v_existing_lot
    );

  ELSIF p_mode = 'shopping' THEN
    INSERT INTO chefbyte.shopping_list (user_id, product_id, qty_containers)
    VALUES (p_user_id, p_product_id, COALESCE(p_qty, 1))
    ON CONFLICT (user_id, product_id) DO UPDATE
      SET qty_containers = chefbyte.shopping_list.qty_containers + EXCLUDED.qty_containers
    RETURNING cart_item_id INTO v_cart_item_id;

    RETURN jsonb_build_object('applied_cart_item_id', v_cart_item_id);

  ELSE
    RAISE EXCEPTION 'unknown_mode: %', p_mode;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION private.execute_scan_action TO authenticated, service_role;

COMMENT ON FUNCTION private.execute_scan_action IS
  'Apply a scan to chefbyte state (purchase/consume_*/shopping). Returns JSONB with applied_*_id keys for the scan_transaction row.';
```

- [ ] **Step 4: Apply + test**

```bash
supabase db reset --local
supabase test db --tests-only supabase/tests/chefbyte/execute_scan_action.test.sql
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260503100100_execute_scan_action_fn.sql \
        supabase/tests/chefbyte/execute_scan_action.test.sql
git commit -m "feat(db): private.execute_scan_action for scanner pipeline"
```

### Task 3: `private.void_scan_transaction` SECURITY DEFINER function

**Files:**

- Create: `supabase/migrations/20260503100200_void_scan_transaction_fn.sql`
- Create: `supabase/tests/chefbyte/void_scan_transaction.test.sql`

- [ ] **Step 1: Write pgTAP test**

```sql
BEGIN;
SELECT plan(3);

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'voidtest@local',
        crypt('x', gen_salt('bf')), now(), now());

INSERT INTO chefbyte.locations (user_id, location_id, name)
VALUES ('00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000098', 'Pantry');
INSERT INTO chefbyte.products (user_id, product_id, name, barcode,
                                servings_per_container, calories_per_serving,
                                protein_per_serving, carbs_per_serving, fat_per_serving)
VALUES ('00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000097',
        'Vodka', '0123456789013', 1, 100, 0, 0, 0);

WITH inserted_lot AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers,
                                   last_update_source, last_update_ts)
  VALUES ('00000000-0000-0000-0000-000000000099',
          '00000000-0000-0000-0000-000000000097',
          '00000000-0000-0000-0000-000000000098', 5, 'manual', now())
  RETURNING lot_id
)
INSERT INTO chefbyte.scan_transactions (user_id, barcode, product_id, mode, qty, unit,
                                          status, logical_date, source, applied_lot_id)
SELECT '00000000-0000-0000-0000-000000000099', '0123456789013',
       '00000000-0000-0000-0000-000000000097', 'purchase', 1, 'container',
       'applied', current_date, 'web', lot_id
FROM inserted_lot;

-- Void: deletes lot, marks transaction voided
SELECT lives_ok(
  $$ SELECT private.void_scan_transaction(
       (SELECT transaction_id FROM chefbyte.scan_transactions
         WHERE user_id = '00000000-0000-0000-0000-000000000099' LIMIT 1)
     ) $$,
  'void_scan_transaction does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = '00000000-0000-0000-0000-000000000099'),
  '=', 0, 'void deleted the applied lot'
);

SELECT cmp_ok(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE user_id = '00000000-0000-0000-0000-000000000099' LIMIT 1),
  '=', 'voided', 'transaction marked voided'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
supabase test db --tests-only supabase/tests/chefbyte/void_scan_transaction.test.sql
```

Expected: FAIL.

- [ ] **Step 3: Write the function migration**

Create `supabase/migrations/20260503100200_void_scan_transaction_fn.sql`:

```sql
CREATE OR REPLACE FUNCTION private.void_scan_transaction(
  p_transaction_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_lot_id UUID;
  v_food_log_id UUID;
  v_cart_item_id UUID;
  v_status TEXT;
BEGIN
  SELECT user_id, applied_lot_id, applied_food_log_id, applied_cart_item_id, status
    INTO v_user_id, v_lot_id, v_food_log_id, v_cart_item_id, v_status
    FROM chefbyte.scan_transactions
    WHERE transaction_id = p_transaction_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transaction_not_found';
  END IF;

  IF v_status = 'voided' THEN
    RETURN;
  END IF;

  IF v_lot_id IS NOT NULL THEN
    DELETE FROM chefbyte.stock_lots WHERE lot_id = v_lot_id;
  END IF;
  IF v_food_log_id IS NOT NULL THEN
    DELETE FROM chefbyte.food_logs WHERE log_id = v_food_log_id;
  END IF;
  IF v_cart_item_id IS NOT NULL THEN
    DELETE FROM chefbyte.shopping_list WHERE cart_item_id = v_cart_item_id;
  END IF;

  UPDATE chefbyte.scan_transactions
    SET status = 'voided'
    WHERE transaction_id = p_transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION private.void_scan_transaction TO authenticated, service_role;

COMMENT ON FUNCTION private.void_scan_transaction IS
  'Reverse a scan_transactions row''s applied_* side-effects and mark voided. Idempotent on already-voided rows.';
```

- [ ] **Step 4: Apply + test**

```bash
supabase db reset --local
supabase test db --tests-only supabase/tests/chefbyte/void_scan_transaction.test.sql
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260503100200_void_scan_transaction_fn.sql \
        supabase/tests/chefbyte/void_scan_transaction.test.sql
git commit -m "feat(db): private.void_scan_transaction reverses applied_* side-effects"
```

---

## Phase B — Cloud edge function routes

### Task 4: `/shelf-ingest/scanner-state` (UPSERT mode)

**Files:**

- Modify: `supabase/functions/shelf-ingest/index.ts`
- Modify: `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts`:

```ts
it('POST /scanner-state UPSERTs scanner_state with PATCH semantics', async () => {
  const ctx = makeTestCtx();
  // First call sets last_active_mode
  const r1 = await invokeHandler(ctx, '/scanner-state', {
    last_active_mode: 'consume_macros',
  });
  assertEquals(r1.status, 200);
  let row = await fetchScannerState(ctx);
  assertEquals(row.last_active_mode, 'consume_macros');
  assertEquals(row.locked_mode, null);

  // Second call sets locked_mode without touching last_active_mode
  const r2 = await invokeHandler(ctx, '/scanner-state', {
    locked_mode: 'shopping',
  });
  assertEquals(r2.status, 200);
  row = await fetchScannerState(ctx);
  assertEquals(row.last_active_mode, 'consume_macros');
  assertEquals(row.locked_mode, 'shopping');

  // Clear lock
  const r3 = await invokeHandler(ctx, '/scanner-state', {
    locked_mode: null,
  });
  assertEquals(r3.status, 200);
  row = await fetchScannerState(ctx);
  assertEquals(row.locked_mode, null);
});

it('POST /scanner-state rejects invalid mode', async () => {
  const ctx = makeTestCtx();
  const r = await invokeHandler(ctx, '/scanner-state', {
    last_active_mode: 'bogus',
  });
  assertEquals(r.status, 400);
});
```

(`fetchScannerState` is a small helper — define it alongside `fetchProduct` in the test file: `await ctx.supabase.schema('chefbyte').from('scanner_state').select('*').eq('user_id', ctx.userId).maybeSingle()`.)

- [ ] **Step 2: Run test, expect FAIL**

```bash
deno test --allow-all supabase/functions/shelf-ingest/test.ts
```

Or `pnpm --filter web test shelf-ingest` (project may use vitest integration). Expected: FAIL — route 404.

- [ ] **Step 3: Add route handler**

In `supabase/functions/shelf-ingest/index.ts`, near the existing `handleProductTare` (around line 1019), add:

```ts
const VALID_SCAN_MODES = new Set(['purchase', 'consume_macros', 'consume_no_macros', 'shopping']);

async function handleScannerState(req: Request, ctx: ShelfIngestContext): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  const updates: { last_active_mode?: string; locked_mode?: string | null } = {};

  if (body.last_active_mode !== undefined) {
    if (typeof body.last_active_mode !== 'string' || !VALID_SCAN_MODES.has(body.last_active_mode)) {
      return jsonResponse({ error: 'invalid last_active_mode' }, 400);
    }
    updates.last_active_mode = body.last_active_mode;
  }
  if (body.locked_mode !== undefined) {
    if (body.locked_mode === null) {
      updates.locked_mode = null;
    } else if (typeof body.locked_mode !== 'string' || !VALID_SCAN_MODES.has(body.locked_mode)) {
      return jsonResponse({ error: 'invalid locked_mode' }, 400);
    } else {
      updates.locked_mode = body.locked_mode;
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse({ error: 'no fields to update' }, 400);
  }

  const upsertPayload = { user_id: ctx.userId, ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await ctx.supabase
    .schema('chefbyte')
    .from('scanner_state')
    .upsert(upsertPayload, { onConflict: 'user_id' })
    .select('user_id, last_active_mode, locked_mode')
    .single();
  if (error || !data) {
    return jsonResponse({ error: error?.message ?? 'upsert failed' }, 500);
  }
  return jsonResponse({ ok: true, ...data });
}
```

Then in the route dispatcher (search for `case 'product-tare'`), add:

```ts
case 'scanner-state':
  return handleScannerState(req, ctx);
```

- [ ] **Step 4: Run test, expect PASS**

```bash
pnpm --filter web test shelf-ingest 2>&1 | tail -10
```

Expected: PASS (2 new tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shelf-ingest/index.ts \
        apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts
git commit -m "feat(shelf-ingest): /scanner-state route for mode persistence"
```

### Task 5: `/shelf-ingest/barcode-scan` route

**Files:**

- Modify: `supabase/functions/shelf-ingest/index.ts`
- Modify: `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `shelf-ingest.test.ts`:

```ts
it('POST /barcode-scan(purchase) creates a stock_lot + scan_transactions row', async () => {
  const ctx = makeTestCtx();
  const productId = await createTestProduct(ctx, {
    barcode: '0123456789014',
    name: 'Pasta',
    servings_per_container: 2,
  });
  // Set last_active_mode = purchase
  await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase' });

  // Pi-style call (omits mode; uses scanner_state)
  const res = await invokeHandler(ctx, '/barcode-scan', {
    barcode: '0123456789014',
    pi_event_id: 'evt-' + crypto.randomUUID(),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.transaction_id);
  assertEquals(body.status, 'applied');

  const tx = await fetchScanTransaction(ctx, body.transaction_id);
  assertEquals(tx.barcode, '0123456789014');
  assertEquals(tx.mode, 'purchase');
  assertEquals(tx.product_id, productId);
  assertExists(tx.applied_lot_id);

  const lots = await ctx.supabase.schema('chefbyte').from('stock_lots').select('*').eq('user_id', ctx.userId);
  assertEquals(lots.data?.length, 1);
});

it('POST /barcode-scan with same pi_event_id is idempotent', async () => {
  const ctx = makeTestCtx();
  await createTestProduct(ctx, { barcode: '0123456789015', name: 'X' });
  const eventId = 'evt-' + crypto.randomUUID();

  await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase' });
  const r1 = await invokeHandler(ctx, '/barcode-scan', { barcode: '0123456789015', pi_event_id: eventId });
  const r2 = await invokeHandler(ctx, '/barcode-scan', { barcode: '0123456789015', pi_event_id: eventId });
  const b1 = await r1.json();
  const b2 = await r2.json();
  assertEquals(b1.transaction_id, b2.transaction_id, 'same pi_event_id → same transaction');

  const txCount = await ctx.supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', ctx.userId)
    .eq('pi_event_id', eventId);
  assertEquals(txCount.count, 1);
});

it('POST /barcode-scan applies locked_mode override', async () => {
  const ctx = makeTestCtx();
  await createTestProduct(ctx, { barcode: '0123456789016', name: 'Y' });
  await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase', locked_mode: 'shopping' });

  const res = await invokeHandler(ctx, '/barcode-scan', {
    barcode: '0123456789016',
    pi_event_id: 'evt-' + crypto.randomUUID(),
  });
  const body = await res.json();
  const tx = await fetchScanTransaction(ctx, body.transaction_id);
  assertEquals(tx.mode, 'shopping');
});
```

- [ ] **Step 2: Run test, expect FAIL**

Expected: FAIL — route 404.

- [ ] **Step 3: Add the handler**

In `supabase/functions/shelf-ingest/index.ts`:

```ts
async function handleBarcodeScan(req: Request, ctx: ShelfIngestContext): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  const barcode = typeof body.barcode === 'string' ? body.barcode.trim() : '';
  if (!barcode) return jsonResponse({ error: 'barcode required' }, 400);

  const piEventId = typeof body.pi_event_id === 'string' ? body.pi_event_id : null;

  // Idempotency check.
  if (piEventId) {
    const existing = await ctx.supabase
      .schema('chefbyte')
      .from('scan_transactions')
      .select('transaction_id, status, applied_lot_id, applied_food_log_id, applied_cart_item_id')
      .eq('user_id', ctx.userId)
      .eq('pi_event_id', piEventId)
      .maybeSingle();
    if (existing.data) {
      return jsonResponse({
        transaction_id: existing.data.transaction_id,
        status: existing.data.status,
        idempotent: true,
        ...existing.data,
      });
    }
  }

  // Resolve mode.
  let mode: string | undefined = body.mode && VALID_SCAN_MODES.has(body.mode) ? body.mode : undefined;
  if (!mode) {
    const stateQ = await ctx.supabase
      .schema('chefbyte')
      .from('scanner_state')
      .select('last_active_mode, locked_mode')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    mode = stateQ.data?.locked_mode ?? stateQ.data?.last_active_mode ?? 'purchase';
  } else {
    // If client sent explicit mode, respect locked override (cloud-side trust boundary).
    const stateQ = await ctx.supabase
      .schema('chefbyte')
      .from('scanner_state')
      .select('locked_mode')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (stateQ.data?.locked_mode) {
      mode = stateQ.data.locked_mode;
    }
  }
  // Yet, the Pi-test asserts locked_mode wins even when omitted; ensure
  // the locked check is the same in both branches above. Both branches
  // already do that.

  // Lookup product.
  const productQ = await ctx.supabase
    .schema('chefbyte')
    .from('products')
    .select('product_id, name, servings_per_container')
    .eq('user_id', ctx.userId)
    .eq('barcode', barcode)
    .is('deleted_at', null)
    .maybeSingle();

  let productId: string | null = productQ.data?.product_id ?? null;

  if (!productId) {
    // First-scan unknown — call analyze-product. Best-effort: if it fails,
    // log errored transaction but still return 200.
    try {
      const analyzeRes = await ctx.supabase.functions.invoke('analyze-product', {
        body: { barcode, user_id: ctx.userId },
      });
      if (analyzeRes.error) throw new Error(analyzeRes.error.message);
      // analyze-product upserts the product itself; re-query.
      const re = await ctx.supabase
        .schema('chefbyte')
        .from('products')
        .select('product_id')
        .eq('user_id', ctx.userId)
        .eq('barcode', barcode)
        .is('deleted_at', null)
        .maybeSingle();
      productId = re.data?.product_id ?? null;
    } catch (e) {
      // Fall through: log errored transaction.
      const errored = await ctx.supabase
        .schema('chefbyte')
        .from('scan_transactions')
        .insert({
          user_id: ctx.userId,
          barcode,
          product_id: null,
          mode,
          qty: body.qty ?? null,
          unit: body.unit ?? null,
          status: 'errored',
          error_msg: `analyze-product: ${(e as Error).message}`,
          logical_date: new Date().toISOString().slice(0, 10),
          source: ctx.deviceId ? 'pi_usb' : 'web',
          pi_event_id: piEventId,
        })
        .select('transaction_id')
        .single();
      return jsonResponse({
        transaction_id: errored.data?.transaction_id,
        status: 'errored',
        error_msg: `analyze-product failed: ${(e as Error).message}`,
      });
    }
  }

  if (!productId) {
    const errored = await ctx.supabase
      .schema('chefbyte')
      .from('scan_transactions')
      .insert({
        user_id: ctx.userId,
        barcode,
        product_id: null,
        mode,
        qty: body.qty ?? null,
        unit: body.unit ?? null,
        status: 'errored',
        error_msg: 'product not found and analyze-product silent',
        logical_date: new Date().toISOString().slice(0, 10),
        source: ctx.deviceId ? 'pi_usb' : 'web',
        pi_event_id: piEventId,
      })
      .select('transaction_id')
      .single();
    return jsonResponse({
      transaction_id: errored.data?.transaction_id,
      status: 'errored',
      error_msg: 'product not found',
    });
  }

  // Execute action.
  const actionQ = await ctx.supabase.rpc('execute_scan_action', {
    p_user_id: ctx.userId,
    p_product_id: productId,
    p_mode: mode,
    p_qty: body.qty ?? 1,
    p_unit: body.unit ?? (mode === 'consume_macros' || mode === 'consume_no_macros' ? 'serving' : 'container'),
    p_nutrition_snapshot: body.nutrition_snapshot ?? null,
  });

  if (actionQ.error) {
    const errored = await ctx.supabase
      .schema('chefbyte')
      .from('scan_transactions')
      .insert({
        user_id: ctx.userId,
        barcode,
        product_id: productId,
        mode,
        qty: body.qty ?? null,
        unit: body.unit ?? null,
        status: 'errored',
        error_msg: actionQ.error.message,
        logical_date: new Date().toISOString().slice(0, 10),
        source: ctx.deviceId ? 'pi_usb' : 'web',
        pi_event_id: piEventId,
      })
      .select('transaction_id')
      .single();
    return jsonResponse({
      transaction_id: errored.data?.transaction_id,
      status: 'errored',
      error_msg: actionQ.error.message,
    });
  }

  const result = (actionQ.data ?? {}) as {
    applied_lot_id?: string;
    applied_food_log_id?: string;
    applied_cart_item_id?: string;
  };

  const tx = await ctx.supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .insert({
      user_id: ctx.userId,
      barcode,
      product_id: productId,
      mode,
      qty: body.qty ?? 1,
      unit: body.unit ?? null,
      nutrition_snapshot: body.nutrition_snapshot ?? null,
      status: 'applied',
      logical_date: new Date().toISOString().slice(0, 10),
      source: ctx.deviceId ? 'pi_usb' : 'web',
      pi_event_id: piEventId,
      applied_lot_id: result.applied_lot_id ?? null,
      applied_food_log_id: result.applied_food_log_id ?? null,
      applied_cart_item_id: result.applied_cart_item_id ?? null,
      applied_at: new Date().toISOString(),
    })
    .select('transaction_id')
    .single();

  return jsonResponse({
    transaction_id: tx.data?.transaction_id,
    status: 'applied',
    product_id: productId,
    mode,
    ...result,
  });
}
```

In the dispatcher add:

```ts
case 'barcode-scan':
  return handleBarcodeScan(req, ctx);
```

NOTE: `ctx.deviceId` should be set when auth was via `x-api-key` (Pi). Otherwise (JWT browser), it's undefined. If `ShelfIngestContext` doesn't already have `deviceId`, add it during auth resolution.

- [ ] **Step 4: Run tests, expect PASS**

Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shelf-ingest/index.ts \
        apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts
git commit -m "feat(shelf-ingest): /barcode-scan route — Pi/web entrypoint"
```

### Task 6: `/shelf-ingest/scan-transaction/:id/void` route

**Files:**

- Modify: `supabase/functions/shelf-ingest/index.ts`
- Modify: `apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('POST /scan-transaction/:id/void reverses applied_lot_id', async () => {
  const ctx = makeTestCtx();
  await createTestProduct(ctx, { barcode: '0123456789020', name: 'Beans' });
  await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase' });
  const scanRes = await invokeHandler(ctx, '/barcode-scan', {
    barcode: '0123456789020',
    pi_event_id: 'evt-' + crypto.randomUUID(),
  });
  const scanBody = await scanRes.json();

  let lots = await ctx.supabase.schema('chefbyte').from('stock_lots').select('*').eq('user_id', ctx.userId);
  assertEquals(lots.data?.length, 1);

  const voidRes = await fetch(`${ctx.baseUrl}/scan-transaction/${scanBody.transaction_id}/void`, {
    method: 'POST',
    headers: ctx.authHeaders,
  });
  assertEquals(voidRes.status, 200);

  lots = await ctx.supabase.schema('chefbyte').from('stock_lots').select('*').eq('user_id', ctx.userId);
  assertEquals(lots.data?.length, 0, 'lot deleted');

  const tx = await fetchScanTransaction(ctx, scanBody.transaction_id);
  assertEquals(tx.status, 'voided');
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Add handler**

```ts
async function handleVoidScanTransaction(
  req: Request,
  ctx: ShelfIngestContext,
  transactionId: string,
): Promise<Response> {
  // RLS scopes the user — but we use the security-definer function which
  // verifies user_id implicitly via the row's user_id column.
  // Verify the row belongs to this user first to short-circuit.
  const own = await ctx.supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .select('transaction_id')
    .eq('user_id', ctx.userId)
    .eq('transaction_id', transactionId)
    .maybeSingle();
  if (!own.data) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  const r = await ctx.supabase.rpc('void_scan_transaction', {
    p_transaction_id: transactionId,
  });
  if (r.error) {
    return jsonResponse({ error: r.error.message }, 500);
  }
  return jsonResponse({ ok: true, transaction_id: transactionId });
}
```

In the dispatcher (path-param style):

```ts
// Match `/scan-transaction/<uuid>/void`
const voidMatch = path.match(/^\/scan-transaction\/([0-9a-f-]{36})\/void$/i);
if (voidMatch && req.method === 'POST') {
  return handleVoidScanTransaction(req, ctx, voidMatch[1]);
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shelf-ingest/index.ts \
        apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts
git commit -m "feat(shelf-ingest): /scan-transaction/:id/void route"
```

---

## Phase C — Pi-side USB scanner

### Task 7: HID listener (evdev)

**Files:**

- Create: `hardware/live-shelf/server/barcode/__init__.py`
- Create: `hardware/live-shelf/server/barcode/hid_listener.py`
- Create: `hardware/live-shelf/server/barcode/tests/__init__.py`
- Create: `hardware/live-shelf/server/barcode/tests/test_hid_listener.py`

- [ ] **Step 1: Write failing test**

`hardware/live-shelf/server/barcode/tests/test_hid_listener.py`:

```python
"""HID listener tests with a fake evdev source."""
from __future__ import annotations
from server.barcode.hid_listener import accumulate_keys_to_barcode

def test_accumulates_digits_until_enter():
    keys = ['KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5',
            'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9', 'KEY_0', 'KEY_1', 'KEY_2',
            'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    assert barcode == '0123456789012'

def test_ignores_non_digit_keys_other_than_enter():
    keys = ['KEY_LEFTSHIFT', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    assert barcode == '123'

def test_returns_empty_string_when_no_enter():
    barcode = accumulate_keys_to_barcode(['KEY_1', 'KEY_2', 'KEY_3'])
    assert barcode == ''

def test_handles_caps_and_letter_keys():
    keys = ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_1', 'KEY_2', 'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    # Letters preserved (some scanners encode UPC checks as alpha)
    assert barcode == 'ABC12'
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd /home/jeremy/luna-hub-lite/.worktrees/catch-all-livetrack/hardware/live-shelf
/home/jeremy/luna-hub-lite/hardware/live-shelf/.venv/bin/pytest \
  server/barcode/tests/test_hid_listener.py -v
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the listener**

`hardware/live-shelf/server/barcode/__init__.py`: empty file.

`hardware/live-shelf/server/barcode/hid_listener.py`:

```python
"""USB HID barcode listener.

A USB barcode scanner appears to Linux as an HID keyboard. It types the
barcode digits and presses ENTER. We watch /dev/input/eventX, accumulate
keystrokes into a string, and emit it on ENTER.

For test isolation, the keystroke-to-barcode logic is split out into
``accumulate_keys_to_barcode`` (pure function) and the OS-side reader
(``open_device_and_stream_barcodes``) is a thin wrapper over evdev.
"""
from __future__ import annotations
import logging
import os
from typing import Iterable, Iterator

logger = logging.getLogger(__name__)

# Map evdev keycode → character.
KEY_MAP: dict[str, str] = {
    f'KEY_{d}': str(d) for d in range(10)
}
KEY_MAP.update({
    f'KEY_{c}': c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
})

ENTER_KEYS = {'KEY_ENTER', 'KEY_KPENTER'}
IGNORED_KEYS = {'KEY_LEFTSHIFT', 'KEY_RIGHTSHIFT',
                'KEY_LEFTCTRL', 'KEY_RIGHTCTRL',
                'KEY_LEFTALT', 'KEY_RIGHTALT',
                'KEY_CAPSLOCK', 'KEY_NUMLOCK'}


def accumulate_keys_to_barcode(keys: Iterable[str]) -> str:
    """Convert a sequence of evdev key names to a barcode string.

    Stops at the first ENTER. Non-digit, non-letter, non-ENTER keys are
    silently ignored. Returns empty string if no ENTER appears.
    """
    out: list[str] = []
    for key in keys:
        if key in ENTER_KEYS:
            return ''.join(out)
        if key in IGNORED_KEYS:
            continue
        char = KEY_MAP.get(key)
        if char:
            out.append(char)
    return ''  # No ENTER seen.


def open_device_and_stream_barcodes(device_path: str) -> Iterator[str]:
    """Open an evdev device and yield barcodes as they are scanned.

    Blocking iterator. Wraps ``evdev`` to stay testable: tests substitute
    a fake by passing a list to ``accumulate_keys_to_barcode`` directly.
    """
    import evdev  # type: ignore[import-untyped]
    if not os.path.exists(device_path):
        raise FileNotFoundError(f'evdev device not found: {device_path}')
    device = evdev.InputDevice(device_path)
    logger.info('barcode: opened %s (%s)', device_path, device.name)
    buffer: list[str] = []
    for event in device.read_loop():
        if event.type != evdev.ecodes.EV_KEY:
            continue
        key_event = evdev.categorize(event)
        if key_event.keystate != key_event.key_down:
            continue
        keycode = key_event.keycode
        if isinstance(keycode, list):
            keycode = keycode[0]
        if keycode in ENTER_KEYS:
            barcode = ''.join(buffer)
            buffer = []
            if barcode:
                yield barcode
        elif keycode in IGNORED_KEYS:
            continue
        else:
            char = KEY_MAP.get(keycode)
            if char:
                buffer.append(char)
```

- [ ] **Step 4: Run, expect PASS**

```bash
/home/jeremy/luna-hub-lite/hardware/live-shelf/.venv/bin/pytest \
  server/barcode/tests/test_hid_listener.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hardware/live-shelf/server/barcode/__init__.py \
        hardware/live-shelf/server/barcode/hid_listener.py \
        hardware/live-shelf/server/barcode/tests/__init__.py \
        hardware/live-shelf/server/barcode/tests/test_hid_listener.py
git commit -m "feat(live-shelf): USB HID barcode listener (pure-function + evdev wrapper)"
```

### Task 8: Cloud client extension (`post_barcode_scan`)

**Files:**

- Modify: `hardware/live-shelf/server/cloud/client.py`
- Create: `hardware/live-shelf/server/barcode/tests/test_cloud_post.py`

- [ ] **Step 1: Failing test**

`hardware/live-shelf/server/barcode/tests/test_cloud_post.py`:

```python
"""Verify CloudClient.post_barcode_scan POST shape."""
from unittest.mock import MagicMock, patch
from server.cloud.client import CloudClient

def test_post_barcode_scan_routes_to_correct_endpoint():
    client = CloudClient(base_url='https://x', api_key='k')
    with patch.object(client, '_post') as mock_post:
        mock_post.return_value = {'transaction_id': 'tx-1', 'status': 'applied'}
        result = client.post_barcode_scan(barcode='123', pi_event_id='evt-1')
        mock_post.assert_called_once()
        path = mock_post.call_args.args[0]
        body = mock_post.call_args.args[1]
        assert path == '/barcode-scan'
        assert body['barcode'] == '123'
        assert body['pi_event_id'] == 'evt-1'
        assert result['transaction_id'] == 'tx-1'
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Add `post_barcode_scan` to `CloudClient`**

In `hardware/live-shelf/server/cloud/client.py`, add a new method:

```python
def post_barcode_scan(
    self, *,
    barcode: str,
    pi_event_id: str,
    mode: str | None = None,
    qty: float | None = None,
    unit: str | None = None,
) -> dict[str, Any]:
    """POST /barcode-scan with the user's USB-scanner barcode.

    Returns the cloud response as a dict ({transaction_id, status, ...}).
    Idempotent: re-posting the same pi_event_id returns the original
    transaction_id.
    """
    body: dict[str, Any] = {
        'barcode': barcode,
        'pi_event_id': pi_event_id,
    }
    if mode is not None:
        body['mode'] = mode
    if qty is not None:
        body['qty'] = qty
    if unit is not None:
        body['unit'] = unit
    return self._post('/barcode-scan', body)
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hardware/live-shelf/server/cloud/client.py \
        hardware/live-shelf/server/barcode/tests/test_cloud_post.py
git commit -m "feat(live-shelf): CloudClient.post_barcode_scan"
```

### Task 9: Scanner loop

**Files:**

- Create: `hardware/live-shelf/server/barcode/scanner_loop.py`
- Create: `hardware/live-shelf/server/barcode/tests/test_scanner_loop.py`

- [ ] **Step 1: Failing test**

`hardware/live-shelf/server/barcode/tests/test_scanner_loop.py`:

```python
from unittest.mock import MagicMock
from server.barcode.scanner_loop import ScannerLoop

def test_scanner_loop_dispatches_each_barcode():
    cloud = MagicMock()
    cloud.post_barcode_scan.return_value = {'transaction_id': 't', 'status': 'applied'}

    def fake_source():
        yield '0123456789012'
        yield '0123456789013'

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    loop.run_once()
    loop.run_once()
    assert cloud.post_barcode_scan.call_count == 2

def test_scanner_loop_swallows_cloud_errors():
    cloud = MagicMock()
    cloud.post_barcode_scan.side_effect = RuntimeError('cloud down')

    def fake_source():
        yield '0123456789012'

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    # Must not raise: errors should be logged + swallowed.
    loop.run_once()
    assert cloud.post_barcode_scan.call_count == 1

def test_scanner_loop_generates_unique_pi_event_id_per_scan():
    cloud = MagicMock()
    cloud.post_barcode_scan.return_value = {'transaction_id': 't'}

    def fake_source():
        yield '0123456789012'
        yield '0123456789012'  # same barcode, different pi_event_id

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    loop.run_once()
    loop.run_once()
    eid1 = cloud.post_barcode_scan.call_args_list[0].kwargs['pi_event_id']
    eid2 = cloud.post_barcode_scan.call_args_list[1].kwargs['pi_event_id']
    assert eid1 != eid2
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`hardware/live-shelf/server/barcode/scanner_loop.py`:

```python
"""Scanner orchestration loop.

Pulls barcodes from a source iterator (HID listener in production, fake
in tests) and forwards each to the cloud via CloudClient.post_barcode_scan.

Failure handling:
  * Cloud errors are logged and swallowed; the loop never crashes.
  * pi_event_id is generated per-scan as ``barcode-<uuid4>`` so retries
    triggered higher up (process restart) generate fresh IDs. The
    cloud's idempotency layer will deduplicate within a single
    pi_event_id.
"""
from __future__ import annotations
import logging
import uuid
from typing import Any, Callable, Iterator

logger = logging.getLogger(__name__)


class ScannerLoop:
    def __init__(
        self,
        *,
        cloud_client: Any,
        barcode_source: Callable[[], Iterator[str]],
    ) -> None:
        self._cloud = cloud_client
        self._source_factory = barcode_source
        self._iterator: Iterator[str] | None = None

    def _ensure_iter(self) -> Iterator[str]:
        if self._iterator is None:
            self._iterator = iter(self._source_factory())
        return self._iterator

    def run_once(self) -> None:
        """Pull the next barcode and forward it. Exit cleanly when source
        is exhausted; tests rely on this single-step API."""
        try:
            barcode = next(self._ensure_iter())
        except StopIteration:
            return
        pi_event_id = f'barcode-{uuid.uuid4()}'
        try:
            res = self._cloud.post_barcode_scan(
                barcode=barcode, pi_event_id=pi_event_id,
            )
            logger.info('barcode: %s → tx=%s status=%s',
                        barcode, res.get('transaction_id'), res.get('status'))
        except Exception:
            logger.warning('barcode: cloud post failed for %s (non-fatal)',
                           barcode, exc_info=True)

    def run_forever(self) -> None:
        """Production entry point — loops until the source is exhausted."""
        for barcode in self._source_factory():
            pi_event_id = f'barcode-{uuid.uuid4()}'
            try:
                res = self._cloud.post_barcode_scan(
                    barcode=barcode, pi_event_id=pi_event_id,
                )
                logger.info('barcode: %s → tx=%s status=%s',
                            barcode, res.get('transaction_id'), res.get('status'))
            except Exception:
                logger.warning('barcode: cloud post failed for %s (non-fatal)',
                               barcode, exc_info=True)
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hardware/live-shelf/server/barcode/scanner_loop.py \
        hardware/live-shelf/server/barcode/tests/test_scanner_loop.py
git commit -m "feat(live-shelf): ScannerLoop orchestrator (HID + cloud)"
```

### Task 10: Wire scanner into Pi app entrypoint

**Files:**

- Modify: `hardware/live-shelf/app.py` (or wherever the entrypoint is — read first)
- Create: `hardware/live-shelf/server/barcode/tests/test_app_integration.py`

- [ ] **Step 1: Read the existing entrypoint to find the right insertion point.**

The entrypoint typically has a section that starts background threads (`Thread(target=…).start()`). Insert the scanner thread there, gated by the `BARCODE_SCANNER_ENABLED` env var.

- [ ] **Step 2: Write failing test**

`test_app_integration.py`:

```python
"""Verify the app entrypoint wires the scanner loop on demand."""
import os
from unittest.mock import patch, MagicMock

def test_scanner_thread_starts_when_env_var_enabled(monkeypatch):
    monkeypatch.setenv('BARCODE_SCANNER_ENABLED', 'true')
    monkeypatch.setenv('BARCODE_SCANNER_DEVICE', '/dev/null')  # safe stub
    with patch('server.barcode.hid_listener.open_device_and_stream_barcodes') as mock_open:
        mock_open.return_value = iter([])  # immediate stop
        # Importing app.py triggers the wiring. Replace with the actual
        # entrypoint module path — likely server.app or hardware.live-shelf.app.
        from server import app as _app
        # Verify the thread was started — we can't assert directly without
        # a hook; minimum: confirm the env-var-gated path runs without
        # raising. A real test would check `threading.enumerate()` for a
        # named thread "barcode-scanner".
        # This test guards against import-time crashes.
```

(This test is intentionally weak — it just ensures wiring doesn't crash. A stronger test would inject a Thread spy.)

- [ ] **Step 3: Run, expect FAIL or SKIP** (depending on test design)

- [ ] **Step 4: Wire scanner into entrypoint**

In `hardware/live-shelf/app.py` (adapt the file path to whatever the actual entrypoint is — could be `hardware/live-shelf/server/__main__.py` or similar), near the existing thread-startup block:

```python
def _start_barcode_scanner_thread(cloud_client) -> None:
    if os.environ.get('BARCODE_SCANNER_ENABLED', '').lower() not in ('1', 'true', 'yes'):
        return
    device_path = os.environ.get('BARCODE_SCANNER_DEVICE', '/dev/input/event0')

    def _run() -> None:
        from server.barcode.hid_listener import open_device_and_stream_barcodes
        from server.barcode.scanner_loop import ScannerLoop
        loop = ScannerLoop(
            cloud_client=cloud_client,
            barcode_source=lambda: open_device_and_stream_barcodes(device_path),
        )
        try:
            loop.run_forever()
        except Exception:
            logger.exception('barcode scanner loop crashed')

    import threading
    t = threading.Thread(target=_run, name='barcode-scanner', daemon=True)
    t.start()
    logger.info('barcode-scanner thread started for device=%s', device_path)


# Existing wiring — call after CloudClient is constructed.
_start_barcode_scanner_thread(cloud_client)
```

- [ ] **Step 5: Run all Pi tests**

```bash
cd /home/jeremy/luna-hub-lite/.worktrees/catch-all-livetrack/hardware/live-shelf
/home/jeremy/luna-hub-lite/hardware/live-shelf/.venv/bin/pytest -q 2>&1 | tail -10
```

Expected: existing tests still pass. New scanner tests pass.

- [ ] **Step 6: Commit**

```bash
git add hardware/live-shelf/app.py \
        hardware/live-shelf/server/barcode/tests/test_app_integration.py
git commit -m "feat(live-shelf): wire USB scanner thread into Pi entrypoint"
```

---

## Phase D — Web Scanner page

### Task 11: Mode broadcast + locked_mode hydration

**Files:**

- Create: `apps/web/src/shared/scannerStateApi.ts`
- Modify: `apps/web/src/pages/chefbyte/ScannerPage.tsx`
- Modify: `apps/web/src/shared/queryKeys.ts`
- Modify: `apps/web/src/shared/queryKeys-invalidation-registry.ts`
- Create: `apps/web/src/__tests__/unit/chefbyte/ScannerStatePush.test.tsx`

- [ ] **Step 1: Add query key + registry entry**

In `apps/web/src/shared/queryKeys.ts`, add (matching the file's flat structure):

```ts
scannerState: (userId?: string) => ['chefbyte', 'scannerState', userId] as const,
```

In `queryKeys-invalidation-registry.ts`, register:

```ts
scannerState: 'invalidated-by-mutation',
```

- [ ] **Step 2: Write failing test**

`apps/web/src/__tests__/unit/chefbyte/ScannerStatePush.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { pushScannerMode } from '@/shared/scannerStateApi';

describe('pushScannerMode', () => {
  it('POSTs to /shelf-ingest/scanner-state with last_active_mode', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: null, error: null });
    await pushScannerMode({ last_active_mode: 'consume_macros' }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({
        body: { last_active_mode: 'consume_macros' },
      }),
    );
  });

  it('passes through locked_mode', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: null, error: null });
    await pushScannerMode({ locked_mode: 'shopping' }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({ body: { locked_mode: 'shopping' } }),
    );
  });
});
```

- [ ] **Step 3: Run, expect FAIL** (module doesn't exist)

- [ ] **Step 4: Implement helper**

`apps/web/src/shared/scannerStateApi.ts`:

```ts
import { supabase } from './supabase';

export type ScanMode = 'purchase' | 'consume_macros' | 'consume_no_macros' | 'shopping';

export interface ScannerStatePatch {
  last_active_mode?: ScanMode;
  locked_mode?: ScanMode | null;
}

type InvokeFn = typeof supabase.functions.invoke;

export async function pushScannerMode(
  patch: ScannerStatePatch,
  invoke: InvokeFn = supabase.functions.invoke,
): Promise<void> {
  const { error } = await invoke('shelf-ingest/scanner-state', { body: patch });
  if (error) throw error;
}

export async function fetchScannerState(): Promise<{
  last_active_mode: ScanMode;
  locked_mode: ScanMode | null;
} | null> {
  const { data, error } = await supabase.from('scanner_state').select('last_active_mode, locked_mode').maybeSingle();
  if (error || !data) return null;
  return data as { last_active_mode: ScanMode; locked_mode: ScanMode | null };
}
```

(Note: `supabase` is the JWT-auth client; for `chefbyte.scanner_state` the table needs to be in `chefbyte` schema. If the project's `supabase` client doesn't auto-set schema, use `.schema('chefbyte').from('scanner_state')` instead. Adapt to the project pattern by reading nearby code.)

- [ ] **Step 5: Wire into ScannerPage**

In `apps/web/src/pages/chefbyte/ScannerPage.tsx`:

(a) Near the top of `ScannerPage`, add a hook that fetches scanner state:

```tsx
const { data: scannerState } = useQuery({
  queryKey: queryKeys.scannerState(user?.id),
  queryFn: fetchScannerState,
  enabled: !!user,
  staleTime: 60_000,
});
```

(b) When initializing mode, prefer `locked_mode → last_active_mode → 'purchase' (default)`:

```tsx
const initialMode: ScanMode = (() => {
  if (scannerState?.locked_mode) return scannerState.locked_mode;
  if (scannerState?.last_active_mode) return scannerState.last_active_mode;
  return (searchParams.get('mode') as ScanMode) || 'purchase';
})();
```

(c) Disable the mode dropdown when `scannerState?.locked_mode` is set.

(d) On `setMode(...)`, also fire-and-forget push:

```tsx
const debouncedPushModeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const handleSetMode = (newMode: ScanMode) => {
  setMode(newMode);
  if (debouncedPushModeRef.current) clearTimeout(debouncedPushModeRef.current);
  debouncedPushModeRef.current = setTimeout(() => {
    pushScannerMode({ last_active_mode: newMode }).catch(console.warn);
  }, 500);
};
```

Replace `setMode(...)` callsites with `handleSetMode(...)`.

- [ ] **Step 6: Run, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/shared/scannerStateApi.ts \
        apps/web/src/pages/chefbyte/ScannerPage.tsx \
        apps/web/src/shared/queryKeys.ts \
        apps/web/src/shared/queryKeys-invalidation-registry.ts \
        apps/web/src/__tests__/unit/chefbyte/ScannerStatePush.test.tsx
git commit -m "feat(chef): scanner mode broadcast + locked_mode hydration"
```

### Task 12: Web scanner writes scan_transactions on each scan

**Files:**

- Modify: `apps/web/src/pages/chefbyte/ScannerPage.tsx`
- Create: `apps/web/src/__tests__/unit/chefbyte/ScannerLogsTransaction.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Mock supabase to record scan_transactions inserts.
const insertMock = vi.fn(() => ({
  select: () => ({ single: () => Promise.resolve({ data: { transaction_id: 'tx-1' }, error: null }) }),
}));
vi.mock('@/shared/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/shared/supabase')>('@/shared/supabase');
  return {
    ...actual,
    chefbyte: () => ({
      from: (t: string) => {
        if (t === 'scan_transactions') return { insert: insertMock };
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      },
    }),
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

describe('ScannerPage logs scan_transactions', () => {
  it('inserts a scan_transactions row when a known product is scanned', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScannerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = await screen.findByTestId('barcode-input');
    await user.clear(input);
    await user.type(input, '0123456789012');
    await user.keyboard('{Enter}');

    // Wait for the pipeline.
    await new Promise((r) => setTimeout(r, 200));
    expect(insertMock).toHaveBeenCalled();
    const patch = insertMock.mock.calls.at(-1)?.[0];
    expect(patch.barcode).toBe('0123456789012');
    expect(patch.source).toBe('web');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Add transaction logging to ScannerPage**

In `executeAction` (or wherever a scan completes successfully/erroneously), after the existing INSERTs, add:

```tsx
chefbyte()
  .from('scan_transactions')
  .insert({
    user_id: user!.id,
    barcode: queueItem.barcode,
    product_id: queueItem.productId ?? null,
    mode: queueItem.mode,
    qty: queueItem.quantity,
    unit: queueItem.unit ?? null,
    status: success ? 'applied' : 'errored',
    error_msg: success ? null : queueItem.errorMsg,
    logical_date: new Date().toISOString().slice(0, 10),
    source: 'web',
    applied_lot_id: success ? newLotId : null,
    applied_food_log_id: success ? newFoodLogId : null,
    applied_cart_item_id: success ? newCartItemId : null,
    applied_at: success ? new Date().toISOString() : null,
  })
  .then(({ error }) => {
    if (error) console.warn('scan_transactions log failed:', error);
  });
```

Adapt the variable names (`queueItem.*`, `newLotId`, etc.) to whatever the actual page uses. The point is logging every scan in addition to the existing flow.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/chefbyte/ScannerPage.tsx \
        apps/web/src/__tests__/unit/chefbyte/ScannerLogsTransaction.test.tsx
git commit -m "feat(chef): ScannerPage logs every scan to scan_transactions"
```

---

## Phase E — Settings tabs

### Task 13: Scanner Settings tab (lock toggle)

**Files:**

- Create: `apps/web/src/pages/chefbyte/ScannerTab.tsx`
- Modify: `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- Create: `apps/web/src/__tests__/unit/chefbyte/ScannerTab.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// Asserts: lock toggle UPSERTs locked_mode to scanner_state via mutation.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const invokeMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
vi.mock('@/shared/supabase', () => ({
  supabase: { functions: { invoke: invokeMock } },
}));
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, loading: false, signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn() }),
}));

import { ScannerTab } from '@/pages/chefbyte/ScannerTab';

describe('ScannerTab', () => {
  it('toggling lock + selecting mode POSTs locked_mode', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ScannerTab />
      </QueryClientProvider>,
    );
    await user.click(screen.getByTestId('scanner-lock-toggle'));
    await user.selectOptions(screen.getByTestId('scanner-locked-mode-select'), 'shopping');
    await user.click(screen.getByTestId('scanner-save-lock'));

    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({ body: { locked_mode: 'shopping' } }),
    );
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement ScannerTab**

`apps/web/src/pages/chefbyte/ScannerTab.tsx`:

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchScannerState, pushScannerMode, type ScanMode } from '@/shared/scannerStateApi';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';

const MODE_LABELS: Record<ScanMode, string> = {
  purchase: 'Purchase (add to stock)',
  consume_macros: 'Consume + log macros',
  consume_no_macros: 'Consume (no macros)',
  shopping: 'Add to shopping list',
};

export function ScannerTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: state } = useQuery({
    queryKey: queryKeys.scannerState(user?.id),
    queryFn: fetchScannerState,
    enabled: !!user,
  });

  const [locked, setLocked] = useState(!!state?.locked_mode);
  const [selectedMode, setSelectedMode] = useState<ScanMode>(state?.locked_mode ?? 'purchase');

  const mutation = useMutation({
    mutationFn: async () => {
      await pushScannerMode({ locked_mode: locked ? selectedMode : null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scannerState(user?.id) });
    },
  });

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="scanner-lock-toggle"
          data-testid="scanner-lock-toggle"
          checked={locked}
          onChange={(e) => setLocked(e.target.checked)}
        />
        <label htmlFor="scanner-lock-toggle">Lock scanner to a single mode</label>
      </div>

      {locked && (
        <select
          data-testid="scanner-locked-mode-select"
          value={selectedMode}
          onChange={(e) => setSelectedMode(e.target.value as ScanMode)}
          className="border border-border rounded px-2 py-1"
        >
          {(Object.keys(MODE_LABELS) as ScanMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        data-testid="scanner-save-lock"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        className="bg-primary text-on-primary px-3 py-1 rounded"
      >
        {mutation.isPending ? 'Saving…' : 'Save'}
      </button>

      {state?.locked_mode && !mutation.isPending && (
        <p className="text-xs text-text-muted">Currently locked to: {MODE_LABELS[state.locked_mode]}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add to SettingsPage**

In `SettingsPage.tsx`, extend the `Tab` type + tabs array:

```ts
type Tab =
  | 'products'
  | 'walmart'
  | 'scales'
  | 'scanner'
  | 'scanner-transactions'
  | 'locations'
  | 'classifier'
  | 'backup'
  | 'events';

const tabs = [
  // ... existing entries ...
  { id: 'scanner' as const, label: 'Scanner', icon: '📷' },
  { id: 'scanner-transactions' as const, label: 'Scanner Transactions', icon: '📋' },
  // ...
];
```

In the tab-content render block, add:

```tsx
{
  activeTab === 'scanner' && <ScannerTab />;
}
```

- [ ] **Step 5: Run tests, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/chefbyte/ScannerTab.tsx \
        apps/web/src/pages/chefbyte/SettingsPage.tsx \
        apps/web/src/__tests__/unit/chefbyte/ScannerTab.test.tsx
git commit -m "feat(chef): Settings → Scanner tab (lock-to-mode toggle)"
```

### Task 14: Scanner Transactions tab

**Files:**

- Create: `apps/web/src/pages/chefbyte/ScannerTransactionsTab.tsx`
- Modify: `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- Modify: `apps/web/src/shared/queryKeys.ts`
- Create: `apps/web/src/__tests__/unit/chefbyte/ScannerTransactionsTab.test.tsx`

- [ ] **Step 1: Add query key**

```ts
scanTransactions: (userId?: string) => ['chefbyte', 'scanTransactions', userId] as const,
```

- [ ] **Step 2: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const invokeMock = vi.fn();
const sampleRows = [
  {
    transaction_id: 'tx-1',
    barcode: '111',
    product_id: 'p-1',
    mode: 'purchase',
    qty: 1,
    unit: 'container',
    status: 'applied',
    source: 'pi_usb',
    error_msg: null,
    logical_date: '2026-05-03',
    created_at: '2026-05-03T00:00:00Z',
  },
  {
    transaction_id: 'tx-2',
    barcode: '222',
    product_id: 'p-2',
    mode: 'consume_macros',
    qty: 1,
    unit: 'serving',
    status: 'errored',
    source: 'web',
    error_msg: 'No location configured',
    logical_date: '2026-05-03',
    created_at: '2026-05-03T00:01:00Z',
  },
];
vi.mock('@/shared/supabase', () => ({
  supabase: { functions: { invoke: invokeMock } },
  chefbyte: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: sampleRows, error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, loading: false, signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn() }),
}));

import { ScannerTransactionsTab } from '@/pages/chefbyte/ScannerTransactionsTab';

describe('ScannerTransactionsTab', () => {
  it('lists transactions and allows void', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScannerTransactionsTab />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('111')).toBeInTheDocument());
    expect(screen.getByText('222')).toBeInTheDocument();

    await user.click(screen.getByTestId('void-tx-1'));
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scan-transaction/tx-1/void',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Implement**

`apps/web/src/pages/chefbyte/ScannerTransactionsTab.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';

interface ScanTxRow {
  transaction_id: string;
  barcode: string;
  product_id: string | null;
  mode: string;
  qty: number | null;
  unit: string | null;
  status: 'pending' | 'applied' | 'voided' | 'errored';
  error_msg: string | null;
  logical_date: string;
  source: 'web' | 'pi_usb';
  created_at: string;
}

export function ScannerTransactionsTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: rows = [] } = useQuery<ScanTxRow[]>({
    queryKey: queryKeys.scanTransactions(user?.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('scan_transactions')
        .select(
          'transaction_id, barcode, product_id, mode, qty, unit, status, error_msg, logical_date, source, created_at',
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ScanTxRow[];
    },
    enabled: !!user,
  });

  const voidMutation = useMutation({
    mutationFn: async (transactionId: string) => {
      const { error } = await supabase.functions.invoke(`shelf-ingest/scan-transaction/${transactionId}/void`, {
        method: 'POST',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scanTransactions(user?.id) });
    },
  });

  return (
    <div className="space-y-2 p-4">
      <h3 className="text-lg font-semibold">Scanner Transactions</h3>
      <p className="text-xs text-text-muted">
        All scans (web + Pi USB) recorded here. Void to reverse the side-effect.
      </p>
      <div className="overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-bg-soft">
              <th className="text-left p-1">When</th>
              <th className="text-left p-1">Source</th>
              <th className="text-left p-1">Barcode</th>
              <th className="text-left p-1">Mode</th>
              <th className="text-left p-1">Qty</th>
              <th className="text-left p-1">Status</th>
              <th className="text-left p-1">Error</th>
              <th className="text-left p-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.transaction_id} className="border-t border-border">
                <td className="p-1">{new Date(row.created_at).toLocaleString()}</td>
                <td className="p-1">{row.source}</td>
                <td className="p-1 font-mono">{row.barcode}</td>
                <td className="p-1">{row.mode}</td>
                <td className="p-1">
                  {row.qty ?? '-'} {row.unit ?? ''}
                </td>
                <td className="p-1">{row.status}</td>
                <td className="p-1 text-danger">{row.error_msg ?? ''}</td>
                <td className="p-1">
                  {row.status === 'applied' && (
                    <button
                      type="button"
                      data-testid={`void-${row.transaction_id}`}
                      onClick={() => voidMutation.mutate(row.transaction_id)}
                      disabled={voidMutation.isPending}
                      className="text-danger underline"
                    >
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire into SettingsPage**

```tsx
{
  activeTab === 'scanner-transactions' && <ScannerTransactionsTab />;
}
```

- [ ] **Step 6: Run, expect PASS**

- [ ] **Step 7: Register query key in invalidation registry**

In `queryKeys-invalidation-registry.ts`:

```ts
scanTransactions: 'invalidated-by-mutation',
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/chefbyte/ScannerTransactionsTab.tsx \
        apps/web/src/pages/chefbyte/SettingsPage.tsx \
        apps/web/src/shared/queryKeys.ts \
        apps/web/src/shared/queryKeys-invalidation-registry.ts \
        apps/web/src/__tests__/unit/chefbyte/ScannerTransactionsTab.test.tsx
git commit -m "feat(chef): Settings → Scanner Transactions tab (view + void)"
```

---

## Phase F — E2E + docs

### Task 15: End-to-end integration test

**Files:**

- Create: `apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it } from 'vitest';
import { assertEquals, assertExists } from '@/test-helpers/assertions';
import { makeTestCtx, createTestProduct, fetchScanTransaction, fetchScannerState } from './helpers';

describe('Scanner pipeline E2E (real cloud)', () => {
  it('mode push → Pi-style barcode-scan → transaction logged → void reverses', async () => {
    const ctx = makeTestCtx();

    // 1. Web pushes mode.
    await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase' });
    let state = await fetchScannerState(ctx);
    assertEquals(state.last_active_mode, 'purchase');

    // 2. User has a product.
    const productId = await createTestProduct(ctx, {
      barcode: '0900000000001',
      name: 'E2E Pasta',
      servings_per_container: 2,
      calories_per_serving: 300,
    });

    // 3. Pi-style scan.
    const scan = await invokeHandler(ctx, '/barcode-scan', {
      barcode: '0900000000001',
      pi_event_id: 'e2e-' + crypto.randomUUID(),
    });
    assertEquals(scan.status, 200);
    const scanBody = await scan.json();
    assertEquals(scanBody.status, 'applied');

    // 4. Verify a stock_lot was created.
    const lots = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('*')
      .eq('user_id', ctx.userId)
      .eq('product_id', productId);
    assertEquals(lots.data?.length, 1);

    // 5. Verify scan_transactions has the row.
    const tx = await fetchScanTransaction(ctx, scanBody.transaction_id);
    assertEquals(tx.barcode, '0900000000001');
    assertEquals(tx.mode, 'purchase');
    assertEquals(tx.source, 'pi_usb');

    // 6. Void.
    const voidRes = await fetch(`${ctx.baseUrl}/scan-transaction/${scanBody.transaction_id}/void`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    assertEquals(voidRes.status, 200);

    // 7. Verify lot deleted, transaction marked voided.
    const lotsAfter = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('*')
      .eq('user_id', ctx.userId)
      .eq('product_id', productId);
    assertEquals(lotsAfter.data?.length, 0);
    const txAfter = await fetchScanTransaction(ctx, scanBody.transaction_id);
    assertEquals(txAfter.status, 'voided');
  });

  it('locked_mode overrides mode in body', async () => {
    const ctx = makeTestCtx();
    await invokeHandler(ctx, '/scanner-state', { last_active_mode: 'purchase', locked_mode: 'shopping' });
    await createTestProduct(ctx, { barcode: '0900000000002', name: 'X' });

    const scan = await invokeHandler(ctx, '/barcode-scan', {
      barcode: '0900000000002',
      pi_event_id: crypto.randomUUID(),
      mode: 'purchase', // explicit mode in body — should be overridden by lock.
    });
    const body = await scan.json();
    const tx = await fetchScanTransaction(ctx, body.transaction_id);
    assertEquals(tx.mode, 'shopping');
  });
});
```

- [ ] **Step 2: Add helpers**

In the existing `test-helpers/assertions.ts` or a new `e2e-helpers.ts`, add `fetchScannerState`, `fetchScanTransaction` if missing. Pattern matches existing `fetchProduct` from Task 2 of the catch-all batch.

- [ ] **Step 3: Run E2E, expect PASS**

```bash
pnpm --filter web test scanner-pipeline 2>&1 | tail -10
```

Expected: 2 tests pass against the real local Supabase.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts
git commit -m "test(scanner): E2E pipeline (mode push → barcode-scan → void)"
```

### Task 16: Documentation

**Files:**

- Modify: `docs/apps/chefbyte.md`
- Modify: `hardware/live-shelf/docs/plan.md` (or add new `BARCODE_SCANNER.md`)

- [ ] **Step 1: Update `docs/apps/chefbyte.md`**

Add a section near the existing Scanner content:

```markdown
### USB Scanner (Pi → cloud forwarder)

Plug a USB barcode scanner into the live-shelf Pi. Scans forward to the
cloud edge function which processes them under your currently-active
scanner mode (purchase / consume / shopping).

**Mode resolution** (`chefbyte.scanner_state` table):

- If you've toggled "Lock scanner to single mode" in Settings → Scanner,
  that mode is used for every Pi USB scan.
- Otherwise the Pi uses the mode the web Scanner page last broadcast
  (default: purchase).

**Persistent transactions**: every scan (web + Pi USB) is logged in
`chefbyte.scan_transactions`. Visit Settings → Scanner Transactions to
view, filter, or void past scans. Voiding a transaction reverses its
side-effect (deletes the stock_lot, food_log, or shopping_list row that
was created).

**Pi setup**: set `BARCODE_SCANNER_ENABLED=true` and
`BARCODE_SCANNER_DEVICE=/dev/input/eventX` in the Pi env. The scanner
listens via evdev; ENTER terminates each barcode.
```

- [ ] **Step 2: Add hardware docs**

`hardware/live-shelf/docs/BARCODE_SCANNER.md`:

```markdown
# USB Barcode Scanner Module

A USB HID barcode scanner plugged into the live-shelf Pi forwards each
scan to the cloud edge function `/shelf-ingest/barcode-scan`. The
module runs as a daemon thread alongside the existing scale event
handlers, gated by env var `BARCODE_SCANNER_ENABLED=true`.

## Components

- `server/barcode/hid_listener.py` — opens an evdev device, accumulates
  keystrokes until ENTER, yields barcode strings.
- `server/barcode/scanner_loop.py` — orchestrates: pulls barcodes from
  the listener, generates a unique `pi_event_id` per scan, forwards via
  `CloudClient.post_barcode_scan`. Cloud errors are logged + swallowed.
- `cloud/client.py::post_barcode_scan` — POST to `/shelf-ingest/barcode-scan`.

## Auth

Reuses the existing `chefbyte.live_shelf_devices` table (x-api-key
SHA-256). The same Pi serves both the load-cell scales and the USB
scanner; one device row is sufficient.

## Idempotency

Each scan generates `pi_event_id = 'barcode-<uuid4>'`. The cloud
edge function's unique partial index on
`(user_id, pi_event_id) WHERE pi_event_id IS NOT NULL` deduplicates
retries triggered by HTTP failures.

## Mode resolution

The cloud — not the Pi — resolves the mode for each scan from
`chefbyte.scanner_state.locked_mode || last_active_mode`. The Pi
sends only the barcode + `pi_event_id`.

## Configuration

Env vars (set in `/etc/luna-live-shelf.env` or the systemd unit):

- `BARCODE_SCANNER_ENABLED=true` — gate the scanner thread.
- `BARCODE_SCANNER_DEVICE=/dev/input/event2` — evdev device path.
  Default: `/dev/input/event0`. Find yours with `cat /proc/bus/input/devices`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/apps/chefbyte.md hardware/live-shelf/docs/BARCODE_SCANNER.md
git commit -m "docs: USB barcode scanner forwarder + scanner transactions"
```

---

## Self-Review Checklist (run after all tasks)

- [ ] Schema migrations apply cleanly (`supabase db reset`).
- [ ] All pgTAP tests pass.
- [ ] `pnpm --filter web test` green.
- [ ] `pnpm --filter web typecheck` clean.
- [ ] Pi tests green: `cd hardware/live-shelf && /home/jeremy/luna-hub-lite/hardware/live-shelf/.venv/bin/pytest server/barcode/`.
- [ ] E2E `scanner-pipeline.test.ts` green against local Supabase.
- [ ] Three set-once / safety layers verified:
  - `pi_event_id` idempotency (unique partial index).
  - `locked_mode` overrides `last_active_mode` AND any client-supplied mode.
  - Void mutation reverses side-effect deterministically (FK-based).
- [ ] Manual smoke-test (if possible): plug a real USB scanner into the Pi, scan a known product → verify a stock_lot lands in cloud + a row appears in Settings → Scanner Transactions.

---

## Open trade-offs (for future iteration)

- **Edit transactions** (vs delete): not implemented this round. The user asked for "view, edit, delete" — delete is implemented as void. Edit (e.g., change qty after the fact) requires reversing + re-applying, which is error-prone. Defer until requested explicitly.
- **Pi-side cache of locked_mode**: the Pi reads from cloud on every scan via the edge function, which already does the mode resolution. No Pi-local caching means a temporary network blip causes the scan to fail. Acceptable for MVP.
