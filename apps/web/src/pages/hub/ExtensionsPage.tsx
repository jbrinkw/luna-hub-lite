import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { ExtensionCard } from '@/components/hub/ExtensionCard';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { CardSkeleton } from '@/components/ui/Skeleton';

const EXTENSIONS = [
  {
    name: 'obsidian',
    displayName: 'Obsidian',
    description: 'Sync notes and data with your Obsidian vault',
    credentialFields: [
      { key: 'obsidian_url', label: 'Obsidian Local REST API URL' },
      { key: 'obsidian_api_key', label: 'API Key' },
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
  const { data: states = {} as Record<string, ExtensionState>, isLoading } = useQuery({
    queryKey: queryKeys.extensions(user!.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('extension_settings')
        .select('extension_name, enabled, credentials_encrypted')
        .eq('user_id', user!.id);
      if (error) throw error;

      const map: Record<string, ExtensionState> = {};
      data?.forEach((row) => {
        map[row.extension_name] = {
          enabled: row.enabled,
          hasCredentials: !!row.credentials_encrypted,
        };
      });
      return map;
    },
    enabled: !!user,
  });

  // Toggle extension mutation with optimistic update
  const toggleMutation = useMutation({
    mutationFn: async ({ extName, enabled }: { extName: string; enabled: boolean }) => {
      const { error } = await supabase
        .schema('hub')
        .from('extension_settings')
        .upsert({ user_id: user!.id, extension_name: extName, enabled }, { onConflict: 'user_id,extension_name' });
      if (error) throw error;
    },
    onMutate: async ({ extName, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.extensions(user!.id) });
      const previous = queryClient.getQueryData<Record<string, ExtensionState>>(queryKeys.extensions(user!.id));
      queryClient.setQueryData(queryKeys.extensions(user!.id), (old: Record<string, ExtensionState> | undefined) => ({
        ...old,
        [extName]: { ...old?.[extName], enabled, hasCredentials: old?.[extName]?.hasCredentials ?? false },
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
      {isLoading ? (
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
