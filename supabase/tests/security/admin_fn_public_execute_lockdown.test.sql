-- ════════════════════════════════════════════════════════════════════════════
-- T2 Privilege-Escalation Class — admin SECURITY DEFINER fn lockdown
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings C-1, H-4, H-5, H-6, B1b(rls)-07.
--
-- Six SECURITY DEFINER functions accept a `p_user_id` argument, live in a
-- PostgREST-exposed schema (hub / coachbyte / chefbyte), and were left with
-- EXECUTE granted to PUBLIC (hence anon + authenticated) after a re-CREATE
-- migration dropped the original REVOKE. SECURITY DEFINER bypasses RLS, and
-- the inner `WHERE user_id = p_user_id` is NOT a security barrier because the
-- attacker passes the *victim's* own id. Net effect: any anon/authenticated
-- caller can read or mutate another tenant's data — confirmed live by reading
-- another user's decrypted sk-ant Anthropic key (C-1).
--
-- The six functions:
--   1. hub.get_agent_anthropic_key_admin(uuid)                     [C-1] read key
--   2. hub.get_agent_system_prompt_admin(uuid)                     [H-6] read prompt
--   3. hub.get_agent_voice_ack_admin(uuid)                         [H-6] read ack cfg
--   4. coachbyte.complete_next_set_admin(uuid,uuid,int,numeric)    [H-4] cross-user WRITE
--   5. chefbyte.consume_product_admin(uuid,uuid,numeric,text,bool,date,bool) [B1b] WRITE
--   6. chefbyte.add_to_shopping_admin(uuid,uuid,numeric)           [H-5] cross-user WRITE
--
-- Contract enforced here (two complementary styles per function):
--   (a) ACL:        authenticated AND anon must NOT have EXECUTE.
--   (b) Behavioral: an authenticated attacker calling with a *victim* user_id
--                   must be denied (SQLSTATE 42501 — insufficient_privilege).
--                   42501 is raised both by the missing-grant path (REVOKE) and
--                   by the in-body auth.uid() guard, so this assertion holds
--                   regardless of which defense fires.
--
-- RED (pre-fix): every assertion FAILS — grants exist, no guard, calls succeed.
-- GREEN (post-fix): every assertion PASSES — revoked + guarded.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 6 functions × (2 ACL + 1 behavioral) = 18, plus 1 positive control = 19.
SELECT plan(19);

-- ── Seed two tenants ────────────────────────────────────────────────────────
-- victim   : owns the data the attacker tries to reach/mutate.
-- attacker : a different authenticated user passing the victim's id.
SELECT tests.create_supabase_user('t2_victim');
SELECT tests.create_supabase_user('t2_attacker');

SELECT tests.get_supabase_uid('t2_victim')   AS _victim  \gset
SELECT tests.get_supabase_uid('t2_attacker') AS _attacker \gset

