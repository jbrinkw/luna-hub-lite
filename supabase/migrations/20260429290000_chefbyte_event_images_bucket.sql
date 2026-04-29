-- Migration: create Supabase Storage bucket for Pi event images
-- (mixed-content fix: Pi uploads before/after JPEGs so the web app
--  can serve them over HTTPS instead of LAN http://192.168.x.x:8000)
--
-- Bucket: chefbyte-event-images
--   public READ  — anyone who knows the URL (contains event UUID) can view
--   WRITE        — service_role only (Pi uploads via service_role key)
--
-- Object path convention: <user_id>/<event_id>/before.jpg
--                          <user_id>/<event_id>/after.jpg

-- 1. Create the bucket (public=true means authenticated URL is not required
--    for GET — the random UUID path is the security boundary).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chefbyte-event-images',
  'chefbyte-event-images',
  true,
  5242880,  -- 5 MiB per file
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- 2. RLS: public can SELECT (read) any object in this bucket.
CREATE POLICY "chefbyte_event_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chefbyte-event-images');

-- 3. RLS: only service_role can INSERT (upload) into this bucket.
--    Pi uploads use the service_role JWT, not the user JWT.
CREATE POLICY "chefbyte_event_images_service_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chefbyte-event-images'
    AND (auth.role() = 'service_role' OR auth.jwt() ->> 'role' = 'service_role')
  );

-- 4. RLS: service_role can UPDATE (overwrite) existing uploads (idempotent re-upload).
CREATE POLICY "chefbyte_event_images_service_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chefbyte-event-images'
    AND (auth.role() = 'service_role' OR auth.jwt() ->> 'role' = 'service_role')
  );
