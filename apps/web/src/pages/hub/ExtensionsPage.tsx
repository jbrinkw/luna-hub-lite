import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { ExtensionCard } from '@/components/hub/ExtensionCard';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { Alert } from '@/components/ui/Alert';

const EXTENSIONS = [
  {
    name: 'obsidian',
    displayName: 'Obsidian',
    description: 'Read and write notes in your Obsidian vault via GitHub/Gitea API',
    credentialFields: [
      { key: 'github_repo', label: 'GitHub Repo (owner/repo)' },
      { key: 'github_token', label: 'GitHub Personal Access Token' },
      { key: 'github_api_url', label: 'API URL (default: https://api.github.com)', optional: true },
    ],
  },
  {
    name: 'todoist',
    displayName: 'Todoist',
    description: 'Sync tasks and shopping lists with Todoist',
    credentialFields: [{ key: 'todoist_api_key', label: 'API Token' }],
  },
  {
    name: 'homeassistant',
    displayName: 'Home Assistant',
    description: 'Control smart home devices and automations',
    credentialFields: [
      { key: 'ha_url', label: 'Home Assistant URL' },
      { key: 'ha_api_key', label: 'Long-Lived Access Token' },
    ],
  },
];

interface ExtensionState {
  enabled: boolean;
  hasCredentials: boolean;
}

export function ExtensionsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Load extension settings via useQuery
  const {
    data: states = {} as Record<string, ExtensionState>,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.extensions(user!.id),
    queryFn: async () => {
      // vault_secret_id is the post-Vault credential pointer (nullable UUID).
      // The browser never sees the secret payload itself — that lives in
      // vault.secrets and is only readable via the get_extension_credentials
      // RPC (server-side, MCP worker uses the *_admin variant). Truthy
      // UUID == "credentials configured".
      const { data, error } = await supabase
        .schema('hub')
        .from('extension_settings')
        .select('extension_name, enabled, vault_secret_id')
        .eq('user_id', user!.id);
      if (error) throw error;

      const map: Record<string, ExtensionState> = {};
      data?.forEach((row) => {
        map[row.extension_name] = {
          enabled: row.enabled,
          hasCredentials: !!row.vault_secret_id,
        };
      });
      return map;
    },
    enabled: !!user,
  });

  // Toggle extension mutation with optimistic update.
  //
  // Disable side-effect (2026-04-29): when toggling enabled=false, also
  // CLEAR the vault secret so re-enabling the extension forces the user
  // to re-enter credentials. Rationale: stale tokens/keys outliving a
  // disable-toggle is a worse failure mode than the small re-entry friction
  // when re-enabling. Re-enables are rare (per UX audit) and credentials
  // can rotate / get revoked while the extension was disabled.
  //
  // Vault migration (20260429160000_extension_credentials_vault.sql):
  // disable now calls hub.clear_extension_credentials(), which both nulls
  // the vault_secret_id pointer AND deletes the underlying vault.secrets
  // row. The legacy "set credentials_encrypted = null" upsert no longer
  // works — the column was dropped.
  const toggleMutation = useMutation({
    mutationFn: async ({ extName, enabled }: { extName: string; enabled: boolean }) => {
      // Always upsert the enabled flag first.
      const { error: upsertErr } = await supabase
        .schema('hub')
        .from('extension_settings')
        .upsert({ user_id: user!.id, extension_name: extName, enabled }, { onConflict: 'user_id,extension_name' });
      if (upsertErr) throw upsertErr;
      // Then, if disabling, clear the vault secret atomically.
      if (!enabled) {
        const { error: clearErr } = await supabase
          .schema('hub')
          .rpc('clear_extension_credentials', { p_extension_name: extName });
        if (clearErr) throw clearErr;
      }
    },
    onMutate: async ({ extName, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.extensions(user!.id) });
      const previous = queryClient.getQueryData<Record<string, ExtensionState>>(queryKeys.extensions(user!.id));
      queryClient.setQueryData(queryKeys.extensions(user!.id), (old: Record<string, ExtensionState> | undefined) => ({
        ...old,
        [extName]: {
          ...old?.[extName],
          enabled,
          // On disable, optimistically reflect credential clear so the
          // "Credentials configured" badge flips immediately.
          hasCredentials: enabled ? (old?.[extName]?.hasCredentials ?? false) : false,
        },
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.extensions(user!.id), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.extensions(user!.id) });
    },
  });

  // Save credentials mutation
  const saveCredentialsMutation = useMutation({
    mutationFn: async ({ extName, credentials }: { extName: string; credentials: Record<string, string> }) => {
      const { error } = await supabase.schema('hub').rpc('save_extension_credentials', {
        p_extension_name: extName,
        p_credentials_json: JSON.stringify(credentials),
      });
      if (error) throw error;
    },
    onSuccess: (_data, { extName }) => {
      queryClient.setQueryData(queryKeys.extensions(user!.id), (old: Record<string, ExtensionState> | undefined) => ({
        ...old,
        [extName]: { ...old?.[extName], enabled: old?.[extName]?.enabled ?? false, hasCredentials: true },
      }));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.extensions(user!.id) });
    },
  });

  const handleToggle = (extName: string, enabled: boolean) => {
    toggleMutation.mutate({ extName, enabled });
  };

  const handleSaveCredentials = async (extName: string, credentials: Record<string, string>) => {
    try {
      await saveCredentialsMutation.mutateAsync({ extName, credentials });
      return {};
    } catch (err: any) {
      return { error: err.message };
    }
  };

  return (
    <HubLayout title="Extensions">
      {isError ? (
        <Alert variant="error">Failed to load extension settings. Please refresh the page.</Alert>
      ) : isLoading ? (
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : (
        <div className="space-y-4">
          {EXTENSIONS.map((ext) => (
            <ExtensionCard
              key={ext.name}
              extensionName={ext.name}
              displayName={ext.displayName}
              description={ext.description}
              enabled={states[ext.name]?.enabled ?? false}
              hasCredentials={states[ext.name]?.hasCredentials ?? false}
              credentialFields={ext.credentialFields}
              onToggle={(enabled) => handleToggle(ext.name, enabled)}
              onSaveCredentials={(creds) => handleSaveCredentials(ext.name, creds)}
            />
          ))}
        </div>
      )}
    </HubLayout>
  );
}
