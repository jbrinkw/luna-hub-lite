-- save_recipe_ingredients_no_visual: revert
-- private.save_recipe_ingredients (and its public wrapper
-- chefbyte.save_recipe_ingredients) to the pre-visual signature.
--
-- The per-ingredient visual_unit_label + visual_quantity columns were
-- dropped in companion migration
-- 20260430050000_drop_recipe_visual_unit.sql. The JSONB ingredient
-- payload now ONLY carries {product_id, quantity, unit, note}; no
-- visual fields are accepted or referenced by the INSERT.
--
-- The original (pre-visual) function lived in
-- supabase/migrations/20260304040001_atomic_recipe_ingredients.sql; this
-- migration restores that body verbatim while leaving the previous
-- 20260429260000 visual-aware definition in place at its original
-- file (CREATE OR REPLACE supersedes it on apply).

CREATE OR REPLACE FUNCTION private.save_recipe_ingredients(
  p_user_id UUID,
  p_recipe_id UUID,
  p_ingredients JSONB  -- array of {product_id, quantity, unit, note}
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ing JSONB;
BEGIN
  -- Verify recipe ownership
  IF NOT EXISTS (
    SELECT 1 FROM chefbyte.recipes WHERE recipe_id = p_recipe_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Recipe not found or not owned by user';
  END IF;

  -- Atomic: delete old + insert new in same transaction
  DELETE FROM chefbyte.recipe_ingredients
  WHERE recipe_id = p_recipe_id AND user_id = p_user_id;

  FOR v_ing IN SELECT * FROM jsonb_array_elements(p_ingredients)
  LOOP
    INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit, note)
    VALUES (
      p_user_id,
      p_recipe_id,
      (v_ing->>'product_id')::uuid,
      (v_ing->>'quantity')::numeric,
      v_ing->>'unit',
      v_ing->>'note'
    );
  END LOOP;
END;
$$;

-- Public wrapper is a sql SECURITY DEFINER that delegates to private —
-- signature unchanged; re-grant to be safe so the wrapper executes for
-- authenticated callers regardless of GRANT history on prior versions.
CREATE OR REPLACE FUNCTION chefbyte.save_recipe_ingredients(
  p_recipe_id UUID,
  p_ingredients JSONB
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.save_recipe_ingredients(
    (SELECT auth.uid()), p_recipe_id, p_ingredients
  );
$$;

GRANT EXECUTE ON FUNCTION chefbyte.save_recipe_ingredients(UUID, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION chefbyte.save_recipe_ingredients(UUID, JSONB) FROM anon;
