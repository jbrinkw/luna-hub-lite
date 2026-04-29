-- save_recipe_ingredients_visual: extend save_recipe_ingredients RPC to persist
-- visual_unit_label and visual_quantity on recipe_ingredients rows.
--
-- visual_unit_label / visual_quantity are display-only fields added in
-- migration 20260429250000_recipe_visual_unit.sql. The JSONB ingredient
-- payload now optionally carries them; if absent or null the columns remain
-- NULL (both-or-neither constraint is satisfied). The function reads canonical
-- `unit`+`quantity` from the same payload — visual fields are stored but never
-- used in macro/stock math.

CREATE OR REPLACE FUNCTION private.save_recipe_ingredients(
  p_user_id UUID,
  p_recipe_id UUID,
  p_ingredients JSONB  -- array of {product_id, quantity, unit, note, visual_unit_label?, visual_quantity?}
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
    INSERT INTO chefbyte.recipe_ingredients (
      user_id, recipe_id, product_id, quantity, unit, note,
      visual_unit_label, visual_quantity
    )
    VALUES (
      p_user_id,
      p_recipe_id,
      (v_ing->>'product_id')::uuid,
      (v_ing->>'quantity')::numeric,
      v_ing->>'unit',
      v_ing->>'note',
      -- visual pair: stored as-is; CHECK constraint on the table enforces
      -- both-or-neither + qty > 0 invariant server-side.
      NULLIF(v_ing->>'visual_unit_label', ''),
      CASE
        WHEN v_ing->>'visual_quantity' IS NOT NULL
         AND v_ing->>'visual_quantity' <> ''
        THEN (v_ing->>'visual_quantity')::numeric
        ELSE NULL
      END
    );
  END LOOP;
END;
$$;

-- Public wrapper is a sql SECURITY DEFINER that delegates to private —
-- no change needed to the wrapper signature; just re-grant to be safe.
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
