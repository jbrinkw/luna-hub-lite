/**
 * Typed helpers for the LiveTrack Import session row.
 *
 * The edge function owns:
 *   - session creation (picks the freshest-heartbeated device + expires
 *     prior live rows).
 *   - Pi-side mutations (x-api-key allow-list).
 *
 * The browser owns (via supabase-js UPDATE against the session row):
 *   - barcode + product_id selection.
 *   - state flips that the user-initiates (close, re-arm, start AI tare).
 *
 * RLS on chefbyte.livetrack_import_sessions keeps each user scoped to
 * their own rows, so direct supabase-js writes are safe.
 */

import { chefbyte, supabase } from '@/shared/supabase';

export type LiveTrackState =
  | 'waiting_barcode'
  | 'waiting_scale'
  | 'scale_reading_received'
  | 'awaiting_ai_tare'
  | 'ai_tare_ready'
  | 'closed'
  | 'expired';

export interface LiveTrackSession {
  session_id: string;
  user_id: string;
  device_id: string;
  state: LiveTrackState;
  current_barcode: string | null;
  current_product_id: string | null;
  scale_reading_g: number | null;
  scale_reading_ts: string | null;
  ai_tare_product_form: Record<string, unknown> | null;
  ai_tare_g: number | null;
  ai_tare_confidence: 'low' | 'medium' | 'high' | null;
  ai_tare_reasoning: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Shape the browser sends as `ai_tare_product_form`. The Pi rebuilds an
 * AiTareProductForm from these keys — fields that don't deserialize cleanly
 * become None and ai_tare.estimate handles the partial form.
 */
export interface AiTareProductFormJson {
  name?: string | null;
  brand?: string | null;
  variant?: string | null;
  net_weight_g?: number | null;
  serving_weight_g?: number | null;
  servings_per_container?: number | null;
  unit_type?: string | null;
  container_type?: string | null;
}

/**
 * Create a fresh session for the calling user's most-recently-heartbeated
 * device. Wraps the `/livetrack-session/create` edge function. Throws on
 * non-2xx so callers can render a typed error banner.
 *
 * 409 = no fresh device → caller shows the "Pi offline" branch.
 */
export async function createLiveTrackSession(): Promise<LiveTrackSession> {
  const { data, error } = await supabase.functions.invoke('livetrack-session/create', {
    body: {},
  });
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError. Surface a helpful
    // message when possible — the edge function returns
    // `{ error: "..." }` for 4xx.
    let body: any = null;
    try {
      body = await (error as any)?.context?.json?.();
    } catch {
      body = null;
    }
    const reason = body?.error ?? error.message ?? 'Unknown error';
    const err = new Error(reason);
    (err as any).status = (error as any)?.context?.status ?? 500;
    throw err;
  }
  if (!data?.session) {
    throw new Error('session create returned empty body');
  }
  return data.session as LiveTrackSession;
}

/**
 * Patch a session row client-side. Allowed fields are everything the
 * browser owns: state transitions, barcode, current_product_id, the
 * AI-tare product-form payload, and last_error-for-display clears.
 */
export async function patchLiveTrackSession(
  sessionId: string,
  patch: Partial<{
    state: LiveTrackState;
    current_barcode: string | null;
    current_product_id: string | null;
    ai_tare_product_form: AiTareProductFormJson | null;
    last_error: string | null;
    // Also allow browser-driven clears of scale/ai fields on re-arm.
    scale_reading_g: number | null;
    scale_reading_ts: string | null;
    ai_tare_g: number | null;
    ai_tare_confidence: 'low' | 'medium' | 'high' | null;
    ai_tare_reasoning: string | null;
  }>,
): Promise<LiveTrackSession> {
  const { data, error } = await chefbyte()
    .from('livetrack_import_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'session update failed');
  return data as LiveTrackSession;
}

/**
 * Load a session by id. Returns null when the row is not found (covers
 * expired-and-purged as well as RLS misses).
 */
export async function loadLiveTrackSession(
  sessionId: string,
): Promise<LiveTrackSession | null> {
  const { data, error } = await chefbyte()
    .from('livetrack_import_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LiveTrackSession | null) ?? null;
}

/**
 * Fetch the owning user's most-recently-heartbeated active device.
 * Returns null when no such device exists so the UI can render the
 * "pair a device first" prompt instead of blocking on session create.
 */
export async function loadFreshLiveShelfDevice(userId: string): Promise<{
  device_id: string;
  device_name: string;
  last_heartbeat_ts: string | null;
  is_active: boolean;
} | null> {
  const { data, error } = await chefbyte()
    .from('live_shelf_devices')
    .select('device_id, device_name, last_heartbeat_ts, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('last_heartbeat_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Test whether a device's heartbeat is within the UI's "Pi online" window
 * (60s). Matches the edge function's DEVICE_FRESH_WINDOW_MS so both sides
 * agree.
 */
export function isDeviceFresh(lastHeartbeatTs: string | null | undefined): boolean {
  if (!lastHeartbeatTs) return false;
  const age = Date.now() - new Date(lastHeartbeatTs).getTime();
  if (!Number.isFinite(age)) return false;
  return age >= 0 && age <= 60_000;
}
