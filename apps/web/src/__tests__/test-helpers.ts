import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from './setup.integration';

interface TestUser {
  userId: string;
  email: string;
  client: SupabaseClient<Database>;
}

/**
 * Create a test user via Supabase Auth admin API, return a signed-in client.
 * Each test user gets a unique email to avoid collisions.
 */
export async function createTestUser(
  suffix?: string,
): Promise<TestUser> {
  const id = suffix ?? crypto.randomUUID().slice(0, 8);
  const email = `test-${id}@test.com`;
  const password = 'test-password-123';

  // Create user via admin API (bypasses email confirmation)
  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

  if (createError || !created.user) {
    throw new Error(`Failed to create test user: ${createError?.message}`);
  }

  // Create a client and sign in as this user
  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    throw new Error(`Failed to sign in test user: ${signInError.message}`);
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
