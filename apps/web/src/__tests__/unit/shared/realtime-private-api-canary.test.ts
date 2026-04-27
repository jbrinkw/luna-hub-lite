import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * Compatibility canary for the undocumented Supabase Realtime private API.
 *
 * Production code at `apps/web/src/shared/useRealtimeInvalidation.ts` reads
 * `supabase.realtime.stateChangeCallbacks.close` (an Array<Function>) on
 * every effect-mount to wire a socket-close listener that triggers a
 * reconnect. There is no public `RealtimeClient.onClose()` (or equivalent)
 * method exposed by `@supabase/realtime-js` — `stateChangeCallbacks` is an
 * internal property of the client.
 *
 * If `@supabase/supabase-js` (or its transitive `@supabase/realtime-js`) is
 * upgraded and renames/removes the property, the production code's runtime
 * guard logs a `console.error` and quietly skips registration — meaning the
 * realtime reconnect-on-close behavior silently breaks in prod.
 *
 * This test pins the shape so we catch the break at CI time, on dependency
 * bump, BEFORE the broken build ships. If this test fails: open
 * `useRealtimeInvalidation.ts` and migrate to whatever supported close-event
 * API the new realtime-js version exposes.
 */
describe('Supabase Realtime private API canary', () => {
  it('realtime.stateChangeCallbacks.close is still an array (private API used by useRealtimeInvalidation)', () => {
    // Use placeholder URL/key — we never connect; we only check the
    // in-memory shape of the freshly constructed client.
    const client = createClient('http://localhost:54321', 'anon-key-doesnt-matter-for-shape-check');
    expect(client.realtime).toBeDefined();

    const rt = client.realtime as unknown as {
      stateChangeCallbacks?: { close?: unknown };
    };
    expect(rt.stateChangeCallbacks).toBeDefined();
    expect(rt.stateChangeCallbacks?.close).toBeInstanceOf(Array);
  });
});
