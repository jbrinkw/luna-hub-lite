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

const MAX_ACTIVE_KEYS = 10;

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchActiveKeys(userId: string) {
  return supabase
    .schema('hub')
    .from('api_keys')
    .select('id, label, created_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
}

export function McpSettingsPage() {
  const { user } = useAuth();
  const [activeKeys, setActiveKeys] = useState<ActiveKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    if (!user) return;

    const load = async () => {
      const { data, error: err } = await fetchActiveKeys(user.id);
      if (err) setError(err.message);
      else setActiveKeys(data ?? []);
      setLoading(false);
    };

    load();
  }, [user, refreshCounter]);

  const handleGenerate = async (label: string): Promise<string | null> => {
    if (!user) return null;
    setError(null);

    // Enforce maximum of 10 active (non-revoked) API keys per user
    const { count, error: countErr } = await supabase
      .schema('hub')
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('revoked_at', null);

    if (countErr) {
      setError(countErr.message);
      return null;
    }

    if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
      setError(
        `Maximum of ${MAX_ACTIVE_KEYS} active API keys reached. Revoke an existing key before creating a new one.`,
      );
      return null;
    }

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
    setRefreshCounter((c) => c + 1);
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
    setRefreshCounter((c) => c + 1);
  };

  return (
    <HubLayout title="MCP Settings">
      <h3>Endpoint</h3>
      <IonText>
        <code>{import.meta.env.VITE_MCP_URL ?? 'https://mcp.lunahub.dev'}/sse</code>
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
