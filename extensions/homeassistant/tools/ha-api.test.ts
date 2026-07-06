import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEntityState, callService, resolveEntityId, type HACredentials } from './ha-api';

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

const creds: HACredentials = { token: 't', url: 'https://ha.example.com:8123' };

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// B4-04 — entity_id must be percent-encoded into the REST URL path
// ===========================================================================
describe('B4-04: entity_id URL encoding', () => {
  it('getEntityState percent-encodes a space in the entity_id path', async () => {
    mockFetch.mockReturnValueOnce(ok({ entity_id: 'light.foo bar', state: 'on' }));

    await getEntityState(creds, 'light.foo bar');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    // The space MUST be encoded; a raw space in a URL path is invalid / unsafe.
    expect(url).toBe('https://ha.example.com:8123/api/states/light.foo%20bar');
    expect(url).not.toContain('light.foo bar');
  });

  it('getEntityState encodes characters that change path meaning (# fragment, ?)', async () => {
    mockFetch.mockReturnValueOnce(ok({ entity_id: 'light.a#b?c', state: 'on' }));

    await getEntityState(creds, 'light.a#b?c');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://ha.example.com:8123/api/states/light.a%23b%3Fc');
  });

  it('callService percent-encodes the domain and service path segments', async () => {
    mockFetch.mockReturnValueOnce(ok({}));

    await callService(creds, 'media player', 'turn on', { entity_id: 'x' });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://ha.example.com:8123/api/services/media%20player/turn%20on');
  });
});

// ===========================================================================
// B4-02 — friendly-name fallback across non-forced domains
// ===========================================================================
describe('B4-02: unfiltered friendly-name fallback', () => {
  // "tv" forces inferDomain -> ['media_player'] only. A device correctly named
  // "TV" but living in the `switch` domain is invisible to the domain-filtered
  // passes. After the fix, an unfiltered exact friendly-name retry resolves it.
  function statesWithSwitchTv() {
    return [
      { entity_id: 'switch.tv', attributes: { friendly_name: 'TV' } },
      { entity_id: 'light.kitchen', attributes: { friendly_name: 'Kitchen' } },
    ];
  }

  it('resolves a friendly-name match that lives in a non-forced (switch) domain', async () => {
    // resolveEntityId('tv') -> fetchStates (single call), then resolves locally.
    mockFetch.mockReturnValueOnce(ok(statesWithSwitchTv()));

    const [resolved, err] = await resolveEntityId(creds, 'tv');

    expect(err).toBeNull();
    expect(resolved).toBe('switch.tv');
  });

  it('does not let the unfiltered fallback override a domain-correct match', async () => {
    // When a media_player.tv exists, the domain-filtered pass should win and the
    // switch.tv must NOT create ambiguity that breaks resolution.
    mockFetch.mockReturnValueOnce(
      ok([
        { entity_id: 'media_player.tv', attributes: { friendly_name: 'TV' } },
        { entity_id: 'switch.tv', attributes: { friendly_name: 'TV' } },
      ]),
    );

    const [resolved, err] = await resolveEntityId(creds, 'tv');

    expect(err).toBeNull();
    expect(resolved).toBe('media_player.tv');
  });

  it('still returns not-found when no friendly name matches in any domain', async () => {
    mockFetch.mockReturnValueOnce(ok(statesWithSwitchTv()));

    const [resolved, err] = await resolveEntityId(creds, 'nonexistent gadget');

    expect(resolved).toBeNull();
    expect(err).toContain('not found');
  });
});
