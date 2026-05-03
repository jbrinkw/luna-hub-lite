/**
 * Helper module for the Web Scanner page's bidirectional sync with
 * `chefbyte.scanner_state` (cloud-side authority).
 *
 * Two flows:
 *   - `pushScannerMode({ last_active_mode | locked_mode })` — broadcast a
 *     mode change to the cloud edge function so the Pi USB-scanner
 *     forwarder picks it up via Realtime. POSTs to
 *     `/shelf-ingest/scanner-state` (browser-JWT route — uses the
 *     authenticated session bearer token automatically via supabase-js).
 *   - `fetchScannerState()` — hydrate the row on Scanner page mount so
 *     the UI initializes from `locked_mode` (or `last_active_mode`)
 *     instead of always defaulting to 'purchase'.
 *
 * `pushScannerMode` accepts an optional injected `invoke` so the unit
 * tests can assert on the path + body without going through the supabase
 * module mock plumbing. Production callers omit it and the default
 * `supabase.functions.invoke` is used.
 *
 * The edge function is the trust boundary for mode validation —
 * unrecognized strings are rejected with a 400. Clients only need to
 * forward whatever ScanMode the user selected; the row's PATCH semantics
 * mean omitting either field leaves it untouched on the server.
 */
import { supabase, chefbyte } from './supabase';

export type ScanMode = 'purchase' | 'consume_macros' | 'consume_no_macros' | 'shopping';

export interface ScannerStatePatch {
  last_active_mode?: ScanMode;
  /**
   * Send `null` to clear an existing lock; omit the field entirely to
   * leave the lock untouched. Sending a valid mode string locks the
   * scanner to that mode regardless of what the user selects locally.
   */
  locked_mode?: ScanMode | null;
}

type InvokeFn = typeof supabase.functions.invoke;

/**
 * POST a PATCH-style update to `chefbyte.scanner_state` via the
 * `shelf-ingest/scanner-state` edge function. Throws on edge-function
 * error so callers can surface failures (current callers do
 * fire-and-forget with a console.warn — see ScannerPage).
 *
 * The default `invoke` wraps `supabase.functions.invoke` in an arrow
 * so the `this` binding to `supabase.functions` is preserved. Capturing
 * the bare method reference loses `this` and the supabase-js SDK throws
 * `Cannot read properties of undefined (reading 'region')` on call.
 * Tests can pass their own `invoke` to bypass the SDK entirely.
 */
export async function pushScannerMode(
  patch: ScannerStatePatch,
  invoke: InvokeFn = (name, opts) => supabase.functions.invoke(name, opts),
): Promise<void> {
  const { error } = await invoke('shelf-ingest/scanner-state', { body: patch });
  if (error) throw error;
}

/**
 * Read the current scanner_state row for the signed-in user. Returns
 * `null` when the row hasn't been created yet OR when the read fails
 * (RLS denial, network error). Callers should treat null as "fall back
 * to local default" rather than surfacing an error — the row is created
 * lazily on the first push.
 */
export async function fetchScannerState(): Promise<{
  last_active_mode: ScanMode;
  locked_mode: ScanMode | null;
} | null> {
  const { data, error } = await chefbyte().from('scanner_state').select('last_active_mode, locked_mode').maybeSingle();
  if (error || !data) return null;
  return data as { last_active_mode: ScanMode; locked_mode: ScanMode | null };
}
