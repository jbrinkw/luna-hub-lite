import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from './setup.integration';

interface TestUser {
  userId: string;
  email: string;
  client: SupabaseClient<Database>;
}

function isRateLimitError(error: any): boolean {
  const msg = error?.message ?? '';
  return msg.includes('rate limit') || msg.includes('Rate limit');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a test user via Supabase Auth admin API, return a signed-in client.
 * Each test user gets a unique email to avoid collisions.
 * Retries on rate limit errors with exponential backoff.
 */
export async function createTestUser(suffix?: string): Promise<TestUser> {
  const base = suffix ?? crypto.randomUUID().slice(0, 8);
  const email = `test-${base}-${Date.now()}@test.com`;
  const password = 'test-password-123';

  // Create user via admin API with retry
  let created: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!error) {
      created = data;
      break;
    }
    if (!isRateLimitError(error) || attempt === 4) {
      throw new Error(`Failed to create test user: ${error.message}`);
    }
    await sleep(1000 * Math.pow(2, attempt));
  }

  if (!created?.user) {
    throw new Error('Failed to create test user: no user returned');
  }

  // Create a client and sign in with retry
  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) break;
    if (!isRateLimitError(error) || attempt === 4) {
      throw new Error(`Failed to sign in test user: ${error.message}`);
    }
    await sleep(1000 * Math.pow(2, attempt));
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
