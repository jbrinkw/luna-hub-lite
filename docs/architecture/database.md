# Database Design

## Schema Layout

| Schema | Owner | Purpose |
|--------|-------|---------|
| `hub` | Luna Hub | User profiles (including `day_start_hour`, timezone), app activation records, MCP API keys (SHA-256 hashed), user tool toggles, extension settings (encrypted via Vault) |
| `coachbyte` | CoachByte | Exercises, daily logs, planned/completed sets, splits, PRs, timers |
| `chefbyte` | ChefByte | Products, `stock_lots` (lot-based inventory + expiration), recipes, meal plans, shopping lists, macros, LiquidTrack device IDs/import keys, liquid events |
| `private` | Platform | All SECURITY DEFINER functions (not exposed via API). Each function includes `SET search_path = ''`. |

Cross-schema queries from the frontend use RPC functions in the `private` schema. The Supabase JS client `.from()` defaults to one schema; use `.schema('name')` for cross-schema access.

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

## Day Boundary System

A single PostgreSQL function computes the "logical date" for any timestamp:

```sql
CREATE FUNCTION private.get_logical_date(
  ts TIMESTAMPTZ,
  tz TEXT,
  day_start_hour INTEGER
) RETURNS DATE AS $$
  SELECT (ts AT TIME ZONE tz - (day_start_hour || ' hours')::INTERVAL)::DATE;
$$ LANGUAGE SQL IMMUTABLE;
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

| Logic Type | Runs In | Examples |
|------------|---------|---------|
| Simple CRUD | Supabase client SDK (direct from frontend) | Add a planned set, update a product name, mark a meal done |
| Multi-step transactions | Database functions (plpgsql, SECURITY DEFINER in `private` schema) | Ensure today's plan + clone from split, complete a set + set timer + update queue, consume product + log macros + update stock |
| External API calls | Supabase Edge Functions | Walmart scraping (via third-party scraper API, already implemented), OpenFoodFacts + Claude Haiku 4.5 product analysis, LiquidTrack ingestion |
| MCP tool execution | Cloudflare Worker → Supabase RPC via Supavisor (for app tools) or direct API call (for extension tools) | All tool calls from external AI clients |

## Key Indexes (Day 1)

- `(user_id, plan_date)` on daily plans — UNIQUE constraint, supports bootstrap idempotency
- `(user_id, logical_date)` on food logs, completed sets, meal plan entries
- `UNIQUE (user_id, product_id, location_id, COALESCE(expires_on, DATE '9999-12-31'))` on `chefbyte.stock_lots` — lot merge key (treats NULL expiry as one bucket)
- `(user_id, product_id, expires_on)` on `chefbyte.stock_lots` — supports nearest-expiration lot depletion
- `(user_id, barcode)` on products (WHERE barcode IS NOT NULL)
- `(user_id, LOWER(name))` on exercises — UNIQUE constraint, case-insensitive dedup
- `(user_id, product_id)` on shopping list — UNIQUE constraint with quantity merge on conflict
