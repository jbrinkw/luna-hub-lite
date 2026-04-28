import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from './setup.integration';

interface TestUser {
  userId: string;
  email: string;
  client: SupabaseClient<Database>;
}

/**
 * Detects rate-limit errors from GoTrue across the variants the local
 * stack actually emits. The default config has sign_in_sign_ups = 30
 * per 5 minutes per IP (supabase/config.toml). When integration tests
 * run in parallel (vitest's default) the shared budget is exhausted
 * easily, so retry must be conservative — match every plausible
 * phrasing, not just "rate limit".
 */
function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '').toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many') ||
    msg.includes('over_email_send_rate_limit') ||
    msg.includes('over_request_rate_limit') ||
    msg.includes('try again later')
  ) {
    return true;
  }
  if (error.status === 429) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a test user via Supabase Auth admin API, return a signed-in client.
 *
 * Each test user gets a unique email (suffix + Date.now() + extra random
 * tail) to avoid collisions across parallel test files. Retries on rate
 * limits with exponential backoff + jitter; 7 attempts back off
 * 1s,2s,4s,8s,16s,32s — worst case ~63s, well under the 5-minute window.
 * Jitter prevents thundering-herd from concurrent files retrying in lockstep.
 */
export async function createTestUser(suffix?: string): Promise<TestUser> {
  const base = suffix ?? crypto.randomUUID().slice(0, 8);
  // Append a random tail in addition to Date.now() — when two parallel
  // workers hit Date.now() in the same millisecond the email collides
  // and createUser fails with "User already registered". Random tail
  // pushes that probability to ~0.
  const tail = crypto.randomUUID().slice(0, 6);
  const email = `test-${base}-${Date.now()}-${tail}@test.com`;
  const password = 'test-password-123';

  const maxAttempts = 7;
  let created: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!error) {
      created = data;
      break;
    }
    if (!isRateLimitError(error) || attempt === maxAttempts - 1) {
      throw new Error(`Failed to create test user: ${error.message}`);
    }
    const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  if (!created?.user) {
    throw new Error('Failed to create test user: no user returned');
  }

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) break;
    if (!isRateLimitError(error) || attempt === maxAttempts - 1) {
      throw new Error(`Failed to sign in test user: ${error.message}`);
    }
    const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  return { userId: created.user.id, email, client };
}

/**
 * Delete a test user via admin API. FK cascade handles profile cleanup.
 */
export async function cleanupUser(userId: string): Promise<void> {
  const { error } = await adminClient.auth.admin.deleteUser(userId);
  if (error) {
    console.warn(`Failed to cleanup user ${userId}: ${error.message}`);
  }
}
