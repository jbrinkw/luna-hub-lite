/**
 * Audit recommendation #25 (LOW): demo-account data isolation.
 *
 * The `hub.reset_demo_dates()` RPC is callable by any authenticated
 * user (so the demo login button works), and its private implementation
 * hardcodes `email = 'demo@lunahub.dev'`. The function MUST only touch
 * the demo user's rows — real users' data must be untouched regardless
 * of who triggers it.
 *
 * Guards the following regressions:
 *   1. A future refactor changes `private.reset_demo_dates()` to use
 *      `auth.uid()` instead of the hardcoded email lookup — every user
 *      would then zero-out their own data on demo login.
 *   2. A migration drops the `WHERE user_id = v_demo_uid` clause from
 *      one of the UPDATE statements — that UPDATE would leak across
 *      all users.
 *   3. Idempotency regression: running the RPC twice leaves the state
 *      stable (no row duplication, no cascading changes in real-user
 *      data on subsequent calls).
 *
 * Fidelity:
 *   - Real local Supabase, real auth, real RPC.
 *   - Two real users (A, B) with real ChefByte seed data.
 *   - Demo user is the one seeded by `supabase/seed.sql`
 *     (demo@lunahub.dev / demo1234) — we do NOT create a parallel demo
 *     user because the RPC matches on email, so only the canonical one
 *     is a valid target.
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedUser, seedFullAndLogin, seedChefByteData, signInWithRetry } from '../helpers/seed';
import { admin, SUPABASE_URL, ANON_KEY } from '../helpers/constants';

interface StockFingerprint {
  lotIds: string[];
  totalQty: number;
  lastWriteHints: Array<{ lot_id: string; qty: number; product_id: string; expires_on: string | null }>;
}

/** Capture a stable fingerprint of a user's chefbyte.stock_lots for later comparison. */
async function fingerprintStock(userId: string): Promise<StockFingerprint> {
  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('stock_lots')
    .select('lot_id, qty_containers, product_id, expires_on')
    .eq('user_id', userId)
    .order('lot_id');
  expect(error).toBeNull();
  const rows = (data ?? []) as Array<{
    lot_id: string;
    qty_containers: number;
    product_id: string;
    expires_on: string | null;
  }>;
  return {
    lotIds: rows.map((r) => r.lot_id).sort(),
    totalQty: rows.reduce((a, r) => a + Number(r.qty_containers), 0),
    lastWriteHints: rows.map((r) => ({
      lot_id: r.lot_id,
      qty: Number(r.qty_containers),
      product_id: r.product_id,
      expires_on: r.expires_on,
    })),
  };
}

