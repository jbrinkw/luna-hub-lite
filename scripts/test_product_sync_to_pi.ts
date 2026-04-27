/**
 * End-to-end test: cloud product INSERT → Pi local catalog visibility.
 *
 * Validates the 30s product-sync poller by:
 *   1. Inserting a fresh product into ``chefbyte.products`` via the
 *      service-role client (bypassing any UI — mirrors what the wizard
 *      writes on save).
 *   2. Polling the Pi's local SQLite via ssh + sqlite3 until the product
 *      shows up, or a hard timeout fires.
 *   3. Recording the elapsed seconds from insert → Pi visibility.
 *   4. Cleaning up the cloud row so repeat runs don't accumulate test
 *      junk.
 *
 * Assumes:
 *   * ``.env`` at the repo root has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *   * The Pi at ``fridgecam`` (or whatever ``PI_HOST`` is set to) is
 *     reachable + has the poller running.
 *   * ``PI_USER_ID`` env var OR the first active ``live_shelf_devices`` row
 *     identifies which cloud user owns the Pi we're testing against.
 *
 * Run with:
 *   pnpm dlx tsx scripts/test_product_sync_to_pi.ts
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const PI_HOST = process.env.PI_HOST || 'fridgecam';
const PI_USER = process.env.PI_USER || 'jeremy';
const PI_DB_PATH = process.env.PI_DB_PATH || '/home/jeremy/live-shelf/data/shelf.sqlite3';

// Hard ceiling — the poller runs every 30s, so 45s covers one missed
// tick plus a little slack. Bigger numbers would just delay failure.
const VISIBILITY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 2_000;

function loadEnv(file: string): Record<string, string> {
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

const env = { ...loadEnv('.env'), ...process.env };
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('ERR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Resolve which cloud user the Pi is currently authenticated as. */
async function resolvePiUserId(): Promise<string> {
  if (env.PI_USER_ID) return env.PI_USER_ID;
  const { data, error } = await admin
    .schema('chefbyte')
    .from('live_shelf_devices')
    .select('user_id')
    .eq('is_active', true)
    .order('last_heartbeat_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`live_shelf_devices lookup: ${error.message}`);
  if (!data?.user_id) {
    throw new Error('no active live_shelf_devices row — set PI_USER_ID env var');
  }
  return data.user_id;
}

/** Return stdout of a sqlite3 query executed on the Pi via ssh.
 *
 * Auth matches the live-shelf-deploy skill: an SSH_ASKPASS helper script
 * supplies the Pi password on stdin. Assumes the same /tmp/askpass.sh
 * exists (created by the skill on first run) or is created here inline.
 */
const ASKPASS_PATH = '/tmp/askpass.sh';
function ensureAskpass(): void {
  try {
    execSync(`test -x ${ASKPASS_PATH}`, { stdio: 'ignore' });
    return;
  } catch {
    /* needs creation */
  }
  const pw = process.env.PI_PASS || 'jeremy';
  execSync(
    `bash -c 'cat > ${ASKPASS_PATH} <<EOF
#!/bin/bash
echo ${pw}
EOF
chmod +x ${ASKPASS_PATH}'`,
  );
}

function piQuery(sql: string): string {
  ensureAskpass();
  // ``setsid -w`` detaches the tty so the SSH_ASKPASS helper is actually
  // consulted. StrictHostKeyChecking=accept-new keeps CI/bootstrap runs
  // from hanging on an unknown host prompt.
  //
  // The Pi's non-interactive shell doesn't have sqlite3 on PATH, but
  // python3 is universally available — use stdlib sqlite3 via a small
  // base64-encoded inline script. Base64 round-tripping avoids the
  // double-quote / newline escaping headaches that tripped up earlier
  // iterations.
  const pyScript = [
    'import sqlite3,sys,base64',
    'q=base64.b64decode(sys.argv[2]).decode()',
    'c=sqlite3.connect(sys.argv[1]).execute(q)',
    "for r in c: print(' '.join(str(x) for x in r))",
  ].join('\n');
  const b64Script = Buffer.from(pyScript, 'utf8').toString('base64');
  const b64Sql = Buffer.from(sql, 'utf8').toString('base64');
  const cmd = `SSH_ASKPASS=${ASKPASS_PATH} SSH_ASKPASS_REQUIRE=force DISPLAY=dummy setsid -w ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${PI_USER}@${PI_HOST} 'echo ${b64Script} | base64 -d | python3 - ${PI_DB_PATH} ${b64Sql}'`;
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  console.log('[1] resolve Pi user_id');
  const userId = await resolvePiUserId();
  console.log(`    user_id=${userId}`);

  const marker = `sync-test-${Date.now()}`;
  const productId = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0')}`;
  console.log(`[2] insert product ${marker} (id=${productId})`);
  const insertStartMs = Date.now();
  const { error: insErr } = await admin.schema('chefbyte').from('products').insert({
    product_id: productId,
    user_id: userId,
    name: marker,
    unit_type: 'solid',
    certified: true,
  });
  if (insErr) throw new Error(`insert: ${insErr.message}`);

  try {
    console.log('[3] poll Pi SQLite for the row');
    const deadline = insertStartMs + VISIBILITY_TIMEOUT_MS;
    let piHitMs = 0;
    while (Date.now() < deadline) {
      const stdout = piQuery(`SELECT product_id FROM products WHERE product_id='${productId}'`);
      if (stdout.trim() === productId) {
        piHitMs = Date.now();
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (piHitMs === 0) {
      throw new Error(`Pi did not see product within ${VISIBILITY_TIMEOUT_MS / 1000}s`);
    }
    const elapsedS = ((piHitMs - insertStartMs) / 1000).toFixed(1);
    console.log(`[4] PASS — product visible on Pi in ${elapsedS}s`);
  } finally {
    console.log('[5] cleanup — delete cloud product');
    const { error: delErr } = await admin.schema('chefbyte').from('products').delete().eq('product_id', productId);
    if (delErr) console.warn(`cleanup warning: ${delErr.message}`);
    // Best-effort local cleanup — the next poll tick won't delete it
    // automatically (the sync is additive-only), so we tidy by hand.
    try {
      piQuery(`DELETE FROM products WHERE product_id='${productId}'`);
    } catch {
      /* cleanup best-effort */
    }
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
