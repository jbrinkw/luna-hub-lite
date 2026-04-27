/**
 * In-process Pi simulator.
 *
 * Approach + rationale (Phase-2 spec, option (b)):
 *
 * - The real Pi (`hardware/live-shelf/server/`) runs a Flask app + SQLite +
 *   reconciler that ultimately calls the `shelf-ingest` edge function over
 *   HTTPS.
 * - For e2e harness purposes we synthesize the *outbound HTTP* the Pi would
 *   produce. We post events to `/functions/v1/shelf-ingest/{event,intake,
 *   heartbeat,catalog,...}` with the device's x-api-key. This exercises the
 *   real edge fn → real `apply_shelf_event` RPC → real DB writes → real
 *   realtime broadcast → real React render. Every link downstream of the
 *   Pi's outbox is the same code path that runs in production.
 * - We do NOT re-run the Pi reconciler / classifier / state machine here —
 *   those are covered by the existing 38-file Pi pytest suite + 15-scenario
 *   Python harness. This simulator's job is to hit the *cloud-facing
 *   contract* with the right payloads.
 *
 * Why option (b) over option (a) (Python subprocess): faster scenario boot
 * (~50ms vs ~3-5s spawning Python+venv+supabase-py per scenario), no Python
 * dependency, single language for the spec file. The cost is we don't
 * exercise the Pi-side classifier/reconciler — but those have their own
 * tests, and the existing harness covers the Python state machine
 * end-to-end.
 *
 * For each scenario that needs Pi → Cloud emission, we:
 *   1. seed a `live_shelf_devices` row + raw key (sha256 hashed)
 *   2. POST to shelf-ingest the way the Pi would
 *   3. assert cloud DB state via the admin client
 *   4. assert React UI render via Playwright
 */
import { adminClient, SUPABASE_URL, sha256Hex } from './env';
import { randomUUID } from 'crypto';

export interface SeededPiDevice {
  deviceId: string;
  rawKey: string;
  userId: string;
}

/** Seed a Live Shelf device with a known raw key. SHA-256 hashes for storage. */
export async function seedPiDevice(userId: string, name = 'harness-pi'): Promise<SeededPiDevice> {
  const admin = adminClient();
  const rawKey = `hk-${randomUUID().replace(/-/g, '')}`;
  const keyHash = await sha256Hex(rawKey);
  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('live_shelf_devices')
    .insert({
      user_id: userId,
      device_name: name,
      import_key_hash: keyHash,
      is_active: true,
    })
    .select('device_id')
    .single();
  if (error || !data) throw new Error(`seedPiDevice failed: ${error?.message}`);
  return { deviceId: data.device_id, rawKey, userId };
}

/** Seed a scale_pairings row binding a scale_id to a product. Returns pairing_id. */
export async function seedScalePairing(
  device: SeededPiDevice,
  scaleId: string,
  productId: string | null,
  kind: 'live_shelf' | 'live_scale' | 'catch_all' = 'live_shelf',
): Promise<string> {
  const admin = adminClient();
  const { data, error } = await (admin as any)
    .schema('chefbyte')
    .from('scale_pairings')
    .insert({
      user_id: device.userId,
      device_id: device.deviceId,
      scale_id: scaleId,
      kind,
      product_id: productId,
    })
    .select('pairing_id')
    .single();
  if (error || !data) throw new Error(`seedScalePairing failed: ${error?.message}`);
  return data.pairing_id;
}

export type EventKind =
  | 'consumed'
  | 'added'
  | 'refilled'
  | 'depleted'
  | 'in_flight_pickup'
  | 'in_flight_return'
  | 'discarded';

export interface PiEventPayload {
  kind: 'live_shelf' | 'live_scale' | 'catch_all';
  eventKind: EventKind;
  scaleId: string;
  productId?: string | null;
  deltaG: number;
  occurredAt?: string;
  clientEventId?: string;
  piEventId?: string;
}

export interface PiEventResult {
  status: number;
  body: {
    ok?: boolean;
    applied?: boolean;
    resolved_lot_id?: string | null;
    reason?: string | null;
    error?: string;
  };
}

/**
 * POST a single scale event to shelf-ingest as if from the Pi. Returns the
 * raw response so scenarios can assert applied / reason / status.
 */
export async function postPiEvent(device: SeededPiDevice, ev: PiEventPayload): Promise<PiEventResult> {
  const occurredAt = ev.occurredAt ?? new Date().toISOString();
  const clientEventId = ev.clientEventId ?? `harness-${randomUUID()}`;
  const body: Record<string, unknown> = {
    kind: ev.kind,
    event_kind: ev.eventKind,
    scale_id: ev.scaleId,
    delta_g: ev.deltaG,
    occurred_at: occurredAt,
    client_event_id: clientEventId,
    product_id: ev.productId ?? null,
    pi_event_id: ev.piEventId ?? null,
  };
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/shelf-ingest/event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': device.rawKey,
    },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try {
    json = await resp.json();
  } catch {
    /* empty body */
  }
  return { status: resp.status, body: json };
}

/** POST a heartbeat. Used by scenarios that exercise pending-review counts. */
export async function postHeartbeat(device: SeededPiDevice, payload: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/shelf-ingest/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': device.rawKey },
    body: JSON.stringify({
      pending_review_count: 0,
      outbox_pending_count: 0,
      outbox_permanent_failures: 0,
      scales: [],
      ...payload,
    }),
  });
}

/**
 * Wait for a DB predicate to become true, or fail with a useful message.
 * Used to bridge the realtime / RPC propagation gap between a Pi event POST
 * and the cloud-side state landing.
 */
export async function waitForCloudState<T>(
  query: () => Promise<T>,
  predicate: (val: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 5000;
  const interval = opts.intervalMs ?? 100;
  const start = Date.now();
  let lastVal: T | undefined;
  while (Date.now() - start < timeout) {
    lastVal = await query();
    if (predicate(lastVal)) return lastVal;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForCloudState: predicate did not become true within ${timeout}ms` +
      (opts.description ? ` (${opts.description})` : '') +
      `\n  last value: ${JSON.stringify(lastVal, null, 2)}`,
  );
}
