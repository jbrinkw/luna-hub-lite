/**
 * Per-scenario DB seeding + cleanup helpers.
 *
 * Convention: each scenario creates a fresh user via {@link seedUser} and
 * registers the returned `cleanup` function in a `try/finally` so the user
 * (and all their cascaded rows) is removed regardless of pass/fail.
 *
 * We deliberately do NOT truncate global tables — all data is partitioned by
 * `user_id`, and creating + deleting one user per scenario gives us a clean
 * slate without cross-scenario interference.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, anonClient, SUPABASE_URL, SUPABASE_ANON_KEY } from './env';

export interface SeededUser {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
}

export interface SeededUserWithClient extends SeededUser {
  client: SupabaseClient;
}

/** Create a confirmed test user via the admin API, return ids + cleanup. */
export async function seedUser(slug: string): Promise<SeededUser> {
  const admin = adminClient();
  const email = `e2e-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@local.test`;
  const password = 'test-password-e2e';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `E2E ${slug}` },
  });
  if (error || !data.user) {
    throw new Error(`seedUser: admin.createUser failed: ${error?.message ?? 'no user'}`);
  }
  const userId = data.user.id;
  return {
    userId,
    email,
    password,
    cleanup: async () => {
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Create user + sign in (anon SDK) + activate hub modules. Returns the
 * authenticated client + cleanup. The web app will pick up the same session
 * via storage when {@link loginViaInjection} writes it into the page
 * localStorage.
 */
export async function seedUserAndActivate(
  slug: string,
  opts: { activateChef?: boolean; activateCoach?: boolean; activateHub?: boolean } = {},
): Promise<SeededUserWithClient> {
  const activateChef = opts.activateChef ?? true;
  const activateCoach = opts.activateCoach ?? true;

  const { userId, email, password, cleanup } = await seedUser(slug);

  const client = anonClient();
  const { error: signInErr, data: signInData } = await client.auth.signInWithPassword({ email, password });
  if (signInErr || !signInData.session) {
    throw new Error(`seedUserAndActivate: sign-in failed: ${signInErr?.message}`);
  }

  if (activateChef) {
    const { error } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (error) throw new Error(`activate chefbyte failed: ${error.message}`);
  }
  if (activateCoach) {
    const { error } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    if (error) throw new Error(`activate coachbyte failed: ${error.message}`);
  }

  return { userId, email, password, client, cleanup };
}

/**
 * Inject the authenticated session into the browser localStorage so the React
 * app boots already-logged-in. Avoids browser rate limits + UI flake.
 *
 * The supabase-js client stores under `sb-{first-hostname-segment}-auth-token`.
 * Mirrors the existing apps/web/e2e helper.
 */
export async function loginViaInjection(
  page: import('@playwright/test').Page,
  client: SupabaseClient,
): Promise<void> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw new Error(`loginViaInjection: no active session — call seedUserAndActivate first`);
  }
  const url = new URL(SUPABASE_URL);
  const ref = url.hostname.split('.')[0];
  const storageKey = `sb-${ref}-auth-token`;

  // Visit a page first so localStorage is available, then write the token,
  // then navigate to /hub which will pick up the session.
  await page.goto('/login');
  await page.evaluate(
    ([key, payload]) => {
      window.localStorage.setItem(key, payload);
    },
    [storageKey, JSON.stringify(data.session)],
  );
  await page.goto('/hub');
}

/** UI-driven login. Slower but exercises the actual sign-in flow. */
export async function loginViaUi(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait for the hub redirect — proves the session was established.
  await page.waitForURL(/\/hub/, { timeout: 15_000 });
}

/** Set hub.profiles.day_start_hour for a user. */
export async function setDayStartHour(userId: string, hour: number, timezone = 'UTC'): Promise<void> {
  const admin = adminClient();
  const { error } = await (admin as any)
    .schema('hub')
    .from('profiles')
    .update({ day_start_hour: hour, timezone })
    .eq('user_id', userId);
  if (error) throw new Error(`setDayStartHour failed: ${error.message}`);
}

