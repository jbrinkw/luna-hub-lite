import { createClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase environment variables not set');
}

export const supabase = createClient<Database>(supabaseUrl || 'http://localhost:54321', supabaseAnonKey || '');

/**
 * Schema helpers — single `as any` cast here instead of 12+ scattered ones.
 * The chefbyte/coachbyte schemas aren't in our generated Database type yet,
 * so we need the cast until db-types covers non-public schemas.
 */

export const chefbyte = () => supabase.schema('chefbyte') as any;

export const coachbyte = () => supabase.schema('coachbyte') as any;

/**
 * Escape special characters in user input before passing to `.ilike()`.
 * Prevents `%` and `_` in user-typed text from acting as SQL wildcards.
 */
export const escapeIlike = (s: string): string => s.replace(/[%_\\]/g, '\\$&');
