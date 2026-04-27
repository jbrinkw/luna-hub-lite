import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * invariant-monitor — runs every 30 min; checks system invariants
 * against live data and writes any violations to hub.alerts.
 *
 * Invocation contract:
 *   * Caller MUST supply Authorization: Bearer <SERVICE_ROLE_KEY>.
 *     A pg_cron job or external scheduler hits the function URL with
 *     the service-role JWT in the header. JWT-callable mode (browser
 *     auth) is explicitly rejected — clients must NEVER trigger the
 *     monitor. Body may include `{ "invariants": ["qty_non_negative"] }`
 *     to run only a subset (used by tests + manual debugging).
 *
 * Idempotency: each violation is written via `private.upsert_alert`
 * which uses a `dedup_key = md5(invariant + subject_type + subject_id)`
 * partial-unique-on-unacked index. A persistent violation that survives
 * across cron ticks bumps `details.last_seen_at` + `seen_count` instead
 * of inserting a new row.
 *
 * Coverage scope: this monitor catches the invariants below + any
 * future invariants added to INVARIANTS. It is NOT a substitute for
 * unit / integration / harness testing — it backstops production data
 * corruption between scheduled checks.
 *
 * ─── Cross-layer reconcile (2026-04-27) ────────────────────────────
 * Invariant names + bug-class semantics are aligned with the Phase 3
 * runtime predicates in `tests/e2e/invariants.ts` (Audit B 2026-04-27).
 * Differences that remain are intentional context-of-execution choices
 * (per-user vs global scope, per-scenario time window vs production
 * sweep window). DO NOT rename a predicate without updating both
 * layers — the test suite asserts the names match.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ─── Invariant types ────────────────────────────────────────────────

type Severity = 'warning' | 'error' | 'critical';

interface ViolationRow {
  /** Stable string id for dedup — UUID, integer, or composite key. */
  subject_id: string | null;
  /** Optional user attribution; null = global (e.g. schema-level). */
  user_id: string | null;
  /** Free-form context per invariant. */
  details: Record<string, unknown>;
}

interface InvariantSpec {
  name: string;
  severity: Severity;
  subject_type: string;
  /**
   * Why we care. Kept terse so future devs grep for the predicate name
   * and immediately see the "what's being protected".
   */
  intent: string;
  /** Returns one row per violation. Empty array = healthy. */
  check: (supabase: SupabaseClient) => Promise<ViolationRow[]>;
}

// ─── Invariants ─────────────────────────────────────────────────────

