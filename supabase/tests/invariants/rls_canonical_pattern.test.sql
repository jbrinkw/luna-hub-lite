-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — RLS canonical pattern
-- ════════════════════════════════════════════════════════════════════════════
-- CLAUDE.md: every user-scoped table MUST enforce RLS via the canonical
-- predicate ``(select auth.uid()) = user_id`` for the ``authenticated``
-- role. The 88ec208 audit (2026-04-22) confirmed every table conforms;
-- this file pins the result so a new table or a policy mutation can't
-- silently regress it.
--
-- Pattern: enumerate every (schema, table, policy) tuple in the user
-- schemas and bucket them into:
--   * canonical          — passes the regex on qual + with_check
--   * documented_carve   — name in the explicit allow-list (with reason)
--   * NEEDS REVIEW       — anything else
--
-- A NEEDS-REVIEW row fails the test with the table + policy name spelled
-- out, so a future agent immediately sees what they regressed.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

-- ----------------------------------------------------------------------------
-- 1. Allow-list of documented carve-outs.
-- ----------------------------------------------------------------------------
-- Each row here MUST point to a decision-log entry or doc explaining
-- why the canonical pattern doesn't apply. Re-audit when adding a new
-- entry.
CREATE TEMP TABLE _allowlist (
  schema_name TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  reason      TEXT NOT NULL,
  PRIMARY KEY (schema_name, table_name, policy_name)
);

INSERT INTO _allowlist VALUES
  ('coachbyte', 'exercises',
    'Users can read own and global exercises',
    'Globals (user_id IS NULL) — exercise library is shared. CLAUDE.md exercise-library spec.'),
  ('hub', 'alerts',
    'alerts_admin_select',
    'Admin-only — invariant monitor; not a per-user table. See alerts.test.sql.'),
  ('hub', 'alerts',
    'alerts_admin_update',
    'Admin-only — invariant monitor; not a per-user table. See alerts.test.sql.'),
  ('chefbyte', 'shelf_event_log',
    'shelf_event_log_rls',
    'SELECT-only canonical SELECT predicate; INSERT/UPDATE/DELETE done by service_role only. Decisions #43-#56.');

-- ----------------------------------------------------------------------------
-- 2. Canonical-pattern check on every policy.
-- ----------------------------------------------------------------------------
-- The canonical predicate is one of:
--   ( SELECT auth.uid() AS uid) = user_id    (qual on SELECT/UPDATE/DELETE)
--   ( SELECT auth.uid() AS uid) = user_id    (with_check on INSERT/UPDATE)
--
-- We build a regex that matches both patterns, allowing whitespace
-- and the optional alias.

