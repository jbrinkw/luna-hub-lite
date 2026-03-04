-------------------------------------------------------------
-- Atomic recipe ingredient save
-- Replaces the non-atomic DELETE + INSERT pattern with a
-- single transactional RPC call.
-------------------------------------------------------------

-- Core logic in private schema
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

-- Public RPC wrapper in chefbyte schema (PostgREST-accessible)
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
