import { useEffect, useState } from 'react';
import { IonSpinner } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { AppActivationCard } from '@/components/hub/AppActivationCard';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

const APPS = [
  { name: 'coachbyte', displayName: 'CoachByte' },
  { name: 'chefbyte', displayName: 'ChefByte' },
];

export function AppsPage() {
  const { user } = useAuth();
  const [activations, setActivations] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState<string | null>(null);

  const loadActivations = async () => {
    if (!user) return;
    const { data } = await supabase
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', user.id);

    const map: Record<string, boolean> = {};
    data?.forEach((row) => { map[row.app_name] = true; });
    setActivations(map);
    setLoading(false);
  };

  useEffect(() => { loadActivations(); }, [user]);

  const handleActivate = async (appName: string) => {
    setMutating(appName);
    await supabase.schema('hub').rpc('activate_app', { p_app_name: appName });
    await loadActivations();
    setMutating(null);
  };

  const handleDeactivate = async (appName: string) => {
    setMutating(appName);
    await supabase.schema('hub').rpc('deactivate_app', { p_app_name: appName });
    await loadActivations();
    setMutating(null);
  };

  return (
    <HubLayout title="Apps">
      {loading ? (
        <IonSpinner />
      ) : (
        APPS.map((app) => (
          <AppActivationCard
            key={app.name}
            appName={app.name}
            displayName={app.displayName}
            active={!!activations[app.name]}
            loading={mutating === app.name}
            onActivate={() => handleActivate(app.name)}
            onDeactivate={() => handleDeactivate(app.name)}
          />
        ))
      )}
    </HubLayout>
  );
}