const INVARIANTS: InvariantSpec[] = [
  {
    name: 'qty_non_negative',
    severity: 'critical',
    subject_type: 'stock_lot',
    intent:
      'CHECK (qty_containers >= 0) is enforced at the DB layer (migration 20260304010000). A violation here means the constraint was dropped, a SECURITY DEFINER bypassed it, or a race condition slipped a negative through. Either way: corruption.',
    check: async (sb) => {
      const { data, error } = await sb
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, user_id, qty_containers, product_id')
        .lt('qty_containers', 0)
        .is('deleted_at', null);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: r.lot_id,
        user_id: r.user_id,
        details: { qty_containers: r.qty_containers, product_id: r.product_id },
      }));
    },
  },
  {
    name: 'food_logs_per_day_match_consume_events',
    severity: 'warning',
    subject_type: 'food_log_day',
    intent:
      'For every (user, logical_date) the SUM(food_logs.calories) should be reproducible from the underlying consume events (4 * carbs + 4 * protein + 9 * fat) within ±10 kcal — drift > 10 kcal indicates either the macro-recompute trigger is broken or a manual log was inserted with bad math. Phase 4-only: per-day aggregate drift is invisible to per-scenario runs.',
    check: async (sb) => {
      // Aggregate via SQL through PostgREST: sum macros per user/day, compare
      // against sum(calories). Tolerance ±10 kcal absorbs rounding (numeric(10,3)).
      const { data, error } = await sb
        .schema('chefbyte')
        .from('food_logs')
        .select('user_id, logical_date, calories, carbs, protein, fat')
        // Ignore very old data — the monitor reports today + yesterday only
        // to avoid alerting on legacy bad data we're not going to fix.
        .gte('logical_date', new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10));
      if (error) throw error;

      type Bucket = { user_id: string; date: string; cal: number; carbs: number; prot: number; fat: number };
      const buckets = new Map<string, Bucket>();
      for (const row of data ?? []) {
        const key = `${row.user_id}|${row.logical_date}`;
        const b = buckets.get(key) ?? {
          user_id: row.user_id,
          date: row.logical_date,
          cal: 0,
          carbs: 0,
          prot: 0,
          fat: 0,
        };
        b.cal += Number(row.calories) || 0;
        b.carbs += Number(row.carbs) || 0;
        b.prot += Number(row.protein) || 0;
        b.fat += Number(row.fat) || 0;
        buckets.set(key, b);
      }

      const out: ViolationRow[] = [];
      for (const b of buckets.values()) {
        const inferred = 4 * b.carbs + 4 * b.prot + 9 * b.fat;
        const drift = Math.abs(b.cal - inferred);
        if (drift > 10) {
          out.push({
            subject_id: `${b.user_id}|${b.date}`,
            user_id: b.user_id,
            details: {
              date: b.date,
              actual_calories: b.cal,
              inferred_calories: inferred,
              drift_kcal: drift,
              carbs: b.carbs,
              protein: b.prot,
              fat: b.fat,
            },
          });
        }
      }
      return out;
    },
  },
  {
    name: 'stock_lots_in_flight_consistent',
    severity: 'error',
    subject_type: 'stock_lot',
    intent:
      'A lot with in_flight_since older than 24h (well past the 6h TTL reaper window) AND no matching pickup_event_id row in shelf_event_log is orphaned — the reaper should have either cleared the marker or removed the row. Same predicate intent as the Phase 3 runtime check; production cutoff is wider (24h vs 6h) because the reaper has up to 6h of slack to fire.',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, user_id, in_flight_since, pickup_event_id, qty_containers')
        .not('in_flight_since', 'is', null)
        .lt('in_flight_since', cutoff)
        .is('deleted_at', null);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: r.lot_id,
        user_id: r.user_id,
        details: {
          in_flight_since: r.in_flight_since,
          pickup_event_id: r.pickup_event_id,
          qty_containers: r.qty_containers,
          age_hours: r.in_flight_since ? (Date.now() - new Date(r.in_flight_since).getTime()) / 3_600_000 : null,
        },
      }));
    },
  },
  {
    name: 'pi_cloud_lot_id_match',
    severity: 'warning',
    subject_type: 'pi_cloud_pair',
    intent:
      'Pi-side check that every cloud stock_lots row touched in the last 7 days appears in the Pi cloud_lots mirror. NOT enforceable from cloud alone — flagged as warning so the operator runs the Pi-side checker manually. Phase 3 has a parameterized version that activates when a lot-tracking simulator is wired in. Same name across both layers (post-2026-04-27 reconcile) so admin UI + tests speak the same vocabulary.',
    check: async (_sb) => {
      // Deferred: Pi-side data is not visible to the cloud edge function.
      // Emit a single static warning advertising the gap so it shows up in
      // the admin UI on every monitor run (and bumps last_seen_at — we
      // EXPECT this one to persist until a Pi mirror table lands).
      return [
        {
          subject_id: 'pi_side_check_required',
          user_id: null,
          details: {
            note: 'Pi-side invariant: every cloud stock_lots row touched in last 7d should appear in Pi cloud_lots. Run hardware/live-shelf/server/cloud/lot_snapshot_check.py for verification.',
            deferred: true,
          },
        },
      ];
    },
  },
  {
    name: 'mcp_tool_log_user_id_present',
    severity: 'error',
    subject_type: 'mcp_tool_log',
    intent:
      'Every MCP tool call must be attributed to a user (the observability wrapper inserts user_id from the JWT/api-key). NULL means the wrapper bypassed the auth path or the column constraint is broken.',
    check: async (sb) => {
      // schema=hub but PostgREST exposes hub. user_id is NOT NULL at the
      // DB layer — this query is the canary that catches the constraint
      // being dropped or a service_role insert path losing the field.
      const { data, error } = await sb
        .schema('hub')
        .from('mcp_tool_logs')
        .select('id, user_id, tool_name')
        .is('user_id', null)
        .limit(50);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: String(r.id),
        user_id: null,
        details: { tool_name: r.tool_name },
      }));
    },
  },
  {
    name: 'food_logs_4_4_9_within_tolerance',
    severity: 'warning',
    subject_type: 'food_log',
    intent:
      'Per-row 4-4-9 invariant: |calories - (4c + 4p + 9f)| <= 10 kcal. Stricter than the daily aggregate — catches an individual log written with bad macros even if other logs in the same day cancel it out. Same predicate name + logic as Phase 3 (post-2026-04-27 reconcile); production sweeps the last 7 days, Phase 3 sweeps the per-scenario window.',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data, error } = await sb
        .schema('chefbyte')
        .from('food_logs')
        .select('log_id, user_id, calories, carbs, protein, fat, logical_date')
        .gte('created_at', cutoff)
        .limit(1000);
      if (error) throw error;
      const out: ViolationRow[] = [];
      for (const r of data ?? []) {
        const inferred = 4 * Number(r.carbs) + 4 * Number(r.protein) + 9 * Number(r.fat);
        const drift = Math.abs(Number(r.calories) - inferred);
        if (drift > 10) {
          out.push({
            subject_id: r.log_id,
            user_id: r.user_id,
            details: {
              logical_date: r.logical_date,
              calories: Number(r.calories),
              inferred_calories: inferred,
              drift_kcal: drift,
              carbs: Number(r.carbs),
              protein: Number(r.protein),
              fat: Number(r.fat),
            },
          });
        }
      }
      return out;
    },
  },
  {
    name: 'shelf_event_log_no_orphan_lots',
    severity: 'error',
    subject_type: 'shelf_event_log',
    intent:
      'Every shelf_event_log.resolved_lot_id should reference an existing chefbyte.stock_lots.lot_id (or be NULL). A non-NULL lot_id with no matching row means the lot was deleted while events still reference it — the FK is intentionally absent (the events table is append-only history, not a foreign key target) so this invariant is the only line of defense.',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data, error } = await sb
        .schema('chefbyte')
        .from('shelf_event_log')
        .select('event_id, user_id, resolved_lot_id, created_at')
        .not('resolved_lot_id', 'is', null)
        .gte('created_at', cutoff)
        .limit(2000);
      if (error) throw error;
      const events = data ?? [];
      if (events.length === 0) return [];

      // Resolve which lot_ids are missing in stock_lots. Batch-by-IN to
      // keep the query under PostgREST's URL-length cap.
      const seen = new Set<string>();
      const lotIds = events.map((e: any) => e.resolved_lot_id).filter(Boolean);
      // Distinct ids only.
      const distinctLotIds = Array.from(new Set(lotIds));
      const found = new Set<string>();
      const CHUNK = 100;
      for (let i = 0; i < distinctLotIds.length; i += CHUNK) {
        const slice = distinctLotIds.slice(i, i + CHUNK);
        const { data: lots, error: lotErr } = await sb
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id')
          .in('lot_id', slice);
        if (lotErr) throw lotErr;
        for (const l of lots ?? []) found.add((l as any).lot_id);
      }

      const out: ViolationRow[] = [];
      for (const e of events) {
        if (e.resolved_lot_id && !found.has(e.resolved_lot_id) && !seen.has(e.event_id)) {
          seen.add(e.event_id);
          out.push({
            subject_id: e.event_id,
            user_id: e.user_id,
            details: {
              missing_lot_id: e.resolved_lot_id,
              created_at: e.created_at,
            },
          });
        }
      }
      return out;
    },
  },
  {
    name: 'livetrack_session_no_zombie_active',
    severity: 'warning',
    subject_type: 'livetrack_session',
    intent:
      'A LiveTrack import wizard session is live (state NOT IN closed/expired) AND > 1 hour old most likely means the browser tab was closed without finishing the wizard. The expires_at default (10 min) should have flipped it expired — if not, the expiry sweeper is broken. Same predicate name as Phase 3 runtime (post-2026-04-27 reconcile); production tolerates a longer 1h window because real wizard sessions can legitimately stretch to 30+ minutes.',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('session_id, user_id, state, created_at, expires_at, device_id')
        .not('state', 'in', '("closed","expired")')
        .lt('created_at', cutoff);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: r.session_id,
        user_id: r.user_id,
        details: {
          state: r.state,
          created_at: r.created_at,
          expires_at: r.expires_at,
          device_id: r.device_id,
        },
      }));
    },
  },
  {
    name: 'coachbyte_timer_running_has_end_time',
    severity: 'error',
    subject_type: 'coachbyte_timer',
    intent:
      'A rest timer in state=running with end_time IS NULL is a partial-write — the state machine left the row in an internally inconsistent state. CHECK constraint at the DB layer would prevent this; the invariant is the canary if the constraint is dropped or a SECURITY DEFINER bypasses it. Mirrors the Phase 3 runtime predicate (post-2026-04-27 split — was previously combined under the ambiguous coachbyte_timer_consistent name).',
    check: async (sb) => {
      const { data, error } = await sb
        .schema('coachbyte')
        .from('timers')
        .select('timer_id, user_id, state, end_time')
        .eq('state', 'running')
        .is('end_time', null);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: r.timer_id,
        user_id: r.user_id,
        details: { state: r.state, end_time: r.end_time },
      }));
    },
  },
  {
    name: 'coachbyte_timer_running_not_stale',
    severity: 'warning',
    subject_type: 'coachbyte_timer',
    intent:
      'A rest timer in state=running with end_time > 4h ago is a forgotten timer (the user closed the app mid-rest). Not corruption, but worth surfacing so the admin can clean it up — and a sustained backlog might indicate the auto-expire logic is broken. Mirrors the Phase 3 runtime predicate.',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .schema('coachbyte')
        .from('timers')
        .select('timer_id, user_id, state, end_time')
        .eq('state', 'running')
        .not('end_time', 'is', null)
        .lt('end_time', cutoff);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        subject_id: r.timer_id,
        user_id: r.user_id,
        details: { state: r.state, end_time: r.end_time },
      }));
    },
  },
  {
    name: 'product_macro_drift_4_4_9',
    severity: 'warning',
    subject_type: 'product',
    intent:
      'Products updated in the last 30 days where stored calories diverge from 4 * carbs + 4 * protein + 9 * fat by >5%. Catches a paste-error in the chef UI or an AI normalize step that wrote inconsistent macros — defends against silent macro corruption that would later be amplified through food_logs. Same name + logic as Phase 3 runtime (post-2026-04-27 reconcile).',
    check: async (sb) => {
      const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { data, error } = await sb
        .schema('chefbyte')
        .from('products')
        .select(
          'product_id, user_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, updated_at',
        )
        .gte('updated_at', cutoff)
        .limit(2000);
      if (error) throw error;
      const out: ViolationRow[] = [];
      for (const r of data ?? []) {
        const cal = Number(r.calories_per_serving);
        const carbs = Number(r.carbs_per_serving);
        const prot = Number(r.protein_per_serving);
        const fat = Number(r.fat_per_serving);
        if (!Number.isFinite(cal) || cal === 0) continue; // rows with no calories are placeholders
        const inferred = 4 * carbs + 4 * prot + 9 * fat;
        if (inferred === 0) continue; // also placeholder
        const driftPct = Math.abs(cal - inferred) / Math.max(cal, inferred);
        if (driftPct > 0.05) {
          out.push({
            subject_id: r.product_id,
            user_id: r.user_id,
            details: {
              name: r.name,
              calories_per_serving: cal,
              inferred_calories: inferred,
              drift_pct: Number(driftPct.toFixed(4)),
              carbs_per_serving: carbs,
              protein_per_serving: prot,
              fat_per_serving: fat,
              updated_at: r.updated_at,
            },
          });
        }
      }
      return out;
    },
  },
];

