import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars from root .env.test for Playwright E2E tests
// Playwright runs TS as ESM (__dirname unavailable), so use import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

for (const base of [path.resolve(__dirname, '../../../../.env.test'), path.resolve(process.cwd(), '../../.env.test')]) {
  try {
    process.loadEnvFile(base);
    break;
  } catch {
    /* try next */
  }
}

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const ANON_KEY = process.env.SUPABASE_ANON_KEY!;

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
