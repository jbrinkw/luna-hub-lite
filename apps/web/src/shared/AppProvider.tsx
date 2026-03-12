import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth/AuthProvider';
import { supabase } from './supabase';
import { queryKeys } from './queryKeys';
import { useRealtimeInvalidation } from './useRealtimeInvalidation';

interface AppContextType {
  activations: Record<string, boolean>;
  activationsLoading: boolean;
  online: boolean;
  lastSynced: Date | null;
  dayStartHour: number;
  refreshActivations: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  activations: {},
  activationsLoading: true,
  online: true,
  lastSynced: null,
  dayStartHour: 0,
  refreshActivations: async () => {},
});

export function useAppContext() {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const { data: activations = {}, isLoading: activationsLoading } = useQuery({
    queryKey: queryKeys.activations(user?.id ?? ''),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('app_activations')
        .select('app_name')
        .eq('user_id', user!.id);
      if (error) throw error;
      const map: Record<string, boolean> = {};
      (data || []).forEach((row: any) => {
        map[row.app_name] = true;
      });
      setLastSynced(new Date());
      return map;
    },
    enabled: !!user,
  });

  const { data: dayStartHour = 0 } = useQuery({
    queryKey: queryKeys.profile(user?.id ?? ''),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('day_start_hour')
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data?.day_start_hour ?? 0;
    },
    enabled: !!user,
    staleTime: 10 * 60 * 1000,
  });

  // Realtime invalidation for activation changes
  useRealtimeInvalidation('app-activations', [
    {
      schema: 'hub',
      table: 'app_activations',
      queryKeys: [queryKeys.activations(user?.id ?? '')],
    },
  ]);

  // Online/offline detection
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.activations(user?.id ?? '') });
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [user, queryClient]);

  const refreshActivations = useMemo(
    () => async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.activations(user?.id ?? '') });
    },
    [user, queryClient],
  );

  const value = useMemo(
    () => ({ activations, activationsLoading, online, lastSynced, dayStartHour, refreshActivations }),
    [activations, activationsLoading, online, lastSynced, dayStartHour, refreshActivations],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
