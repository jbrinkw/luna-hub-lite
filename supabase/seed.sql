-- =============================================================================
-- Luna Hub Lite — Seed Data
-- =============================================================================
-- Runs on `supabase db reset` as superuser.
-- Creates a demo user with realistic data across all modules.
-- All UUIDs are fixed for determinism. ON CONFLICT DO NOTHING for idempotency.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Demo user in auth.users + auth.identities
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new,
  email_change_token_current,
  phone_change,
  phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated',
  'authenticated',
  'demo@lunahub.dev',
  crypt('demo1234', gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"display_name": "Demo User", "timezone": "America/New_York"}',
  now(),
  now(),
  '',
  '',
  '',
  '',
  '',
  '',
  ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub": "11111111-1111-1111-1111-111111111111", "email": "demo@lunahub.dev"}',
  'email',
  now(),
  now(),
  now()
) ON CONFLICT (provider_id, provider) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Hub profile
-- ─────────────────────────────────────────────────────────────────────────────
-- The trigger on auth.users INSERT creates the profile automatically,
-- but we update it here to ensure the values we want.

UPDATE hub.profiles
SET display_name = 'Demo User',
    timezone = 'America/New_York',
    day_start_hour = 6
WHERE user_id = '11111111-1111-1111-1111-111111111111';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Activate both apps
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO hub.app_activations (user_id, app_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'coachbyte'),
  ('11111111-1111-1111-1111-111111111111', 'chefbyte')
