import { useEffect, useState } from 'react';
import { IonSpinner } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { ExtensionCard } from '@/components/hub/ExtensionCard';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

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
  const [states, setStates] = useState<Record<string, ExtensionState>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const loadSettings = async () => {
      const { data } = await supabase
        .schema('hub')
        .from('extension_settings')
        .select('extension_name, enabled, credentials_encrypted')
        .eq('user_id', user.id);

      const map: Record<string, ExtensionState> = {};
      data?.forEach((row) => {
        map[row.extension_name] = {
          enabled: row.enabled,
          hasCredentials: !!row.credentials_encrypted,
        };
      });
      setStates(map);
      setLoading(false);
    };

    loadSettings();
  }, [user]);

  const handleToggle = async (extName: string, enabled: boolean) => {
    if (!user) return;
    const prev = states[extName];
    setStates((s) => ({
      ...s,
      [extName]: { ...s[extName], enabled },
    }));

    const { error } = await supabase
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: user.id, extension_name: extName, enabled }, { onConflict: 'user_id,extension_name' });

    if (error) {
      // Rollback optimistic update
      setStates((s) => ({
        ...s,
        [extName]: prev ?? { enabled: !enabled, hasCredentials: false },
      }));
    }
  };

  const handleSaveCredentials = async (extName: string, credentials: Record<string, string>) => {
    if (!user) return { error: 'Not authenticated' };

    // Save credentials via server-side encrypted RPC (pgp_sym_encrypt)
    const { error } = await supabase.schema('hub').rpc('save_extension_credentials', {
      p_extension_name: extName,
      p_credentials_json: JSON.stringify(credentials),
    });

    if (error) return { error: error.message };

    setStates((prev) => ({
      ...prev,
      [extName]: { ...prev[extName], hasCredentials: true },
    }));
    return {};
  };

  return (
    <HubLayout title="Extensions">
      {loading ? (
        <IonSpinner />
      ) : (
        EXTENSIONS.map((ext) => (
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
        ))
      )}
    </HubLayout>
  );
}
