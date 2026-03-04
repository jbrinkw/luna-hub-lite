-- Add meal_type column to meal_plan_entries for categorizing meals.
-- Nullable TEXT with a CHECK constraint limiting to known types.

ALTER TABLE chefbyte.meal_plan_entries
  ADD COLUMN meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack'));
