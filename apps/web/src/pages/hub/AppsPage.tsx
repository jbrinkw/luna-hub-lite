import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { AppActivationCard } from '@/components/hub/AppActivationCard';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { Alert } from '@/components/ui/Alert';
import { CardSkeleton } from '@/components/ui/Skeleton';

const APPS = [
  { name: 'coachbyte', displayName: 'CoachByte' },
  { name: 'chefbyte', displayName: 'ChefByte' },
];

export function AppsPage() {
  const { user } = useAuth();
  const { activations, activationsLoading, refreshActivations } = useAppContext();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const activateMutation = useMutation({
    mutationFn: async (appName: string) => {
      const { error: rpcError } = await supabase.schema('hub').rpc('activate_app', { p_app_name: appName });
      if (rpcError) throw rpcError;
    },
    onSettled: () => {
      refreshActivations();
      queryClient.invalidateQueries({ queryKey: queryKeys.activations(user!.id) });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (appName: string) => {
      const { error: rpcError } = await supabase.schema('hub').rpc('deactivate_app', { p_app_name: appName });
      if (rpcError) throw rpcError;
    },
    onSettled: () => {
      refreshActivations();
      queryClient.invalidateQueries({ queryKey: queryKeys.activations(user!.id) });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const mutatingApp = activateMutation.isPending
    ? (activateMutation.variables as string)
    : deactivateMutation.isPending
      ? (deactivateMutation.variables as string)
      : null;

  return (
    <HubLayout title="Apps">
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}
      {activationsLoading ? (
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : (
        <div className="space-y-4">
          {APPS.map((app) => (
            <AppActivationCard
              key={app.name}
              appName={app.name}
              displayName={app.displayName}
              active={!!activations[app.name]}
              loading={mutatingApp === app.name}
              onActivate={() => {
                setError(null);
                activateMutation.mutate(app.name);
              }}
              onDeactivate={() => {
                setError(null);
                deactivateMutation.mutate(app.name);
              }}
            />
          ))}
        </div>
      )}
    </HubLayout>
  );
}
