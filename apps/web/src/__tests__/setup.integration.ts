import { execSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';

// Standard Supabase local development keys (same for all `supabase start` instances)
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * Generate an ES256-signed service_role JWT via the Supabase CLI.
 * Supabase CLI 2.75+ uses EC keys for GoTrue auth, so the old HS256
 * service_role JWT is rejected by the admin API. This generates a
 * fresh ES256-signed JWT that GoTrue will accept.
 */
function getServiceRoleKey(): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  try {
    const jwt = execSync('npx supabase gen bearer-jwt --role service_role --valid-for 87600h', {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: process.env.SUPABASE_WORKDIR ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // The output may contain npm warnings before the JWT — grab the last line
    const lines = jwt.split('\n');
    return lines[lines.length - 1].trim();
  } catch {
    // Fallback to legacy HS256 key (works with older Supabase CLI)
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
  }
}

const SUPABASE_SERVICE_ROLE_KEY = getServiceRoleKey();

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
