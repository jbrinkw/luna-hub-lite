# Phase 06d: ChefByte DB — LiquidTrack + Activation + Types Regen
> Previous: phase-06c.md | Next: phase-06e.md

## Skills
test-driven-development, context7 (Supabase)

## Build
- Migration: `supabase/migrations/YYYYMMDD_chefbyte_liquidtrack_activation.sql`
- `chefbyte.liquidtrack_devices` — device_id UUID PK, user_id FK auth.users CASCADE, device_name TEXT NOT NULL, product_id UUID FK SET NULL, import_key_hash TEXT, import_key_used_at TIMESTAMPTZ nullable, created_at TIMESTAMPTZ
- `chefbyte.liquidtrack_events` — event_id UUID PK, device_id TEXT NOT NULL, user_id FK auth.users CASCADE, weight_before NUMERIC(10,3), weight_after NUMERIC(10,3), consumed_amount NUMERIC(10,3), calories NUMERIC(10,3), protein NUMERIC(10,3), carbs NUMERIC(10,3), fats NUMERIC(10,3), created_at TIMESTAMPTZ, logical_date DATE NOT NULL, is_refill BOOLEAN DEFAULT false
  - **Liquid Log entries** use `device_id='manual'`, `weight_before=0`, `weight_after=0` (decision #22). This is NOT temp_items — it flows through liquidtrack_events so get_daily_macros aggregates it automatically.
- RLS on both tables: `(select auth.uid()) = user_id TO authenticated`
- Extend `private.activate_app(p_user_id, p_app_name)` with ChefByte branch:
  - Insert default target_macros row (2000 cal, 150g protein, 200g carbs, 80g fats)
- Extend `private.deactivate_app(p_user_id, p_app_name)` with ChefByte branch:
  - CASCADE delete all ChefByte data: products, stock_lots, recipes, recipe_ingredients, meal_plan, shopping_list, food_logs, temp_items, target_macros, liquidtrack_devices, liquidtrack_events
- Regenerate DB types: `supabase gen types typescript --local > packages/db-types/src/database.ts`
- Update get_daily_macros to include liquidtrack_events in aggregate (if not already wired in phase-06c)

## Test (TDD)

### pgTAP: `supabase/tests/hub/activation_chefbyte.test.sql`
- Activate ChefByte -> target_macros row created with defaults (2000cal, 150p, 200c, 80f)
- Activate ChefByte -> target_macros defaults match expected values exactly
- Deactivate ChefByte -> all ChefByte tables empty for user (products, stock_lots, recipes, recipe_ingredients, meal_plan, shopping_list, food_logs, temp_items, target_macros, liquidtrack_devices, liquidtrack_events)
- Reactivate ChefByte -> fresh target_macros defaults, no stale data
- Activate/deactivate ChefByte does not affect other users' ChefByte data
- Activate/deactivate ChefByte does not affect user's CoachByte data (if activated)

### Integration: `apps/web/src/__tests__/integration/chefbyte/app-activation-chefbyte.test.ts`
- Activate ChefByte -> target_macros row exists with defaults (2000, 150, 200, 80)
- Create products, stock, recipes, food_logs -> deactivate -> all ChefByte tables empty
- Deactivate -> reactivate -> clean slate with fresh defaults
- Deactivate ChefByte -> Hub profile still intact
- Deactivate ChefByte -> CoachByte data (if any) still intact
- Liquidtrack devices + events deleted on deactivation

### Integration: `apps/web/src/__tests__/integration/chefbyte/liquidtrack-tables.test.ts`
- Create device -> row stored with device_name and user_id
- Device with product_id FK -> product linked correctly
- Import key hash stored (not plaintext)
- import_key_used_at nullable (NULL before provisioning)
- Create liquidtrack_event with device_id='manual' (Liquid Log) -> weight_before=0, weight_after=0, macros stored
- Create liquidtrack_event with real device_id -> all fields stored
- is_refill=true stored correctly
- get_daily_macros includes liquidtrack_events in aggregate
- Liquid Log entry (device_id='manual') included in get_daily_macros
- Delete device -> events NOT cascade deleted (events have historical value)

## Legacy Reference
- `legacy/luna-ext-chefbyte/services/liquidtrack/init_schema.sql` — LiquidTrack table schemas
- `legacy/luna-ext-chefbyte/services/liquidtrack/server.py` — IoT ingestion logic, device provisioning
- `legacy/luna-ext-chefbyte/lib/services/inventory.py` — activation/deactivation patterns

## Commit
`feat: chefbyte liquidtrack tables + activation + DB types regen`

## Acceptance
- [ ] liquidtrack_devices and liquidtrack_events tables with RLS
- [ ] Liquid Log writes to liquidtrack_events with device_id='manual' (NOT temp_items)
- [ ] ChefByte activation creates target_macros defaults
- [ ] ChefByte deactivation cascades all ChefByte data
- [ ] get_daily_macros includes liquidtrack_events (including Liquid Log entries)
- [ ] DB types regenerated in packages/db-types/src/database.ts
- [ ] pgTAP tests pass: `supabase test db --grep hub/activation_chefbyte`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte/app-activation-chefbyte src/__tests__/integration/chefbyte/liquidtrack-tables`
- [ ] `pnpm typecheck` passes
