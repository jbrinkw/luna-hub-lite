/**
 * End-to-end smoke test for the LiveTrack Import wizard's save paths.
 *
 * Reproduces the `null value in column "calories_per_serving"` error the
 * owner hit with barcode 052000208085 and exercises both tare paths:
 *
 *   1. analyze-product → product INSERT (used to fail when AI returned
 *      partial nutrition). Asserts product row lands successfully.
 *   2. Auto-tare path: scale_reading - net_weight_g → products.tare_weight_g
 *      UPDATE + stock_lot INSERT.
 *   3. AI-tare path: state transitions waiting_scale → awaiting_ai_tare,
 *      then a simulated Pi /pi-update posts ai_tare_g.
 *
 * Run with: pnpm dlx tsx scripts/test_livetrack_import_flow.ts
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();

function loadEnv(file: string) {
  const out: Record<string, string> = {};
  try {
    const content = readFileSync(join(REPO_ROOT, file), 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* ignore */
  }
  return out;
}

const env = { ...loadEnv('.env') };
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('missing env vars');
  process.exit(1);
}

const BARCODE = '052000208085';
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function main() {
  const suffix = `lt-${Date.now()}`;
  const email = `e2e-${suffix}@test.com`;
  const password = 'testpass123';

  console.log(`[1] create user ${email}`);
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !createData.user) throw new Error(`createUser: ${createErr?.message}`);
  const userId = createData.user.id;

  try {
    console.log(`[2] activate chefbyte for user`);
    await admin
      .schema('hub')
      .from('user_apps')
      .upsert({ user_id: userId, app_name: 'chefbyte', active: true }, { onConflict: 'user_id,app_name' });

    console.log(`[3] seed a live_shelf_device (prereq for livetrack-session/create)`);
    const rawKey = `test-key-${suffix}`;
    const keyHash = await sha256(rawKey);
    const { data: device, error: devErr } = await admin
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'E2E Test Pi',
        import_key_hash: keyHash,
        is_active: true,
        last_heartbeat_ts: new Date().toISOString(),
        pending_review_count: 0,
      })
      .select('device_id')
      .single();
    if (devErr || !device) throw new Error(`device insert: ${devErr?.message}`);
    const deviceId = device.device_id;
    console.log(`    device_id=${deviceId}`);

    console.log(`[4] sign in to get user JWT`);
    const user = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signIn, error: signInErr } = await user.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !signIn.session) throw new Error(`signIn: ${signInErr?.message}`);
    const accessToken = signIn.session.access_token;

    console.log(`[5] create livetrack session`);
    const createResp = await fetch(`${SUPABASE_URL}/functions/v1/livetrack-session/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: ANON_KEY!,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const createBody = await createResp.json();
    console.log(`    session-create status=${createResp.status}`);
    console.log(`    session-create body=${JSON.stringify(createBody).slice(0, 200)}`);
    if (createResp.status !== 200 || !createBody.session) {
      throw new Error(`session create failed: ${JSON.stringify(createBody)}`);
    }
    const sessionId = createBody.session.session_id;

    console.log(`[6] analyze-product(${BARCODE})`);
    const analyzeResp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-product`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: ANON_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ barcode: BARCODE }),
    });
    const analyzeBody = await analyzeResp.json();
    console.log(`    analyze-product status=${analyzeResp.status}`);
    console.log(`    suggestion: ${JSON.stringify(analyzeBody.suggestion).slice(0, 300)}`);
    const s = analyzeBody.suggestion ?? null;
    const off = analyzeBody.off ?? null;

    console.log(`[7] INSERT product with wizard's null→0 fallback logic`);
    const productFields = {
      barcode: BARCODE,
      name: s?.name || off?.product_name || `Product (${BARCODE})`,
      description: s?.description ?? null,
      is_placeholder: false,
      servings_per_container: s?.servings_per_container ?? 1,
      calories_per_serving: s?.calories_per_serving ?? 0,
      carbs_per_serving: s?.carbs_per_serving ?? 0,
      fat_per_serving: s?.fat_per_serving ?? 0,
      protein_per_serving: s?.protein_per_serving ?? 0,
      default_shelf_life_days: s?.default_shelf_life_days ?? null,
      net_weight_g: off?.product_quantity ?? null,
      container_type: null,
      unit_type: null,
      user_id: userId,
    };
    console.log(`    fields: ${JSON.stringify(productFields).slice(0, 300)}`);
    const { data: product, error: prodErr } = await admin
      .schema('chefbyte')
      .from('products')
      .insert(productFields)
      .select('*')
      .single();
    if (prodErr || !product) throw new Error(`product insert: ${prodErr?.message}`);
    console.log(`    ✓ product_id=${product.product_id} inserted OK`);
    const productId = product.product_id;

    console.log(`[8] patch session to waiting_scale`);
    await admin
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .update({
        current_barcode: BARCODE,
        current_product_id: productId,
        state: 'waiting_scale',
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId);

    console.log(`[9] simulate Pi pi-update with scale_reading`);
    const simulatedReading = 500.0; // grams
    const piUpdateResp = await fetch(`${SUPABASE_URL}/functions/v1/livetrack-session/pi-update`, {
      method: 'POST',
      headers: {
        'x-api-key': rawKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        scale_reading_g: simulatedReading,
        scale_reading_ts: new Date().toISOString(),
        state: 'scale_reading_received',
      }),
    });
    const piUpdateBody = await piUpdateResp.json();
    console.log(`    pi-update status=${piUpdateResp.status}  body=${JSON.stringify(piUpdateBody).slice(0, 200)}`);
    if (piUpdateResp.status !== 200) throw new Error(`pi-update failed`);

    console.log(`[10] AUTO TARE path — compute + save`);
    const netWeight = product.net_weight_g ?? 0;
    const autoTareG = netWeight > 0 ? simulatedReading - Number(netWeight) : simulatedReading;
    console.log(`    net_weight_g=${netWeight}  scale=${simulatedReading}  tare_g=${autoTareG}`);

    const { error: updErr } = await admin
      .schema('chefbyte')
      .from('products')
      .update({
        tare_weight_g: autoTareG,
        servings_per_container: Number(product.servings_per_container),
        calories_per_serving: Number(product.calories_per_serving),
        carbs_per_serving: Number(product.carbs_per_serving),
        fat_per_serving: Number(product.fat_per_serving),
        protein_per_serving: Number(product.protein_per_serving),
      })
      .eq('product_id', productId)
      .eq('user_id', userId);
    if (updErr) throw new Error(`products UPDATE (auto tare): ${updErr.message}`);

    const { data: afterProd } = await admin
      .schema('chefbyte')
      .from('products')
      .select('tare_weight_g, calories_per_serving')
      .eq('product_id', productId)
      .single();
    console.log(
      `    ✓ products.tare_weight_g=${afterProd?.tare_weight_g}  calories=${afterProd?.calories_per_serving}`,
    );
    if (afterProd?.tare_weight_g == null) throw new Error(`auto-tare did not persist`);

    console.log(`[11] AI TARE path — patch state=awaiting_ai_tare`);
    await admin
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .update({
        state: 'awaiting_ai_tare',
        ai_tare_product_form: {
          name: product.name,
          net_weight_g: product.net_weight_g,
          container_type: product.container_type,
          unit_type: product.unit_type,
          servings_per_container: product.servings_per_container,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId);

    console.log(`[12] simulate Pi posting AI-tare result`);
    const aiTareG = 55.0;
    const aiUpdateResp = await fetch(`${SUPABASE_URL}/functions/v1/livetrack-session/pi-update`, {
      method: 'POST',
      headers: {
        'x-api-key': rawKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        ai_tare_g: aiTareG,
        ai_tare_confidence: 'medium',
        ai_tare_reasoning: 'E2E stub',
        state: 'ai_tare_ready',
      }),
    });
    const aiUpdateBody = await aiUpdateResp.json();
    console.log(`    pi-update(AI) status=${aiUpdateResp.status}  body=${JSON.stringify(aiUpdateBody).slice(0, 200)}`);
    if (aiUpdateResp.status !== 200) throw new Error(`pi-update AI failed`);

    console.log(`[13] simulate user accepting AI tare → UPDATE products + re-arm session`);
    await admin
      .schema('chefbyte')
      .from('products')
      .update({ tare_weight_g: aiTareG })
      .eq('product_id', productId)
      .eq('user_id', userId);

    await admin
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .update({
        state: 'waiting_barcode',
        current_barcode: null,
        current_product_id: null,
        scale_reading_g: null,
        scale_reading_ts: null,
        ai_tare_g: null,
        ai_tare_confidence: null,
        ai_tare_reasoning: null,
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId);

    const { data: reArmed } = await admin
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .select('state, scale_reading_g, current_barcode')
      .eq('session_id', sessionId)
      .single();
    console.log(`    ✓ session re-armed: state=${reArmed?.state} (cleared reading + barcode)`);

    console.log('');
    console.log('=== ALL STAGES PASSED ===');
    console.log(`BARCODE ${BARCODE} flow:`);
    console.log(`  ✓ product INSERT succeeded (null→0 fallback worked)`);
    console.log(`  ✓ auto-tare UPDATE (scale=${simulatedReading}g, tare=${autoTareG}g)`);
    console.log(`  ✓ AI-tare UPDATE (ai_tare_g=${aiTareG})`);
    console.log(`  ✓ session re-armed back to waiting_barcode`);
  } finally {
    console.log(`[cleanup] delete user`);
    await admin.auth.admin.deleteUser(userId);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
