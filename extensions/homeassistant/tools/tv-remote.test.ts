import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HOMEASSISTANT_tv_remote } from './tv-remote';
import type { ExtensionToolContext } from '@luna-hub/app-tools';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function haCtx(): ExtensionToolContext {
  return {
    userId: 'u1',
    supabase: {} as any,
    credentials: { ha_api_key: 'k', ha_url: 'https://ha.example.com:8123' },
  };
}

const handler = HOMEASSISTANT_tv_remote.handler;

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// B4-05 — unrecognized commands must error, not send junk to HA
// ===========================================================================
describe('B4-05: unrecognized command handling', () => {
  it('rejects a multi-word junk command without calling HA (no UNKNOWN sentinel)', async () => {
    const result = await handler({ button: 'do a backflip' }, haCtx());

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    // Must not silently report success or send a sentinel command.
    expect(result.content[0].text.toLowerCase()).not.toContain('unknown');
  });

  it('rejects an arbitrary single-word token instead of forwarding it uppercased', async () => {
    const result = await handler({ button: 'asdfqwer' }, haCtx());

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the error message names the offending command so the caller can correct it', async () => {
    const result = await handler({ button: 'do a backflip' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('do a backflip');
  });

  // Regression guards — recognized commands still work end-to-end.
  it('still sends a recognized navigation command (up -> DPAD_UP)', async () => {
    mockFetch.mockReturnValueOnce(ok([]));

    const result = await handler({ button: 'up' }, haCtx());

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://ha.example.com:8123/api/services/remote/send_command');
    expect(JSON.parse(opts.body).command).toBe('DPAD_UP');
  });

  it('still launches a recognized app (netflix)', async () => {
    mockFetch.mockReturnValueOnce(ok([]));

    const result = await handler({ button: 'netflix' }, haCtx());

    expect(result.isError).toBeUndefined();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://ha.example.com:8123/api/services/remote/turn_on');
    expect(JSON.parse(opts.body).activity).toBe('com.netflix.ninja');
  });
});
