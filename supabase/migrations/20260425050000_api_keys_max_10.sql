-- Enforce the 10-active-keys-per-user cap at the DB layer.
--
-- Prior art: `apps/web/src/pages/hub/McpSettingsPage.tsx` enforces
-- MAX_ACTIVE_KEYS = 10 on the client by counting rows before insert and
-- throwing if >= 10. That guard is bypassed by:
--
--   * Any service-role tool (e.g. an admin fixing something via SQL
--     editor or a one-off script) inserting rows directly.
--   * A future MCP/REST endpoint that lets a key generate child keys.
--   * An attacker who found a path into the authenticated JWT
--     (post-auth they could spam `.from('api_keys').insert(...)` in a
--     loop).
--
-- Moving the cap to a BEFORE INSERT trigger makes the invariant
-- unforgeable from above. The client check becomes a UX convenience
-- (better error surface than a raw Postgres error) — the DB is the
-- source of truth.
--
-- Design:
--   * BEFORE INSERT trigger — fires for each row, raises SQLSTATE
--     'P0001' if the user already has >= 10 non-revoked keys.
--   * The count query uses the partial index `api_keys_user_last_used_idx`
--     created by 20260424010000 (WHERE revoked_at IS NULL ORDER BY
--     last_used_at) for a fast count scan.
--   * Revoked rows do not count against the cap.
--   * The trigger does NOT fire on UPDATE — revoking a key by setting
--     revoked_at is unaffected. A future "undelete" (clearing
--     revoked_at) could push a user back over the cap; if that becomes a
--     feature we can extend the trigger to AFTER UPDATE as well.

BEGIN;

CREATE OR REPLACE FUNCTION private.api_keys_enforce_max_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active_count INTEGER;
  v_max CONSTANT INTEGER := 10;
BEGIN
  -- Only enforce on rows that will be active (revoked_at IS NULL on
  -- INSERT). A caller who inserts a row with revoked_at already set
  -- (e.g. re-importing keys from an audit log) is not counted against
  -- the cap.
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM hub.api_keys
   WHERE user_id = NEW.user_id
     AND revoked_at IS NULL;

  IF v_active_count >= v_max THEN
    RAISE EXCEPTION 'api_keys: maximum of % active keys reached for user', v_max
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.api_keys_enforce_max_active() FROM PUBLIC;

DROP TRIGGER IF EXISTS api_keys_enforce_max_active_trigger ON hub.api_keys;
CREATE TRIGGER api_keys_enforce_max_active_trigger
  BEFORE INSERT ON hub.api_keys
  FOR EACH ROW EXECUTE FUNCTION private.api_keys_enforce_max_active();

COMMIT;
