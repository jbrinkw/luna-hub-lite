/**
 * Env constants for the Phase-2 e2e harness.
 *
 * Loads `.env.test` from the repo root if not already loaded so individual
 * helper files can be imported in isolation (e.g. from a Playwright fixture
 * that runs before the suite loads playwright.config.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) {
  for (const candidate of [
    path.resolve(__dirname, '../../../.env.test'),
    path.resolve(process.cwd(), '.env.test'),
  ]) {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      // try next
    }
  }
}

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'tests/e2e: missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Ensure `.env.test` is present at repo root or env vars are set.',
  );
}

/** Service-role client — RLS bypassed. Use only for seed + assertions. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Anon client — wraps the SDK for sign-in flows that mirror real users. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** SHA-256 (hex) using Web Crypto. Mirrors the shelf-ingest edge fn. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
