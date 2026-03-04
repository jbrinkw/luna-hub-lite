-- Add partial unique index for fast API key authentication lookup (D4)
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON hub.api_keys (api_key_hash)
  WHERE revoked_at IS NULL;

-- Add index on planned_sets.plan_id for frequent join queries (D5)
CREATE INDEX IF NOT EXISTS idx_planned_sets_plan_id
  ON coachbyte.planned_sets (plan_id);

-- Add index on recipe_ingredients.recipe_id for frequent join queries (D6)
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe_id
  ON chefbyte.recipe_ingredients (recipe_id);
