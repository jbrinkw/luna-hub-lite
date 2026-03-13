import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { ApiKeyGenerator } from '@/components/hub/ApiKeyGenerator';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Copy, Check } from 'lucide-react';

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

export function McpSettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [endpointCopied, setEndpointCopied] = useState(false);

  const endpointUrl = `${import.meta.env.VITE_MCP_URL ?? 'https://mcp.lunahub.dev'}/sse`;

  // Load active API keys via useQuery
  const { data: activeKeys = [], isLoading } = useQuery({
    queryKey: queryKeys.apiKeys(user!.id),
    queryFn: async () => {
      const { data, error: err } = await supabase
        .schema('hub')
        .from('api_keys')
        .select('id, label, created_at')
        .eq('user_id', user!.id)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
      if (err) throw err;
      return (data ?? []) as ActiveKey[];
    },
    enabled: !!user,
  });

  // Generate key mutation
  const generateMutation = useMutation({
    mutationFn: async (label: string): Promise<string> => {
      // Enforce maximum of 10 active (non-revoked) API keys per user
      const { count, error: countErr } = await supabase
        .schema('hub')
        .from('api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .is('revoked_at', null);

      if (countErr) throw countErr;

      if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
        throw new Error(
          `Maximum of ${MAX_ACTIVE_KEYS} active API keys reached. Revoke an existing key before creating a new one.`,
        );
      }

      const plaintext = `lh_${crypto.randomUUID().replace(/-/g, '')}`;
      const hash = await sha256(plaintext);

      const { error: err } = await supabase
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: user!.id, api_key_hash: hash, label });

      if (err) throw err;
      return plaintext;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(user!.id) });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  // Revoke key mutation
  const revokeMutation = useMutation({
    mutationFn: async (keyId: string) => {
      const { error: err } = await supabase
        .schema('hub')
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId)
        .eq('user_id', user!.id);
      if (err) throw err;
    },
    onMutate: async (keyId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys(user!.id) });
      const previous = queryClient.getQueryData<ActiveKey[]>(queryKeys.apiKeys(user!.id));
      queryClient.setQueryData(queryKeys.apiKeys(user!.id), (old: ActiveKey[] | undefined) =>
        old?.filter((key) => key.id !== keyId),
      );
      return { previous };
    },
    onError: (_err, _keyId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.apiKeys(user!.id), context.previous);
      }
      setError(_err.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(user!.id) });
    },
  });

  const handleCopyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setEndpointCopied(true);
      setTimeout(() => setEndpointCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const handleGenerate = async (label: string): Promise<string | null> => {
    setError(null);
    try {
      return await generateMutation.mutateAsync(label || 'Untitled');
    } catch {
      return null;
    }
  };

  const handleRevoke = (keyId: string) => {
    setError(null);
    revokeMutation.mutate(keyId);
  };

  return (
    <HubLayout title="MCP Settings">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Endpoint</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="text-sm bg-code-bg px-3 py-1.5 rounded-md text-code-text flex-1 break-all">
                {endpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyEndpoint} data-testid="copy-endpoint">
                {endpointCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {endpointCopied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <CardSkeleton />
        ) : (
          <ApiKeyGenerator
            activeKeys={activeKeys}
            loading={generateMutation.isPending || revokeMutation.isPending}
            error={error}
            onGenerate={handleGenerate}
            onRevoke={handleRevoke}
          />
        )}
      </div>
    </HubLayout>
  );
}
