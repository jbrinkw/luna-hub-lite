/**
 * useChefbyteProducts — canonical product list hook for ChefByte UI.
 *
 * Single source of truth for the filter that controls which products appear
 * in the normal user-facing UI (Inventory, Settings → Products, Scales tab,
 * etc.). Both `deleted_at IS NULL` and `[MEAL]` exclusion are applied here so
 * no page can accidentally diverge from the other.
 *
 * Filter rules (must be consistent across ALL ChefByte UI surfaces):
 *   1. deleted_at IS NULL  — tombstoned products never appear in the UI
 *   2. name NOT ILIKE '[MEAL]%' — internal meal-plan sentinels are hidden
 *
 * Columns selected are the superset needed by inventory + settings + scales.
 * Individual consumers that only need a subset will still receive the full
 * row; the extra fields are lightweight and the shared cache means there is
 * only one network round-trip regardless of how many components consume this
 * hook.
 *
 * Query key: queryKeys.products(userId)  ← same key used by all existing
 * invalidation calls, so mutations in SettingsPage / ScannerPage / etc. that
 * already call invalidateQueries({ queryKey: queryKeys.products(userId) })
 * will automatically refetch the filtered list.
 */

import { useQuery } from '@tanstack/react-query';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useAuth } from '@/shared/auth/AuthProvider';

export interface ChefbyteProduct {
  product_id: string;
  user_id: string;
  name: string;
  barcode: string | null;
  description: string | null;
  servings_per_container: number;
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  min_stock_amount: number;
  is_placeholder: boolean;
  walmart_link: string | null;
  price: number | null;
  net_weight_g: number | null;
  is_distinct_unit_item: boolean;
  default_recipe_unit: 'gram' | 'serving' | 'container' | null;
  tare_weight_g: number | null;
  certified: boolean | null;
  // Display-only visual unit pair. Both NULL → fallback to canonical
  // svg / ctn / g rendering. Both set → display layer renders e.g.
  // "2 eggs Cage-Free Eggs". Backend math NEVER reads these columns.
  visual_unit_label: string | null;
  visual_units_per_serving: number | null;
}

export function useChefbyteProducts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: queryKeys.products(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('products')
        .select('*')
        .eq('user_id', user!.id)
        // Rule 1: never show tombstoned products
        .is('deleted_at', null)
        // Rule 2: never show internal [MEAL] sentinel products
        .not('name', 'ilike', '[MEAL]%')
        .order('name');
      if (error) throw error;
      return (data ?? []) as ChefbyteProduct[];
    },
    enabled: !!user,
    staleTime: 2 * 60 * 1000, // 2 min — consistent with app default
  });
}
