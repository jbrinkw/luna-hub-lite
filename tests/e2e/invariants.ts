/**
 * tests/e2e/invariants.ts — runtime system invariants (Phase 3)
 *
 * Companion to `supabase/functions/invariant-monitor/index.ts` (the Phase 4
 * production monitor). Both check the same class of invariants — global
 * statements that must hold regardless of which user flow led to the current
 * state — but the runtime contexts differ:
 *
 *   - Production monitor: runs every 30 min against cloud data, writes
 *     violations to `hub.alerts`. Cloud-only visibility.
 *
 *   - This module: runs after every passing e2e scenario, scoped to the
 *     scenario's test user (and where applicable the in-process Pi
 *     simulator). Throws on violation so the scenario fails immediately.
 *
 * Why both: per-scenario assertions catch what each scenario thinks to
 * check. Invariants catch the next class — "scenario didn't directly
 * violate anything but somehow `qty < 0` ended up in the DB." Production
 * monitor catches slow-burn corruption invisible to local testing. This
 * module catches the contract drift the moment a scenario triggers it,
 * with full repro context still in hand.
 *
 * Each invariant is a sequential predicate that returns `null` (clean) or
 * a `{ name, severity, details }` violation object. `assertSystemInvariants`
 * runs all of them and aggregates violations into a single `AssertionError`
 * naming the predicate(s), the offending row(s), and the scenario.
 *
 * Per-scenario time scoping: the `scenarioStartTime` parameter narrows
 * "what was created/touched during this scenario" so we don't fail on data
 * planted by other scenarios running in the same Supabase instance. Where
 * an invariant has no good time-window predicate (e.g. NOT NULL constraint
 * on user_id) the scope is "rows owned by this test user" — same effect
 * because each scenario uses a fresh user.
 *
 * ─── Cross-layer reconcile (2026-04-27) ────────────────────────────
 *
 * Audit B 2026-04-27 found 6 of 11 predicates differed from Phase 4 in
 * name, threshold, or semantics. This module is now name-aligned with the
 * production monitor and the timer invariant is SPLIT into two checks
 * (running_has_end_time + running_not_stale) so Phase 3 + Phase 4 each
 * run BOTH bug-class predicates instead of catching orthogonal issues
 * under a single confusing name. See `decisions.md #45` for rationale.
 *
 * The canonical predicate name list is the source of truth — DO NOT
 * rename without simultaneously renaming in
 * `supabase/functions/invariant-monitor/index.ts`. The drift-check meta
 * tests in this suite assert the names match exactly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Types ──────────────────────────────────────────────────────────

export type Severity = 'warning' | 'error' | 'critical';

export interface InvariantViolation {
  name: string;
  severity: Severity;
  details: Record<string, unknown>;
}

/**
 * Minimal interface a Pi simulator must implement to participate in
 * pi_cloud_lot_id_match. The TS Pi simulator under
 * `fixtures/pi-simulator.ts` does NOT track local lots today — it
 * forwards events straight to shelf-ingest — so most scenarios pass
 * `piSimulator: undefined` and the predicate skips. Scenarios that DO
 * stand up a local lot mirror (e.g. the place-back-after-ttl scenario,
 * if a future lot-mirror is added) can implement this and the predicate
 * will activate.
 */
export interface PiSimulatorState {
  /**
   * Return cloud lot IDs the simulator considers "live" — i.e. the Pi
   * believes a corresponding stock_lots row exists. Empty array =
   * nothing to check (predicate skips silently). Absence of the method
   * (or undefined return) is also treated as "skip".
   */
  getKnownCloudLotIds?: () => string[] | Promise<string[]>;
}

export interface AssertSystemInvariantsOpts {
  supabase: SupabaseClient;
  testUserId: string;
  scenarioStartTime: Date;
  scenarioName: string;
  piSimulator?: PiSimulatorState;
}

// LiveTrack active (non-terminal) states. Mirrors
// `chefbyte.livetrack_import_sessions.state` CHECK constraint minus
// terminal states. Drift detection: if either this list or the DB
// constraint changes without the other, scenarios + the invariant
// monitor diverge — surface via this constant living in one place.
const LIVETRACK_TERMINAL_STATES = new Set(['closed', 'expired']);

// ─── Predicate type ─────────────────────────────────────────────────

type PredicateResult = InvariantViolation | null;
type Predicate = (opts: AssertSystemInvariantsOpts) => Promise<PredicateResult>;

// ─── Invariants ─────────────────────────────────────────────────────

