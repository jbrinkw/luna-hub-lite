export async function authenticateApiKey(
  supabase: any,
  apiKey: string,
): Promise<string | null> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

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
