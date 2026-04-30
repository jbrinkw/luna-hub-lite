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
import { Alert } from '@/components/ui/Alert';
import { Copy, Check, ExternalLink, PlugZap, AlertCircle } from 'lucide-react';

interface ActiveKey {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

const MAX_ACTIVE_KEYS = 10;

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; ms: number }
  | { status: 'fail'; message: string };

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
  const [urlCopied, setUrlCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [lastTestKey, setLastTestKey] = useState<string | null>(null);
  const [testKeyInput, setTestKeyInput] = useState('');
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  // Use the recommended Streamable HTTP endpoint at /mcp. The legacy /sse
  // path still works on the worker but burns Durable Object duration billing
  // (per docs/mcp/guide.md). UI defaults users to the cheaper transport.
  const baseUrl = import.meta.env.VITE_MCP_URL ?? 'https://mcp.lunahub.dev';
  const endpointUrl = `${baseUrl}/mcp`;

  // Load active API keys via useQuery
  const {
    data: activeKeys = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.apiKeys(user!.id),
    queryFn: async () => {
      const { data, error: err } = await supabase
        .schema('hub')
        .from('api_keys')
        .select('id, label, created_at, last_used_at')
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

  // Revoke all keys mutation — wired to the "Revoke all" button, and
  // available to external callers (e.g. logout flow when the user has
  // `revoke_keys_on_logout` enabled). Routes through the
  // hub.revoke_all_api_keys_admin SECURITY DEFINER RPC so it works even
  // if the RLS session is about to be torn down on signOut.
  const revokeAllMutation = useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error: err } = await supabase
        .schema('hub')
        .rpc('revoke_all_api_keys_admin', { p_user_id: user!.id });
      if (err) throw err;
      return (data as number | null) ?? 0;
    },
    onError: (err: Error) => {
      setError(err.message);
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
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Clipboard API unavailable in non-HTTPS or restricted contexts — copy silently fails
    } catch {}
  };

  // Claude.ai's "Add custom MCP" connector takes URL + Bearer token as
  // SEPARATE inputs. The earlier multi-line "snippet" promised a
  // single-paste experience that doesn't exist — the user had to
  // manually split it in Claude.ai. R2 audit F3: surface URL and token
  // separately so each is a one-click copy into its respective field.
  const tokenPlaceholder = '<paste-your-key-here>';
  // Optional power-user curl test — wraps both into a one-liner for
  // CLI verification. Kept under "Advanced" so the primary flow stays
  // two-button (URL + token) clean.
  const curlSnippet = `curl -X POST '${endpointUrl}' \\\n  -H 'Authorization: Bearer ${tokenPlaceholder}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'`;

  const copyText = async (text: string, setFlag: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Clipboard API unavailable in non-HTTPS or restricted contexts — copy silently fails
    } catch {}
  };

  /**
   * Fire a JSON-RPC `ping` against POST /mcp using the supplied bearer key.
   * The worker handles `ping` in stateless.ts and returns an empty success
   * body — round-trip latency confirms both auth and reachability.
   */
  const handleTestConnection = async (apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setTestState({ status: 'fail', message: 'Paste an API key to test.' });
      return;
    }
    setLastTestKey(trimmed);
    setTestState({ status: 'running' });
    const start = Date.now();
    try {
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'hub-test', method: 'ping' }),
      });
      const ms = Date.now() - start;
      if (!res.ok) {
        if (res.status === 401) {
          setTestState({ status: 'fail', message: 'Authentication failed (401). Check the key.' });
        } else {
          setTestState({ status: 'fail', message: `HTTP ${res.status} from MCP endpoint.` });
        }
        return;
      }
      // ping returns either {jsonrpc:..., result: {}} or a similar shape.
      // We don't enforce the body — the 200 + JSON parse confirms the call.
      try {
        await res.json();
      } catch {
        setTestState({ status: 'fail', message: 'MCP endpoint returned non-JSON response.' });
        return;
      }
      setTestState({ status: 'ok', ms });
    } catch (e) {
      setTestState({
        status: 'fail',
        message: e instanceof Error ? e.message : 'Network error reaching MCP endpoint.',
      });
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

  const handleRevokeAll = () => {
    setError(null);
    revokeAllMutation.mutate();
  };

  return (
    <HubLayout title="MCP Settings">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Endpoint</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="text-sm bg-code-bg px-3 py-1.5 rounded-md text-code-text flex-1 break-all">
                {endpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyEndpoint} data-testid="copy-endpoint">
                {endpointCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {endpointCopied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-text-secondary">
              Streamable HTTP transport (recommended). Authenticate every request with an{' '}
              <code className="text-xs">Authorization: Bearer &lt;key&gt;</code> header.
            </p>
          </CardContent>
        </Card>

        {/* Quick Start: copy-pasteable Claude.ai setup snippet. Closes the
            biggest documented dead-end in the audit — "Hub gives me a key
            and tells me nothing about how to plug it into Claude.ai." */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Start — Connect Claude.ai</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="list-decimal pl-5 space-y-1 text-sm text-text-secondary">
              <li>Generate a key below (or reuse one). Copy the plaintext value — it's only shown once.</li>
              <li>
                In Claude.ai, open <span className="font-medium text-text">Settings → Connectors → Add custom MCP</span>
                .
              </li>
              <li>Use the URL + Bearer token copy buttons below — Claude.ai expects them as separate inputs.</li>
              <li>
                Hit <span className="font-medium text-text">Test connection</span> here to verify before going back to
                Claude.ai.
              </li>
            </ol>

            {/* Claude.ai's connector form has TWO inputs (URL + Bearer
                token), not one. Surface each as its own one-click copy
                so the user pastes into the right field every time. */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-text-secondary">Paste into the Claude.ai connector form:</p>

              <div className="space-y-1">
                <label className="text-xs text-text-secondary" htmlFor="mcp-url-display">
                  URL
                </label>
                <div className="flex items-center gap-2">
                  <code
                    id="mcp-url-display"
                    data-testid="mcp-claude-url"
                    className="text-xs bg-code-bg px-3 py-2 rounded-md text-code-text flex-1 break-all"
                  >
                    {endpointUrl}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(endpointUrl, setUrlCopied)}
                    data-testid="copy-claude-url"
                  >
                    {urlCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {urlCopied ? 'Copied!' : 'Copy URL'}
                  </Button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-text-secondary" htmlFor="mcp-token-display">
                  Bearer token
                </label>
                <div className="flex items-center gap-2">
                  <code
                    id="mcp-token-display"
                    data-testid="mcp-claude-token"
                    className="text-xs bg-code-bg px-3 py-2 rounded-md text-code-text flex-1 break-all"
                  >
                    {tokenPlaceholder}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(tokenPlaceholder, setTokenCopied)}
                    data-testid="copy-claude-token"
                  >
                    {tokenCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {tokenCopied ? 'Copied!' : 'Copy Token'}
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary">
                  Replace the placeholder above with the plaintext key from "Generate New Key" below.
                </p>
              </div>

              {/* Power-user curl one-liner. Kept compact, no copy-by-default
                  to avoid distracting the primary URL+token flow. */}
              <details className="text-xs">
                <summary className="cursor-pointer text-text-secondary hover:text-text">
                  Advanced — curl test command
                </summary>
                <div className="mt-2 space-y-2">
                  <pre
                    data-testid="mcp-curl-snippet"
                    className="text-xs bg-code-bg px-3 py-2 rounded-md text-code-text whitespace-pre-wrap break-all"
                  >
                    {curlSnippet}
                  </pre>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => copyText(curlSnippet, setCurlCopied)}
                    data-testid="copy-curl-snippet"
                  >
                    {curlCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {curlCopied ? 'Copied!' : 'Copy curl test'}
                  </Button>
                </div>
              </details>
            </div>

            <a
              href="https://docs.lunahub.dev/mcp/guide"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Full MCP setup guide
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>

        {/* Test connection: fires a JSON-RPC ping against POST /mcp.
            Confirms both reachability and auth in one round-trip so the
            user doesn't need to bounce to Claude.ai to confirm the key
            works. */}
        <Card>
          <CardHeader>
            <CardTitle>Test connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-secondary">
              Paste a freshly generated key to verify the endpoint accepts it. We send a JSON-RPC{' '}
              <code className="text-xs">ping</code> — no tools are invoked.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="lh_..."
                value={testKeyInput}
                onChange={(e) => setTestKeyInput(e.target.value)}
                data-testid="mcp-test-key-input"
                className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                aria-label="API key to test"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleTestConnection(testKeyInput)}
                loading={testState.status === 'running'}
                disabled={testState.status === 'running' || testKeyInput.trim().length === 0}
                data-testid="mcp-test-connection"
              >
                <PlugZap className="h-4 w-4" />
                Test
              </Button>
            </div>
            {testState.status === 'ok' && (
              <Alert variant="success" data-testid="mcp-test-result-ok">
                Connected. MCP responded in {testState.ms}ms.
              </Alert>
            )}
            {testState.status === 'fail' && (
              <Alert variant="error" data-testid="mcp-test-result-fail">
                <span className="inline-flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  {testState.message}
                </span>
              </Alert>
            )}
            {/* Hidden marker so the test/integration suite can confirm the
                last key tested matches the one passed in (mostly for
                debugging — not user-facing). */}
            {lastTestKey && <span className="hidden" data-testid="mcp-test-last-key" />}
          </CardContent>
        </Card>

        {isError ? (
          <Alert variant="error">Failed to load API keys. Please refresh the page.</Alert>
        ) : isLoading ? (
          <CardSkeleton />
        ) : (
          <ApiKeyGenerator
            activeKeys={activeKeys}
            loading={generateMutation.isPending || revokeMutation.isPending || revokeAllMutation.isPending}
            error={error}
            onGenerate={handleGenerate}
            onRevoke={handleRevoke}
            onRevokeAll={handleRevokeAll}
          />
        )}
      </div>
    </HubLayout>
  );
}
