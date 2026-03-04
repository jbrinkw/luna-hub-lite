import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonText } from '@ionic/react';
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
  const [error, setError] = useState<string | null>(null);

  const loadActivations = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.schema('hub').from('app_activations').select('app_name').eq('user_id', user.id);

    const map: Record<string, boolean> = {};
    data?.forEach((row) => {
      map[row.app_name] = true;
    });
    setActivations(map);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadActivations();
  }, [loadActivations]);

  const handleActivate = async (appName: string) => {
    setError(null);
    setMutating(appName);
    const { error: rpcError } = await supabase.schema('hub').rpc('activate_app', { p_app_name: appName });
    if (rpcError) {
      setError(rpcError.message);
      setMutating(null);
      return;
    }
    await loadActivations();
    setMutating(null);
  };

  const handleDeactivate = async (appName: string) => {
    setError(null);
    setMutating(appName);
    const { error: rpcError } = await supabase.schema('hub').rpc('deactivate_app', { p_app_name: appName });
    if (rpcError) {
      setError(rpcError.message);
      setMutating(null);
      return;
    }
    await loadActivations();
    setMutating(null);
  };

  return (
    <HubLayout title="Apps">
      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}
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
