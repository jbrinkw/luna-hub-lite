import { execSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';

// Loaded from .env.test via vitest envFile config
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * The service-role key the supabase edge runtime sees inside the Deno
 * container. Local supabase CLI (≤ 2.75) injects an HS256 demo key into
 * the function env — which is DIFFERENT from the ES256 key in .env.test.
 * Tests that need to byte-compare against the function's
 * SUPABASE_SERVICE_ROLE_KEY (e.g., dual-auth detection) must use this key,
 * NOT the .env.test one.
 *
 * Lazily computed from the live container env so we never bake the demo
 * key into source. Falls back to SUPABASE_SERVICE_ROLE_KEY if the lookup
 * fails (e.g., running against a real cloud project where both keys
 * already match).
 */
let _functionRuntimeServiceRoleKey: string | null = null;
export function getFunctionRuntimeServiceRoleKey(): string {
  if (_functionRuntimeServiceRoleKey !== null) return _functionRuntimeServiceRoleKey;
  try {
    const out = execSync("docker ps --filter 'name=supabase_edge_runtime' --format '{{.Names}}' | head -1", {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out) {
      const env = execSync(`docker exec ${out} env | grep '^SUPABASE_SERVICE_ROLE_KEY='`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      const m = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/);
      if (m) {
        _functionRuntimeServiceRoleKey = m[1];
        return _functionRuntimeServiceRoleKey;
      }
    }
    // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: docker exec is best-effort lookup; falling back to the .env.test key is the documented behavior for non-local-supabase environments
  } catch {
    // Container not running or docker unavailable — fall through to env fallback.
  }
  _functionRuntimeServiceRoleKey = SUPABASE_SERVICE_ROLE_KEY;
  return _functionRuntimeServiceRoleKey;
}

/** Admin client (service_role) — bypasses RLS, used for user management */
export const adminClient: SupabaseClient<Database> = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Create a Supabase client authenticated as the anon role */
export function createAnonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY };
