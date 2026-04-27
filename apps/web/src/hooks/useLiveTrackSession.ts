/**
 * TanStack Query + Realtime wrapper around one LiveTrack Import session.
 *
 * - Keeps the session row cached under `queryKeys.livetrackSession`.
 * - Subscribes to the row via Realtime + invalidates on every change
 *   (scoped by session_id so two concurrent sessions don't cross-talk).
 * - Exposes convenience mutation wrappers that delegate to livetrackSession.ts
 *   helpers and update the cache optimistically.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/shared/auth/AuthProvider';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { loadLiveTrackSession, patchLiveTrackSession, type LiveTrackSession } from '@/pages/chefbyte/livetrackSession';

export interface UseLiveTrackSessionResult {
  session: LiveTrackSession | null | undefined;
  isLoading: boolean;
  error: unknown;
  /** Optimistic-ish patch: sets cache then awaits the write. */
  patch(patch: Parameters<typeof patchLiveTrackSession>[1]): Promise<LiveTrackSession>;
  refetch(): Promise<unknown>;
}

export function useLiveTrackSession(sessionId: string | null): UseLiveTrackSessionResult {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? '';

  // Custom `filter` scopes the subscription to exactly this session row. The
  // default (`user_id=eq.<uid>`) would also work, but multi-tab sessions
  // can split and we don't want one tab's re-arm to race-trigger another's
  // cache invalidation.
  useRealtimeInvalidation('livetrack-session', [
    {
      schema: 'chefbyte',
      table: 'livetrack_import_sessions',
      filter: sessionId ? `session_id=eq.${sessionId}` : `user_id=eq.${userId}`,
      queryKeys: [queryKeys.livetrackSession(userId, sessionId)],
    },
    {
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      // Default filter `user_id=eq.<uid>` handles heartbeat updates for
      // every device this user owns — the UI picks the freshest.
      queryKeys: [queryKeys.liveShelfDevice(userId)],
    },
  ]);

  const query = useQuery<LiveTrackSession | null>({
    queryKey: queryKeys.livetrackSession(userId, sessionId),
    queryFn: async () => {
      if (!sessionId) return null;
      return await loadLiveTrackSession(sessionId);
    },
    enabled: Boolean(userId && sessionId),
    staleTime: 2 * 60 * 1000,
  });

  const patch = async (p: Parameters<typeof patchLiveTrackSession>[1]): Promise<LiveTrackSession> => {
    if (!sessionId) throw new Error('no active session');
    const result = await patchLiveTrackSession(sessionId, p);
    queryClient.setQueryData(queryKeys.livetrackSession(userId, sessionId), result);
    return result;
  };

  return {
    session: query.data,
    isLoading: query.isLoading,
    error: query.error,
    patch,
    refetch: query.refetch,
  };
}
