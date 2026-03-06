import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from './auth/AuthProvider';
import { supabase } from './supabase';

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
  const [activations, setActivations] = useState<Record<string, boolean>>({});
  const [activationsLoading, setActivationsLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [dayStartHour, setDayStartHour] = useState(0);

  const loadActivations = useCallback(async () => {
    if (!user) {
      setActivations({});
      setActivationsLoading(false);
      return;
    }
    const { data, error } = await supabase
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', user.id);

    if (error) {
      console.error('Failed to load activations:', error.message);
    }
    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });
    setActivations(map);
    setActivationsLoading(false);
    setLastSynced(new Date());

    // Load day_start_hour from profile
    const { data: profile } = await supabase
      .schema('hub')
      .from('profiles')
      .select('day_start_hour')
      .eq('user_id', user.id)
      .single();
    if (profile?.day_start_hour != null) {
      setDayStartHour(profile.day_start_hour);
    }
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      value={{ activations, activationsLoading, online, lastSynced, dayStartHour, refreshActivations: loadActivations }}
    >
      {children}
    </AppContext.Provider>
  );
}
