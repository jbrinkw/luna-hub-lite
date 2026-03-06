import { useEffect, useState } from 'react';
import { chefbyte } from '@/shared/supabase';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useSettingsAlerts() {
  const { user } = useAuth();
  const [hasAlerts, setHasAlerts] = useState(false);

  useEffect(() => {
    if (!user) return;

    async function check() {
      const userId = user!.id;

      // Products missing walmart link (excluding NOT_ON_WALMART sentinel and placeholders)
      const { count: missingLinks, error: linksError } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('walmart_link', null)
        .eq('is_placeholder', false);

      if (linksError) {
        console.error('[useSettingsAlerts] Failed to check missing walmart links:', linksError.message);
        return;
      }

      // Products missing price (non-placeholder)
      const { count: missingPrices, error: pricesError } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('price', null)
        .eq('is_placeholder', false);

      if (pricesError) {
        console.error('[useSettingsAlerts] Failed to check missing prices:', pricesError.message);
        return;
      }

      // Placeholder products
      const { count: placeholders, error: placeholdersError } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_placeholder', true);

      if (placeholdersError) {
        console.error('[useSettingsAlerts] Failed to check placeholders:', placeholdersError.message);
        return;
      }

      setHasAlerts((missingLinks ?? 0) > 0 || (missingPrices ?? 0) > 0 || (placeholders ?? 0) > 0);
    }

    check();
  }, [user]);

  return hasAlerts;
}
