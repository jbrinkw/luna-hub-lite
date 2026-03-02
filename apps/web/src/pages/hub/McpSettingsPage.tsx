import { useEffect, useState } from 'react';
import { IonSpinner, IonText } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { ApiKeyGenerator } from '@/components/hub/ApiKeyGenerator';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

interface ActiveKey {
  id: string;
  label: string | null;
  created_at: string;
}

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function McpSettingsPage() {
  const { user } = useAuth();
  const [activeKeys, setActiveKeys] = useState<ActiveKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = async () => {
    if (!user) return;
    const { data, error: err } = await supabase
      .schema('hub')
      .from('api_keys')
      .select('id, label, created_at')
      .eq('user_id', user.id)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });

    if (err) setError(err.message);
    else setActiveKeys(data ?? []);
    setLoading(false);
  };

  useEffect(() => { loadKeys(); }, [user]);

  const handleGenerate = async (label: string): Promise<string | null> => {
    if (!user) return null;
    setError(null);
    const plaintext = `lh_${crypto.randomUUID().replace(/-/g, '')}`;
    const hash = await sha256(plaintext);

    const { error: err } = await supabase
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: user.id, api_key_hash: hash, label });

    if (err) {
      setError(err.message);
      return null;
    }
    await loadKeys();
    return plaintext;
  };

  const handleRevoke = async (keyId: string) => {
    setError(null);
    const { error: err } = await supabase
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId);

    if (err) setError(err.message);
    await loadKeys();
  };

  return (
    <HubLayout title="MCP Settings">
      <h3>Endpoint</h3>
      <IonText>
        <code>https://mcp.lunahub.dev/sse</code>
      </IonText>

      {loading ? (
        <IonSpinner />
      ) : (
        <ApiKeyGenerator
          activeKeys={activeKeys}
          loading={loading}
          error={error}
          onGenerate={handleGenerate}
          onRevoke={handleRevoke}
        />
      )}
    </HubLayout>
  );
}
