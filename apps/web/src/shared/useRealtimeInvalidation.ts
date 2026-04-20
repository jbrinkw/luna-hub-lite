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
          // Read the latest subscriptions from the ref in case the caller
          // re-rendered with new keys after mount. Invalidate AND force a
          // refetch: the default ``refetchType: 'active'`` silently skips
          // queries whose observers aren't settled yet (e.g. during route
          // transitions), which was hiding updates for pages that had
          // just mounted when the event fired. ``'all'`` guarantees the
          // refetch fires regardless of observer state.
          const current = subsRef.current.find((s) => s.schema === sub.schema && s.table === sub.table) ?? sub;
          for (const key of current.queryKeys) {
            queryClient.invalidateQueries({ queryKey: [...key], refetchType: 'all' });
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