-- Victim sets up data the admin functions read/touch (acting as themselves).
SELECT tests.authenticate_as('t2_victim');
SELECT hub.activate_app('coachbyte');
SELECT hub.activate_app('chefbyte');
-- Real encrypted Anthropic key (flagship C-1 target).
SELECT hub.save_agent_anthropic_key('sk-ant-VICTIM-SECRET-DO-NOT-LEAK');
-- A victim-owned product so the chefbyte write paths reach real rows.
INSERT INTO chefbyte.products (user_id, name, servings_per_container)
VALUES (:'_victim'::uuid, 'T2 Victim Product', 1)
RETURNING product_id AS _victim_product \gset
-- A victim-owned location so consume/purchase paths have somewhere to land.
INSERT INTO chefbyte.locations (user_id, name)
VALUES (:'_victim'::uuid, 'T2 Victim Fridge')
RETURNING location_id AS _victim_location \gset
-- Stock so consume_product can actually decrement something.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
VALUES (:'_victim'::uuid, :'_victim_product'::uuid, :'_victim_location'::uuid, 10);
-- A victim-owned plan + one pending planned set so complete_next_set_admin
-- reaches a real, completable set (the inner ownership check passes because the
-- attacker passes the victim's own plan_id — that is the whole point of T2).
INSERT INTO coachbyte.daily_plans (user_id, plan_date, logical_date, summary)
VALUES (:'_victim'::uuid, CURRENT_DATE, CURRENT_DATE, 'T2 victim plan')
RETURNING plan_id AS _victim_plan \gset
INSERT INTO coachbyte.planned_sets
  (plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
VALUES (
  :'_victim_plan'::uuid, :'_victim'::uuid,
  (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
  1, 5, 100.0, 90
);

SELECT tests.clear_authentication();

-- Positive control: assume the real MCP/edge identity — service_role with NO JWT
-- claims, so auth.uid() is NULL and the in-body guard is skipped. service_role
-- retains EXECUTE after the REVOKE. This guards against an over-broad fix that
-- would break the legit caller, and proves the key is actually stored + readable
-- by the only identity that should pass an arbitrary p_user_id.
SET LOCAL role = service_role;
SELECT is(
  hub.get_agent_anthropic_key_admin(:'_victim'::uuid),
  'sk-ant-VICTIM-SECRET-DO-NOT-LEAK',
  'CONTROL: service-role path (auth.uid() NULL) still decrypts the key'
);
RESET role;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. hub.get_agent_anthropic_key_admin(uuid)   [C-1 — the worst]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'hub.get_agent_anthropic_key_admin(uuid)', 'EXECUTE'),
  'get_agent_anthropic_key_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'hub.get_agent_anthropic_key_admin(uuid)', 'EXECUTE'),
  'get_agent_anthropic_key_admin: anon must NOT have EXECUTE'
);
-- Behavioral: attacker tries to read the victim's decrypted key. RED = it
-- returns the secret (no throw) → assertion fails, proving the live leak.
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT hub.get_agent_anthropic_key_admin(%L::uuid)', :'_victim'),
  '42501',
  NULL,
  'get_agent_anthropic_key_admin: attacker reading victim key is denied (42501)'
);
SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. hub.get_agent_system_prompt_admin(uuid)   [H-6]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'hub.get_agent_system_prompt_admin(uuid)', 'EXECUTE'),
  'get_agent_system_prompt_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'hub.get_agent_system_prompt_admin(uuid)', 'EXECUTE'),
  'get_agent_system_prompt_admin: anon must NOT have EXECUTE'
);
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT hub.get_agent_system_prompt_admin(%L::uuid)', :'_victim'),
  '42501',
  NULL,
  'get_agent_system_prompt_admin: attacker reading victim prompt is denied (42501)'
);
SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- 3. hub.get_agent_voice_ack_admin(uuid)   [H-6]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'hub.get_agent_voice_ack_admin(uuid)', 'EXECUTE'),
  'get_agent_voice_ack_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'hub.get_agent_voice_ack_admin(uuid)', 'EXECUTE'),
  'get_agent_voice_ack_admin: anon must NOT have EXECUTE'
);
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT * FROM hub.get_agent_voice_ack_admin(%L::uuid)', :'_victim'),
  '42501',
  NULL,
  'get_agent_voice_ack_admin: attacker reading victim voice-ack cfg is denied (42501)'
);
SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. coachbyte.complete_next_set_admin(uuid,uuid,int,numeric)   [H-4 — cross-user WRITE]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'coachbyte.complete_next_set_admin(uuid,uuid,integer,numeric)', 'EXECUTE'),
  'complete_next_set_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'coachbyte.complete_next_set_admin(uuid,uuid,integer,numeric)', 'EXECUTE'),
  'complete_next_set_admin: anon must NOT have EXECUTE'
);
-- Behavioral: attacker passes the victim's own plan_id (so the inner ownership
-- check is satisfied) → RED executes the write. Must be denied (42501).
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT * FROM coachbyte.complete_next_set_admin(%L::uuid, %L::uuid, 5, 100.0)',
         :'_victim', :'_victim_plan'),
  '42501',
  NULL,
  'complete_next_set_admin: attacker completing victim set is denied (42501)'
);
SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- 5. chefbyte.consume_product_admin(uuid,uuid,numeric,text,bool,date,bool)   [B1b — WRITE]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'chefbyte.consume_product_admin(uuid,uuid,numeric,text,boolean,date,boolean)', 'EXECUTE'),
  'consume_product_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'chefbyte.consume_product_admin(uuid,uuid,numeric,text,boolean,date,boolean)', 'EXECUTE'),
  'consume_product_admin: anon must NOT have EXECUTE'
);
-- Behavioral: attacker decrements the victim's stock + logs macros on victim.
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT chefbyte.consume_product_admin(%L::uuid, %L::uuid, 1, %L, true, %L::date, true)',
         :'_victim', :'_victim_product', 'serving', CURRENT_DATE),
  '42501',
  NULL,
  'consume_product_admin: attacker consuming victim stock is denied (42501)'
);
SELECT tests.clear_authentication();

-- ════════════════════════════════════════════════════════════════════════════
-- 6. chefbyte.add_to_shopping_admin(uuid,uuid,numeric)   [H-5 — cross-user WRITE]
-- ════════════════════════════════════════════════════════════════════════════
SELECT ok(
  NOT has_function_privilege('authenticated', 'chefbyte.add_to_shopping_admin(uuid,uuid,numeric)', 'EXECUTE'),
  'add_to_shopping_admin: authenticated must NOT have EXECUTE'
);
SELECT ok(
  NOT has_function_privilege('anon', 'chefbyte.add_to_shopping_admin(uuid,uuid,numeric)', 'EXECUTE'),
  'add_to_shopping_admin: anon must NOT have EXECUTE'
);
-- Behavioral: attacker writes to the victim's shopping list.
SELECT tests.authenticate_as('t2_attacker');
SELECT throws_ok(
  format('SELECT * FROM chefbyte.add_to_shopping_admin(%L::uuid, %L::uuid, 2)',
         :'_victim', :'_victim_product'),
  '42501',
  NULL,
  'add_to_shopping_admin: attacker writing victim shopping list is denied (42501)'
);
SELECT tests.clear_authentication();

-- ── Teardown ────────────────────────────────────────────────────────────────
SELECT tests.delete_supabase_user('t2_victim');
SELECT tests.delete_supabase_user('t2_attacker');

SELECT * FROM finish();

ROLLBACK;
