import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';

interface RealtimeSub {
  schema: string;
  table: string;
  filter?: string;
  queryKeys: readonly (readonly unknown[])[];
}

/**
 * Subscribe to Supabase Realtime postgres_changes and invalidate specific
 * TanStack Query keys when rows change. Replaces the old pattern of
 * "Realtime event → refetch all page data".
 */
export function useRealtimeInvalidation(channelName: string, subscriptions: RealtimeSub[]) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const subsRef = useRef(subscriptions);

  useEffect(() => {
    subsRef.current = subscriptions;
  });

  useEffect(() => {
    if (!user) return;

    let channel = supabase.channel(channelName);
    for (const sub of subsRef.current) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: sub.schema,
          table: sub.table,
          filter: sub.filter ?? `user_id=eq.${user.id}`,
        },
        () => {
          for (const key of sub.queryKeys) {
            queryClient.invalidateQueries({ queryKey: [...key] });
          }
        },
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, channelName, queryClient]);
}
