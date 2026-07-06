/**
 * useUnitSystem — read the current user's `hub.profiles.unit_system`
 * preference. Used by display-by-weight rendering in inventory / recipes /
 * meal plan / macros UI.
 *
 * Defaults to 'imperial' before the profile loads or for users predating
 * the 2026-04-30 migration. Caches via TanStack so the read is shared
 * across pages and re-fetched only when the profile mutates (AccountPage
 * invalidates the profile keys on save).
 *
 * H-13 / PROFILE-CACHE: this reads its OWN `profileKeys.unitSystem` key — it
 * MUST NOT share a key with AppProvider (bare number day_start_hour) or any
 * other profile consumer, or it would read a foreign shape and mis-derive the
 * unit (e.g. a metric user silently getting imperial). See `profileKeys` in
 * queryKeys.ts.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';
import { profileKeys } from './queryKeys';
import type { UnitSystem } from './recipes/formatIngredientDisplay';

export function useUnitSystem(): UnitSystem {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: profileKeys.unitSystem(user?.id ?? 'anon'),
    queryFn: async () => {
      if (!user) return null;
      const { data: row, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('unit_system')
        .eq('user_id', user.id)
        // maybeSingle, not single: a missing profile row (fresh/seeded account)
        // must not 406 → browser console error. Null row falls through to the
        // 'imperial' default below.
        .maybeSingle();
      if (error) throw error;
      return row;
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const us = (data as { unit_system?: string } | null | undefined)?.unit_system;
  return us === 'metric' ? 'metric' : 'imperial';
}
