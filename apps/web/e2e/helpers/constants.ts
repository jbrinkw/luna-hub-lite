import { createClient } from '@supabase/supabase-js';
import path from 'path';

// Load env vars from root .env.test for Playwright E2E tests
try {
  process.loadEnvFile(path.resolve(__dirname, '../../../../.env.test'));
} catch {
  /* env file optional */
}

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const ANON_KEY = process.env.SUPABASE_ANON_KEY!;

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
