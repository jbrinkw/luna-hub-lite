# Phase 06a: ChefByte DB — Products + Stock + consume_product

> Previous: phase-05b.md | Next: phase-06b.md

## Skills

test-driven-development, test-quality-review, context7 (Supabase, pgTAP)

## Build

- Migration: `supabase/migrations/YYYYMMDD_chefbyte_products_stock.sql`
- `chefbyte.products` — product_id UUID PK, user_id FK auth.users CASCADE, name TEXT NOT NULL, barcode TEXT nullable, servings_per_container NUMERIC(10,3) NOT NULL DEFAULT 1, calories NUMERIC(10,3), protein_g NUMERIC(10,3), carbs_g NUMERIC(10,3), fats_g NUMERIC(10,3), is_placeholder BOOLEAN DEFAULT false, min_stock_containers NUMERIC(10,3) DEFAULT 0, walmart_url TEXT, price NUMERIC(10,2), created_at TIMESTAMPTZ
- `chefbyte.stock_lots` — lot_id UUID PK, product_id FK CASCADE, user_id FK auth.users CASCADE, location_id TEXT NOT NULL, qty_containers NUMERIC(10,3) NOT NULL DEFAULT 0, expires_on DATE nullable, created_at TIMESTAMPTZ
- Index: `UNIQUE (user_id, barcode) WHERE barcode IS NOT NULL` on products
- Index: `UNIQUE (user_id, product_id, location_id, COALESCE(expires_on, DATE '9999-12-31'))` on stock_lots (lot merge key)
- Index: `(user_id, product_id, expires_on)` on stock_lots (nearest-expiry depletion)
- RLS on both tables: `(select auth.uid()) = user_id TO authenticated` for SELECT, INSERT, UPDATE, DELETE
- `private.consume_product(p_user_id UUID, p_product_id UUID, p_qty NUMERIC, p_unit TEXT, p_log_macros BOOLEAN)` — convert servings to containers via servings_per_container, deplete lots nearest-expiry-first (expires_on ASC NULLS LAST), floor stock at 0, optionally insert food_log with full requested amount macros
- `chefbyte.consume_product(p_product_id, p_qty, p_unit, p_log_macros)` — thin RPC wrapper, passes auth.uid()
- Test helper: `createProduct(client, overrides)` factory in test-helpers.ts

## Test (TDD)

### pgTAP: `supabase/tests/chefbyte/consume_product.test.sql`

- Single lot consumed correctly (qty reduced)
- Multi-lot depletion in nearest-expiry order
- NULL expires_on consumed last
- Stock floors at 0 (no negative qty)
- Servings-to-containers conversion applied before depletion
- Optional macro logging: p_log_macros=true creates food_log, p_log_macros=false does not
- Macros logged for full requested amount regardless of stock shortage

### Integration: `apps/web/src/__tests__/integration/chefbyte/product-crud.test.ts`

- Create product with macros -> all fields stored correctly (NUMERIC(10,3) precision)
- Update macros -> reflected on reload
- Barcode unique per user: two products with same barcode -> second rejected
- Duplicate barcode rejected with clear error
- Products can exist without barcode (barcode nullable)
- Two users can have the same barcode (isolation)
- Create placeholder product (is_placeholder=true) -> stored correctly
- Product with min_stock_containers -> stored correctly

### Integration: `apps/web/src/__tests__/integration/chefbyte/stock-lot-operations.test.ts`

- Add stock -> lot created with correct qty_containers and location_id
- Add same product+location+expiry -> qty merged (UPSERT)
- Add same product+different location -> separate lot created
- Add same product+different expiry -> separate lot created
- Consume -> nearest expiry depleted first
- Consume more than total stock -> qty floors at 0, no negative lots
- Multi-lot consumption across lots in expiry order (partial depletion of second lot)
- Storage locations (Fridge, Pantry, Freezer) all accepted
- Lot merge rule: product+location+expiry match merges, any difference creates new lot
- expires_on nullable: NULL sorts last in consumption order
- Mutations accept containers (p_unit='containers')
- Mutations accept servings (p_unit='servings') -> converted via servings_per_container
- Inventory adjustments are stock-only: consume with p_log_macros=false -> no food_log row created
- Consume with p_log_macros=true -> food_log row created with correct macros

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/chefbyte-vercel/apps/web/src/lib/api-supabase.ts` — product/stock Supabase queries, lot merge patterns
- `legacy/luna-ext-chefbyte/lib/services/inventory.py` — consume logic, nearest-expiry depletion
- `legacy/luna-ext-chefbyte/lib/core/qu_resolver.py` — servings-to-containers conversion
- `legacy/chefbyte-vercel/supabase/migrations/*.sql` — table schemas, indexes, RLS policies

## Commit

`feat: chefbyte products + stock lots + consume_product`

## Acceptance

- [ ] Products table with all columns, indexes, and RLS policies
- [ ] Stock lots table with merge key UNIQUE constraint and RLS policies
- [ ] consume_product depletes nearest-expiry-first, floors at 0, optionally logs macros
- [ ] createProduct test helper available in test-helpers.ts
- [ ] pgTAP tests pass: `supabase test db --grep chefbyte/consume_product`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte/product-crud src/__tests__/integration/chefbyte/stock-lot-operations`
- [ ] `pnpm typecheck` passes
