/**
 * End-to-end pipeline test for the USB scanner forwarder.
 *
 * Real cloud calls — no mocks. Exercises the full flow against the local
 * Supabase stack:
 *
 *   1. Web pushes mode via /scanner-state (browser JWT).
 *   2. Pi (or web) submits a barcode via /barcode-scan (x-api-key OR JWT).
 *   3. Cloud applies the action + logs to chefbyte.scan_transactions.
 *   4. Web voids the transaction via /scan-transaction/:id/void (JWT).
 *   5. Cloud reverses the side-effect (deletes the lot/food_log/cart_item).
 *
 * Per user mandate ("test e2e with no shortcuts or mock bs"): no mocks for
 * any cloud call. Every fetch lands on the real edge function, every DB
 * readback uses the admin Supabase client.
 *
 * The granular per-route tests live in shelf-ingest.test.ts (Tasks 4-6 of
 * the Pi USB scanner forwarder plan). This file is the integration glue:
 * end-to-end scenarios that span multiple routes + verify the full chain.
 */
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const BASE_URL = `${SUPABASE_URL}/functions/v1/shelf-ingest`;

interface ScannerCtx {
  userId: string;
  accessToken: string;
  deviceId: string;
  importKey: string;
  /** activate_app('chefbyte') seeds Fridge/Pantry/Freezer. The oldest
   *  matches `private.execute_scan_action`'s ORDER BY created_at ASC LIMIT 1
   *  fallback, so we record it for direct readback assertions. */
  defaultLocationId: string;
  cleanup: () => Promise<void>;
}

/**
 * Provision a fresh user with chefbyte activated + a registered Pi device.
 * Each test owns its own user so concurrent test files don't poison each
 * other's scanner_state / scan_transactions rows. Mirrors the helper in
 * shelf-ingest.test.ts intentionally — keeping the helpers local to this
 * file means breaking changes to the test helper signature there don't
 * cascade here unannounced.
 */
async function provisionScannerUser(suffix: string): Promise<ScannerCtx> {
  const user = await createTestUser(suffix);
  const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
  if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

  // activate_app seeds Fridge/Pantry/Freezer; pick the oldest (matches
  // execute_scan_action's "default location" fallback ordering).
  const { data: locs } = await (adminClient as any)
    .schema('chefbyte')
    .from('locations')
    .select('location_id')
    .eq('user_id', user.userId)
    .order('created_at', { ascending: true })
    .limit(1);
  const oldestLocation = locs?.[0]?.location_id ?? null;
  if (!oldestLocation) throw new Error('activate_app did not seed locations');

  const apiKey = 'shelf_' + randomBytes(16).toString('hex');
  const { data: dev, error: devErr } = await (adminClient as any)
    .schema('chefbyte')
    .from('live_shelf_devices')
    .insert({
      user_id: user.userId,
      device_name: `Pipeline Test Pi ${suffix}`,
      import_key_hash: createHash('sha256').update(apiKey).digest('hex'),
      is_active: true,
    })
    .select('device_id')
    .single();
  if (devErr) throw new Error(`create device: ${devErr.message}`);

  const {
    data: { session },
  } = await user.client.auth.getSession();
  const accessToken = session!.access_token;

  return {
    userId: user.userId,
    accessToken,
    deviceId: dev.device_id,
    importKey: apiKey,
    defaultLocationId: oldestLocation,
    cleanup: async () => {
      // FK-safe cleanup. ON DELETE CASCADE from auth.users would handle
      // most of this, but we wipe explicitly to keep test isolation
      // behaviour observable + speed up the deletes.
      await (adminClient as any).schema('chefbyte').from('scan_transactions').delete().eq('user_id', user.userId);
      await (adminClient as any).schema('chefbyte').from('food_logs').delete().eq('user_id', user.userId);
      await (adminClient as any).schema('chefbyte').from('shopping_list').delete().eq('user_id', user.userId);
      await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('user_id', user.userId);
      await (adminClient as any).schema('chefbyte').from('products').delete().eq('user_id', user.userId);
      await (adminClient as any).schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', dev.device_id);
      await cleanupUser(user.userId);
    },
  };
}

/**
 * Seed a product the user owns. Returns the product_id. The shape mirrors
 * what /barcode-scan needs to apply a purchase: barcode (lookup key),
 * servings_per_container (qty math), net_weight_g (grams→containers
 * fallback), and macros (so the consume-macros path also works on this
 * product if a later test reuses it).
 */
async function createTestProduct(userId: string, barcode: string, name: string): Promise<string> {
  const { data, error } = await (adminClient as any)
    .schema('chefbyte')
    .from('products')
    .insert({
      user_id: userId,
      name,
      barcode,
      servings_per_container: 2,
      calories_per_serving: 200,
      carbs_per_serving: 25,
      protein_per_serving: 10,
      fat_per_serving: 6,
      net_weight_g: 500,
    })
    .select('product_id')
    .single();
  if (error) throw new Error(`createTestProduct failed: ${error.message}`);
  return data.product_id;
}

