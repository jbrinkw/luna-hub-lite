# Database Design

## Schema Layout

| Schema      | Owner     | Purpose                                                                                                                                                                  |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hub`       | Luna Hub  | User profiles (including `day_start_hour`, timezone), app activation records, MCP API keys (SHA-256 hashed), user tool toggles, extension settings (encrypted via Vault) |
| `coachbyte` | CoachByte | Exercises, daily logs, planned/completed sets, splits, timers                                                                                                            |
| `chefbyte`  | ChefByte  | Products, `stock_lots` (lot-based inventory + expiration), recipes, meal plans, shopping lists, macros, LiquidTrack device IDs/import keys, liquid events                |
| `private`   | Platform  | All SECURITY DEFINER functions (not exposed via API). Each function includes `SET search_path = ''`.                                                                     |

The `private` schema is **not exposed via PostgREST** — it has no REST API endpoints. The `authenticated` role has no USAGE on `private`; only `service_role` does. Functions in `private` are called only by triggers, other DB functions, and the MCP Worker (which uses `service_role`).

**Frontend-callable RPC pattern:** For multi-step operations the frontend needs to trigger, each module schema has thin wrapper functions that delegate to private. The wrapper authenticates via `auth.uid()` and delegates to the private implementation:

```sql
CREATE FUNCTION coachbyte.ensure_daily_plan(p_day DATE)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.ensure_daily_plan((SELECT auth.uid()), p_day); $$;
GRANT EXECUTE ON FUNCTION coachbyte.ensure_daily_plan(DATE) TO authenticated;
```

The Supabase JS client calls wrappers: `supabase.schema('coachbyte').rpc('ensure_daily_plan', { p_day })`.

**Frontend-callable wrappers needed:**

| Wrapper Schema | Function                                                     | Delegates To                                      |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `hub`          | `activate_app(p_app_name)`                                   | `private.activate_app(uid, p_app_name)`           |
| `hub`          | `deactivate_app(p_app_name)`                                 | `private.deactivate_app(uid, p_app_name)`         |
| `coachbyte`    | `ensure_daily_plan(p_day)`                                   | `private.ensure_daily_plan(uid, p_day)`           |
| `coachbyte`    | `complete_next_set(p_plan_id, p_reps, p_load)`               | `private.complete_next_set(uid, ...)`             |
| `chefbyte`     | `get_daily_macros(p_logical_date)`                           | `private.get_daily_macros(uid, p_date)`           |
| `chefbyte`     | `mark_meal_done(p_meal_id)`                                  | `private.mark_meal_done(uid, p_meal_id)`          |
| `chefbyte`     | `consume_product(p_product_id, p_qty, p_unit, p_log_macros)` | `private.consume_product(uid, ...)`               |
| `chefbyte`     | `sync_meal_plan_to_shopping(p_days)`                         | `private.sync_meal_plan_to_shopping(uid, p_days)` |
| `chefbyte`     | `import_shopping_to_inventory()`                             | `private.import_shopping_to_inventory(uid)`       |

**Internal-only (no wrapper):** `private.handle_new_user()` (trigger), `private.get_logical_date()` (utility called by other functions).

The Supabase JS client `.from()` defaults to one schema; use `.schema('name')` for cross-schema table access.

## Per-User Isolation

Every user-facing table includes a `user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE` column. RLS policies use `(select auth.uid()) = user_id` (subselect wrapper for performance) and include `TO authenticated` to prevent evaluation for anonymous users. Client-side queries duplicate the RLS filter (`.eq('user_id', userId)`) for better query plans.

CASCADE deletes from `auth.users` bypass RLS — this is expected PostgreSQL behavior and is the correct cleanup mechanism.

Exception: The global exercise library in CoachByte has rows with `user_id = NULL` representing shared exercises. RLS policy: `(select auth.uid()) = user_id OR user_id IS NULL` for SELECT. Write/delete policies restrict to `(select auth.uid()) = user_id` only (no writes to global rows). Partial index: `CREATE INDEX idx_exercises_global ON exercises (id) WHERE user_id IS NULL`.

## Hub Profile

`hub.profiles`:

- `user_id` UUID (PK, references auth.users, ON DELETE CASCADE)
- `display_name` TEXT
- `timezone` TEXT DEFAULT 'America/New_York' (IANA timezone name — never numeric offsets, handles DST correctly)
- `day_start_hour` INTEGER DEFAULT 6 (0-23, shared across all modules)
- `created_at` TIMESTAMPTZ

## Notable Table Additions (Post-MVP Migrations)

### `chefbyte.locations`

Storage locations (Fridge, Pantry, Freezer, etc.) for lot-based inventory tracking:

- `location_id` UUID (PK, auto-generated)
- `user_id` UUID (FK → auth.users, ON DELETE CASCADE)
- `name` TEXT NOT NULL
- `created_at` TIMESTAMPTZ DEFAULT now()

Default locations (Fridge, Pantry, Freezer) are seeded per user on ChefByte activation.

### `coachbyte.daily_plans` — new column

- `notes` TEXT — free-text workout notes for the day (migration 20260304060000)

### `coachbyte.user_settings` — new column

- `pr_tracked_exercise_ids` JSONB DEFAULT NULL — array of exercise UUIDs to show on the PRs page. NULL means "track all exercises" (migration 20260304040003)

### `chefbyte.meal_plan_entries` — new column

- `meal_type` TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')) — categorizes meal plan entries by meal type (migration 20260304050000)

### Non-negative CHECK constraints (migration 20260304040004)

- `chefbyte.products`: `calories_per_serving >= 0`, `protein_per_serving >= 0`, `carbs_per_serving >= 0`, `fat_per_serving >= 0`
- `coachbyte.planned_sets`: `target_reps >= 0 OR target_reps IS NULL`, `target_load >= 0 OR target_load IS NULL`

## Day Boundary System

A single PostgreSQL function computes the "logical date" for any timestamp:

```sql
CREATE FUNCTION private.get_logical_date(
  ts TIMESTAMPTZ,
  tz TEXT,
  day_start_hour INTEGER
) RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN (ts AT TIME ZONE tz - (day_start_hour || ' hours')::INTERVAL)::DATE;
END;
$$;
```

Every date-sensitive table stores a `logical_date DATE` column computed at insert time using this function. All queries filter on `logical_date` for fast indexed access. The function is the source of truth at write time; the stored column is the source of truth at read time.

**Changing `day_start_hour`:** Changes take effect at the next day boundary. Existing rows retain their assigned `logical_date`. A user who changes from 6 AM to midnight at 3 PM on Tuesday will see Tuesday's data unchanged; Wednesday uses the new boundary.

## Numeric Representation

All quantity columns (stock, servings, recipe amounts, shopping quantities) use `NUMERIC(10,3)` in PostgreSQL. This provides arbitrary precision with no floating-point errors. JavaScript clients use `toFixed()` for display rounding. Display rounding rules: quantities shown to 1 decimal place in the UI, stored to 3 decimal places in the DB. Purchase quantities (shopping list) are always rounded up to whole containers.

## Quantity Unit System

- **Stock** is canonical in **containers**, but stored at the **lot level** (`chefbyte.stock_lots`) so each batch can carry its own expiration and location.
- **Lot fields**: each lot has a unique `lot_id`, references `product_id`, includes `location_id`, `qty_containers`, and nullable `expires_on DATE`.
- **Lot merge rule**: quantities merge only when `(user_id, product_id, location_id, expires_on)` match. Different expiration or location creates a separate lot.
- **Expiration semantics**: `expires_on = NULL` means "no expiration" and is consumed/sorted last.
- **Consumption** accepts quantity in **containers** or **servings**. Serving input is converted server-side with `quantity_in_servings / servings_per_container`.
- **Lot depletion order**: nearest expiration first (`expires_on ASC NULLS LAST`).
- **For macro-logging consume flows, macros are logged for the full requested consumed amount regardless of stock state.** If inventory is short, stock floors at zero while the requested consumed amount still logs to macros.
- **Recipe ingredients** reference products via FK and specify quantity in either **containers** or **servings** (stored as quantity + unit enum).
- **Shopping list** quantities are always in **containers** (rounded up from needed amounts).
- **Display** defaults to containers, with serving equivalents shown where helpful.
- **Conversion** relies solely on `servings_per_container` per product. No density tables, no gram/ml conversions.
- Shopping list and "can be made" calculations use inventory totals aggregated across lots.

## Business Logic Placement

| Logic Type              | Runs In                                                                                                         | Examples                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simple CRUD             | Supabase client SDK (direct from frontend)                                                                      | Add a planned set, update a product name, toggle a tool                                                                                                                                                                                                                                                               |
| Multi-step transactions | Database functions (plpgsql, SECURITY DEFINER in `private` schema, exposed via thin wrappers in module schemas) | Ensure today's plan + clone from split, complete a set + return rest_seconds, mark meal done (consume ingredients + log macros or create [MEAL] lot), consume product (nearest-expiry lot depletion + optional macro log), import shopping to inventory (bulk lot creation + clear items), sync meal plan to shopping |
| External API calls      | Supabase Edge Functions                                                                                         | Walmart scraping (via third-party scraper API, already implemented), OpenFoodFacts + Claude Haiku 4.5 product analysis, LiquidTrack ingestion                                                                                                                                                                         |
| MCP tool execution      | Cloudflare Worker → Supabase RPC via Supavisor (for app tools) or direct API call (for extension tools)         | All tool calls from external AI clients                                                                                                                                                                                                                                                                               |

## Key Indexes

- `(user_id, plan_date)` on daily plans — UNIQUE constraint, supports bootstrap idempotency
- `(user_id, logical_date)` on food logs, completed sets, meal plan entries
- `UNIQUE (user_id, product_id, location_id, COALESCE(expires_on, DATE '9999-12-31'))` on `chefbyte.stock_lots` — lot merge key (treats NULL expiry as one bucket)
- `(user_id, product_id, expires_on)` on `chefbyte.stock_lots` — supports nearest-expiration lot depletion
- `(user_id, barcode)` on products (WHERE barcode IS NOT NULL)
- `(user_id, LOWER(name))` on exercises — UNIQUE constraint, case-insensitive dedup
- `(user_id, product_id)` on shopping list — UNIQUE constraint with quantity merge on conflict
- `(api_key_hash)` on `hub.api_keys` WHERE `revoked_at IS NULL` — partial unique index for fast active key lookup (migration 20260304040000)
- `(plan_id)` on `coachbyte.planned_sets` — supports frequent join queries fetching sets for a plan (migration 20260304040000)
- `(recipe_id)` on `chefbyte.recipe_ingredients` — supports frequent join queries fetching ingredients for a recipe (migration 20260304040000)

## Supabase Realtime Subscriptions

The frontend subscribes to Supabase Realtime channels for live data updates. Active subscriptions by page:

| Page / Provider            | Tables Subscribed                                                             | Purpose                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `AppProvider`              | `hub.profiles`                                                                | Live profile changes (timezone, day_start_hour) propagate to all modules |
| `TodayPage` (CoachByte)    | `coachbyte.daily_plans`, `coachbyte.planned_sets`, `coachbyte.completed_sets` | Live workout state — set completion, plan changes, timer updates         |
| `InventoryPage` (ChefByte) | `chefbyte.stock_lots`, `chefbyte.products`                                    | Live inventory updates when lots are consumed or added                   |
| `MacroPage` (ChefByte)     | `chefbyte.food_logs`, `chefbyte.temp_items`                                   | Live macro totals as food is logged                                      |
| `ShoppingPage` (ChefByte)  | `chefbyte.shopping_list`                                                      | Live shopping list updates (sync, import, manual edits)                  |

All subscriptions filter on `user_id = auth.uid()` via RLS. Channels are cleaned up on page unmount.

## Environment Validation

Production builds enforce hard errors on missing critical environment variables:

- `VITE_SUPABASE_URL` — Supabase project URL (required)
- `VITE_SUPABASE_ANON_KEY` — Supabase anonymous/public key (required)

If either variable is missing at build time, the app throws an error during Supabase client initialization rather than silently failing with undefined values. This prevents deploying a non-functional build to production.
