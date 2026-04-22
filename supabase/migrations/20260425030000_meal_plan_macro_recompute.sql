-------------------------------------------------------------
-- Groundwork: chefbyte.recipe_changed_since(recipe_id, ts)
-------------------------------------------------------------
-- Investigation (2026-04-21): the meal-plan UI computes macros
-- at read time by joining meal_plan_entries -> recipes ->
-- recipe_ingredients -> products. There are NO cached macro
-- columns on meal_plan_entries and NO macro snapshot taken by
-- add_meal. Editing a recipe's ingredients therefore causes
-- the meal plan to reflect the new macros on the next render
-- automatically (TanStack Query invalidation refreshes the
-- joined data). A "stale macros" problem does not exist in
-- the current architecture.
--
-- This migration is a no-op for the stale-macros fix but adds
-- a small helper function that future features (e.g. "recipe
-- was edited since you added this meal — review it?") can use
-- without re-investigating the schema. No UI surface consumes
-- it yet.
--
-- Semantics:
--   recipe_changed_since(recipe_id, ts)
--     -> TRUE  if the recipe OR any of its current ingredients
--              were created after `ts`
--     -> FALSE if the recipe is older than ts and no ingredient
--              rows are newer (ingredient edits DELETE+INSERT
--              via private.save_recipe_ingredients, so
--              recipe_ingredients.created_at tracks the most
--              recent ingredient change)
--     -> FALSE if `ts` is NULL (nothing to compare against;
--              callers should treat NULL as "never checked"
--              according to their own policy)
--     -> FALSE if the recipe does not exist or is not owned by
--              the authenticated user (RLS-style safety; no
--              information leak)
--
-- Note: chefbyte.recipes has no updated_at column today. We
-- intentionally do NOT add one here — the DELETE+INSERT
-- pattern in private.save_recipe_ingredients means
-- MAX(recipe_ingredients.created_at) is already an accurate
-- "last content change" signal, and adding updated_at would
-- require touching every write path. If a future feature
-- needs to detect non-ingredient recipe edits (name change,
-- instructions change) we can add updated_at + trigger then.
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.recipe_changed_since(
  p_recipe_id UUID,
  p_ts TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_recipe_created TIMESTAMPTZ;
  v_max_ingredient_created TIMESTAMPTZ;
BEGIN
  -- NULL timestamp -> no comparison basis, treat as "not stale"
  IF p_ts IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Verify the recipe exists AND is owned by the caller.
  -- Using SECURITY DEFINER + explicit user check mirrors the
  -- RLS filter that authenticated users would hit directly.
  SELECT created_at INTO v_recipe_created
  FROM chefbyte.recipes
  WHERE recipe_id = p_recipe_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_recipe_created > p_ts THEN
    RETURN TRUE;
  END IF;

  SELECT MAX(created_at) INTO v_max_ingredient_created
  FROM chefbyte.recipe_ingredients
  WHERE recipe_id = p_recipe_id
    AND user_id = v_user_id;

  -- No ingredients at all -> cannot be "newer than ts"
  IF v_max_ingredient_created IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN v_max_ingredient_created > p_ts;
END;
$$;

GRANT EXECUTE ON FUNCTION chefbyte.recipe_changed_since(UUID, TIMESTAMPTZ) TO authenticated;
