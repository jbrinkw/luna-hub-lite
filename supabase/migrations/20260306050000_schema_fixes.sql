-- Schema fixes: H8, H9, H10, M14
-- H8:  NOT NULL + defaults on chefbyte.products macro columns
-- H9:  NOT NULL + defaults on recipes.base_servings and meal_plan_entries.servings
-- H10: Index on completed_sets(user_id, exercise_id) for PR lookup
-- M14: CHECK constraints on liquidtrack_events weight columns

BEGIN;

------------------------------------------------------------
-- H8: Add NOT NULL + defaults to products macro columns
------------------------------------------------------------
-- Backfill any NULL values before adding NOT NULL constraints.
-- The original table definition already has NOT NULL DEFAULT, but this
-- protects against any rows that may have been inserted via raw SQL
-- or future schema drift.

UPDATE chefbyte.products SET calories_per_serving = 0 WHERE calories_per_serving IS NULL;
UPDATE chefbyte.products SET protein_per_serving = 0 WHERE protein_per_serving IS NULL;
UPDATE chefbyte.products SET carbs_per_serving = 0 WHERE carbs_per_serving IS NULL;
UPDATE chefbyte.products SET fat_per_serving = 0 WHERE fat_per_serving IS NULL;
UPDATE chefbyte.products SET servings_per_container = 1 WHERE servings_per_container IS NULL;

ALTER TABLE chefbyte.products
  ALTER COLUMN calories_per_serving SET DEFAULT 0,
  ALTER COLUMN calories_per_serving SET NOT NULL,
  ALTER COLUMN protein_per_serving SET DEFAULT 0,
  ALTER COLUMN protein_per_serving SET NOT NULL,
  ALTER COLUMN carbs_per_serving SET DEFAULT 0,
  ALTER COLUMN carbs_per_serving SET NOT NULL,
  ALTER COLUMN fat_per_serving SET DEFAULT 0,
  ALTER COLUMN fat_per_serving SET NOT NULL,
  ALTER COLUMN servings_per_container SET DEFAULT 1,
  ALTER COLUMN servings_per_container SET NOT NULL;

------------------------------------------------------------
-- H9: Add NOT NULL + defaults to recipes.base_servings
--     and meal_plan_entries.servings
------------------------------------------------------------
-- Same defensive backfill pattern before enforcing NOT NULL.

UPDATE chefbyte.recipes SET base_servings = 1 WHERE base_servings IS NULL;
ALTER TABLE chefbyte.recipes
  ALTER COLUMN base_servings SET DEFAULT 1,
  ALTER COLUMN base_servings SET NOT NULL;

UPDATE chefbyte.meal_plan_entries SET servings = 1 WHERE servings IS NULL;
ALTER TABLE chefbyte.meal_plan_entries
  ALTER COLUMN servings SET DEFAULT 1,
  ALTER COLUMN servings SET NOT NULL;

------------------------------------------------------------
-- H10: Add index on completed_sets(user_id, exercise_id)
--      for fast PR lookup queries
------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_completed_sets_user_exercise
  ON coachbyte.completed_sets (user_id, exercise_id);

------------------------------------------------------------
-- M14: Add CHECK constraints on liquidtrack_events weight
--      columns to prevent negative weights
------------------------------------------------------------

ALTER TABLE chefbyte.liquidtrack_events
  ADD CONSTRAINT liquidtrack_events_weight_before_positive CHECK (weight_before >= 0),
  ADD CONSTRAINT liquidtrack_events_weight_after_positive CHECK (weight_after >= 0);

COMMIT;
