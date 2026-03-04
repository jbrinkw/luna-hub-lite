-- Non-negative CHECK constraints for critical numeric columns
-- Prevents invalid negative values from persisting to the database

-- Product macros must be non-negative
ALTER TABLE chefbyte.products ADD CONSTRAINT products_calories_nonneg CHECK (calories_per_serving >= 0);
ALTER TABLE chefbyte.products ADD CONSTRAINT products_protein_nonneg CHECK (protein_per_serving >= 0);
ALTER TABLE chefbyte.products ADD CONSTRAINT products_carbs_nonneg CHECK (carbs_per_serving >= 0);
ALTER TABLE chefbyte.products ADD CONSTRAINT products_fat_nonneg CHECK (fat_per_serving >= 0);

-- Planned set targets must be non-negative (NULLs are allowed)
ALTER TABLE coachbyte.planned_sets ADD CONSTRAINT planned_sets_reps_nonneg CHECK (target_reps >= 0 OR target_reps IS NULL);
ALTER TABLE coachbyte.planned_sets ADD CONSTRAINT planned_sets_load_nonneg CHECK (target_load >= 0 OR target_load IS NULL);
