export async function authenticateApiKey(supabase: any, apiKey: string): Promise<string | null> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  const { data: keyRow, error } = await supabase
    .schema('hub')
    .from('api_keys')
    .select('user_id')
    .eq('api_key_hash', keyHash)
    .is('revoked_at', null)
    .single();

  if (error || !keyRow) return null;
  return keyRow.user_id;
}

/**
 * Validate a Supabase JWT (from OAuth 2.1 flow) and return the user ID.
 * Uses Supabase's getUser() endpoint to validate the token server-side.
 */
export async function authenticateJwt(supabase: any, token: string): Promise<string | null> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}
