import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/shared/supabase';
import { useAuth } from '@/shared/auth/AuthProvider';

/**
 * Returns whether the signed-in user has the `is_admin` flag set on
 * their `hub.profiles` row. Used to gate the /hub/alerts route.
 *
 * Failure modes (network error, RLS denial, missing row) all collapse
 * to `isAdmin = false` so a non-admin / signed-out user never gets
 * temporary admin UI by accident.
 */
export function useIsAdmin(): { isAdmin: boolean; loading: boolean } {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['is-admin', user?.id ?? ''],
    queryFn: async () => {
      if (!user) return false;
      const { data: row, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('is_admin')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) return false;
      return row?.is_admin === true;
    },
    enabled: !!user,
    // Admin status changes are rare — cache aggressively.
    staleTime: 10 * 60 * 1000,
  });

  return { isAdmin: data === true, loading: isLoading };
}
