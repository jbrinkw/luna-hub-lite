/**
 * LiveTrack Import wizard — start hook fires edge-function call.
 *
 * Pins the contract: clicking "Start wizard" in the UI calls
 * `supabase.functions.invoke('livetrack-session/create', {...})`. That
 * INSERT against ``chefbyte.livetrack_import_sessions`` is what the Pi
 * picks up via the ``LiveTrackPoller`` snapshot; as long as that row
 * exists + has a non-terminal state, the Pi's scale-event pipeline is
 * suppressed (see ``hardware/live-shelf/server/handlers/scale_events.py``
 * :: ``_is_wizard_active``).
 *
 * Pre-suppression (before 2026-04-22), the wizard had no "wizard
 * active" signal the Pi cared about — weight deltas during calibration
 * spawned phantom pickup sessions. The suppression gate closes that
 * loop by treating a non-terminal ``livetrack_import_sessions`` row
 * as the on-signal. So this test is load-bearing in the end-to-end
 * picture even though the assertion itself is "did we call the edge
 * function" — because the edge function's INSERT is what makes the
 * gate fire on the Pi side.
 *
 * Structural regression the test would catch
 * ------------------------------------------
 *   * Someone swaps the path to ``livetrack-session/start`` (the edge
 *     function doesn't have that route — /active and /create are the
 *     real routes per the supabase/functions/livetrack-session
 *     index.ts).
 *   * Someone passes the body shape the edge function doesn't accept
 *     (the /create handler reads auth.getUser() — the body is ignored
 *     today, but we pin an explicit empty-object shape so future
 *     schema validation doesn't silently accept malformed callers).
 *   * Someone deletes ``createLiveTrackSession()`` altogether and the
 *     wizard starts writing directly to the table (which would bypass
 *     the edge function's device-freshness + expire-prior-sessions
 *     logic — the wizard-active signal would still show up on the Pi,
 *     but only if a device happens to be fresh, a guarantee the edge
 *     function provides).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Vitest module-level mock — we stub `supabase.functions.invoke` and
// assert the wizard-start helper calls it with the exact route + body.
const invokeMock = vi.fn();

vi.mock('@/shared/supabase', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
  chefbyte: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      }),
    }),
  }),
}));

import { createLiveTrackSession } from '@/pages/chefbyte/livetrackSession';

describe('createLiveTrackSession — wizard start → edge function', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('calls livetrack-session/create on start (the wizard-active signal)', async () => {
    // The edge function returns the freshly-inserted row on success;
    // any `state` NOT IN ('closed','expired') is "wizard active" from
    // the Pi's perspective. We return 'waiting_barcode' — the default
    // chosen by the edge function's INSERT.
    invokeMock.mockResolvedValueOnce({
      data: {
        session: {
          session_id: '00000000-0000-0000-0000-000000000001',
          user_id: 'u1',
          device_id: 'dev-1',
          state: 'waiting_barcode',
          current_barcode: null,
          current_product_id: null,
          scale_reading_g: null,
          scale_reading_ts: null,
          ai_tare_product_form: null,
          ai_tare_g: null,
          ai_tare_confidence: null,
          ai_tare_reasoning: null,
          last_error: null,
          created_at: '2026-04-22T12:00:00.000Z',
          updated_at: '2026-04-22T12:00:00.000Z',
          expires_at: '2026-04-22T12:10:00.000Z',
        },
      },
      error: null,
    });

    const session = await createLiveTrackSession();

    // Exact edge-function path — anything else and the Pi poller never
    // sees the wizard-active signal.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [path, opts] = invokeMock.mock.calls[0];
    expect(path).toBe('livetrack-session/create');
    // Body shape: empty object. The edge function reads auth.getUser()
    // for the caller; the body is currently ignored but must still be
    // an object (supabase-js requires a serializable value).
    expect(opts).toEqual({ body: {} });

    // The returned session's state is a non-terminal state — this is
    // the shape the Pi-side poller reads via its snapshot to suppress
    // the event pipeline.
    expect(session.state).toBe('waiting_barcode');
    expect(['closed', 'expired']).not.toContain(session.state);
  });

  it('409 (no fresh device) surfaces as a typed error — no wizard, no suppression', async () => {
    // When no Pi is heartbeating, the edge function returns 409 and
    // the caller must refuse to arm. If we erroneously created a row
    // anyway, the Pi-side gate would never fire (no device is online
    // to poll), but the browser would show "wizard running" — a UX
    // bug that the typed 409 branch prevents.
    invokeMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'no fresh live shelf device',
        context: {
          status: 409,
          json: async () => ({ error: 'no fresh live shelf device (heartbeat stale or missing)' }),
        },
      },
    });

    await expect(createLiveTrackSession()).rejects.toMatchObject({
      status: 409,
    });
  });
});
