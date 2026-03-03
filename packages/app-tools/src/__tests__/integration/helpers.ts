import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext, ToolResult } from '../../types';

// ---------------------------------------------------------------------------
// Constants — local Supabase instance
// ---------------------------------------------------------------------------

export const SUPABASE_URL = 'http://127.0.0.1:54321';

export const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ---------------------------------------------------------------------------
// Admin client — service_role, no session persistence
// ---------------------------------------------------------------------------

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// createTestUser — provision a user with both modules activated
// ---------------------------------------------------------------------------

interface TestUserResult {
  userId: string;
  client: SupabaseClient;
  cleanup: () => Promise<void>;
}

export async function createTestUser(suffix: string): Promise<TestUserResult> {
  const email = `integ-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';

  // 1. Create user via admin API
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message ?? 'no user returned'}`);
  }

  const userId = data.user.id;

  // 2. Create an anon client and sign in as the user
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) {
    // Clean up the created user before throwing
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in test user: ${signInErr.message}`);
  }

  // 3. Activate both modules
  const { error: coachErr } = await (client as any).schema('hub').rpc('activate_app', {
    p_app_name: 'coachbyte',
  });
  if (coachErr) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to activate CoachByte: ${coachErr.message}`);
  }

  const { error: chefErr } = await (client as any).schema('hub').rpc('activate_app', {
    p_app_name: 'chefbyte',
  });
  if (chefErr) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to activate ChefByte: ${chefErr.message}`);
  }

  return {
    userId,
    client,
    cleanup: async () => {
      await admin.auth.admin.deleteUser(userId);
    },
  };
}

// ---------------------------------------------------------------------------
// createToolContext — build a ToolContext for handler invocation
// ---------------------------------------------------------------------------

export function createToolContext(userId: string): ToolContext {
  return { userId, supabase: admin };
}

// ---------------------------------------------------------------------------
// parseToolResult — extract parsed JSON from a successful ToolResult
// ---------------------------------------------------------------------------

export function parseToolResult(result: ToolResult): any {
  if (result.isError) {
    throw new Error(`Tool returned error: ${result.content[0]?.text ?? 'unknown'}`);
  }
  return JSON.parse(result.content[0].text);
}
