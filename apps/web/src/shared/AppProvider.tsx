import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from './auth/AuthProvider';
import { supabase } from './supabase';

interface AppContextType {
  activations: Record<string, boolean>;
  activationsLoading: boolean;
  online: boolean;
  lastSynced: Date | null;
  refreshActivations: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  activations: {},
  activationsLoading: true,
  online: true,
  lastSynced: null,
  refreshActivations: async () => {},
});

export function useAppContext() {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [activations, setActivations] = useState<Record<string, boolean>>({});
  const [activationsLoading, setActivationsLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const loadActivations = useCallback(async () => {
    if (!user) {
      setActivationsLoading(false);
      return;
    }
    const { data } = await supabase.schema('hub').from('app_activations').select('app_name').eq('user_id', user.id);

    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });
    setActivations(map);
    setActivationsLoading(false);
    setLastSynced(new Date());
  }, [user]);

  // Async data fetching with setState is the standard pattern for this use case
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    loadActivations();
  }, [loadActivations]);

  // Realtime subscription for activation changes
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('app-activations')
      .on(
        'postgres_changes',
        { event: '*', schema: 'hub', table: 'app_activations', filter: `user_id=eq.${user.id}` },
        () => loadActivations(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, loadActivations]);

  // Online/offline detection
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      loadActivations();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [loadActivations]);

  return (
    <AppContext.Provider
      value={{ activations, activationsLoading, online, lastSynced, refreshActivations: loadActivations }}
    >
      {children}
    </AppContext.Provider>
  );
}
