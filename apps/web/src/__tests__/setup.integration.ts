import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';

// Standard Supabase local development keys (same for all `supabase start` instances)
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6ImFub24ifQ.P9z45GEzGXk9RpkTeiFK1jgzU0N1T-w6rvXILbKT7BP4uNhe6hbyojDijLra28qrOc3GmcSDxmFFNPEZz6YU8w';

/** Standard local-dev ES256 service_role key */
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.fDBVbcn1yiwrN85kw3c70Yhm__37cMWWZPhf8cqMY5QJ46pzGo5MfHQ-jPzgXLKecXWTRrW261e0ALQQqx-rUw';

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
