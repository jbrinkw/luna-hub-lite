-- pgTAP tests for chefbyte.products.measured_full_at column.
--
-- Drives the 3-state inventory tag (red / blue / normal) for catch-all
-- LiveTrack auto-import:
--   * tare_weight_g IS NULL                              -> red  (no tare)
--   * tare_weight_g IS NOT NULL AND measured_full_at IS NULL -> blue (tare set, full not confirmed)
--   * tare_weight_g IS NOT NULL AND measured_full_at IS NOT NULL -> normal (both set)
--
-- Set-once semantics live in the Pi guard, the cloud edge function guard,
-- and the UI guard (subsequent tasks). This file only verifies that the
-- column exists, has the correct type, and is nullable so the unstamped
-- default state is representable.
--
-- Run:
--   flock /tmp/luna-supabase.lock supabase test db \
--     supabase/tests/chefbyte/products_measured_full_at.test.sql

BEGIN;
SELECT plan(3);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Column exists on chefbyte.products
-- ─────────────────────────────────────────────────────────────────────────

SELECT has_column(
  'chefbyte', 'products', 'measured_full_at',
  'chefbyte.products.measured_full_at exists'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Column type is timestamptz (so the stamp is timezone-safe)
-- ─────────────────────────────────────────────────────────────────────────

SELECT col_type_is(
  'chefbyte', 'products', 'measured_full_at', 'timestamp with time zone',
  'measured_full_at is timestamp with time zone'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Column is nullable — NULL = unstamped default (the blue-tag state
--    when tare_weight_g is also set)
-- ─────────────────────────────────────────────────────────────────────────

SELECT col_is_null(
  'chefbyte', 'products', 'measured_full_at',
  'measured_full_at is nullable (default state = unstamped)'
);

SELECT * FROM finish();
ROLLBACK;
