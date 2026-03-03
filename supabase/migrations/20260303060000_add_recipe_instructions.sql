-- Add instructions column to recipes table for cooking directions.
-- Separate from description (which is a brief summary).
ALTER TABLE chefbyte.recipes ADD COLUMN instructions TEXT;
