/**
 * USB Scanner Task 11 — Web Scanner page broadcasts mode changes to the
 * cloud `chefbyte.scanner_state` row via `pushScannerMode`.
 *
 * Pins the contract:
 *   - The helper POSTs to `shelf-ingest/scanner-state` (the edge function
 *     route exposed by the dispatcher in `supabase/functions/shelf-ingest/
 *     index.ts` — browser-JWT route bypassing the global x-api-key gate).
 *   - The body forwards exactly the patch fields the caller supplied —
 *     PATCH semantics mean fields omitted from the body are NOT touched
 *     on the server, so we must not "helpfully" merge or default.
 *   - `locked_mode: null` round-trips intact (the cloud sentinel for
 *     "clear the lock"); a regression to `undefined` would silently make
 *     the lock un-clearable from the web client.
 *
 * Structural regressions caught:
 *   - Someone renames the route (e.g. `scanner_state` with underscore,
 *     or drops the `shelf-ingest/` prefix) — Pi forwarder loses the
 *     Realtime signal it relies on.
 *   - Someone wraps the body in another object (e.g. `{ patch: ... }`)
 *     — edge function reads `body.last_active_mode` / `body.locked_mode`
 *     directly and would 400 on the wrapped shape.
 *   - Someone strips `locked_mode: null` because it "looks like a no-op"
 *     — the cloud handler treats `undefined` (absent) and `null` (clear)
 *     differently, so dropping null silently loses the unlock action.
 */
import { describe, it, expect, vi } from 'vitest';
import { pushScannerMode } from '@/shared/scannerStateApi';

// The default-invoke regression test below mocks the supabase module so
// `supabase.functions.invoke` is a method (not an arrow) and reads
// `this.region` synchronously. If pushScannerMode captures the bare
// method reference without preserving `this`, the read fails with
// "Cannot read properties of undefined (reading 'region')" — exactly
// the runtime error the user reported.
const supabaseMockState = {
  functionsThis: undefined as unknown,
  invokeCalls: [] as Array<{ name: string; opts: unknown }>,
};

vi.mock('@/shared/supabase', () => {
  function invokeImpl(this: { region?: string }, name: string, opts: unknown) {
    // Capture `this` at call time so the test can assert it was preserved.
    supabaseMockState.functionsThis = this;
    if (this === undefined || this.region === undefined) {
      // Mirror the SDK's actual failure mode when `this` is lost.
      throw new TypeError("Cannot read properties of undefined (reading 'region')");
    }
    supabaseMockState.invokeCalls.push({ name, opts });
    return Promise.resolve({ data: null, error: null });
  }
  const functions = { invoke: invokeImpl, region: 'us-east-1' };
  return {
    supabase: { functions },
    chefbyte: () => ({}),
  };
});

describe('pushScannerMode', () => {
  it('POSTs to /shelf-ingest/scanner-state with last_active_mode', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: null, error: null });
    await pushScannerMode({ last_active_mode: 'consume_macros' }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({
        body: { last_active_mode: 'consume_macros' },
      }),
    );
  });

  it('passes through locked_mode', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: null, error: null });
    await pushScannerMode({ locked_mode: 'shopping' }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({ body: { locked_mode: 'shopping' } }),
    );
  });

  it('passes through locked_mode=null to clear lock', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: null, error: null });
    await pushScannerMode({ locked_mode: null }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(
      'shelf-ingest/scanner-state',
      expect.objectContaining({ body: { locked_mode: null } }),
    );
  });

  it('preserves `this` binding on supabase.functions when caller omits invoke', async () => {
    // Regression for the production-only crash: capturing
    // `supabase.functions.invoke` as a bare reference loses its
    // `this` binding, and the SDK reads `this.region` on call → throws
    // "Cannot read properties of undefined (reading 'region')".
    // The mock above throws that exact error if `this` is undefined.
    supabaseMockState.functionsThis = undefined;
    supabaseMockState.invokeCalls = [];
    await pushScannerMode({ last_active_mode: 'purchase' });
    expect(supabaseMockState.functionsThis).toBeDefined();
    expect((supabaseMockState.functionsThis as { region?: string }).region).toBe('us-east-1');
    expect(supabaseMockState.invokeCalls).toHaveLength(1);
    expect(supabaseMockState.invokeCalls[0].name).toBe('shelf-ingest/scanner-state');
  });
});