ON CONFLICT (user_id, app_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CoachByte user settings
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO coachbyte.user_settings (user_id, default_rest_seconds, bar_weight_lbs, available_plates) VALUES
  ('11111111-1111-1111-1111-111111111111', 90, 45.000, '[45,35,25,10,5,2.5]')
ON CONFLICT (user_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ChefByte locations (3 fixed locations)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO chefbyte.locations (location_id, user_id, name) VALUES
  ('aaaaaaaa-1001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Fridge'),
  ('aaaaaaaa-1002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Freezer'),
  ('aaaaaaaa-1003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Pantry')
ON CONFLICT (user_id, name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ChefByte products (10 products with realistic nutrition)
-- ─────────────────────────────────────────────────────────────────────────────
-- Nutrition is per serving. servings_per_container varies by product.
-- min_stock_amount: minimum containers to keep in stock (0 = no alert).

INSERT INTO chefbyte.products (product_id, user_id, name, barcode, description, servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, min_stock_amount, price) VALUES
  -- Proteins
  ('aaaaaaaa-2001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Chicken Breast', '012345678901', 'Boneless skinless chicken breast, ~4oz serving',
   4.000, 120.000, 0.000, 26.000, 1.500, 2.000, 8.990),

  ('aaaaaaaa-2002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Salmon Fillet', '012345678902', 'Atlantic salmon fillet, ~4oz serving',
   2.000, 208.000, 0.000, 20.000, 13.000, 1.000, 12.490),

  ('aaaaaaaa-2003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Eggs', '012345678903', 'Large eggs, 1 egg per serving',
   12.000, 70.000, 0.000, 6.000, 5.000, 1.000, 3.490),

  ('aaaaaaaa-2004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Greek Yogurt', '012345678904', 'Plain nonfat Greek yogurt, 170g cup',
   1.000, 100.000, 6.000, 17.000, 0.700, 3.000, 1.290),

  -- Carbs
  ('aaaaaaaa-2005-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Brown Rice', '012345678905', 'Long grain brown rice, 1/4 cup dry per serving',
   16.000, 170.000, 35.000, 4.000, 1.500, 1.000, 2.990),

  ('aaaaaaaa-2006-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Oats', '012345678906', 'Old fashioned rolled oats, 1/2 cup dry per serving',
   13.000, 150.000, 27.000, 5.000, 3.000, 1.000, 4.490),

  ('aaaaaaaa-2007-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Bananas', '012345678907', 'Medium banana, ~118g',
   1.000, 105.000, 27.000, 1.300, 0.400, 3.000, 0.290),

  -- Fats
  ('aaaaaaaa-2008-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Olive Oil', '012345678908', 'Extra virgin olive oil, 1 tbsp per serving',
   33.000, 120.000, 0.000, 0.000, 14.000, 1.000, 7.990),

  -- Supplements
  ('aaaaaaaa-2009-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Protein Powder', '012345678909', 'Whey protein isolate, 1 scoop (30g) per serving',
   30.000, 120.000, 3.000, 25.000, 1.000, 1.000, 34.990),

  -- Vegetables
  ('aaaaaaaa-200a-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Broccoli', '012345678910', 'Fresh broccoli crowns, ~1 cup chopped per serving',
   3.000, 55.000, 11.000, 3.700, 0.600, 2.000, 2.490)
ON CONFLICT (product_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ChefByte stock lots (varied levels)
-- ─────────────────────────────────────────────────────────────────────────────
-- Some above min_stock, some below, some zero.
-- Bananas and Broccoli intentionally have NO lots (0 stock).

INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on) VALUES
  -- Chicken Breast: 3 containers in Fridge (above min 2), 2 in Freezer
  ('aaaaaaaa-3001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2001-0000-0000-000000000000', 'aaaaaaaa-1001-0000-0000-000000000000',
   3.000, CURRENT_DATE + INTERVAL '3 days'),
  ('aaaaaaaa-3002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2001-0000-0000-000000000000', 'aaaaaaaa-1002-0000-0000-000000000000',
   2.000, CURRENT_DATE + INTERVAL '30 days'),

  -- Salmon: 1 container in Freezer (at min 1)
  ('aaaaaaaa-3003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2002-0000-0000-000000000000', 'aaaaaaaa-1002-0000-0000-000000000000',
   1.000, CURRENT_DATE + INTERVAL '14 days'),

  -- Eggs: 2 containers in Fridge (above min 1), one expiring soon
  ('aaaaaaaa-3004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2003-0000-0000-000000000000', 'aaaaaaaa-1001-0000-0000-000000000000',
   1.000, CURRENT_DATE + INTERVAL '5 days'),
  ('aaaaaaaa-3005-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2003-0000-0000-000000000000', 'aaaaaaaa-1001-0000-0000-000000000000',
   1.000, CURRENT_DATE + INTERVAL '12 days'),

  -- Greek Yogurt: 2 cups in Fridge (below min 3)
  ('aaaaaaaa-3006-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2004-0000-0000-000000000000', 'aaaaaaaa-1001-0000-0000-000000000000',
   2.000, CURRENT_DATE + INTERVAL '7 days'),

  -- Brown Rice: 1 bag in Pantry (at min 1)
  ('aaaaaaaa-3007-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2005-0000-0000-000000000000', 'aaaaaaaa-1003-0000-0000-000000000000',
   1.000, NULL),

  -- Oats: 2 containers in Pantry (above min 1)
  ('aaaaaaaa-3008-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2006-0000-0000-000000000000', 'aaaaaaaa-1003-0000-0000-000000000000',
   2.000, NULL),

  -- Bananas: NO LOTS (0 stock, below min 3) -- intentionally omitted

  -- Olive Oil: 1 bottle in Pantry (at min 1)
  ('aaaaaaaa-3009-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2008-0000-0000-000000000000', 'aaaaaaaa-1003-0000-0000-000000000000',
   1.000, NULL),

  -- Protein Powder: 0.5 container in Pantry (below min 1)
  ('aaaaaaaa-300a-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2009-0000-0000-000000000000', 'aaaaaaaa-1003-0000-0000-000000000000',
   0.500, NULL)

  -- Broccoli: NO LOTS (0 stock, below min 2) -- intentionally omitted
ON CONFLICT (lot_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ChefByte recipes (3 recipes with ingredients)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, description, base_servings, active_time, total_time) VALUES
  ('aaaaaaaa-4001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Chicken & Rice Bowl', 'Grilled chicken breast on brown rice with olive oil drizzle',
   1.000, 10, 30),

  ('aaaaaaaa-4002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Protein Shake', 'Quick post-workout protein shake with banana and oats',
   1.000, 3, 3),

  ('aaaaaaaa-4003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Greek Yogurt Bowl', 'Greek yogurt topped with oats and banana slices',
   1.000, 5, 5)
ON CONFLICT (recipe_id) DO NOTHING;

-- Recipe ingredients
INSERT INTO chefbyte.recipe_ingredients (ingredient_id, recipe_id, product_id, user_id, quantity, unit, note) VALUES
  -- Chicken & Rice Bowl: 1 serving chicken (1/4 container), 2 servings rice, 1 serving olive oil
  ('aaaaaaaa-4101-0000-0000-000000000000', 'aaaaaaaa-4001-0000-0000-000000000000',
   'aaaaaaaa-2001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'serving', 'Grilled and sliced'),
  ('aaaaaaaa-4102-0000-0000-000000000000', 'aaaaaaaa-4001-0000-0000-000000000000',
   'aaaaaaaa-2005-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   2.000, 'serving', '1/2 cup dry rice'),
  ('aaaaaaaa-4103-0000-0000-000000000000', 'aaaaaaaa-4001-0000-0000-000000000000',
   'aaaaaaaa-2008-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'serving', 'Drizzle on top'),

  -- Protein Shake: 1 scoop protein, 1 banana, 1 serving oats
  ('aaaaaaaa-4201-0000-0000-000000000000', 'aaaaaaaa-4002-0000-0000-000000000000',
   'aaaaaaaa-2009-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'serving', NULL),
  ('aaaaaaaa-4202-0000-0000-000000000000', 'aaaaaaaa-4002-0000-0000-000000000000',
   'aaaaaaaa-2007-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'container', 'One medium banana'),
  ('aaaaaaaa-4203-0000-0000-000000000000', 'aaaaaaaa-4002-0000-0000-000000000000',
   'aaaaaaaa-2006-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'serving', 'Blended in'),

  -- Greek Yogurt Bowl: 1 yogurt cup, 1 serving oats, 0.5 banana
  ('aaaaaaaa-4301-0000-0000-000000000000', 'aaaaaaaa-4003-0000-0000-000000000000',
   'aaaaaaaa-2004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'container', NULL),
  ('aaaaaaaa-4302-0000-0000-000000000000', 'aaaaaaaa-4003-0000-0000-000000000000',
   'aaaaaaaa-2006-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   1.000, 'serving', 'Sprinkled on top'),
  ('aaaaaaaa-4303-0000-0000-000000000000', 'aaaaaaaa-4003-0000-0000-000000000000',
   'aaaaaaaa-2007-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   0.500, 'container', 'Half banana, sliced')
ON CONFLICT (ingredient_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Meal plan entries: today (3 meals) + tomorrow (1 meal prep)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO chefbyte.meal_plan_entries (meal_id, user_id, recipe_id, product_id, logical_date, servings, meal_prep, completed_at) VALUES
  -- Today: Greek Yogurt Bowl for breakfast (completed)
  ('aaaaaaaa-5001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-4003-0000-0000-000000000000', NULL,
   CURRENT_DATE, 1.000, false, now() - INTERVAL '4 hours'),

  -- Today: Chicken & Rice Bowl for lunch (not yet completed)
  ('aaaaaaaa-5002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-4001-0000-0000-000000000000', NULL,
   CURRENT_DATE, 1.000, false, NULL),

  -- Today: Protein Shake post-workout (not yet completed)
  ('aaaaaaaa-5003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-4002-0000-0000-000000000000', NULL,
   CURRENT_DATE, 1.000, false, NULL),

  -- Tomorrow: Chicken & Rice Bowl x3 (meal prep)
  ('aaaaaaaa-5004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-4001-0000-0000-000000000000', NULL,
   CURRENT_DATE + 1, 3.000, true, NULL)
ON CONFLICT (meal_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Food log (1 entry: eggs today) + temp item (coffee with cream)
-- ─────────────────────────────────────────────────────────────────────────────

-- Eggs: 2 eggs consumed = 2 servings
INSERT INTO chefbyte.food_logs (log_id, user_id, product_id, logical_date, qty_consumed, unit, calories, carbs, protein, fat) VALUES
  ('aaaaaaaa-6001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2003-0000-0000-000000000000',
   CURRENT_DATE, 2.000, 'serving',
   140.000, 0.000, 12.000, 10.000)
ON CONFLICT (log_id) DO NOTHING;

-- Temp item: Coffee with cream (not a tracked product)
INSERT INTO chefbyte.temp_items (temp_id, user_id, name, logical_date, calories, carbs, protein, fat) VALUES
  ('aaaaaaaa-6101-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'Coffee with Cream', CURRENT_DATE,
   50.000, 1.000, 1.000, 5.000)
ON CONFLICT (temp_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Macro goals in user_config (2200 cal, 180p, 220c, 73f)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO chefbyte.user_config (config_id, user_id, key, value) VALUES
  ('aaaaaaaa-7001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_calories', '2200'),
  ('aaaaaaaa-7002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_protein', '180'),
  ('aaaaaaaa-7003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_carbs', '220'),
  ('aaaaaaaa-7004-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'goal_fat', '73')
ON CONFLICT (user_id, key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Shopping list items
-- ─────────────────────────────────────────────────────────────────────────────
-- Bananas: need to buy (0 stock, min 3)
-- Broccoli: need to buy (0 stock, min 2)
-- Eggs: already purchased

INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers, purchased) VALUES
  ('aaaaaaaa-8001-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2007-0000-0000-000000000000', 3.000, false),
  ('aaaaaaaa-8002-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-200a-0000-0000-000000000000', 2.000, false),
  ('aaaaaaaa-8003-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-2003-0000-0000-000000000000', 1.000, true)
ON CONFLICT (user_id, product_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. CoachByte splits (Push/Pull/Legs for weekdays 1,2,3,5,6)
-- ─────────────────────────────────────────────────────────────────────────────
-- Looks up global exercise IDs by name since they are auto-generated UUIDs.
-- Weekday: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

DO $$ DECLARE
  v_user_id     UUID := '11111111-1111-1111-1111-111111111111';
  -- Push exercises
  v_bench       UUID;
  v_ohp         UUID;
  v_incline     UUID;
  v_dip         UUID;
  v_tricep_ext  UUID;
  v_lateral     UUID;
  -- Pull exercises
  v_deadlift    UUID;
  v_pullup      UUID;
  v_row         UUID;
  v_lat_pull    UUID;
  v_cable_row   UUID;
  v_curl        UUID;
  v_face_pull   UUID;
  -- Legs exercises
  v_squat       UUID;
  v_leg_press   UUID;
  v_rdl         UUID;
  v_leg_curl    UUID;
  v_leg_ext     UUID;
  v_calf        UUID;
BEGIN
  -- Look up global exercise IDs
  SELECT exercise_id INTO v_bench      FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Bench Press';
  SELECT exercise_id INTO v_ohp        FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Overhead Press';
  SELECT exercise_id INTO v_incline    FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Incline Bench Press';
  SELECT exercise_id INTO v_dip        FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Dip';
  SELECT exercise_id INTO v_tricep_ext FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Tricep Extension';
  SELECT exercise_id INTO v_lateral    FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Lateral Raise';

  SELECT exercise_id INTO v_deadlift   FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Deadlift';
  SELECT exercise_id INTO v_pullup     FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Pull-Up';
  SELECT exercise_id INTO v_row        FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Barbell Row';
  SELECT exercise_id INTO v_lat_pull   FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Lat Pulldown';
  SELECT exercise_id INTO v_cable_row  FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Cable Row';
  SELECT exercise_id INTO v_curl       FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Barbell Curl';
  SELECT exercise_id INTO v_face_pull  FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Face Pull';

  SELECT exercise_id INTO v_squat      FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat';
  SELECT exercise_id INTO v_leg_press  FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Leg Press';
  SELECT exercise_id INTO v_rdl        FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Romanian Deadlift';
  SELECT exercise_id INTO v_leg_curl   FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Leg Curl';
  SELECT exercise_id INTO v_leg_ext    FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Leg Extension';
  SELECT exercise_id INTO v_calf       FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Calf Raise';

  -- Monday (1) = Push A
  INSERT INTO coachbyte.splits (split_id, user_id, weekday, template_sets, split_notes) VALUES
    ('aaaaaaaa-9001-0000-0000-000000000000', v_user_id, 1,
     jsonb_build_array(
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 8,  'target_load', 185, 'rest_seconds', 120, 'order', 1),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 8,  'target_load', 185, 'rest_seconds', 120, 'order', 2),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 8,  'target_load', 185, 'rest_seconds', 120, 'order', 3),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 8,  'target_load', 185, 'rest_seconds', 120, 'order', 4),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 10, 'target_load', 95,  'rest_seconds', 90,  'order', 5),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 10, 'target_load', 95,  'rest_seconds', 90,  'order', 6),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 10, 'target_load', 95,  'rest_seconds', 90,  'order', 7),
       jsonb_build_object('exercise_id', v_dip,        'target_reps', 12, 'target_load', 0,   'rest_seconds', 60,  'order', 8),
       jsonb_build_object('exercise_id', v_dip,        'target_reps', 12, 'target_load', 0,   'rest_seconds', 60,  'order', 9),
       jsonb_build_object('exercise_id', v_dip,        'target_reps', 12, 'target_load', 0,   'rest_seconds', 60,  'order', 10),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 12, 'target_load', 40,  'rest_seconds', 60,  'order', 11),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 12, 'target_load', 40,  'rest_seconds', 60,  'order', 12),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 12, 'target_load', 40,  'rest_seconds', 60,  'order', 13),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 20,  'rest_seconds', 60,  'order', 14),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 20,  'rest_seconds', 60,  'order', 15),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 20,  'rest_seconds', 60,  'order', 16)
     ),
     'Push A — Bench focus')
  ON CONFLICT (user_id, weekday) DO NOTHING;

  -- Tuesday (2) = Pull A
  INSERT INTO coachbyte.splits (split_id, user_id, weekday, template_sets, split_notes) VALUES
    ('aaaaaaaa-9002-0000-0000-000000000000', v_user_id, 2,
     jsonb_build_array(
       jsonb_build_object('exercise_id', v_deadlift,  'target_reps', 5,  'target_load', 315, 'rest_seconds', 180, 'order', 1),
       jsonb_build_object('exercise_id', v_deadlift,  'target_reps', 5,  'target_load', 315, 'rest_seconds', 180, 'order', 2),
       jsonb_build_object('exercise_id', v_deadlift,  'target_reps', 5,  'target_load', 315, 'rest_seconds', 180, 'order', 3),
       jsonb_build_object('exercise_id', v_deadlift,  'target_reps', 5,  'target_load', 315, 'rest_seconds', 180, 'order', 4),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 5),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 6),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 7),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 10, 'target_load', 155, 'rest_seconds', 90,  'order', 8),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 10, 'target_load', 155, 'rest_seconds', 90,  'order', 9),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 10, 'target_load', 155, 'rest_seconds', 90,  'order', 10),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 65,  'rest_seconds', 60,  'order', 11),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 65,  'rest_seconds', 60,  'order', 12),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 65,  'rest_seconds', 60,  'order', 13),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 30,  'rest_seconds', 60,  'order', 14),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 30,  'rest_seconds', 60,  'order', 15),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 30,  'rest_seconds', 60,  'order', 16)
     ),
     'Pull A — Deadlift focus')
  ON CONFLICT (user_id, weekday) DO NOTHING;

  -- Wednesday (3) = Legs A
  INSERT INTO coachbyte.splits (split_id, user_id, weekday, template_sets, split_notes) VALUES
    ('aaaaaaaa-9003-0000-0000-000000000000', v_user_id, 3,
     jsonb_build_array(
       jsonb_build_object('exercise_id', v_squat,     'target_reps', 6,  'target_load', 275, 'rest_seconds', 180, 'order', 1),
       jsonb_build_object('exercise_id', v_squat,     'target_reps', 6,  'target_load', 275, 'rest_seconds', 180, 'order', 2),
       jsonb_build_object('exercise_id', v_squat,     'target_reps', 6,  'target_load', 275, 'rest_seconds', 180, 'order', 3),
       jsonb_build_object('exercise_id', v_squat,     'target_reps', 6,  'target_load', 275, 'rest_seconds', 180, 'order', 4),
       jsonb_build_object('exercise_id', v_leg_press, 'target_reps', 12, 'target_load', 360, 'rest_seconds', 90,  'order', 5),
       jsonb_build_object('exercise_id', v_leg_press, 'target_reps', 12, 'target_load', 360, 'rest_seconds', 90,  'order', 6),
       jsonb_build_object('exercise_id', v_leg_press, 'target_reps', 12, 'target_load', 360, 'rest_seconds', 90,  'order', 7),
       jsonb_build_object('exercise_id', v_rdl,       'target_reps', 10, 'target_load', 185, 'rest_seconds', 90,  'order', 8),
       jsonb_build_object('exercise_id', v_rdl,       'target_reps', 10, 'target_load', 185, 'rest_seconds', 90,  'order', 9),
       jsonb_build_object('exercise_id', v_rdl,       'target_reps', 10, 'target_load', 185, 'rest_seconds', 90,  'order', 10),
       jsonb_build_object('exercise_id', v_leg_curl,  'target_reps', 12, 'target_load', 90,  'rest_seconds', 60,  'order', 11),
       jsonb_build_object('exercise_id', v_leg_curl,  'target_reps', 12, 'target_load', 90,  'rest_seconds', 60,  'order', 12),
       jsonb_build_object('exercise_id', v_leg_curl,  'target_reps', 12, 'target_load', 90,  'rest_seconds', 60,  'order', 13),
       jsonb_build_object('exercise_id', v_calf,      'target_reps', 15, 'target_load', 135, 'rest_seconds', 60,  'order', 14),
       jsonb_build_object('exercise_id', v_calf,      'target_reps', 15, 'target_load', 135, 'rest_seconds', 60,  'order', 15),
       jsonb_build_object('exercise_id', v_calf,      'target_reps', 15, 'target_load', 135, 'rest_seconds', 60,  'order', 16),
       jsonb_build_object('exercise_id', v_calf,      'target_reps', 15, 'target_load', 135, 'rest_seconds', 60,  'order', 17)
     ),
     'Legs A — Squat focus')
  ON CONFLICT (user_id, weekday) DO NOTHING;

  -- Friday (5) = Push B
  INSERT INTO coachbyte.splits (split_id, user_id, weekday, template_sets, split_notes) VALUES
    ('aaaaaaaa-9005-0000-0000-000000000000', v_user_id, 5,
     jsonb_build_array(
       jsonb_build_object('exercise_id', v_incline,    'target_reps', 8,  'target_load', 155, 'rest_seconds', 120, 'order', 1),
       jsonb_build_object('exercise_id', v_incline,    'target_reps', 8,  'target_load', 155, 'rest_seconds', 120, 'order', 2),
       jsonb_build_object('exercise_id', v_incline,    'target_reps', 8,  'target_load', 155, 'rest_seconds', 120, 'order', 3),
       jsonb_build_object('exercise_id', v_incline,    'target_reps', 8,  'target_load', 155, 'rest_seconds', 120, 'order', 4),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 8,  'target_load', 105, 'rest_seconds', 90,  'order', 5),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 8,  'target_load', 105, 'rest_seconds', 90,  'order', 6),
       jsonb_build_object('exercise_id', v_ohp,        'target_reps', 8,  'target_load', 105, 'rest_seconds', 90,  'order', 7),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 10, 'target_load', 165, 'rest_seconds', 90,  'order', 8),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 10, 'target_load', 165, 'rest_seconds', 90,  'order', 9),
       jsonb_build_object('exercise_id', v_bench,      'target_reps', 10, 'target_load', 165, 'rest_seconds', 90,  'order', 10),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 11),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 12),
       jsonb_build_object('exercise_id', v_tricep_ext, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 13),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 25,  'rest_seconds', 60,  'order', 14),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 25,  'rest_seconds', 60,  'order', 15),
       jsonb_build_object('exercise_id', v_lateral,    'target_reps', 15, 'target_load', 25,  'rest_seconds', 60,  'order', 16)
     ),
     'Push B — Incline focus')
  ON CONFLICT (user_id, weekday) DO NOTHING;

  -- Saturday (6) = Pull B
  INSERT INTO coachbyte.splits (split_id, user_id, weekday, template_sets, split_notes) VALUES
    ('aaaaaaaa-9006-0000-0000-000000000000', v_user_id, 6,
     jsonb_build_array(
       jsonb_build_object('exercise_id', v_row,       'target_reps', 8,  'target_load', 165, 'rest_seconds', 120, 'order', 1),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 8,  'target_load', 165, 'rest_seconds', 120, 'order', 2),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 8,  'target_load', 165, 'rest_seconds', 120, 'order', 3),
       jsonb_build_object('exercise_id', v_row,       'target_reps', 8,  'target_load', 165, 'rest_seconds', 120, 'order', 4),
       jsonb_build_object('exercise_id', v_lat_pull,  'target_reps', 10, 'target_load', 140, 'rest_seconds', 90,  'order', 5),
       jsonb_build_object('exercise_id', v_lat_pull,  'target_reps', 10, 'target_load', 140, 'rest_seconds', 90,  'order', 6),
       jsonb_build_object('exercise_id', v_lat_pull,  'target_reps', 10, 'target_load', 140, 'rest_seconds', 90,  'order', 7),
       jsonb_build_object('exercise_id', v_cable_row, 'target_reps', 12, 'target_load', 120, 'rest_seconds', 90,  'order', 8),
       jsonb_build_object('exercise_id', v_cable_row, 'target_reps', 12, 'target_load', 120, 'rest_seconds', 90,  'order', 9),
       jsonb_build_object('exercise_id', v_cable_row, 'target_reps', 12, 'target_load', 120, 'rest_seconds', 90,  'order', 10),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 11),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 12),
       jsonb_build_object('exercise_id', v_pullup,    'target_reps', 8,  'target_load', 0,   'rest_seconds', 90,  'order', 13),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 70,  'rest_seconds', 60,  'order', 14),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 70,  'rest_seconds', 60,  'order', 15),
       jsonb_build_object('exercise_id', v_curl,      'target_reps', 12, 'target_load', 70,  'rest_seconds', 60,  'order', 16),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 17),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 18),
       jsonb_build_object('exercise_id', v_face_pull, 'target_reps', 15, 'target_load', 35,  'rest_seconds', 60,  'order', 19)
     ),
     'Pull B — Row focus')
  ON CONFLICT (user_id, weekday) DO NOTHING;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 14. Yesterday's completed workout (Push A)
  -- ───────────────────────────────────────────────────────────────────────────

  -- Daily plan for yesterday
  INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary) VALUES
    ('aaaaaaaa-a001-0000-0000-000000000000', v_user_id,
     CURRENT_DATE - 1, CURRENT_DATE - 1, 'Push A — Bench focus')
  ON CONFLICT (user_id, plan_date) DO NOTHING;

  -- Planned sets for yesterday's Push A (16 total sets)
  -- Bench Press 4x8 @ 185
  INSERT INTO coachbyte.planned_sets (planned_set_id, plan_id, user_id, exercise_id, target_reps, target_load, rest_seconds, "order") VALUES
    ('aaaaaaaa-b001-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, 120, 1),
    ('aaaaaaaa-b002-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, 120, 2),
    ('aaaaaaaa-b003-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, 120, 3),
    ('aaaaaaaa-b004-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, 120, 4),
    -- OHP 3x10 @ 95
    ('aaaaaaaa-b005-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, 90, 5),
    ('aaaaaaaa-b006-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, 90, 6),
    ('aaaaaaaa-b007-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, 90, 7),
    -- Dip 3x12 @ bodyweight
    ('aaaaaaaa-b008-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, 90, 8),
    ('aaaaaaaa-b009-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, 90, 9),
    ('aaaaaaaa-b00a-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, 90, 10),
    -- Tricep Extension 3x12 @ 40
    ('aaaaaaaa-b00b-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_tricep_ext, 12, 40.000, 60, 11),
    ('aaaaaaaa-b00c-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_tricep_ext, 12, 40.000, 60, 12),
    ('aaaaaaaa-b00d-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_tricep_ext, 12, 40.000, 60, 13),
    -- Lateral Raise 3x15 @ 20
    ('aaaaaaaa-b00e-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, 60, 14),
    ('aaaaaaaa-b00f-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, 60, 15),
    ('aaaaaaaa-b010-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, 60, 16)
  ON CONFLICT (planned_set_id) DO NOTHING;

  -- Completed sets matching the planned sets (realistic: slight rep variation)
  INSERT INTO coachbyte.completed_sets (completed_set_id, plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date, completed_at) VALUES
    -- Bench: hit all reps on sets 1-3, dropped to 7 on set 4
    ('aaaaaaaa-c001-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b001-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, CURRENT_DATE - 1, now() - INTERVAL '25 hours'),
    ('aaaaaaaa-c002-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b002-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 57 minutes'),
    ('aaaaaaaa-c003-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b003-0000-0000-000000000000', v_user_id, v_bench, 8, 185.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 54 minutes'),
    ('aaaaaaaa-c004-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b004-0000-0000-000000000000', v_user_id, v_bench, 7, 185.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 51 minutes'),
    -- OHP: all 10 reps
    ('aaaaaaaa-c005-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b005-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 47 minutes'),
    ('aaaaaaaa-c006-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b006-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 44 minutes'),
    ('aaaaaaaa-c007-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b007-0000-0000-000000000000', v_user_id, v_ohp, 10, 95.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 41 minutes'),
    -- Dips: all 12 reps
    ('aaaaaaaa-c008-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b008-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 37 minutes'),
    ('aaaaaaaa-c009-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b009-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 34 minutes'),
    ('aaaaaaaa-c00a-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00a-0000-0000-000000000000', v_user_id, v_dip, 12, 0.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 31 minutes'),
    -- Tricep Extension: 12, 12, 10 (fatigued on last set)
    ('aaaaaaaa-c00b-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00b-0000-0000-000000000000', v_user_id, v_tricep_ext, 12, 40.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 27 minutes'),
    ('aaaaaaaa-c00c-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00c-0000-0000-000000000000', v_user_id, v_tricep_ext, 12, 40.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 24 minutes'),
    ('aaaaaaaa-c00d-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00d-0000-0000-000000000000', v_user_id, v_tricep_ext, 10, 40.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 21 minutes'),
    -- Lateral Raise: all 15 reps
    ('aaaaaaaa-c00e-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00e-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 17 minutes'),
    ('aaaaaaaa-c00f-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b00f-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 14 minutes'),
    ('aaaaaaaa-c010-0000-0000-000000000000', 'aaaaaaaa-a001-0000-0000-000000000000', 'aaaaaaaa-b010-0000-0000-000000000000', v_user_id, v_lateral, 15, 20.000, CURRENT_DATE - 1, now() - INTERVAL '24 hours 11 minutes')
  ON CONFLICT (completed_set_id) DO NOTHING;

END $$;
