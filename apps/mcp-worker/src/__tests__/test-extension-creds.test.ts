/**
 * test-extension-creds — Worker-side credential probe.
 *
 * Pins the HA probe behavior added in FLAG-03 closure: LAN-only hosts
 * surface a clear "expose via tunnel" message instead of a generic
 * network error. Public hosts attempt a real GET to {url}/api/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeUpstream } from '../test-extension-creds';

describe('probeUpstream — Home Assistant (FLAG-03)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty creds with a "URL + token required" message', async () => {
    const r = await probeUpstream('homeassistant', {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/URL.*token.*required/i);
  });

  it('rejects malformed URLs', async () => {
    const r = await probeUpstream('homeassistant', { ha_url: 'not-a-url', ha_token: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not a valid URL/i);
  });

  it('flags 192.168.x LAN URLs as unreachable from cloud Worker', async () => {
    const r = await probeUpstream('homeassistant', { ha_url: 'http://192.168.0.42:8123', ha_token: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/private\/LAN|tunnel|public hostname/i);
  });

  it('flags *.local hostnames as LAN-only', async () => {
    const r = await probeUpstream('homeassistant', { ha_url: 'http://homeassistant.local:8123', ha_token: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/private\/LAN|tunnel|public hostname/i);
  });

  it('flags localhost as LAN-only', async () => {
    const r = await probeUpstream('homeassistant', { ha_url: 'http://localhost:8123', ha_token: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/private\/LAN|tunnel|public hostname/i);
  });

  it('returns ok when the public HA host responds 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: 'API running.' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeUpstream('homeassistant', { ha_url: 'https://ha.example.com', ha_token: 'tok' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reachable/i);
  });

  it('rejects with auth-error message when HA returns 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeUpstream('homeassistant', { ha_url: 'https://ha.example.com', ha_token: 'badtok' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Authentication rejected/i);
  });

  it('hints at the wrong base-URL shape on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeUpstream('homeassistant', { ha_url: 'https://ha.example.com', ha_token: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HA root|no trailing/i);
  });
});
