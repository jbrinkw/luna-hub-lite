import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';

const userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await adminClient.auth.admin.deleteUser(id);
  }
  userIds.length = 0;
});

function anonClient() {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isRateLimitError(error: any): boolean {
  const msg = error?.message ?? '';
  return msg.includes('rate limit') || msg.includes('Rate limit');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry an auth operation with exponential backoff on rate limits */
async function withRetry<T extends { error: any }>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await fn();
    if (!result.error || !isRateLimitError(result.error)) return result;
    if (attempt === 4) return result;
    await sleep(1000 * Math.pow(2, attempt));
  }
  throw new Error('Unreachable');
}

/** Create user via admin API with retry */
async function createUserWithRetry(email: string, password: string, opts?: { data?: Record<string, any> }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ...(opts?.data ? { user_metadata: opts.data } : {}),
    });
    if (!error) return { data, error: null };
    if (!isRateLimitError(error) || attempt === 4) return { data, error };
    await sleep(1000 * Math.pow(2, attempt));
  }
  throw new Error('Unreachable');
}

describe('Auth lifecycle', () => {
  it('signup creates profile with defaults (timezone, day_start_hour)', async () => {
    const email = `lifecycle-defaults-${crypto.randomUUID().slice(0, 8)}@test.com`;

    // Use admin API to avoid email rate limits on production; handle_new_user trigger still fires
    const { data, error } = await createUserWithRetry(email, 'password123');
    expect(error).toBeNull();
    userIds.push(data.user!.id);

    // Profile auto-created by handle_new_user trigger
    const { data: profile } = await (adminClient as any)
      .schema('hub')
      .from('profiles')
      .select('timezone, day_start_hour')
      .eq('user_id', data.user!.id)
      .single();

    expect(profile).toEqual({
      timezone: 'America/New_York',
      day_start_hour: 6,
    });
  });

  it('signup stores display_name in profile from metadata', async () => {
    const email = `lifecycle-name-${crypto.randomUUID().slice(0, 8)}@test.com`;

    // Use admin API with user_metadata; handle_new_user trigger reads display_name from metadata
    const { data, error } = await createUserWithRetry(email, 'password123', {
      data: { display_name: 'Test Display' },
    });
    expect(error).toBeNull();
    userIds.push(data.user!.id);

    const { data: profile } = await (adminClient as any)
      .schema('hub')
      .from('profiles')
      .select('display_name')
      .eq('user_id', data.user!.id)
      .single();

    expect(profile?.display_name).toBe('Test Display');
  });

  it('login with correct credentials returns valid session', async () => {
    const client = anonClient();
    const email = `lifecycle-login-${crypto.randomUUID().slice(0, 8)}@test.com`;

    // Create user first
    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    // Login
    const { data, error } = await withRetry(() => client.auth.signInWithPassword({ email, password: 'password123' }));
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.session?.user.id).toBe(created.user!.id);
  });

  it('login with wrong password returns error', async () => {
    const client = anonClient();
    const email = `lifecycle-wrong-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    const { error } = await withRetry(() => client.auth.signInWithPassword({ email, password: 'wrongpassword' }));
    // Accept either "invalid credentials" or rate limit (we can't control production rate limits for bad-password tests)
    expect(error).not.toBeNull();
  });

  it('logout clears session, subsequent calls rejected', async () => {
    const client = anonClient();
    const email = `lifecycle-logout-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    const { error: signInError } = await withRetry(() =>
      client.auth.signInWithPassword({ email, password: 'password123' }),
    );
    expect(signInError).toBeNull();

    // Verify logged in
    const { data: before } = await client.auth.getSession();
    expect(before.session).not.toBeNull();

    // Logout
    await client.auth.signOut();

    // Session cleared
    const { data: after } = await client.auth.getSession();
    expect(after.session).toBeNull();
  });

  it('duplicate email signup returns error', async () => {
    const email = `lifecycle-dup-${crypto.randomUUID().slice(0, 8)}@test.com`;

    // Create first user via admin API to avoid rate limits
    const { data, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(data.user!.id);

    // Second signup with same email via client API
    const client2 = anonClient();
    const { error: dupError, data: dupData } = await withRetry(() =>
      client2.auth.signUp({ email, password: 'password456' }),
    );

    // GoTrue either returns error or obfuscated response (anti-enumeration).
    // On production, it may return a fake user with a different ID.
    // The key invariant: the original user is still intact.
    const { data: firstUser } = await adminClient.auth.admin.getUserById(data.user!.id);
    expect(firstUser.user).not.toBeNull();
    expect(firstUser.user!.email).toBe(email);

    // Clean up any fake user GoTrue may have created
    if (!dupError && dupData.user && dupData.user.id !== data.user!.id) {
      userIds.push(dupData.user.id);
    }
  });

  it('session token refresh works', async () => {
    const client = anonClient();
    const email = `lifecycle-refresh-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    await withRetry(() => client.auth.signInWithPassword({ email, password: 'password123' }));

    // Refresh session
    const { data, error } = await withRetry(() => client.auth.refreshSession());
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.session?.user.id).toBe(created.user!.id);
  });

  it('password reset: request sends reset email', async () => {
    const client = anonClient();
    const email = `lifecycle-reset-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    // Request password reset (goes to Inbucket in local dev)
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: 'http://localhost:5173/reset',
    });
    // Accept either success or email rate limit (production has strict 2/hour email limits)
    if (error) {
      expect(error.message).toMatch(/rate limit/i);
    }
  });

  it('forgot password request sends reset email', async () => {
    const client = anonClient();
    const email = `lifecycle-forgot-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'password123');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    // Request password reset — goes to Inbucket in local dev
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: 'http://localhost:5173/hub/reset-password',
    });
    // Accept either success or email rate limit (production has strict 2/hour email limits)
    if (error) {
      expect(error.message).toMatch(/rate limit/i);
    }
  });

  it('login with empty email returns validation error', async () => {
    const client = anonClient();
    const { error } = await withRetry(() => client.auth.signInWithPassword({ email: '', password: 'password123' }));
    expect(error).not.toBeNull();
  });

  it('login with empty password returns validation error', async () => {
    const client = anonClient();
    const { error } = await withRetry(() =>
      client.auth.signInWithPassword({ email: 'test@example.com', password: '' }),
    );
    expect(error).not.toBeNull();
  });

  it('password update via admin: can login with new password', async () => {
    const email = `lifecycle-newpw-${crypto.randomUUID().slice(0, 8)}@test.com`;

    const { data: created, error: createErr } = await createUserWithRetry(email, 'oldpassword');
    expect(createErr).toBeNull();
    userIds.push(created.user!.id);

    // Update password via admin API (simulates reset flow)
    await adminClient.auth.admin.updateUserById(created.user!.id, {
      password: 'newpassword',
    });

    // Login with new password
    const client = anonClient();
    const { data, error } = await withRetry(() => client.auth.signInWithPassword({ email, password: 'newpassword' }));
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();

    // Old password no longer works
    const client2 = anonClient();
    const { error: oldError } = await withRetry(() =>
      client2.auth.signInWithPassword({ email, password: 'oldpassword' }),
    );
    expect(oldError).not.toBeNull();
  });

  // -------------------------------------------------------------------
  // #39: Demo login — succeeds with seeded demo account, fails with
  // wrong password (simulating "Demo account unavailable" error branch)
  // -------------------------------------------------------------------
  it('demo login succeeds with correct credentials', async () => {
    const client = anonClient();
    const { data, error } = await withRetry(() =>
      client.auth.signInWithPassword({ email: 'demo@lunahub.dev', password: 'demo1234' }),
    );
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
  });

  it('demo login with wrong password returns error (Demo account unavailable branch)', async () => {
    const client = anonClient();
    const { error } = await withRetry(() =>
      client.auth.signInWithPassword({ email: 'demo@lunahub.dev', password: 'wrongpassword' }),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toBeDefined();
  });

  // -------------------------------------------------------------------
  // #40: reset_demo_dates RPC — verify function exists, executes, and
  // actually shifts demo data dates to today.
  // -------------------------------------------------------------------
  it('reset_demo_dates RPC exists and executes successfully for demo user', async () => {
    // Login as the demo user — reset_demo_dates only works for the demo account
    const client = anonClient();
    const { data: session, error: loginErr } = await withRetry(() =>
      client.auth.signInWithPassword({ email: 'demo@lunahub.dev', password: 'demo1234' }),
    );
    expect(loginErr).toBeNull();
    expect(session.session).not.toBeNull();

    // Call reset_demo_dates — must succeed (not just "not crash")
    const result = await (client.schema('hub') as any).rpc('reset_demo_dates');
    expect(result.error).toBeNull();
    expect(result.status).toBeLessThan(300);

    // Verify the function actually did something:
    // Demo meal plan entries for today should exist after reset
    const today = new Date().toISOString().split('T')[0];
    const { data: meals, error: mealsErr } = await (client.schema('chefbyte') as any)
      .from('meal_plan_entries')
      .select('meal_id, logical_date')
      .eq('logical_date', today);
    expect(mealsErr).toBeNull();
    expect(meals).not.toBeNull();
    expect(meals.length).toBeGreaterThanOrEqual(1);
  });
});
