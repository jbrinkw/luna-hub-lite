import { expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Verify a DB row exists with expected field values.
 * Throws with a descriptive message if the row is missing or fields don't match.
 */
export async function expectDbRow(
  client: SupabaseClient,
  schema: string,
  table: string,
  filter: Record<string, any>,
  expected: Record<string, any>,
): Promise<Record<string, any>> {
  const sc = (client as any).schema(schema);
  let query = sc.from(table).select('*');

  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      query = query.is(key, null);
    } else {
      query = query.eq(key, value);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`expectDbRow query failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`expectDbRow: no row found in ${schema}.${table} matching ${JSON.stringify(filter)}`);
  }

  const row = data[0];
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === 'number') {
      expect(Number(row[key])).toBeCloseTo(value, 1);
    } else {
      expect(row[key]).toBe(value);
    }
  }

  return row;
}

/**
 * Verify NO row exists matching the given filter.
 */
export async function expectNoDbRow(
  client: SupabaseClient,
  schema: string,
  table: string,
  filter: Record<string, any>,
): Promise<void> {
  const sc = (client as any).schema(schema);
  let query = sc.from(table).select('*');

  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      query = query.is(key, null);
    } else {
      query = query.eq(key, value);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`expectNoDbRow query failed: ${error.message}`);
  expect(data?.length ?? 0).toBe(0);
}

/**
 * Count rows matching a filter in a schema.table.
 */
export async function countDbRows(
  client: SupabaseClient,
  schema: string,
  table: string,
  filter: Record<string, any>,
): Promise<number> {
  const sc = (client as any).schema(schema);
  let query = sc.from(table).select('*', { count: 'exact', head: true });

  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      query = query.is(key, null);
    } else {
      query = query.eq(key, value);
    }
  }

  const { count, error } = await query;
  if (error) throw new Error(`countDbRows query failed: ${error.message}`);
  return count ?? 0;
}
