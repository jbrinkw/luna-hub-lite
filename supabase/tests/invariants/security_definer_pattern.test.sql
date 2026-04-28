-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — SECURITY DEFINER + SET search_path = ''
-- ════════════════════════════════════════════════════════════════════════════
-- CLAUDE.md: "DB functions: ``private`` schema, SECURITY DEFINER,
-- ``SET search_path = ''``."
--
-- Pattern: enumerate every function in the ``private`` schema, classify
-- it, and assert non-trigger-helper functions are SECURITY DEFINER and
-- carry ``search_path=""`` in their proconfig. Trigger helpers (named
-- like ``set_*_updated_at``) are explicitly carve-outs because they run
-- with the trigger owner's privileges and don't need DEFINER escalation.
--
-- A regression here lets a privilege-escalation bug ride into prod
-- silently — the search_path missing means a malicious SET can re-route
-- any unqualified table reference inside the function to a planted
-- schema. This is the OWASP-style hardening the spec encodes.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

-- ----------------------------------------------------------------------------
-- 1. Allow-list of trigger helpers + intentional carve-outs.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE _sec_allowlist (
  function_signature TEXT NOT NULL PRIMARY KEY,
  reason             TEXT NOT NULL
);

-- Trigger helpers: invoked by the row-trigger machinery, run as the
-- table owner (postgres) on every DML operation. They never escalate
-- and don't accept user input — SECURITY INVOKER is correct.
INSERT INTO _sec_allowlist VALUES
  ('private.set_products_updated_at()',
    'Trigger helper — runs as table owner on every DML. No escalation needed.'),
  ('private.set_stock_lots_updated_at()',
    'Trigger helper — runs as table owner on every DML. No escalation needed.');

-- ----------------------------------------------------------------------------
-- 2. Audit table — every private function with classification.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE _func_audit AS
SELECT
  n.nspname || '.' || p.proname || '('
    || pg_get_function_identity_arguments(p.oid)
    || ')' AS sig,
  p.proname,
  p.prosecdef AS is_security_definer,
  -- Pull the search_path GUC out of proconfig; NULL if not set.
  (
    SELECT cfg
    FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
    WHERE cfg LIKE 'search_path=%'
    LIMIT 1
  ) AS search_path_setting,
  COALESCE(
    EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgfoid = p.oid AND NOT t.tgisinternal
    ),
    false
  ) AS is_trigger_helper
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'private';

-- ----------------------------------------------------------------------------
-- 3. Assertion 1 — every private function is SECURITY DEFINER OR
--    allow-listed.
-- ----------------------------------------------------------------------------
WITH offenders AS (
  SELECT a.sig
  FROM _func_audit a
  LEFT JOIN _sec_allowlist w ON w.function_signature = a.sig
  WHERE NOT a.is_security_definer
    AND w.function_signature IS NULL
)
SELECT is(
  (SELECT count(*)::integer FROM offenders),
  0,
  'private functions: every function MUST be SECURITY DEFINER OR '
    'allow-listed (CLAUDE.md). NEEDS REVIEW: ' ||
    COALESCE((SELECT string_agg(sig, ', ' ORDER BY sig) FROM offenders),
             '<none>')
);

-- ----------------------------------------------------------------------------
-- 4. Assertion 2 — every private function has SET search_path = '' OR
--    is allow-listed.
-- ----------------------------------------------------------------------------
WITH offenders AS (
  SELECT a.sig, a.search_path_setting
  FROM _func_audit a
  LEFT JOIN _sec_allowlist w ON w.function_signature = a.sig
  WHERE w.function_signature IS NULL
    AND COALESCE(a.search_path_setting, '') NOT IN
        ('search_path=', 'search_path=""')
)
SELECT is(
  (SELECT count(*)::integer FROM offenders),
  0,
  'private functions: every function MUST set ``search_path=""`` '
    '(CLAUDE.md hardening). Without this, an attacker who can SET '
    'search_path can hijack every unqualified reference inside the '
    'function. NEEDS REVIEW: ' ||
    COALESCE((SELECT string_agg(format('%s [search_path=%s]',
                                       sig, COALESCE(search_path_setting, '<unset>')),
                                ', ' ORDER BY sig)
              FROM offenders), '<none>')
);

-- ----------------------------------------------------------------------------
-- 5. Assertion 3 — sanity: at least N private functions exist (so the
--    test isn't trivially passing because the schema vanished).
-- ----------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)::integer FROM _func_audit),
  '>=', 30,
  'private schema: expected >=30 functions (sanity check — if the '
    'audit table is empty, the test would falsely pass)'
);

SELECT * FROM finish();
ROLLBACK;
