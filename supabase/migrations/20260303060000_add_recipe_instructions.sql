-- no-test: column addition only — chefbyte.recipes table coverage in chefbyte/rls_core.test.sql
-- Add instructions column to recipes table for cooking directions.
-- Separate from description (which is a brief summary).
ALTER TABLE chefbyte.recipes ADD COLUMN instructions TEXT;