/** Insert a chefbyte product as the given user. Returns product_id. */
export async function seedProduct(
  userId: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const admin = adminClient();
  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('products')
    .insert({
      user_id: userId,
      name,
      servings_per_container: 4,
      calories_per_serving: 100,
      carbs_per_serving: 10,
      protein_per_serving: 5,
      fat_per_serving: 2,
      min_stock_amount: 1,
      ...extra,
    })
    .select('product_id')
    .single();
  if (error || !data) throw new Error(`seedProduct(${name}) failed: ${error?.message}`);
  return data.product_id;
}

/** Look up the user's Fridge location_id (or insert if missing). */
export async function getFridgeLocationId(userId: string): Promise<string> {
  const admin = adminClient();
  const { data: existing } = await (admin as any)
    .schema('chefbyte')
    .from('locations')
    .select('location_id')
    .eq('user_id', userId)
    .eq('name', 'Fridge')
    .maybeSingle();
  if (existing?.location_id) return existing.location_id;

  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('locations')
    .insert({ user_id: userId, name: 'Fridge' })
    .select('location_id')
    .single();
  if (error || !data) throw new Error(`getFridgeLocationId failed: ${error?.message}`);
  return data.location_id;
}

/** Insert a stock_lot. Returns lot_id. */
export async function seedStockLot(
  userId: string,
  productId: string,
  qtyContainers: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const admin = adminClient();
  const locationId = await getFridgeLocationId(userId);
  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('stock_lots')
    .insert({
      user_id: userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: qtyContainers,
      ...extra,
    })
    .select('lot_id')
    .single();
  if (error || !data) throw new Error(`seedStockLot failed: ${error?.message}`);
  return data.lot_id;
}

/**
 * Force-set in_flight_since on an existing lot to simulate the "TTL has now
 * elapsed" condition. Used by scenarios 6 + 7 since freezing the system clock
 * or running a 6-hour test is impractical.
 */
export async function expireInFlightSince(lotId: string, ageHours = 7): Promise<void> {
  const admin = adminClient();
  const expiredTs = new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString();
  const { error } = await (admin as any)
    .schema('chefbyte')
    .from('stock_lots')
    .update({ in_flight_since: expiredTs })
    .eq('lot_id', lotId);
  if (error) throw new Error(`expireInFlightSince failed: ${error.message}`);
}

/** Run the in-flight TTL reaper once (drives scenarios 6 + 7). */
export async function runInFlightReaper(): Promise<void> {
  const admin = adminClient();
  // Reaper exposed as a SECURITY DEFINER fn in the chefbyte schema. Name
  // verified against migration 20260427010000_in_flight_pickup_resolve_whole_lot.
  const { error } = await (admin as any).schema('chefbyte').rpc('reap_expired_in_flight_lots');
  if (error) {
    throw new Error(`runInFlightReaper failed: ${error.message}`);
  }
}

/** Read a single stock_lot row. Null if not found. */
export async function getStockLot(lotId: string) {
  const admin = adminClient();
  const { data } = await (admin as any)
    .schema('chefbyte')
    .from('stock_lots')
    .select('*')
    .eq('lot_id', lotId)
    .maybeSingle();
  return data;
}

/** Count rows in a chefbyte table for a user. */
export async function countUserRows(
  schema: string,
  table: string,
  userId: string,
  extraFilter: Record<string, unknown> = {},
): Promise<number> {
  const admin = adminClient();
  let q = (admin as any).schema(schema).from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
  for (const [k, v] of Object.entries(extraFilter)) {
    q = v === null ? q.is(k, null) : q.eq(k, v);
  }
  const { count, error } = await q;
  if (error) throw new Error(`countUserRows failed: ${error.message}`);
  return count ?? 0;
}