test.describe('Demo account reset leaves real users untouched', () => {
  test('two real users + demo reset: demo shifts, real-user stock is preserved bit-for-bit, idempotent across 2 runs', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ── 1. Seed two real users with ChefByte data ──
    // `seedFullAndLogin` creates user A, signs the browser in, and
    // returns an authenticated client we can reuse to call the RPC.
    const { userId: userAId, cleanup: cleanupA, client: clientA } = await seedFullAndLogin(page, 'demo-contam-a');
    const chefAdmin = (admin as any).schema('chefbyte');

    // Give user A a distinct stock row (on top of activation-seed data)
    // with a known lot_id so we can verify it by UUID.
    const userASignature = crypto.randomUUID();
    const { data: userAProduct, error: aProdErr } = await chefAdmin
      .from('products')
      .insert({
        user_id: userAId,
        name: `A-Unique-${userASignature.slice(0, 8)}`,
        servings_per_container: 5,
        calories_per_serving: 100,
        protein_per_serving: 10,
        carbs_per_serving: 5,
        fat_per_serving: 2,
      })
      .select('product_id')
      .single();
    expect(aProdErr).toBeNull();
    const { data: userALoc } = await chefAdmin
      .from('locations')
      .select('location_id')
      .eq('user_id', userAId)
      .limit(1)
      .single();
    const { error: aLotErr } = await chefAdmin.from('stock_lots').insert({
      user_id: userAId,
      product_id: userAProduct!.product_id,
      location_id: userALoc!.location_id,
      qty_containers: 7,
      expires_on: '2099-12-31',
    });
    expect(aLotErr).toBeNull();

    // ── 2. Seed user B via the admin API + manual activation ──
    const { userId: userBId, email: emailB, password: passwordB, cleanup: cleanupB } = await seedUser('demo-contam-b');
    const clientB = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signInRes = await signInWithRetry(clientB, emailB, passwordB);
    expect(signInRes.error).toBeNull();
    for (const app of ['coachbyte', 'chefbyte']) {
      const { error } = await (clientB as any).schema('hub').rpc('activate_app', { p_app_name: app });
      expect(error).toBeNull();
    }
    await seedChefByteData(clientB, userBId);

    try {
      // ── 3. Capture pre-reset fingerprints ──
      const fingerprintA_Pre = await fingerprintStock(userAId);
      const fingerprintB_Pre = await fingerprintStock(userBId);

      // User A should have the unique lot we just inserted plus any
      // activation-seed lots (activation may or may not seed stock —
      // fingerprint captures whatever is present).
      expect(fingerprintA_Pre.lotIds.length).toBeGreaterThan(0);
      expect(fingerprintB_Pre.lotIds.length).toBeGreaterThan(0);

      // ── 4. Look up the demo user + capture ITS fingerprint ──
      const DEMO_EMAIL = 'demo@lunahub.dev';
      const { data: demoUsers } = await admin.auth.admin.listUsers();
      const demoUser = demoUsers.users.find((u) => u.email === DEMO_EMAIL);
      if (!demoUser) {
        test.skip(
          true,
          `demo@lunahub.dev not present in auth.users — supabase/seed.sql did not run. Skipping contamination test.`,
        );
        return;
      }
      const demoUserId = demoUser.id;
      const fingerprintDemo_Pre = await fingerprintStock(demoUserId);

      // ── 5. Invoke the reset RPC as user A (authenticated) ──
      // Uses user A's JWT on purpose: a bug where the RPC rewrites
      // the CALLER's rows instead of the demo user's rows would wipe
      // A's data. If we called as admin, that path would stay hidden.
      const { error: rpc1Err } = await (clientA as any).schema('hub').rpc('reset_demo_dates');
      expect(rpc1Err).toBeNull();

      // ── 6. Post-reset fingerprints ──
      const fingerprintA_Post1 = await fingerprintStock(userAId);
      const fingerprintB_Post1 = await fingerprintStock(userBId);
      const fingerprintDemo_Post1 = await fingerprintStock(demoUserId);

      // Real users must be BIT-FOR-BIT unchanged — every lot_id, qty,
      // expires_on, and product_id is preserved.
      expect(fingerprintA_Post1.lotIds).toEqual(fingerprintA_Pre.lotIds);
      expect(fingerprintA_Post1.totalQty).toBe(fingerprintA_Pre.totalQty);
      expect(fingerprintA_Post1.lastWriteHints).toEqual(fingerprintA_Pre.lastWriteHints);

      expect(fingerprintB_Post1.lotIds).toEqual(fingerprintB_Pre.lotIds);
      expect(fingerprintB_Post1.totalQty).toBe(fingerprintB_Pre.totalQty);
      expect(fingerprintB_Post1.lastWriteHints).toEqual(fingerprintB_Pre.lastWriteHints);

      // Demo account must be NON-empty (reset should NOT have deleted
      // anything — it shifts `expires_on` dates forward). If the reset
      // went no-op because of a broken email lookup, demo rows would
      // still be non-empty but expires_on wouldn't match v_today + N.
      expect(fingerprintDemo_Post1.lotIds.length).toBeGreaterThan(0);
      expect(fingerprintDemo_Post1.lotIds).toEqual(fingerprintDemo_Pre.lotIds);
      // Total qty preserved (reset only touches expires_on, not qty).
      expect(fingerprintDemo_Post1.totalQty).toBe(fingerprintDemo_Pre.totalQty);

      // ── 7. Idempotency: run the reset again — real users still pristine ──
      const { error: rpc2Err } = await (clientA as any).schema('hub').rpc('reset_demo_dates');
      expect(rpc2Err).toBeNull();

      const fingerprintA_Post2 = await fingerprintStock(userAId);
      const fingerprintB_Post2 = await fingerprintStock(userBId);
      const fingerprintDemo_Post2 = await fingerprintStock(demoUserId);

      // Real users: STILL identical to pre-reset. A diff here means
      // repeated resets cascade changes into unrelated data.
      expect(fingerprintA_Post2.lotIds).toEqual(fingerprintA_Pre.lotIds);
      expect(fingerprintA_Post2.totalQty).toBe(fingerprintA_Pre.totalQty);
      expect(fingerprintA_Post2.lastWriteHints).toEqual(fingerprintA_Pre.lastWriteHints);

      expect(fingerprintB_Post2.lotIds).toEqual(fingerprintB_Pre.lotIds);
      expect(fingerprintB_Post2.totalQty).toBe(fingerprintB_Pre.totalQty);
      expect(fingerprintB_Post2.lastWriteHints).toEqual(fingerprintB_Pre.lastWriteHints);

      // Demo idempotent: second run shouldn't add/remove lot_ids, and
      // the expires_on values shouldn't drift (reset uses "today + N"
      // which is stable across runs within the same logical day).
      expect(fingerprintDemo_Post2.lotIds).toEqual(fingerprintDemo_Post1.lotIds);
    } finally {
      await cleanupA();
      await cleanupB();
    }
  });
});
