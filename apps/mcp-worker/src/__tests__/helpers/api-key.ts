import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate a test API key and insert its SHA-256 hash into hub.api_keys.
 *
 * Returns the raw key string (prefixed with 'lh_') which the MCP Worker
 * will hash at runtime to look up the user.
 */
export async function generateTestApiKey(supabase: any, userId: string): Promise<string> {
  // Generate raw key: 'lh_' + 32 random hex chars
  const rawKey = 'lh_' + randomBytes(16).toString('hex');

  // SHA-256 hash (same algorithm as apps/mcp-worker/src/auth.ts)
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  // Insert into hub.api_keys
  const { error } = await supabase.schema('hub').from('api_keys').insert({
    user_id: userId,
    api_key_hash: keyHash,
    label: 'test-key',
  });

  if (error) {
    throw new Error(`Failed to create API key: ${error.message}`);
  }

  return rawKey;
}