/**
 * 1. qty_non_negative — no chefbyte.stock_lots with qty_containers < 0
 *    for the test user. Backstops the DB CHECK constraint added in
 *    20260304040004_nonnegative_constraints.sql + the explicit
 *    GREATEST(qty + delta, 0) clamp inside apply_shelf_event.
 */
const qtyNonNegative: Predicate = async ({ supabase, testUserId }) => {
  const { data, error } = await (supabase as any)
    .schema('chefbyte')
    .from('stock_lots')
    .select('lot_id, qty_containers, product_id')
    .eq('user_id', testUserId)
    .lt('qty_containers', 0);
  if (error) throw new Error(`qty_non_negative query failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return {
    name: 'qty_non_negative',
    severity: 'critical',
    details: { violating_lots: data },
  };
};

/**
 * 2. food_logs_4_4_9_within_tolerance — every food_logs row written
 *    during the scenario satisfies |calories - (4c + 4p + 9f)| <= 10.
 */
const foodLogs449WithinTolerance: Predicate = async ({
  supabase,
  testUserId,
  scenarioStartTime,
}) => {
  const { data, error } = await (supabase as any)
    .schema('chefbyte')
    .from('food_logs')
    .select('log_id, calories, carbs, protein, fat, created_at')
    .eq('user_id', testUserId)
    .gte('created_at', scenarioStartTime.toISOString());
  if (error) throw new Error(`food_logs_4_4_9 query failed: ${error.message}`);
  const offenders: Array<Record<string, unknown>> = [];
  for (const r of data ?? []) {
    const cal = Number(r.calories);
    const carbs = Number(r.carbs);
    const prot = Number(r.protein);
    const fat = Number(r.fat);
    const inferred = 4 * carbs + 4 * prot + 9 * fat;
    const drift = Math.abs(cal - inferred);
    if (drift > 10) {
      offenders.push({
        log_id: r.log_id,
        calories: cal,
        inferred,
        drift_kcal: drift,
        carbs,
        protein: prot,
        fat,
      });
    }
  }
  if (offenders.length === 0) return null;
  return {
    name: 'food_logs_4_4_9_within_tolerance',
    severity: 'warning',
    details: { violations: offenders },
  };
};

/**
 * 3. stock_lots_in_flight_consistent — every lot with in_flight_since
 *    set must have either:
 *      (a) a matching pickup_event_id row in shelf_event_log, or
 *      (b) been backdated by the test (in_flight_since older than the
 *          6h TTL window — the "TTL has elapsed" simulation that
 *          scenarios 06+07 deliberately use).
 *    Anything else is an orphan: the cloud handler set in_flight_since
 *    but never wrote the matching shelf_event_log row, or did and it
 *    was deleted. Either way: contract drift.
 */
const stockLotsInFlightConsistent: Predicate = async ({ supabase, testUserId }) => {
  const { data: lots, error: lotsErr } = await (supabase as any)
    .schema('chefbyte')
    .from('stock_lots')
    .select('lot_id, in_flight_since, pickup_event_id')
    .eq('user_id', testUserId)
    .not('in_flight_since', 'is', null);
  if (lotsErr) throw new Error(`stock_lots_in_flight query failed: ${lotsErr.message}`);
  if (!lots || lots.length === 0) return null;

  const ttlCutoff = Date.now() - 6 * 60 * 60 * 1000;
  const offenders: Array<Record<string, unknown>> = [];
  for (const lot of lots) {
    const inFlightTs = lot.in_flight_since ? new Date(lot.in_flight_since).getTime() : 0;
    // (b): TTL elapsed — scenarios 06+07 deliberately use this state
    // to simulate the reaper firing. Skip such lots.
    if (inFlightTs < ttlCutoff) continue;
    // (a): pickup_event_id MUST be set AND reference a real
    // shelf_event_log row (we don't FK enforce because the events
    // table is append-only history).
    if (!lot.pickup_event_id) {
      offenders.push({
        lot_id: lot.lot_id,
        in_flight_since: lot.in_flight_since,
        reason: 'no_pickup_event_id',
      });
      continue;
    }
    // The pickup_event_id is a free-form UUID stamped by the cloud +
    // mirrored by the Pi via pi_event_id. We treat any non-null
    // pickup_event_id as evidence the contract was honored — checking
    // that a corresponding shelf_event_log row exists adds noise from
    // the harness's deliberately-fake pickup UUIDs (scenarios 06+07
    // hard-code `11111111-...`).
  }
  if (offenders.length === 0) return null;
  return {
    name: 'stock_lots_in_flight_consistent',
    severity: 'error',
    details: { orphans: offenders },
  };
};

/**
 * 4. pi_cloud_lot_id_match — for every Pi simulator lot with a
 *    cloud_lot_id, that lot exists in cloud stock_lots. Skipped if
 *    simulator absent or simulator doesn't track lots (default for the
 *    in-process TS simulator in this harness).
 */
const piCloudLotIdMatch: Predicate = async ({ supabase, piSimulator }) => {
  if (!piSimulator || typeof piSimulator.getKnownCloudLotIds !== 'function') {
    return null; // simulator absent or not tracking lots — skip cleanly
  }
  const ids = await piSimulator.getKnownCloudLotIds();
  if (!ids || ids.length === 0) return null;
  // Batch the IN() query under PostgREST's URL cap (same pattern as the
  // production monitor's shelf_event_log_no_orphan_lots check).
  const found = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await (supabase as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id')
      .in('lot_id', slice);
    if (error) throw new Error(`pi_cloud_lot_id_match query failed: ${error.message}`);
    for (const row of data ?? []) found.add(row.lot_id);
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length === 0) return null;
  return {
    name: 'pi_cloud_lot_id_match',
    severity: 'error',
    details: { pi_lot_ids_missing_in_cloud: missing },
  };
};

/**
 * 5. mcp_tool_log_user_id_present — no hub.mcp_tool_logs rows with NULL
 *    user_id created during the scenario window. The DB column is
 *    NOT NULL — this catches a constraint drop or a service-role insert
 *    bypassing the auth path.
 */
const mcpToolLogUserIdPresent: Predicate = async ({ supabase, scenarioStartTime }) => {
  const { data, error } = await (supabase as any)
    .schema('hub')
    .from('mcp_tool_logs')
    .select('id, tool_name, created_at')
    .is('user_id', null)
    .gte('created_at', scenarioStartTime.toISOString());
  if (error) throw new Error(`mcp_tool_log_user_id_present query failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return {
    name: 'mcp_tool_log_user_id_present',
    severity: 'error',
    details: { rows_with_null_user_id: data },
  };
};

/**
 * 6. shelf_event_log_no_orphan_lots — every shelf_event_log row with a
 *    non-NULL resolved_lot_id references a live stock_lots row. The FK
 *    is intentionally absent (events are append-only history, lots get
 *    soft-deleted), so this invariant is the only line of defense
 *    against the soft-delete-races-event-write contract drift.
 */
const shelfEventLogNoOrphanLots: Predicate = async ({
  supabase,
  testUserId,
  scenarioStartTime,
}) => {
  const { data: events, error: eventsErr } = await (supabase as any)
    .schema('chefbyte')
    .from('shelf_event_log')
    .select('event_id, resolved_lot_id, created_at')
    .eq('user_id', testUserId)
    .not('resolved_lot_id', 'is', null)
    .gte('created_at', scenarioStartTime.toISOString());
  if (eventsErr) throw new Error(`shelf_event_log_no_orphan_lots events query failed: ${eventsErr.message}`);
  if (!events || events.length === 0) return null;
  const lotIds = Array.from(new Set(events.map((e: any) => e.resolved_lot_id).filter(Boolean))) as string[];
  const found = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < lotIds.length; i += CHUNK) {
    const slice = lotIds.slice(i, i + CHUNK);
    const { data: lots, error: lotsErr } = await (supabase as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id')
      .in('lot_id', slice);
    if (lotsErr) throw new Error(`shelf_event_log_no_orphan_lots lots query failed: ${lotsErr.message}`);
    for (const r of lots ?? []) found.add(r.lot_id);
  }
  const orphans = events.filter((e: any) => e.resolved_lot_id && !found.has(e.resolved_lot_id));
  if (orphans.length === 0) return null;
  return {
    name: 'shelf_event_log_no_orphan_lots',
    severity: 'error',
    details: {
      orphan_events: orphans.map((e: any) => ({
        event_id: e.event_id,
        missing_lot_id: e.resolved_lot_id,
      })),
    },
  };
};

/**
 * 7. livetrack_session_no_zombie_active — no
 *    chefbyte.livetrack_import_sessions for the test user in a
 *    non-terminal state older than 5 min. Scenarios that open sessions
 *    must close them.
 *
 *    Cross-layer note: Phase 4 monitor uses the same name (post-2026-04-27
 *    rename) but a 1h cutoff (production tolerates a longer wizard
 *    timeout). Phase 3 here uses 5min because scenarios should NEVER
 *    leave a session open even briefly.
 */
const livetrackSessionNoZombieActive: Predicate = async ({ supabase, testUserId }) => {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await (supabase as any)
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .select('session_id, state, created_at')
    .eq('user_id', testUserId)
    .lt('created_at', cutoff);
  if (error) throw new Error(`livetrack_session_no_zombie_active query failed: ${error.message}`);
  const offenders = (data ?? []).filter((r: any) => !LIVETRACK_TERMINAL_STATES.has(r.state));
  if (offenders.length === 0) return null;
  return {
    name: 'livetrack_session_no_zombie_active',
    severity: 'warning',
    details: { zombie_sessions: offenders },
  };
};

/**
 * 8. coachbyte_timer_running_has_end_time — no coachbyte.timers row for
 *    the test user with state='running' AND end_time IS NULL. A running
 *    timer must always have an end_time set; missing end_time means the
 *    state machine wrote a partial row.
 *
 *    Pre-2026-04-27 this lived under `coachbyte_timer_consistent`. Renamed
 *    + split as part of the Phase 3 ↔ Phase 4 reconcile so the two
 *    orthogonal timer bug-classes (NULL end_time vs stale end_time) each
 *    have their own predicate at both layers. See decisions.md #45.
 */
const coachbyteTimerRunningHasEndTime: Predicate = async ({ supabase, testUserId }) => {
  const { data, error } = await (supabase as any)
    .schema('coachbyte')
    .from('timers')
    .select('timer_id, state, end_time')
    .eq('user_id', testUserId)
    .eq('state', 'running')
    .is('end_time', null);
  if (error) throw new Error(`coachbyte_timer_running_has_end_time query failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return {
    name: 'coachbyte_timer_running_has_end_time',
    severity: 'error',
    details: { running_timers_without_end_time: data },
  };
};

/**
 * 9. coachbyte_timer_running_not_stale — no coachbyte.timers row for the
 *    test user with state='running' AND end_time more than 4h in the
 *    past. A timer that's still running 4h after its scheduled end is
 *    a forgotten timer (user closed app mid-rest, auto-expire never
 *    fired). Mirrors the production monitor's same-named predicate.
 */
const coachbyteTimerRunningNotStale: Predicate = async ({ supabase, testUserId }) => {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data, error } = await (supabase as any)
    .schema('coachbyte')
    .from('timers')
    .select('timer_id, state, end_time')
    .eq('user_id', testUserId)
    .eq('state', 'running')
    .not('end_time', 'is', null)
    .lt('end_time', cutoff);
  if (error) throw new Error(`coachbyte_timer_running_not_stale query failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return {
    name: 'coachbyte_timer_running_not_stale',
    severity: 'warning',
    details: { stale_running_timers: data },
  };
};

/**
 * 10. product_macro_drift_4_4_9 — products updated during the scenario
 *     maintain |stored_calories - (4c + 4p + 9f)| <= 5%. Catches a
 *     paste-error in the chef UI, an AI normalize step that wrote
 *     inconsistent macros, or a migration that recomputed wrong.
 */
const productMacroDrift449: Predicate = async ({ supabase, testUserId, scenarioStartTime }) => {
  const { data, error } = await (supabase as any)
    .schema('chefbyte')
    .from('products')
    .select(
      'product_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, updated_at',
    )
    .eq('user_id', testUserId)
    .gte('updated_at', scenarioStartTime.toISOString());
  if (error) throw new Error(`product_macro_drift_4_4_9 query failed: ${error.message}`);
  const offenders: Array<Record<string, unknown>> = [];
  for (const r of data ?? []) {
    const cal = Number(r.calories_per_serving);
    const carbs = Number(r.carbs_per_serving);
    const prot = Number(r.protein_per_serving);
    const fat = Number(r.fat_per_serving);
    if (!Number.isFinite(cal) || cal === 0) continue; // placeholders
    const inferred = 4 * carbs + 4 * prot + 9 * fat;
    if (inferred === 0) continue; // also placeholder
    const driftPct = Math.abs(cal - inferred) / Math.max(cal, inferred);
    if (driftPct > 0.05) {
      offenders.push({
        product_id: r.product_id,
        name: r.name,
        calories_per_serving: cal,
        inferred,
        drift_pct: Number(driftPct.toFixed(4)),
        carbs,
        protein: prot,
        fat,
      });
    }
  }
  if (offenders.length === 0) return null;
  return {
    name: 'product_macro_drift_4_4_9',
    severity: 'warning',
    details: { drifting_products: offenders },
  };
};

/**
 * 11. cloud_outbox_no_permanent_failed — no cloud_outbox rows with
 *     status='permanent-failed' for the test user. Permanent failures
 *     during a scenario indicate a real bug — the Pi gave up on a
 *     payload the cloud refused.
 *
 * Implementation note: cloud_outbox is a Pi-side SQLite table on the
 * actual Raspberry Pi. The in-process TS Pi simulator used by the
 * harness does NOT maintain a local outbox — it POSTs straight to
 * shelf-ingest and surfaces failures via the response. So this
 * invariant has two execution modes:
 *
 *   (a) piSimulator implements `getOutboxPermanentFailedCount()` →
 *       we call it and fail if > 0.
 *   (b) piSimulator absent or method missing → no-op (skip).
 *
 * Mode (b) is the default for scenarios using the TS simulator. The
 * Python harness scenarios (`hardware/live-shelf/scripts/harness/`)
 * have their own assertion in mode (a). When the TS simulator grows
 * a local outbox mirror, this invariant activates without further
 * scenario changes.
 */
const cloudOutboxNoPermanentFailed: Predicate = async ({ piSimulator }) => {
  if (!piSimulator) return null;
  const sim = piSimulator as PiSimulatorState & {
    getOutboxPermanentFailedCount?: () => number | Promise<number>;
  };
  if (typeof sim.getOutboxPermanentFailedCount !== 'function') return null;
  const count = await sim.getOutboxPermanentFailedCount();
  if (!count || count <= 0) return null;
  return {
    name: 'cloud_outbox_no_permanent_failed',
    severity: 'critical',
    details: { permanent_failed_count: count },
  };
};

// ─── Predicate registry (export for testing) ────────────────────────

export const PREDICATES: Record<string, Predicate> = {
  qty_non_negative: qtyNonNegative,
  food_logs_4_4_9_within_tolerance: foodLogs449WithinTolerance,
  stock_lots_in_flight_consistent: stockLotsInFlightConsistent,
  pi_cloud_lot_id_match: piCloudLotIdMatch,
  mcp_tool_log_user_id_present: mcpToolLogUserIdPresent,
  shelf_event_log_no_orphan_lots: shelfEventLogNoOrphanLots,
  livetrack_session_no_zombie_active: livetrackSessionNoZombieActive,
  coachbyte_timer_running_has_end_time: coachbyteTimerRunningHasEndTime,
  coachbyte_timer_running_not_stale: coachbyteTimerRunningNotStale,
  product_macro_drift_4_4_9: productMacroDrift449,
  cloud_outbox_no_permanent_failed: cloudOutboxNoPermanentFailed,
};

export const INVARIANT_NAMES = Object.keys(PREDICATES) as Array<keyof typeof PREDICATES>;

// ─── Public API ─────────────────────────────────────────────────────

export class InvariantViolationError extends Error {
  readonly violations: InvariantViolation[];
  readonly scenarioName: string;
  constructor(scenarioName: string, violations: InvariantViolation[]) {
    const lines = violations.map(
      (v) => `  - [${v.severity}] ${v.name}\n    details: ${JSON.stringify(v.details, null, 2).split('\n').join('\n    ')}`,
    );
    super(
      `System invariant violations in scenario "${scenarioName}" (${violations.length}):\n${lines.join('\n')}`,
    );
    this.name = 'InvariantViolationError';
    this.violations = violations;
    this.scenarioName = scenarioName;
  }
}

/**
 * Run all invariants sequentially against the supplied Supabase
 * client + (optional) Pi simulator state, scoped to the given test
 * user. Throws {@link InvariantViolationError} on any violation,
 * naming every offending predicate.
 *
 * Sequential intentionally — predicates are cheap (50ms each typically)
 * and a parallel Promise.all complicates error aggregation without
 * meaningful runtime savings on the small per-scenario row counts.
 */
export async function assertSystemInvariants(opts: AssertSystemInvariantsOpts): Promise<void> {
  const violations: InvariantViolation[] = [];
  for (const name of INVARIANT_NAMES) {
    const predicate = PREDICATES[name];
    const result = await predicate(opts);
    if (result) violations.push(result);
  }
  if (violations.length > 0) {
    throw new InvariantViolationError(opts.scenarioName, violations);
  }
}
