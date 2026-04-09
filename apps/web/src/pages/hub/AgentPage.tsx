import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Copy, Check } from 'lucide-react';

const DEFAULT_SYSTEM_PROMPT = `You are Luna, a helpful voice assistant. You have access to tools for managing workouts (CoachByte), food/nutrition (ChefByte), tasks (Todoist), and smart home devices (Home Assistant). Keep responses concise and conversational — the user is talking to you via voice. When calling tools, explain what you're doing briefly. If a tool fails, tell the user plainly.`;

export function AgentPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [endpointCopied, setEndpointCopied] = useState(false);

  const [apiKey, setApiKey] = useState('');
  // null = not yet edited by user (falls back to server value)
  const [systemPromptDraft, setSystemPromptDraft] = useState<string | null>(null);
  const [keySaveError, setKeySaveError] = useState<string | null>(null);
  const [keySaveSuccess, setKeySaveSuccess] = useState(false);
  const [promptSaveError, setPromptSaveError] = useState<string | null>(null);
  const [promptSaveSuccess, setPromptSaveSuccess] = useState(false);

  const endpointUrl = `${import.meta.env.VITE_MCP_URL ?? 'https://mcp.lunahub.dev'}/v1`;

  // Load agent settings
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.agentSettings(user!.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('agent_settings')
        .select('anthropic_key_encrypted, system_prompt')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return {
        hasKey: !!data?.anthropic_key_encrypted,
        systemPrompt: data?.system_prompt || '',
      };
    },
    enabled: !!user,
  });

  // Displayed prompt: user draft takes priority; falls back to server value once loaded
  const systemPrompt = systemPromptDraft ?? settings?.systemPrompt ?? '';

  // Save API key mutation
  const saveKeyMutation = useMutation({
    mutationFn: async (key: string) => {
      const { error } = await supabase.schema('hub').rpc('save_agent_anthropic_key', {
        p_key: key,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setKeySaveSuccess(true);
      setApiKey('');
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
    },
    onError: (err: Error) => setKeySaveError(err.message),
  });

  // Clear API key mutation
  const clearKeyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.schema('hub').rpc('clear_agent_anthropic_key');
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
      setKeySaveSuccess(false);
    },
    onError: (err: Error) => setKeySaveError(err.message),
  });

  // Save system prompt mutation
  const savePromptMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const { error } = await supabase.schema('hub').rpc('save_agent_system_prompt', {
        p_prompt: prompt,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setPromptSaveSuccess(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
    },
    onError: (err: Error) => setPromptSaveError(err.message),
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

  const handleSaveKey = () => {
    setKeySaveError(null);
    setKeySaveSuccess(false);
    if (!apiKey.trim()) {
      setKeySaveError('API key is required');
      return;
    }
    saveKeyMutation.mutate(apiKey.trim());
  };

  const handleSavePrompt = () => {
    setPromptSaveError(null);
    setPromptSaveSuccess(false);
    savePromptMutation.mutate(systemPrompt);
  };

  const handleResetPrompt = () => {
    setSystemPromptDraft(DEFAULT_SYSTEM_PROMPT);
    setPromptSaveSuccess(false);
  };

  if (isLoading) {
    return (
      <HubLayout title="AI Agent">
        <div className="space-y-6">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </HubLayout>
    );
  }

  return (
    <HubLayout title="AI Agent">
      <div className="space-y-6">
        {/* Endpoint URL */}
        <Card>
          <CardHeader>
            <CardTitle>API Endpoint</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-text-secondary">
              Use this as the base URL in your Home Assistant OpenAI-compatible integration. Authenticate with the same
              API keys from MCP Settings.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-sm bg-code-bg px-3 py-1.5 rounded-md text-code-text flex-1 break-all">
                {endpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyEndpoint}>
                {endpointCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {endpointCopied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Anthropic API Key */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Anthropic API Key</CardTitle>
              {settings?.hasKey ? (
                <Badge variant="success">Configured</Badge>
              ) : (
                <Badge variant="warning">Not configured</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-secondary">
              Your Anthropic API key is used to call Claude Haiku for each voice request. The key is stored encrypted
              and never exposed after saving.
            </p>
            <Input
              label="API Key"
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="flex gap-2">
              <Button onClick={handleSaveKey} loading={saveKeyMutation.isPending} size="sm">
                {settings?.hasKey ? 'Update Key' : 'Save Key'}
              </Button>
              {settings?.hasKey && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={clearKeyMutation.isPending}
                  onClick={() => {
                    setKeySaveError(null);
                    setKeySaveSuccess(false);
                    clearKeyMutation.mutate();
                  }}
                >
                  Remove Key
                </Button>
              )}
            </div>
            {keySaveError && <Alert variant="error">{keySaveError}</Alert>}
            {keySaveSuccess && <Alert variant="success">API key saved</Alert>}
          </CardContent>
        </Card>

        {/* System Prompt */}
        <Card>
          <CardHeader>
            <CardTitle>System Prompt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-secondary">
              Customize how Luna responds to voice commands. This prompt is sent with every request.
            </p>
            <textarea
              className="w-full min-h-[160px] px-3 py-2 text-sm rounded-md border border-border bg-surface text-text resize-y focus:outline-none focus:ring-2 focus:ring-focus-ring"
              value={systemPrompt}
              onChange={(e) => {
                setSystemPromptDraft(e.target.value);
                setPromptSaveSuccess(false);
              }}
              placeholder={DEFAULT_SYSTEM_PROMPT}
            />
            <div className="flex gap-2">
              <Button onClick={handleSavePrompt} loading={savePromptMutation.isPending} size="sm">
                Save Prompt
              </Button>
              <Button variant="secondary" size="sm" onClick={handleResetPrompt}>
                Reset to Default
              </Button>
            </div>
            {promptSaveError && <Alert variant="error">{promptSaveError}</Alert>}
            {promptSaveSuccess && <Alert variant="success">System prompt saved</Alert>}
          </CardContent>
        </Card>
      </div>
    </HubLayout>
  );
}
