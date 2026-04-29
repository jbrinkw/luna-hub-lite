-- Migration: add before_image_url / after_image_url to shelf_event_log
-- Pi populates these via service_role UPDATE after uploading to
-- chefbyte-event-images Storage bucket.  Both nullable — NULL means the
-- image has not been uploaded yet; the web app falls back to LAN URL.

ALTER TABLE chefbyte.shelf_event_log
  ADD COLUMN IF NOT EXISTS before_image_url TEXT,
  ADD COLUMN IF NOT EXISTS after_image_url  TEXT;

COMMENT ON COLUMN chefbyte.shelf_event_log.before_image_url IS
  'HTTPS URL of the before-image in Supabase Storage (chefbyte-event-images bucket). '
  'NULL until the Pi uploads the image. Web app falls back to LAN URL when NULL.';

COMMENT ON COLUMN chefbyte.shelf_event_log.after_image_url IS
  'HTTPS URL of the after-image in Supabase Storage (chefbyte-event-images bucket). '
  'NULL until the Pi uploads the image. Web app falls back to LAN URL when NULL.';
