-- ChefByte module tables: locations, products, stock_lots, recipes,
-- recipe_ingredients, meal_plan_entries, food_logs, temp_items,
-- shopping_list, liquidtrack_devices, liquidtrack_events, user_config.
-- Plus RLS, indexes, default location seeds, activation/deactivation hooks.

------------------------------------------------------------
-- TABLES
------------------------------------------------------------

-- Storage locations (Fridge, Pantry, Freezer, etc.)
CREATE TABLE chefbyte.locations (
  location_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Product catalog with macro info
CREATE TABLE chefbyte.products (
  product_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  barcode TEXT,
  description TEXT,
  servings_per_container NUMERIC(10,3) NOT NULL DEFAULT 1,
  calories_per_serving NUMERIC(10,3) NOT NULL DEFAULT 0,
  carbs_per_serving NUMERIC(10,3) NOT NULL DEFAULT 0,
  protein_per_serving NUMERIC(10,3) NOT NULL DEFAULT 0,
  fat_per_serving NUMERIC(10,3) NOT NULL DEFAULT 0,
  min_stock_amount NUMERIC(10,3) NOT NULL DEFAULT 0,
  is_placeholder BOOLEAN NOT NULL DEFAULT false,
  walmart_link TEXT,
  price NUMERIC(10,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lot-based inventory (grouped by product + location + expiration)
CREATE TABLE chefbyte.stock_lots (
  lot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES chefbyte.products(product_id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES chefbyte.locations(location_id) ON DELETE CASCADE,
  qty_containers NUMERIC(10,3) NOT NULL DEFAULT 0,
  expires_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recipes
CREATE TABLE chefbyte.recipes (
  recipe_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  base_servings NUMERIC(10,3) NOT NULL DEFAULT 1,
  active_time INTEGER,
  total_time INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recipe ingredients (denormalized user_id for RLS)
CREATE TABLE chefbyte.recipe_ingredients (
  ingredient_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES chefbyte.recipes(recipe_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES chefbyte.products(product_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quantity NUMERIC(10,3) NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('container', 'serving')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Meal plan entries (can reference a recipe OR a product, not both required but at least one)
CREATE TABLE chefbyte.meal_plan_entries (
  meal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipe_id UUID REFERENCES chefbyte.recipes(recipe_id) ON DELETE CASCADE,
  product_id UUID REFERENCES chefbyte.products(product_id) ON DELETE CASCADE,
  logical_date DATE NOT NULL,
  servings NUMERIC(10,3) NOT NULL DEFAULT 1,
  meal_prep BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (recipe_id IS NOT NULL OR product_id IS NOT NULL)
);

-- Food/macro logs
CREATE TABLE chefbyte.food_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES chefbyte.products(product_id) ON DELETE CASCADE,
  logical_date DATE NOT NULL,
  qty_consumed NUMERIC(10,3) NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('container', 'serving')),
  calories NUMERIC(10,3) NOT NULL,
  carbs NUMERIC(10,3) NOT NULL,
  protein NUMERIC(10,3) NOT NULL,
  fat NUMERIC(10,3) NOT NULL,
  meal_id UUID REFERENCES chefbyte.meal_plan_entries(meal_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Temporary (quick-add) macro items
CREATE TABLE chefbyte.temp_items (
  temp_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logical_date DATE NOT NULL,
  calories NUMERIC(10,3) NOT NULL,
  carbs NUMERIC(10,3) NOT NULL,
  protein NUMERIC(10,3) NOT NULL,
  fat NUMERIC(10,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shopping list (one row per product per user)
CREATE TABLE chefbyte.shopping_list (
  cart_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES chefbyte.products(product_id) ON DELETE CASCADE,
  qty_containers NUMERIC(10,3) NOT NULL,
  purchased BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

-- LiquidTrack IoT devices
CREATE TABLE chefbyte.liquidtrack_devices (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  product_id UUID REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  import_key_hash TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LiquidTrack consumption events
CREATE TABLE chefbyte.liquidtrack_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES chefbyte.liquidtrack_devices(device_id) ON DELETE CASCADE,
  weight_before NUMERIC(10,3) NOT NULL,
  weight_after NUMERIC(10,3) NOT NULL,
  consumption NUMERIC(10,3) NOT NULL,
  is_refill BOOLEAN NOT NULL DEFAULT false,
  calories NUMERIC(10,3),
  carbs NUMERIC(10,3),
  protein NUMERIC(10,3),
  fat NUMERIC(10,3),
  logical_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, created_at)
);

-- Per-user ChefByte config key/value store
CREATE TABLE chefbyte.user_config (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

------------------------------------------------------------
-- INDEXES
------------------------------------------------------------

-- Locations: unique name per user (prevents duplicate seeds on re-activation)
CREATE UNIQUE INDEX locations_user_name_unique
  ON chefbyte.locations (user_id, name);

-- Products: unique barcode per user (partial — only where barcode exists)
CREATE UNIQUE INDEX products_user_barcode_unique
  ON chefbyte.products (user_id, barcode)
  WHERE barcode IS NOT NULL;

-- Products: user lookup
CREATE INDEX products_user_idx
  ON chefbyte.products (user_id);

-- Stock lots: merge key (treats NULL expiry as one bucket via COALESCE sentinel)
CREATE UNIQUE INDEX stock_lots_merge_key
  ON chefbyte.stock_lots (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date));

-- Stock lots: nearest-expiration depletion order
CREATE INDEX stock_lots_depletion_idx
  ON chefbyte.stock_lots (user_id, product_id, expires_on ASC NULLS LAST);

-- Meal plan: user + date lookups
CREATE INDEX meal_plan_user_date_idx
  ON chefbyte.meal_plan_entries (user_id, logical_date);

-- Food logs: user + date lookups
CREATE INDEX food_logs_user_date_idx
  ON chefbyte.food_logs (user_id, logical_date);

-- Temp items: user + date lookups
CREATE INDEX temp_items_user_date_idx
  ON chefbyte.temp_items (user_id, logical_date);

-- LiquidTrack events: user + date lookups
CREATE INDEX lt_events_user_date_idx
  ON chefbyte.liquidtrack_events (user_id, logical_date);

------------------------------------------------------------
-- RLS
------------------------------------------------------------

-- locations: standard per-user pattern
ALTER TABLE chefbyte.locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own locations"
  ON chefbyte.locations FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own locations"
  ON chefbyte.locations FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own locations"
  ON chefbyte.locations FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own locations"
  ON chefbyte.locations FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- products: standard per-user pattern
ALTER TABLE chefbyte.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own products"
  ON chefbyte.products FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own products"
  ON chefbyte.products FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own products"
  ON chefbyte.products FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own products"
  ON chefbyte.products FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- stock_lots: standard per-user pattern
ALTER TABLE chefbyte.stock_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own stock lots"
  ON chefbyte.stock_lots FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own stock lots"
  ON chefbyte.stock_lots FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own stock lots"
  ON chefbyte.stock_lots FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own stock lots"
  ON chefbyte.stock_lots FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- recipes: standard per-user pattern
ALTER TABLE chefbyte.recipes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own recipes"
  ON chefbyte.recipes FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own recipes"
  ON chefbyte.recipes FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own recipes"
  ON chefbyte.recipes FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own recipes"
  ON chefbyte.recipes FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- recipe_ingredients: standard per-user pattern
ALTER TABLE chefbyte.recipe_ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own recipe ingredients"
  ON chefbyte.recipe_ingredients FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own recipe ingredients"
  ON chefbyte.recipe_ingredients FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own recipe ingredients"
  ON chefbyte.recipe_ingredients FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own recipe ingredients"
  ON chefbyte.recipe_ingredients FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- meal_plan_entries: standard per-user pattern
ALTER TABLE chefbyte.meal_plan_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own meal plan entries"
  ON chefbyte.meal_plan_entries FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own meal plan entries"
  ON chefbyte.meal_plan_entries FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own meal plan entries"
  ON chefbyte.meal_plan_entries FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own meal plan entries"
  ON chefbyte.meal_plan_entries FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- food_logs: standard per-user pattern
ALTER TABLE chefbyte.food_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own food logs"
  ON chefbyte.food_logs FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own food logs"
  ON chefbyte.food_logs FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own food logs"
  ON chefbyte.food_logs FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own food logs"
  ON chefbyte.food_logs FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- temp_items: standard per-user pattern
ALTER TABLE chefbyte.temp_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own temp items"
  ON chefbyte.temp_items FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own temp items"
  ON chefbyte.temp_items FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own temp items"
  ON chefbyte.temp_items FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own temp items"
  ON chefbyte.temp_items FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- shopping_list: standard per-user pattern
ALTER TABLE chefbyte.shopping_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own shopping list"
  ON chefbyte.shopping_list FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own shopping list"
  ON chefbyte.shopping_list FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own shopping list"
  ON chefbyte.shopping_list FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own shopping list"
  ON chefbyte.shopping_list FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- liquidtrack_devices: standard per-user pattern
ALTER TABLE chefbyte.liquidtrack_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own liquidtrack devices"
  ON chefbyte.liquidtrack_devices FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own liquidtrack devices"
  ON chefbyte.liquidtrack_devices FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own liquidtrack devices"
  ON chefbyte.liquidtrack_devices FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own liquidtrack devices"
  ON chefbyte.liquidtrack_devices FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- liquidtrack_events: standard per-user pattern
ALTER TABLE chefbyte.liquidtrack_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own liquidtrack events"
  ON chefbyte.liquidtrack_events FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own liquidtrack events"
  ON chefbyte.liquidtrack_events FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own liquidtrack events"
  ON chefbyte.liquidtrack_events FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own liquidtrack events"
  ON chefbyte.liquidtrack_events FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- user_config: standard per-user pattern
ALTER TABLE chefbyte.user_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own config"
  ON chefbyte.user_config FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own config"
  ON chefbyte.user_config FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own config"
  ON chefbyte.user_config FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own config"
  ON chefbyte.user_config FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

------------------------------------------------------------
-- EXTEND ACTIVATION / DEACTIVATION FOR CHEFBYTE
------------------------------------------------------------

-- Replace activate_app to handle BOTH coachbyte AND chefbyte
CREATE OR REPLACE FUNCTION private.activate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO hub.app_activations (user_id, app_name)
  VALUES (p_user_id, p_app_name)
  ON CONFLICT (user_id, app_name) DO NOTHING;

  IF p_app_name = 'coachbyte' THEN
    INSERT INTO coachbyte.user_settings (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF p_app_name = 'chefbyte' THEN
    -- Seed default locations
    INSERT INTO chefbyte.locations (user_id, name)
    VALUES
      (p_user_id, 'Fridge'),
      (p_user_id, 'Pantry'),
      (p_user_id, 'Freezer')
    ON CONFLICT (user_id, name) DO NOTHING;
  END IF;
END;
$$;

-- Replace deactivate_app to cascade-delete BOTH coachbyte AND chefbyte data
CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;

  IF p_app_name = 'coachbyte' THEN
    DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
    DELETE FROM coachbyte.splits WHERE user_id = p_user_id;
    -- daily_plans CASCADE deletes planned_sets and completed_sets
    DELETE FROM coachbyte.daily_plans WHERE user_id = p_user_id;
    DELETE FROM coachbyte.user_settings WHERE user_id = p_user_id;
  END IF;

  IF p_app_name = 'chefbyte' THEN
    -- Delete in FK-dependency order (children before parents)
    DELETE FROM chefbyte.liquidtrack_events WHERE user_id = p_user_id;
    DELETE FROM chefbyte.liquidtrack_devices WHERE user_id = p_user_id;
    DELETE FROM chefbyte.food_logs WHERE user_id = p_user_id;
    DELETE FROM chefbyte.temp_items WHERE user_id = p_user_id;
    DELETE FROM chefbyte.shopping_list WHERE user_id = p_user_id;
    DELETE FROM chefbyte.meal_plan_entries WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipe_ingredients WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipes WHERE user_id = p_user_id;
    DELETE FROM chefbyte.stock_lots WHERE user_id = p_user_id;
    DELETE FROM chefbyte.products WHERE user_id = p_user_id;
    DELETE FROM chefbyte.locations WHERE user_id = p_user_id;
    DELETE FROM chefbyte.user_config WHERE user_id = p_user_id;
  END IF;
END;
$$;
