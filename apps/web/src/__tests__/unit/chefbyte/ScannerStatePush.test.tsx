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
});
