-- Migration: add before_image_url / after_image_url to review_queue
-- Mirrors the same columns on shelf_event_log (20260429300000).
-- Pi populates them when emitting review_queue_create events (after the
-- associated shelf event's images have been uploaded to Storage).
-- Both nullable: NULL = image not yet uploaded; web falls back to LAN path.

ALTER TABLE chefbyte.review_queue
  ADD COLUMN IF NOT EXISTS before_image_url TEXT,
  ADD COLUMN IF NOT EXISTS after_image_url  TEXT;

COMMENT ON COLUMN chefbyte.review_queue.before_image_url IS
  'HTTPS URL of the before-image in Supabase Storage. NULL until Pi uploads.';

COMMENT ON COLUMN chefbyte.review_queue.after_image_url IS
  'HTTPS URL of the after-image in Supabase Storage. NULL until Pi uploads.';