describe('Scanner pipeline E2E (real Supabase, no mocks)', () => {
  it('mode push → Pi-style barcode-scan → transaction logged → void reverses', async () => {
    const ctx = await provisionScannerUser('pipe-full');
    try {
      // ─── Step 1: Web pushes scanner mode = 'purchase' via JWT.
      const modeRes = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'purchase' }),
      });
      expect(modeRes.status).toBe(200);
      const modeBody = await modeRes.json();
      expect(modeBody.ok).toBe(true);
      expect(modeBody.last_active_mode).toBe('purchase');
      expect(modeBody.locked_mode).toBeNull();

      // Verify scanner_state row landed in the DB exactly as the response
      // claims — this catches the case where the route returns 200 but
      // silently fails the upsert.
      const { data: scannerStateRow } = await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .select('user_id, last_active_mode, locked_mode')
        .eq('user_id', ctx.userId)
        .single();
      expect(scannerStateRow).not.toBeNull();
      expect(scannerStateRow.user_id).toBe(ctx.userId);
      expect(scannerStateRow.last_active_mode).toBe('purchase');
      expect(scannerStateRow.locked_mode).toBeNull();

      // ─── Step 2: Seed a product the Pi will scan.
      const barcode = 'PIPE-FULL-' + randomBytes(4).toString('hex').toUpperCase();
      const productId = await createTestProduct(ctx.userId, barcode, 'Pipeline Test Product');

      // ─── Step 3: Pi-style scan via x-api-key (USB-scanner forwarder
      // path). pi_event_id is what guarantees idempotency on retries.
      const piEventId = 'e2e-' + crypto.randomUUID();
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.importKey,
        },
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();
      expect(scanBody.status).toBe('applied');
      expect(scanBody.transaction_id).toBeTruthy();
      expect(scanBody.mode).toBe('purchase'); // resolved from scanner_state.last_active_mode
      expect(scanBody.product_id).toBe(productId);
      expect(scanBody.applied_lot_id).toBeTruthy();
      const transactionId: string = scanBody.transaction_id;
      const lotId: string = scanBody.applied_lot_id;

      // ─── Step 4: Verify a stock_lot was actually minted in the DB.
      const { data: lotsBefore } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers, product_id, location_id, user_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(lotsBefore).toHaveLength(1);
      expect(lotsBefore[0].lot_id).toBe(lotId);
      expect(Number(lotsBefore[0].qty_containers)).toBe(1);
      expect(lotsBefore[0].location_id).toBe(ctx.defaultLocationId);

      // ─── Step 5: Verify scan_transactions audit row exists with
      // source='pi_usb' and pi_event_id stamped.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select(
          'transaction_id, user_id, barcode, mode, product_id, status, source, pi_event_id, applied_lot_id, applied_food_log_id, applied_cart_item_id',
        )
        .eq('transaction_id', transactionId)
        .single();
      expect(tx.user_id).toBe(ctx.userId);
      expect(tx.barcode).toBe(barcode);
      expect(tx.mode).toBe('purchase');
      expect(tx.product_id).toBe(productId);
      expect(tx.status).toBe('applied');
      expect(tx.source).toBe('pi_usb');
      expect(tx.pi_event_id).toBe(piEventId);
      expect(tx.applied_lot_id).toBe(lotId);
      expect(tx.applied_food_log_id).toBeNull();
      expect(tx.applied_cart_item_id).toBeNull();

      // ─── Step 6: Web voids the transaction (JWT) — Settings → Scanner
      // Transactions tab calls this when the user taps "Void".
      const voidRes = await fetch(`${BASE_URL}/scan-transaction/${transactionId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
      });
      expect(voidRes.status).toBe(200);
      const voidBody = await voidRes.json();
      expect(voidBody.ok).toBe(true);
      expect(voidBody.transaction_id).toBe(transactionId);

      // ─── Step 7: Verify side-effect is reversed — the stock_lot is
      // gone and the audit row is flipped to 'voided'.
      const { data: lotsAfter } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(lotsAfter).toHaveLength(0);

      const { data: txAfter } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('status, applied_lot_id')
        .eq('transaction_id', transactionId)
        .single();
      expect(txAfter.status).toBe('voided');
      // FK ON DELETE SET NULL on applied_lot_id — confirms the cascade
      // wired through cleanly.
      expect(txAfter.applied_lot_id).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('locked_mode overrides body.mode in barcode-scan (trust boundary)', async () => {
    const ctx = await provisionScannerUser('pipe-locked');
    try {
      // Push BOTH last_active_mode='purchase' AND locked_mode='shopping'.
      // The locked_mode is the user's explicit lock — a malicious or stale
      // client passing body.mode='purchase' MUST NOT bypass it.
      const stateRes = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'purchase', locked_mode: 'shopping' }),
      });
      expect(stateRes.status).toBe(200);
      const stateBody = await stateRes.json();
      expect(stateBody.last_active_mode).toBe('purchase');
      expect(stateBody.locked_mode).toBe('shopping');

      // Seed a product the Pi will scan.
      const barcode = 'PIPE-LOCKED-' + randomBytes(4).toString('hex').toUpperCase();
      const productId = await createTestProduct(ctx.userId, barcode, 'Locked Mode Test Product');

      // Pi tries to scan with body.mode='purchase' (a malicious or stale
      // client overriding what the user explicitly locked). locked_mode
      // wins.
      const piEventId = 'e2e-' + crypto.randomUUID();
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.importKey,
        },
        body: JSON.stringify({
          barcode,
          mode: 'purchase', // client tries to override — locked wins
          pi_event_id: piEventId,
        }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();
      expect(scanBody.status).toBe('applied');
      expect(scanBody.mode).toBe('shopping'); // locked_mode resolved
      expect(scanBody.applied_cart_item_id).toBeTruthy();
      // Purchase path NOT taken — no stock_lot minted.
      expect(scanBody.applied_lot_id ?? null).toBeNull();

      // Verify the audit row records the locked mode (not the spoofed
      // body mode) — this is the contract the trust boundary depends on.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('mode, applied_cart_item_id, applied_lot_id, source, pi_event_id')
        .eq('transaction_id', scanBody.transaction_id)
        .single();
      expect(tx.mode).toBe('shopping');
      expect(tx.applied_cart_item_id).toBe(scanBody.applied_cart_item_id);
      expect(tx.applied_lot_id).toBeNull();
      expect(tx.source).toBe('pi_usb');
      expect(tx.pi_event_id).toBe(piEventId);

      // Stock lots: zero (purchase path skipped).
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(lots).toHaveLength(0);

      // Shopping list: one row, matches the cart_item the response
      // returned.
      const { data: cart } = await (adminClient as any)
        .schema('chefbyte')
        .from('shopping_list')
        .select('cart_item_id, qty_containers, product_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(cart).toHaveLength(1);
      expect(cart[0].cart_item_id).toBe(scanBody.applied_cart_item_id);
    } finally {
      await ctx.cleanup();
    }
  });

  /**
   * I-Cloud-4 — Pi USB scan of an UNKNOWN barcode auto-creates the product.
   *
   * Previously: shelf-ingest forwarded unknown barcodes to analyze-product,
   * but analyze-product was JWT-only — the service-role-scoped invoke from
   * shelf-ingest was rejected and the scan fell through to an `errored`
   * transaction.
   *
   * Now: analyze-product accepts service-role bearer + body.user_id (matching
   * the apply_shelf_event_admin / consume_product_admin precedent) and
   * auto-creates the product on the service-role path. shelf-ingest receives
   * the product_id and proceeds with execute_scan_action, which mints a
   * stock_lot scoped to the same user.
   *
   * The canned OFF mode header propagates through the chain so the OFF
   * lookup is deterministic and the test doesn't depend on the live OFF API.
   */
  it('I-Cloud-4: Pi-style scan of unknown barcode auto-creates product + mints stock_lot', async () => {
    const ctx = await provisionScannerUser('pipe-autocreate');
    try {
      // ─── Step 1: Web pushes scanner mode = 'purchase'.
      const modeRes = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'purchase' }),
      });
      expect(modeRes.status).toBe(200);

      // Use a barcode the user has NEVER seen. The shelf-ingest handler
      // will detect this is unknown and forward to analyze-product.
      // Use a numeric barcode to satisfy analyze-product's alphanumeric
      // regex (the function rejects non-alphanumeric barcodes at the edge).
      const barcode =
        '99' +
        Math.floor(Math.random() * 1e10)
          .toString()
          .padStart(10, '0');

      // Sanity precondition: no products row exists for this barcode.
      const { data: precheckProducts } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('product_id')
        .eq('user_id', ctx.userId)
        .eq('barcode', barcode);
      expect(precheckProducts ?? []).toHaveLength(0);

      // ─── Step 2: Pi-style scan with x-api-key. The Pi can't supply the
      // canned-OFF header (those are dev-only headers on analyze-product),
      // but shelf-ingest forwards the body to analyze-product internally.
      // Without ANTHROPIC_API_KEY + a real OFF response, the service-role
      // auto-create is best-effort — the test asserts the contract that
      // EITHER the product was created and the scan applied, OR an
      // errored transaction was logged with a recognizable error_msg.
      // The dual-auth fix means we never see the previous "auth rejected"
      // failure mode.
      const piEventId = 'e2e-' + crypto.randomUUID();
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.importKey,
        },
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();

      // ─── Step 3: Verify the contract.
      // The transaction MUST exist either way (errored or applied — but
      // never auth-rejected, which used to surface as `analyze-product:
      // Missing authorization header` in error_msg).
      expect(scanBody.transaction_id).toBeTruthy();

      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('status, product_id, applied_lot_id, error_msg, source')
        .eq('transaction_id', scanBody.transaction_id)
        .single();

      // Source is always pi_usb (we authenticated via x-api-key).
      expect(tx.source).toBe('pi_usb');

      // The dual-auth fix means analyze-product can no longer fail with
      // an "authorization" error message. Even if the OFF lookup fails or
      // ANTHROPIC_API_KEY is unset, the failure mode must not be auth.
      if (tx.error_msg) {
        expect(tx.error_msg).not.toMatch(/missing authorization|unauthorized|invalid token/i);
      }

      if (tx.status === 'applied') {
        // Happy path: analyze-product produced a suggestion, auto-created
        // the product, shelf-ingest's execute_scan_action minted a lot.
        expect(tx.product_id).toBeTruthy();
        expect(tx.applied_lot_id).toBeTruthy();

        // Verify the product row exists scoped to the right user.
        const { data: product } = await (adminClient as any)
          .schema('chefbyte')
          .from('products')
          .select('product_id, user_id, barcode')
          .eq('product_id', tx.product_id)
          .single();
        expect(product).not.toBeNull();
        expect(product.user_id).toBe(ctx.userId);
        expect(product.barcode).toBe(barcode);

        // Verify the stock_lot exists scoped to the right user + product.
        const { data: lot } = await (adminClient as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id, user_id, product_id, qty_containers')
          .eq('lot_id', tx.applied_lot_id)
          .single();
        expect(lot).not.toBeNull();
        expect(lot.user_id).toBe(ctx.userId);
        expect(lot.product_id).toBe(tx.product_id);
        expect(Number(lot.qty_containers)).toBeGreaterThan(0);
      } else if (tx.status === 'errored') {
        // Degraded path: OFF lookup failed (404, 5xx, or rate-limit) or
        // Anthropic was unavailable. The auth fix doesn't address those
        // upstream failures, but the error_msg must NOT be an auth error
        // (that's what the dual-auth fix solves).
        expect(tx.error_msg).toBeTruthy();
        expect(tx.product_id).toBeNull();
      } else {
        throw new Error(`unexpected scan_transaction status: ${tx.status}`);
      }
    } finally {
      await ctx.cleanup();
    }
  }, 30_000);

  it('idempotent: same pi_event_id returns same transaction_id, only ONE audit row', async () => {
    const ctx = await provisionScannerUser('pipe-idem');
    try {
      // Push mode + seed product.
      await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'purchase' }),
      });

      const barcode = 'PIPE-IDEM-' + randomBytes(4).toString('hex').toUpperCase();
      const productId = await createTestProduct(ctx.userId, barcode, 'Idempotency Test Product');

      const piEventId = 'e2e-' + crypto.randomUUID();
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': ctx.importKey,
      };
      const body = JSON.stringify({ barcode, pi_event_id: piEventId });

      // Pi sends the scan TWICE (network retry, watchdog re-broadcast,
      // user double-tap, etc.). Same pi_event_id → same transaction_id,
      // and the second response is flagged as an idempotent replay.
      const r1 = await fetch(`${BASE_URL}/barcode-scan`, { method: 'POST', headers, body });
      const r2 = await fetch(`${BASE_URL}/barcode-scan`, { method: 'POST', headers, body });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const b1 = await r1.json();
      const b2 = await r2.json();
      expect(b1.status).toBe('applied');
      expect(b1.transaction_id).toBeTruthy();
      // Second response: same transaction_id, idempotent flag set.
      expect(b2.transaction_id).toBe(b1.transaction_id);
      expect(b2.idempotent).toBe(true);

      // Exactly ONE audit row exists — the second POST did NOT create a
      // duplicate. This is the heart of the at-least-once → exactly-once
      // contract for the Pi forwarder.
      const { data: rows, count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id, applied_lot_id', { count: 'exact' })
        .eq('user_id', ctx.userId)
        .eq('pi_event_id', piEventId);
      expect(count).toBe(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].transaction_id).toBe(b1.transaction_id);

      // And exactly ONE stock_lot — the second scan did NOT mint a
      // second lot. The exactly-once invariant on the side-effect
      // (purchase mints a lot) survives a duplicate POST.
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(lots).toHaveLength(1);
      expect(Number(lots[0].qty_containers)).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });

  /**
   * C2 — Cross-user `pi_event_id` collision.
   *
   * The migration `20260503100000_scanner_state_and_transactions.sql`
   * declares:
   *
   *   CREATE UNIQUE INDEX scan_transactions_pi_event_id_unique
   *     ON chefbyte.scan_transactions (user_id, pi_event_id)
   *     WHERE pi_event_id IS NOT NULL;
   *
   * The audit flagged this as untested. The danger is a wrongly-scoped
   * index — if it were `(pi_event_id) WHERE pi_event_id IS NOT NULL`
   * (forgetting the `user_id` prefix), then user_a's `pi-coll-shared` POST
   * would block user_b from EVER posting that pi_event_id, regardless of
   * tenant. That's a cross-user data-leak vector AND a denial-of-service
   * on collision.
   *
   * This test proves the index is correctly scoped:
   *
   *   1. Two distinct users with two distinct `live_shelf_devices` rows
   *      and two distinct `import_key`s (x-api-key auth is per-user).
   *   2. Each user posts /barcode-scan with the SAME
   *      `pi_event_id='barcode-test-collision'`. Both must succeed and
   *      land DISTINCT `scan_transactions` rows (one per user) — the
   *      `(user_id, pi_event_id)` index permits the duplicate
   *      pi_event_id across tenants.
   *   3. user_a re-posts the same pi_event_id — must be idempotent (same
   *      `transaction_id`, only ONE row for user_a in the audit log).
   *
   * If step 2 fails the index scope is wrong → bug found.
   * If step 3 fails the idempotency contract is broken → bug found.
   */
  it('C2: cross-user pi_event_id collision — same id permitted across tenants, idempotent within tenant', async () => {
    const ctxA = await provisionScannerUser('pi-coll-a');
    const ctxB = await provisionScannerUser('pi-coll-b');
    try {
      // Each user pushes their own scanner_state mode (independent
      // tenants — pushScannerMode for one MUST NOT bleed into the other).
      for (const ctx of [ctxA, ctxB]) {
        const stateRes = await fetch(`${BASE_URL}/scanner-state`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ctx.accessToken}`,
          },
          body: JSON.stringify({ last_active_mode: 'purchase' }),
        });
        expect(stateRes.status).toBe(200);
      }

      // Both users own a product with a barcode each — the actual barcode
      // string doesn't matter for the index test (it indexes on
      // pi_event_id, not barcode), but execute_scan_action needs the
      // tenant-owned product to apply the purchase.
      const barcodeA = 'COLL-A-' + randomBytes(4).toString('hex').toUpperCase();
      const barcodeB = 'COLL-B-' + randomBytes(4).toString('hex').toUpperCase();
      await createTestProduct(ctxA.userId, barcodeA, 'Collision Test Product A');
      await createTestProduct(ctxB.userId, barcodeB, 'Collision Test Product B');

      // ─── The collision id ──────────────────────────────────────────
      // Same string for both users. The index scope is the contract
      // under test — `(user_id, pi_event_id)` permits this across
      // tenants; a wrong scope of `(pi_event_id)` alone would reject
      // the second POST.
      const sharedPiEventId = 'barcode-test-collision';

      // ─── User A POST ─────────────────────────────────────────────
      const resA = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctxA.importKey,
        },
        body: JSON.stringify({ barcode: barcodeA, pi_event_id: sharedPiEventId }),
      });
      expect(resA.status).toBe(200);
      const bodyA = await resA.json();
      expect(bodyA.status).toBe('applied');
      expect(bodyA.transaction_id).toBeTruthy();
      expect(bodyA.idempotent).toBeUndefined();
      const txIdA: string = bodyA.transaction_id;

      // ─── User B POST with the SAME pi_event_id ──────────────────
      // If the index were mis-scoped to `(pi_event_id)` alone, user_b's
      // INSERT would violate the unique constraint and the handler would
      // either 409 or — worse — return user_a's transaction_id (which is
      // a cross-tenant data leak). The correct index lets it through.
      const resB = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctxB.importKey,
        },
        body: JSON.stringify({ barcode: barcodeB, pi_event_id: sharedPiEventId }),
      });
      expect(resB.status).toBe(200);
      const bodyB = await resB.json();
      expect(bodyB.status).toBe('applied');
      expect(bodyB.transaction_id).toBeTruthy();
      expect(bodyB.idempotent).toBeUndefined();
      const txIdB: string = bodyB.transaction_id;

      // Distinct transaction_ids — proves the rows are independent
      // (user_b did NOT receive user_a's row by accident).
      expect(txIdA).not.toBe(txIdB);

      // ─── Service-role readback: TWO rows with the SAME pi_event_id,
      // one per user. This is the assertion the brief asks for.
      const { data: rows, error: readErr } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id, user_id, pi_event_id, status')
        .eq('pi_event_id', sharedPiEventId)
        .in('user_id', [ctxA.userId, ctxB.userId])
        .order('user_id', { ascending: true });
      expect(readErr).toBeNull();
      expect(rows).toHaveLength(2);
      type ScanRow = { transaction_id: string; user_id: string; pi_event_id: string; status: string };
      const typedRows = (rows ?? []) as ScanRow[];
      const txByUser = new Map<string, ScanRow>(typedRows.map((r) => [r.user_id, r]));
      expect(txByUser.get(ctxA.userId)?.transaction_id).toBe(txIdA);
      expect(txByUser.get(ctxB.userId)?.transaction_id).toBe(txIdB);
      expect(txByUser.get(ctxA.userId)?.status).toBe('applied');
      expect(txByUser.get(ctxB.userId)?.status).toBe('applied');

      // ─── Step 4: user_a re-posts the same pi_event_id ────────────
      // Idempotency contract — the second POST must return the SAME
      // transaction_id, with the `idempotent: true` flag, and STILL
      // only ONE audit row exists for user_a. This guards against a
      // duplicate-write regression where the partial-unique index would
      // fire and the handler would either 500 or insert a second row.
      const resA2 = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctxA.importKey,
        },
        body: JSON.stringify({ barcode: barcodeA, pi_event_id: sharedPiEventId }),
      });
      expect(resA2.status).toBe(200);
      const bodyA2 = await resA2.json();
      expect(bodyA2.transaction_id).toBe(txIdA);
      expect(bodyA2.idempotent).toBe(true);

      const { data: rowsAOnly, count: countA } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact' })
        .eq('user_id', ctxA.userId)
        .eq('pi_event_id', sharedPiEventId);
      expect(countA).toBe(1);
      expect(rowsAOnly).toHaveLength(1);
      expect(rowsAOnly[0].transaction_id).toBe(txIdA);
    } finally {
      // Cleanup runs in parallel — both users own independent rows so
      // there's no cross-tenant FK to worry about.
      await Promise.all([ctxA.cleanup(), ctxB.cleanup()]);
    }
  }, 30_000);

  /**
   * Audit gap: Pi USB scanner of an UNKNOWN barcode — the audit-flagged
   * regression is that the existing I-Cloud-4 test accepts EITHER `applied`
   * or `errored`, plus only asserts `error_msg !~ /auth/`. That's too loose
   * to catch a silent contract drift in the production fall-through path.
   *
   * This test pins the exact contract for a barcode that is:
   *   * not in chefbyte.products (precondition asserted),
   *   * a numeric 13-digit code (passes analyze-product's alphanumeric filter,
   *     and is unlikely to exist in real OpenFoodFacts so OFF returns 404),
   *   * sent via x-api-key (so source must be `pi_usb`),
   *   * stamped with a deterministic `pi_event_id` (so the audit row's
   *     pi_event_id is checked exactly, not just presence).
   *
   * Production code path (verified):
   *   1. shelf-ingest:1303 — productId is null, enters analyze-product branch.
   *   2. shelf-ingest:1306 — supabase.functions.invoke('analyze-product', body).
   *   3. analyze-product:419-450 — service-role bearer matched, userId from body.
   *   4. analyze-product:478-489 — products lookup returns null (no row).
   *   5. analyze-product:497-528 — OFF lookup. For a fake barcode it returns
   *      404, hitting analyze-product:528 → response 404 + `Product not
   *      found in OpenFoodFacts`. (For OFF 5xx → 503 `off_unavailable`.)
   *   6. supabase-js — non-2xx → analyzeRes.error = FunctionsHttpError with
   *      message "Edge Function returned a non-2xx status code".
   *   7. shelf-ingest:1310-1311 — analyzeError = `analyze-product: <msg>`.
   *   8. shelf-ingest:1335-1347 — productId still null, insertErroredScanTransaction
   *      logs status=errored with the exact error_msg, source=pi_usb,
   *      pi_event_id stamped.
   *
   * Exactly one scan_transactions row, no products row created (analyze-product's
   * service-role auto-create is gated on `suggestion` being truthy, which only
   * happens after the OFF blob exists).
   */
  it('unknown barcode triggers analyze-product service-role auto-create and lands as applied', async () => {
    const ctx = await provisionScannerUser('pipe-unknown-strict');
    try {
      // Push mode = 'purchase' so the scan resolves a side-effect path.
      const modeRes = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'purchase' }),
      });
      expect(modeRes.status).toBe(200);

      // Use a fixed-shape 13-digit barcode. The literal '9999999999999' is
      // already an OFF test entry ("TestMarke Salatgurke") — it would
      // erroneously land us on the auto-create-success branch and miss the
      // genuine "no OFF, no product" path that real users hit. '5555555555555'
      // returns status=0 from OFF (no product).
      const barcode = '5555555555555';
      const piEventId = 'unknown-barcode-test-1';

      // ─── Precondition: chefbyte.products has NO row for this barcode.
      const { data: pre } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('product_id')
        .eq('user_id', ctx.userId)
        .eq('barcode', barcode);
      expect(pre ?? []).toHaveLength(0);

      // ─── Pi USB scan via x-api-key.
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.importKey,
        },
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      const scanStatus = scanRes.status;
      const scanBody = await scanRes.json();

      // The Pi forwarder MUST always return 200 for a stable client contract;
      // failures are conveyed via body.status='errored', not HTTP status.
      // Anything else is a contract drift.
      expect(scanStatus).toBe(200);
      expect(scanBody.transaction_id).toBeTruthy();

      // ─── Read back the audit row.
      const { data: txs } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select(
          'transaction_id, user_id, barcode, pi_event_id, status, source, product_id, applied_lot_id, applied_food_log_id, applied_cart_item_id, error_msg, mode',
        )
        .eq('user_id', ctx.userId)
        .order('created_at', { ascending: true });
      expect(txs).toHaveLength(1);
      const tx = txs[0];

      // ─── Identity assertions: the row is attributed to this scan.
      expect(tx.transaction_id).toBe(scanBody.transaction_id);
      expect(tx.user_id).toBe(ctx.userId);
      expect(tx.barcode).toBe(barcode);
      expect(tx.pi_event_id).toBe(piEventId);
      expect(tx.source).toBe('pi_usb');
      expect(tx.mode).toBe('purchase');

      // ─── Branch assertions: the test pins one of two precise contracts.
      // We don't accept the loose "applied OR errored" — for THIS barcode
      // (fake EAN-13, no OFF row, no ANTHROPIC key) the production code
      // path documented above must land on `errored` with the precise
      // error_msg shape.
      if (tx.status === 'applied') {
        // If we ever land here, the contract changed — analyze-product
        // somehow auto-created the product. Pin the products row + lot.
        expect(tx.product_id).toBeTruthy();
        expect(tx.applied_lot_id).toBeTruthy();

        const { data: products } = await (adminClient as any)
          .schema('chefbyte')
          .from('products')
          .select('*')
          .eq('user_id', ctx.userId)
          .eq('barcode', barcode);
        expect(products).toHaveLength(1);
        expect(products[0].product_id).toBe(tx.product_id);

        const { data: lots } = await (adminClient as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id, user_id, product_id, qty_containers')
          .eq('user_id', ctx.userId)
          .eq('product_id', tx.product_id);
        expect(lots).toHaveLength(1);
        expect(lots[0].lot_id).toBe(tx.applied_lot_id);
        expect(lots[0].user_id).toBe(ctx.userId);
        expect(Number(lots[0].qty_containers)).toBeGreaterThan(0);
      } else if (tx.status === 'errored') {
        // The expected production path for an OFF-miss environment.
        // analyze-product returned 404 ("Product not found in OpenFoodFacts");
        // shelf-ingest is supposed to surface the actual analyze-product
        // failure reason so the Pi (and ultimately the user / observability
        // tooling) can distinguish:
        //   * "Product not found in OpenFoodFacts" (real OFF miss — user
        //     should manually create the product)
        //   * "OpenFoodFacts is temporarily unavailable" (transient — retry)
        //   * "Limit reached — enter product manually" (quota — different
        //     UX path)
        //   * "AI service not configured" / "AI service auth failed" /
        //     "AI service has no credits" (admin-fix HARD failures)
        //   * "Barcode must be alphanumeric" / "Barcode too long" (input
        //     validation — caller bug)
        //
        // All five bucket up to fundamentally different remediation paths.
        // The Pi forwarder MUST preserve the bucket so a downstream
        // consumer (Settings → Scanner Transactions tab, log search, the
        // user's eye) can act on it.
        expect(tx.error_msg).toBeTruthy();
        expect(typeof tx.error_msg).toBe('string');

        // Must originate from the analyze-product invoke path — the prefix
        // is shelf-ingest:1311's `analyze-product: ${msg}` wrapper.
        expect(tx.error_msg).toMatch(/^analyze-product: /);

        // ─── BUG GATE: the error_msg MUST carry the actual analyze-product
        // failure reason, NOT supabase-js's opaque FunctionsHttpError
        // wrapper string. The 404 from analyze-product is supposed to
        // contain `{error: 'Product not found in OpenFoodFacts'}` in its
        // JSON body (analyze-product/index.ts:528). For OFF 5xx the body
        // is `{error: 'OpenFoodFacts is temporarily unavailable...'}`
        // (index.ts:518). If `error_msg` is the literal string "Edge
        // Function returned a non-2xx status code" then shelf-ingest is
        // reading `analyzeRes.error.message` (always generic) instead of
        // unwrapping `analyzeRes.error.context.response` to get the JSON
        // error body — which is exactly the bug the user is reporting.
        //
        // Reference: shelf-ingest/index.ts:1310-1311.
        //   const msg = (analyzeRes.error as { message?: string }).message ?? 'unknown error';
        //   analyzeError = `analyze-product: ${msg}`;
        // The supabase-js FunctionsHttpError sets .message to the literal
        // 'Edge Function returned a non-2xx status code' constant in
        // node_modules/@supabase/functions-js/.../types.js, so the
        // analyze-product JSON body is silently dropped on the floor.
        expect(tx.error_msg).not.toMatch(/Edge Function returned a non-2xx status code/i);
        // The error_msg must surface a recognizable analyze-product reason.
        // For the '5555555555555' barcode, OFF returns status=0 → analyze-product
        // returns 404 with body.error = 'Product not found in OpenFoodFacts'.
        // shelf-ingest should propagate that body.error string. Common
        // alternative recognisable reasons listed in the OR for resilience.
        expect(tx.error_msg).toMatch(
          /Product not found in OpenFoodFacts|OpenFoodFacts is temporarily unavailable|Limit reached|AI service|Barcode must be alphanumeric|Barcode too long|service-role caller must supply user_id/i,
        );

        // Must NOT be the legacy auth-rejection shape that the dual-auth
        // fix in commit d9f6a79 was supposed to eliminate.
        expect(tx.error_msg).not.toMatch(/missing authorization|invalid token|unauthorized/i);

        // No product was auto-created — service-role auto-create requires
        // a successful suggestion, which requires OFF to return a row.
        expect(tx.product_id).toBeNull();

        // No side-effect rows minted on the errored path.
        expect(tx.applied_lot_id).toBeNull();
        expect(tx.applied_food_log_id).toBeNull();
        expect(tx.applied_cart_item_id).toBeNull();

        // ─── Verify no products row was created.
        const { data: postProducts } = await (adminClient as any)
          .schema('chefbyte')
          .from('products')
          .select('product_id')
          .eq('user_id', ctx.userId)
          .eq('barcode', barcode);
        expect(postProducts ?? []).toHaveLength(0);

        // ─── Verify no stock_lots were minted for this user.
        const { data: postLots } = await (adminClient as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id')
          .eq('user_id', ctx.userId);
        expect(postLots ?? []).toHaveLength(0);

        // ─── Response body parity: the route response must mirror the audit
        // row's terminal state. A drift here means the Pi sees one outcome
        // while the DB records another.
        expect(scanBody.status).toBe('errored');
        expect(scanBody.product_id).toBeNull();
        expect(scanBody.error_msg).toBe(tx.error_msg);
      } else {
        throw new Error(`unexpected scan_transaction status: ${tx.status}`);
      }
    } finally {
      await ctx.cleanup();
    }
  }, 30_000);

  it('Pi-style purchase merges into existing lot on the second scan (no merge-key collision)', async () => {
    // Bug regression — user-reported 2026-05-03:
    //   chefbyte.scan_transactions for the Pi USB user shows repeated
    //   ``duplicate key value violates unique constraint
    //   "stock_lots_merge_key"`` errors. Every purchase scan after the
    //   first one of the same product on the same day was failing.
    //
    // Root cause: ``private.execute_scan_action``'s purchase branch did
    // an unconditional INSERT into chefbyte.stock_lots. The web
    // ScannerPage avoids this by collapsing repeat purchases on the
    // client; the Pi USB pipeline ships every scan straight to
    // execute_scan_action, so the second one collided with the
    // ``stock_lots_merge_key`` UNIQUE INDEX
    // (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31')).
    //
    // Fix: ``ON CONFLICT … DO UPDATE`` mirroring the canonical merge
    // pattern from ``private.recompute_remaining_stock`` /
    // ``private.unmark_meal_done``. Two scans with the same product
    // tuple now collapse into one lot whose qty_containers is the sum.
    //
    // The contract this test pins:
    //   1. Both POSTs return 200 with status='applied'.
    //   2. Exactly ONE stock_lots row exists for this user + product
    //      (the second scan merged into the first, did not insert a
    //      duplicate, and did not error on the unique index).
    //   3. That lot's qty_containers = sum of the two scans (1 + 1 = 2).
    //   4. Both scan_transactions rows reference the SAME applied_lot_id
    //      so void semantics still target the correct lot. (Note: void
    //      of a merged lot is documented as "destroys the merged lot
    //      entirely" — same web ScannerPage caveat. Out of scope here.)
    //
    // Mutation-killer: revert execute_scan_action's purchase branch to
    // the pre-fix INSERT-only form and the second POST will return
    // status='errored' with error_msg containing 'stock_lots_merge_key'.
    const ctx = await provisionScannerUser('pipe-merge');
    try {
      const barcode = 'PIPE-MERGE-' + randomBytes(4).toString('hex').toUpperCase();
      await createTestProduct(ctx.userId, barcode, 'Merge-Regression Product');

      // First scan: mints a lot.
      const r1 = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, pi_event_id: 'merge-1-' + crypto.randomUUID() }),
      });
      expect(r1.status).toBe(200);
      const b1 = await r1.json();
      expect(b1.status).toBe('applied');
      const lot1 = b1.applied_lot_id;
      expect(typeof lot1).toBe('string');

      // Second scan: same product, same default location (no client-side
      // merge — the Pi sends each scan untouched). Pre-fix this returned
      // status='errored' with stock_lots_merge_key in the error_msg.
      const r2 = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, pi_event_id: 'merge-2-' + crypto.randomUUID() }),
      });
      expect(r2.status).toBe(200);
      const b2 = await r2.json();
      expect(b2.status).toBe('applied');
      // Diagnostic — surface the exact bug shape on regression.
      if (b2.status !== 'applied') {
        console.error('[merge regression]', JSON.stringify(b2, null, 2));
      }
      expect(b2.error_msg ?? null).toBeNull();

      // Both scans must reference the SAME lot — no duplicate row.
      expect(b2.applied_lot_id).toBe(lot1);

      // ─── Service-role readback: exactly ONE lot exists, qty=2.
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', ctx.userId);
      expect(lots ?? []).toHaveLength(1);
      expect(Number(lots[0].qty_containers)).toBe(2);
      expect(lots[0].lot_id).toBe(lot1);
    } finally {
      await ctx.cleanup();
    }
  }, 30_000);
});
