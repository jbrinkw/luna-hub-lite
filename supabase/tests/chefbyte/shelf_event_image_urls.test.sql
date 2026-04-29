-- pgTAP: shelf_event_log image URL columns exist + nullable + usable
-- Tests the 20260429300000_shelf_event_image_urls.sql migration.

BEGIN;

SELECT plan(8);

-- 1. Columns exist on shelf_event_log
SELECT has_column(
  'chefbyte', 'shelf_event_log', 'before_image_url',
  'before_image_url column exists on chefbyte.shelf_event_log'
);

SELECT has_column(
  'chefbyte', 'shelf_event_log', 'after_image_url',
  'after_image_url column exists on chefbyte.shelf_event_log'
);

-- 2. Columns are TEXT type
SELECT col_type_is(
  'chefbyte', 'shelf_event_log', 'before_image_url', 'text',
  'before_image_url is TEXT'
);

SELECT col_type_is(
  'chefbyte', 'shelf_event_log', 'after_image_url', 'text',
  'after_image_url is TEXT'
);

-- 3. Both columns are nullable (default state when image not yet uploaded)
SELECT col_is_null(
  'chefbyte', 'shelf_event_log', 'before_image_url',
  'before_image_url is nullable'
);

SELECT col_is_null(
  'chefbyte', 'shelf_event_log', 'after_image_url',
  'after_image_url is nullable'
);

-- 4. INSERT with both URLs set works (service_role bypass)
DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_device_id UUID := gen_random_uuid();
  v_event_id UUID;
BEGIN
  -- Minimal prerequisite rows (service_role, so RLS bypassed)
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'imgtest@test.invalid')
    ON CONFLICT DO NOTHING;
  INSERT INTO chefbyte.live_shelf_devices
    (device_id, user_id, device_name, import_key_hash)
  VALUES (v_device_id, v_user_id, 'test-device', encode(gen_random_bytes(32), 'hex'))
    ON CONFLICT DO NOTHING;

  INSERT INTO chefbyte.shelf_event_log
    (user_id, device_id, client_event_id, payload, applied,
     before_image_url, after_image_url)
  VALUES (
    v_user_id, v_device_id,
    gen_random_uuid()::text,
    '{"event_kind":"added","product_id":"00000000-0000-0000-0000-000000000001","delta_g":100}'::jsonb,
    true,
    'https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/' || v_user_id || '/' || gen_random_uuid() || '/before.jpg',
    'https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/' || v_user_id || '/' || gen_random_uuid() || '/after.jpg'
  )
  RETURNING event_id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'INSERT with image URLs returned no event_id';
  END IF;
END $$;

SELECT pass('INSERT with both image URLs succeeds');

-- 5. INSERT with both URLs NULL succeeds (default state)
DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_device_id UUID := gen_random_uuid();
  v_event_id UUID;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'imgtest2@test.invalid')
    ON CONFLICT DO NOTHING;
  INSERT INTO chefbyte.live_shelf_devices
    (device_id, user_id, device_name, import_key_hash)
  VALUES (v_device_id, v_user_id, 'test-device-2', encode(gen_random_bytes(32), 'hex'))
    ON CONFLICT DO NOTHING;

  INSERT INTO chefbyte.shelf_event_log
    (user_id, device_id, client_event_id, payload, applied,
     before_image_url, after_image_url)
  VALUES (
    v_user_id, v_device_id,
    gen_random_uuid()::text,
    '{"event_kind":"added","product_id":"00000000-0000-0000-0000-000000000002","delta_g":50}'::jsonb,
    false,
    NULL,
    NULL
  )
  RETURNING event_id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'INSERT with NULL image URLs returned no event_id';
  END IF;
END $$;

SELECT pass('INSERT with both image URLs NULL succeeds (default pre-upload state)');

SELECT * FROM finish();
ROLLBACK;
