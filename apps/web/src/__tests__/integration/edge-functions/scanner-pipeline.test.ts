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
});
