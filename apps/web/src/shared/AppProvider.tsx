import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth/AuthProvider';
import { supabase } from './supabase';
import { queryKeys, profileKeys } from './queryKeys';
import { useRealtimeInvalidation } from './useRealtimeInvalidation';
import { useRealtimeHealth } from './useRealtimeHealth';

interface AppContextType {
  activations: Record<string, boolean>;
  activationsLoading: boolean;
  online: boolean;
  lastSynced: Date | null;
  dayStartHour: number;
  /**
   * The user's profile IANA timezone (e.g. "America/New_York"). Thread this
   * into `todayStr`/`toDateStr` so client-computed logical dates match the
   * server's `private.get_logical_date` (which uses this same timezone). See
   * `shared/dates.ts` — H-19.
   */
  timezone: string;
  refreshActivations: () => Promise<void>;
  // True iff any tracked Supabase Realtime channel has lost its SUBSCRIBED
  // status or missed 3 heartbeats — see `realtimeHealth.ts`.
  realtimeDegraded: boolean;
  // Force-reconnect every tracked realtime channel AND hard-reset the
  // underlying Supabase Realtime WebSocket. Wired to the "Reconnect" button
  // in `OfflineIndicator`. Returns a Promise so the UI can show a brief
  // "Reconnecting…" state while it runs.
  reconnectRealtime: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  activations: {},
  activationsLoading: true,
  online: true,
  lastSynced: null,
  dayStartHour: 0,
  timezone: 'America/New_York',
  refreshActivations: async () => {},
  realtimeDegraded: false,
  reconnectRealtime: async () => {},
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

  const { data: profile } = useQuery({
    // H-13 / PROFILE-CACHE: distinct `dayStart` key. This caches a
    // `{ dayStartHour, timezone }` shape that is incompatible with the other
    // profile consumers (useUnitSystem's `{ unit_system }`, ClassifierTab's
    // `{ chefbyte_classifier_fallback_enabled }`, AccountPage's full row), so
    // it MUST NOT share a cache key with them. See `profileKeys`.
    queryKey: profileKeys.dayStart(user?.id ?? ''),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('day_start_hour, timezone')
        .eq('user_id', user!.id)
        // maybeSingle, not single: a user whose hub.profiles row hasn't been
        // created yet (fresh signup, or a seeded/imported account) must not get
        // a PostgREST 406 that surfaces as a browser console error and errors
        // the query. Missing row → data null → the defaults below apply.
        .maybeSingle();
      if (error) throw error;
      return {
        dayStartHour: data?.day_start_hour ?? 0,
        // Profile `timezone` is NOT NULL with a default, but fall back to the
        // same default the DB uses if a malformed/empty row slips through.
        timezone: (data?.timezone as string | null) || 'America/New_York',
      };
    },
    enabled: !!user,
    staleTime: 10 * 60 * 1000,
  });

  const dayStartHour = profile?.dayStartHour ?? 0;
  const timezone = profile?.timezone ?? 'America/New_York';

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

  const { degraded: realtimeDegraded, reconnect: reconnectRealtime } = useRealtimeHealth();

  const value = useMemo(
    () => ({
      activations,
      activationsLoading,
      online,
      lastSynced,
      dayStartHour,
      timezone,
      refreshActivations,
      realtimeDegraded,
      reconnectRealtime,
    }),
    [
      activations,
      activationsLoading,
      online,
      lastSynced,
      dayStartHour,
      timezone,
      refreshActivations,
      realtimeDegraded,
      reconnectRealtime,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
