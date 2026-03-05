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
      const { count: missingLinks } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('walmart_link', null)
        .eq('is_placeholder', false);

      // Products missing price (non-placeholder)
      const { count: missingPrices } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('price', null)
        .eq('is_placeholder', false);

      // Placeholder products
      const { count: placeholders } = await chefbyte()
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_placeholder', true);

      setHasAlerts((missingLinks ?? 0) > 0 || (missingPrices ?? 0) > 0 || (placeholders ?? 0) > 0);
    }

    check();
  }, [user]);

  return hasAlerts;
}
