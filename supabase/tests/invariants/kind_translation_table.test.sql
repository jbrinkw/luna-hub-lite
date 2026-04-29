-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — pin the cloud-side kind vocabulary.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L10/HIGH (AUDIT_FINDINGS_PHASE1.md):
--
--   live_scale (cloud) ↔ single_item (Pi) literal collision relies on a
--   lossy translation table at every boundary.
--
-- Translation now lives in a single Pi-side helper
-- (``hardware/live-shelf/server/cloud/_kind_translate.py``) shared by
-- pairings_sync_poller, weight_sync_poller, and handlers/scale_events.
-- This pgTAP pins the cloud half of the contract: the cloud-side CHECK
-- constraint on ``chefbyte.scale_pairings.kind`` MUST use the canonical
-- ``{live_shelf, catch_all, live_scale}`` vocabulary. If a migration ever
-- drifts the cloud literal (e.g. accidentally renames live_scale →
-- single_item to "match" the Pi), the Pi's translator silently skips the
-- value, the pairings poller stops applying that kind, and the live-scale
-- ESP appears to lose its pairing.
--
-- This file pins:
--   1. The exact set of accepted ``kind`` values on cloud scale_pairings.
--   2. That the cloud's CHECK rejects the legacy Pi literal (single_item).
--   3. That live_weight_sync's kind enum stays aligned (live_shelf,
--      live_scale only — catch_all is rejected by its own helper).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(7);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('ktt_alice');
SELECT tests.get_supabase_uid('ktt_alice') AS alice_uid \gset
SELECT tests.authenticate_as('ktt_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active
) VALUES (
  'caaaffee-0000-0000-0000-000000000001',
  :'alice_uid'::uuid,
  'ktt-pi',
  'ktt_hash',
  true
);

------------------------------------------------------------
-- Case 1: kind='live_shelf' is accepted.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$INSERT INTO chefbyte.scale_pairings (
        user_id, device_id, scale_id, kind
      ) VALUES (
        %L::uuid,
        'caaaffee-0000-0000-0000-000000000001',
        'scale-01', 'live_shelf'
      )$$,
    :'alice_uid'
  ),
  'kind=''live_shelf'' is accepted by the cloud CHECK constraint'
);

------------------------------------------------------------
-- Case 2: kind='catch_all' is accepted.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$INSERT INTO chefbyte.scale_pairings (
        user_id, device_id, scale_id, kind
      ) VALUES (
        %L::uuid,
        'caaaffee-0000-0000-0000-000000000001',
        'scale-02', 'catch_all'
      )$$,
    :'alice_uid'
  ),
  'kind=''catch_all'' is accepted by the cloud CHECK constraint'
);

------------------------------------------------------------
-- Case 3: kind='live_scale' is accepted.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$INSERT INTO chefbyte.scale_pairings (
        user_id, device_id, scale_id, kind
      ) VALUES (
        %L::uuid,
        'caaaffee-0000-0000-0000-000000000001',
        'scale-03', 'live_scale'
      )$$,
    :'alice_uid'
  ),
  'kind=''live_scale'' is accepted — canonical cloud literal for the '
    'single-item / live-scale kind. The Pi''s ``single_item`` literal '
    'is the legacy Pi-side spelling; the cloud must NEVER mirror it.'
);

------------------------------------------------------------
-- Case 4: kind='single_item' (the Pi-side literal) MUST BE REJECTED
--         by the cloud CHECK. If this assertion ever fails, a
--         migration has drifted the cloud schema toward Pi vocabulary
--         — and downstream code that knows it''s talking to "the
--         cloud" will start receiving Pi literals.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$INSERT INTO chefbyte.scale_pairings (
        user_id, device_id, scale_id, kind
      ) VALUES (
        %L::uuid,
        'caaaffee-0000-0000-0000-000000000001',
        'scale-04', 'single_item'
      )$$,
    :'alice_uid'
  ),
  '23514',  -- check_violation
  NULL,
  'kind=''single_item'' is REJECTED — cloud must never accept the Pi '
    'legacy literal. Translation lives in Pi-side _kind_translate.py.'
);

------------------------------------------------------------
-- Case 5: a totally novel kind is rejected.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$INSERT INTO chefbyte.scale_pairings (
        user_id, device_id, scale_id, kind
      ) VALUES (
        %L::uuid,
        'caaaffee-0000-0000-0000-000000000001',
        'scale-05', 'mystery_kind'
      )$$,
    :'alice_uid'
  ),
  '23514',  -- check_violation
  NULL,
  'kind=''mystery_kind'' rejected — ensures the constraint is doing '
    'allow-list filtering, not just rejecting one bad literal.'
);

------------------------------------------------------------
-- Case 6: live_weight_sync helper enforces kind ∈ (live_shelf, live_scale).
--         Calling with ''catch_all'' must raise.
------------------------------------------------------------

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  :'alice_uid'::uuid,
  'KTT Test Product', 500.000, 4,
  100, 10, 5, 2
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = :'alice_uid'::uuid
   AND name = 'KTT Test Product' \gset

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  :'alice_uid'::uuid,
  :'p_id',
  (SELECT location_id FROM chefbyte.locations
    WHERE user_id = :'alice_uid'::uuid AND name = 'Fridge'),
  1.0, 'live_shelf', now() - interval '5 minutes'
);

SELECT throws_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        '11111111-1111-1111-1111-111111111111'::UUID,
        500.0::NUMERIC, now()::TIMESTAMPTZ, 'ktt-evt-1', NULL
      )$$,
    :'alice_uid',
    'caaaffee-0000-0000-0000-000000000001'
  ),
  '22023',  -- invalid_parameter_value
  NULL,
  'apply_live_weight_sync rejects kind=''catch_all'' — the helper is '
    'live_shelf + live_scale only by design (catch_all has its own '
    'delta-capture stream). Pins the kind enum on the live_weight_sync '
    'code path so a future drift fails this test rather than silently '
    'corrupting catch-all snapshots.'
);

------------------------------------------------------------
-- Case 7: kind='single_item' is also rejected by apply_live_weight_sync.
--         The Pi-side translator is supposed to convert single_item →
--         live_scale BEFORE emit; if it ever forgets, the cloud helper
--         must reject the raw Pi literal.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-03', 'single_item',
        '11111111-1111-1111-1111-111111111111'::UUID,
        500.0::NUMERIC, now()::TIMESTAMPTZ, 'ktt-evt-2', NULL
      )$$,
    :'alice_uid',
    'caaaffee-0000-0000-0000-000000000001'
  ),
  '22023',
  NULL,
  'apply_live_weight_sync rejects the Pi-legacy literal ''single_item'' — '
    'pins the boundary that catches a Pi-translator regression.'
);

SELECT * FROM finish();
ROLLBACK;