// ─── Auth — service_role only ───────────────────────────────────────

/**
 * Verify the inbound request carries the service-role JWT in the
 * Authorization header. Anything else is rejected. The function is
 * configured `verify_jwt = false` because Supabase's relay would treat
 * a service-role bearer as anonymous; we do the comparison ourselves.
 */
function isServiceRoleAuthorized(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match) return false;
  const token = match[1].trim();
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  // Constant-ish-time string compare. Length first (cheap), then byte
  // equality. Token leak via timing isn't a realistic threat on edge
  // runtime but it costs nothing to keep the comparison clean.
  if (expected.length === 0 || token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i += 1) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Runner ─────────────────────────────────────────────────────────

interface InvariantResult {
  name: string;
  ok: boolean;
  violation_count: number;
  upserted: number;
  error?: string;
}

async function runMonitor(supabase: SupabaseClient, filter: Set<string> | null): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const inv of INVARIANTS) {
    if (filter && !filter.has(inv.name)) continue;
    try {
      const violations = await inv.check(supabase);
      let upserted = 0;
      for (const v of violations) {
        const { error: upErr } = await (supabase as any).schema('private').rpc('upsert_alert', {
          p_invariant_name: inv.name,
          p_severity: inv.severity,
          p_subject_type: inv.subject_type,
          p_subject_id: v.subject_id,
          p_user_id: v.user_id,
          p_details: v.details,
        });
        if (upErr) {
          // Don't abort the whole run on a single insert failure — log
          // + carry on. The next tick will retry naturally.
          console.error('invariant-monitor: upsert_alert failed', {
            invariant: inv.name,
            subject_id: v.subject_id,
            error: upErr.message,
          });
          continue;
        }
        upserted += 1;
      }
      results.push({
        name: inv.name,
        ok: true,
        violation_count: violations.length,
        upserted,
      });
    } catch (err: any) {
      console.error('invariant-monitor: check failed', {
        invariant: inv.name,
        error: err?.message ?? String(err),
      });
      results.push({
        name: inv.name,
        ok: false,
        violation_count: 0,
        upserted: 0,
        error: err?.message ?? String(err),
      });
    }
  }
  return results;
}

// ─── Entrypoint ─────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  if (!isServiceRoleAuthorized(req)) {
    return jsonResponse({ error: 'service_role required' }, 401);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const filter =
    Array.isArray(body?.invariants) && body.invariants.length > 0 ? new Set<string>(body.invariants.map(String)) : null;

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const startedAt = new Date().toISOString();
    const results = await runMonitor(supabase, filter);
    const finishedAt = new Date().toISOString();
    return jsonResponse({
      ok: results.every((r) => r.ok),
      started_at: startedAt,
      finished_at: finishedAt,
      results,
    });
  } catch (err: any) {
    console.error('invariant-monitor: top-level failure', err);
    return jsonResponse({ error: 'monitor failed', message: err?.message ?? String(err) }, 500);
  }
});
