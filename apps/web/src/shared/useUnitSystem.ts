/**
 * useUnitSystem — read the current user's `hub.profiles.unit_system`
 * preference. Used by display-by-weight rendering in inventory / recipes /
 * meal plan / macros UI.
 *
 * Defaults to 'imperial' before the profile loads or for users predating
 * the 2026-04-30 migration. Caches via TanStack so the read is shared
 * across pages and re-fetched only when the profile mutates (AccountPage
 * invalidates queryKeys.profile on save).
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';
import { queryKeys } from './queryKeys';
import type { UnitSystem } from './recipes/formatIngredientDisplay';

export function useUnitSystem(): UnitSystem {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.profile(user?.id ?? 'anon'),
    queryFn: async () => {
      if (!user) return null;
      const { data: row, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('unit_system')
        .eq('user_id', user.id)
        .single();
      if (error) throw error;
      return row;
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const us = (data as { unit_system?: string } | null | undefined)?.unit_system;
  return us === 'metric' ? 'metric' : 'imperial';
}