CREATE TEMP TABLE _policy_audit AS
SELECT
  p.schemaname,
  p.tablename,
  p.policyname,
  p.cmd,
  p.qual,
  p.with_check,
  p.roles,
  -- Canonical for SELECT / DELETE: qual matches; with_check NULL.
  -- Canonical for INSERT: qual NULL; with_check matches.
  -- Canonical for UPDATE: qual matches; with_check NULL OR matches.
  -- Canonical for ALL: qual matches; with_check matches.
  CASE
    WHEN COALESCE(p.qual, '') ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
      OR COALESCE(p.with_check, '') ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
    THEN
      CASE
        -- INSERT: qual NULL, with_check must match.
        WHEN p.cmd = 'INSERT' AND p.qual IS NULL
          AND p.with_check ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
          THEN 'canonical'
        -- SELECT/DELETE: qual must match, with_check NULL.
        WHEN p.cmd IN ('SELECT', 'DELETE') AND p.with_check IS NULL
          AND p.qual ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
          THEN 'canonical'
        -- UPDATE: qual must match; with_check NULL or match.
        WHEN p.cmd = 'UPDATE'
          AND p.qual ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
          AND (p.with_check IS NULL OR p.with_check ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$')
          THEN 'canonical'
        -- ALL: both must match.
        WHEN p.cmd = 'ALL'
          AND p.qual ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
          AND p.with_check ~* '^\(\s*\(\s*SELECT auth\.uid\(\) AS uid\s*\)\s*=\s*user_id\s*\)\s*$'
          THEN 'canonical'
        ELSE 'non_canonical'
      END
    ELSE 'non_canonical'
  END AS verdict,
  -- Roles must include 'authenticated' (and only authenticated for
  -- per-user tables — public/anon access is forbidden by spec).
  array_to_string(p.roles, ',') AS roles_str
FROM pg_policies p
WHERE p.schemaname IN ('hub','chefbyte','coachbyte');

-- ----------------------------------------------------------------------------
-- 3. Assertion 1 — every policy is canonical OR allow-listed.
-- ----------------------------------------------------------------------------
-- Build a comma-separated list of NEEDS REVIEW rows for the failure
-- message so the engineer immediately sees which (table, policy)
-- regressed.

WITH offenders AS (
  SELECT a.schemaname, a.tablename, a.policyname
  FROM _policy_audit a
  LEFT JOIN _allowlist w
    ON w.schema_name = a.schemaname
   AND w.table_name  = a.tablename
   AND w.policy_name = a.policyname
  WHERE a.verdict <> 'canonical'
    AND w.policy_name IS NULL
)
SELECT is(
  (SELECT count(*)::integer FROM offenders),
  0,
  'RLS canonical pattern: every (schema, table, policy) is either '
    'canonical "(select auth.uid()) = user_id" OR allow-listed in '
    '_allowlist. NEEDS REVIEW: ' ||
    COALESCE((SELECT string_agg(format('%s.%s::%s', schemaname, tablename, policyname), ', ')
              FROM offenders), '<none>')
);

-- ----------------------------------------------------------------------------
-- 4. Assertion 2 — every policy targets the 'authenticated' role only.
-- ----------------------------------------------------------------------------
-- Per CLAUDE.md ("RLS everywhere: ... TO authenticated"), per-user
-- tables MUST scope their policies to ``authenticated`` so anon users
-- cannot read/write. {public}-scoped policies that worked under RLS=on
-- would still bypass authentication.
WITH bad_roles AS (
  SELECT schemaname, tablename, policyname, roles_str
  FROM _policy_audit
  WHERE roles_str <> 'authenticated'
    -- The carve-out alerts policies are still authenticated-only.
)
SELECT is(
  (SELECT count(*)::integer FROM bad_roles),
  0,
  'RLS role-scope: every user-scoped policy MUST target ''authenticated'' '
    'only. CLAUDE.md spec. NEEDS REVIEW: ' ||
    COALESCE((SELECT string_agg(format('%s.%s::%s (roles=%s)',
                                       schemaname, tablename, policyname,
                                       roles_str), ', ')
              FROM bad_roles), '<none>')
);

-- ----------------------------------------------------------------------------
-- 5. Assertion 3 — every user-scoped table HAS at least one RLS policy.
-- ----------------------------------------------------------------------------
-- A table with a user_id column but NO policies is a footgun: rls=on
-- defaults to deny-all, but a missing rls=on means anon can read it.
-- Enumerate every table with a user_id FK to auth.users and assert
-- it has at least one policy + rls=on.

WITH user_scoped_tables AS (
  SELECT n.nspname AS schemaname, c.relname AS tablename, c.oid AS reloid,
         c.relrowsecurity AS rls_on
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname IN ('hub','chefbyte','coachbyte')
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid
        AND a.attname = 'user_id'
        AND NOT a.attisdropped
    )
),
table_policy_counts AS (
  SELECT t.schemaname, t.tablename, t.rls_on,
         (SELECT count(*) FROM pg_policies p
          WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename) AS policy_count
  FROM user_scoped_tables t
),
unguarded AS (
  SELECT schemaname, tablename, rls_on, policy_count
  FROM table_policy_counts
  WHERE NOT rls_on OR policy_count = 0
)
SELECT is(
  (SELECT count(*)::integer FROM unguarded),
  0,
  'RLS coverage: every user-scoped table MUST have rls=on AND at least '
    'one policy. NEEDS REVIEW: ' ||
    COALESCE((SELECT string_agg(format('%s.%s (rls_on=%s, policies=%s)',
                                       schemaname, tablename, rls_on, policy_count),
                                ', ')
              FROM unguarded), '<none>')
);

SELECT * FROM finish();
ROLLBACK;
