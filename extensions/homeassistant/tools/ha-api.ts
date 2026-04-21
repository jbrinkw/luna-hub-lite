import type { ExtensionToolContext } from '@luna-hub/app-tools';
import { ALLOWED_DOMAINS } from './constants';

export interface HACredentials {
  token: string;
  url: string;
}

export function getHACredentials(ctx: ExtensionToolContext): HACredentials | null {
  const { ha_api_key, ha_url } = ctx.credentials;
  if (!ha_api_key || !ha_url) return null;
  let parsed: URL;
  try {
    parsed = new URL(ha_url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // WHATWG URL preserves the brackets on IPv6 hostnames (e.g. "[::1]"). Strip
  // them so downstream IPv6 range checks match the raw address.
  const rawHost = parsed.hostname;
  const ipv6 = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : null;
  const host = ipv6 ?? rawHost;
  // IPv4-mapped IPv6 address (e.g. ::ffff:10.0.0.1 / ::ffff:a00:1) — extract
  // the embedded IPv4 so the RFC1918 / loopback regexes below can match.
  let mappedV4: string | null = null;
  if (ipv6) {
    const mapped = ipv6.match(/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d{1,3}(?:\.\d{1,3}){3}))$/i);
    if (mapped) {
      if (mapped[3]) {
        mappedV4 = mapped[3];
      } else {
        const hi = parseInt(mapped[1]!, 16);
        const lo = parseInt(mapped[2]!, 16);
        mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      }
    }
  }
  const v4Candidates = [host, mappedV4].filter((h): h is string => !!h);
  const isBlocked =
    host === 'localhost' ||
    host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^fe80:/i.test(host) ||
    /^fd[0-9a-f]{0,2}:/i.test(host) ||
    /^fc[0-9a-f]{0,2}:/i.test(host) ||
    v4Candidates.some((h) => /^127\./.test(h)) ||
    v4Candidates.some((h) => /^10\./.test(h)) ||
    v4Candidates.some((h) => /^192\.168\./.test(h)) ||
    v4Candidates.some((h) => /^169\.254\./.test(h)) ||
    v4Candidates.some((h) => /^172\.(1[6-9]|2\d|3[01])\./.test(h));
  if (isBlocked) return null;
  return { token: ha_api_key, url: parsed.origin };
}

function haHeaders(creds: HACredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.token}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchStates(creds: HACredentials): Promise<any[]> {
  const resp = await fetch(`${creds.url}/api/states`, { headers: haHeaders(creds) });
  if (!resp.ok) throw new Error(`HA API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

export async function getEntityState(creds: HACredentials, entityId: string): Promise<any | null> {
  const resp = await fetch(`${creds.url}/api/states/${entityId}`, { headers: haHeaders(creds) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HA API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function callService(
  creds: HACredentials,
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<any> {
  const resp = await fetch(`${creds.url}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: haHeaders(creds),
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`HA API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

function normalize(text: string): string {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isEntityId(id: string): boolean {
  if (!id.includes('.')) return false;
  const domain = id.split('.')[0];
  return (ALLOWED_DOMAINS as readonly string[]).includes(domain);
}

function inferDomain(text: string): string[] | null {
  const t = normalize(text);
  if (/light|lamp|bulb/.test(t)) return ['light', 'switch'];
  if (/fan/.test(t)) return ['fan', 'switch'];
  if (/switch|outlet|plug|relay/.test(t)) return ['switch'];
  if (/media.player|tv|speaker/.test(t)) return ['media_player'];
  return null;
}

/**
 * Resolve a user-provided identifier (entity_id or friendly name) to a concrete entity_id.
 * Returns [entity_id, error]. One will be null.
 */
export async function resolveEntityId(
  creds: HACredentials,
  identifier: string,
): Promise<[string | null, string | null]> {
  if (!identifier?.trim()) return [null, 'Invalid entity identifier'];

  const candidate = identifier.trim();

  // If it looks like an entity_id, verify it exists
  if (isEntityId(candidate)) {
    const state = await getEntityState(creds, candidate);
    if (state) return [candidate, null];
    // Legacy fallback: derive a friendly-name query from the entity_id
    // e.g. "fan.living_room" → "living room"
    const fallbackQuery = candidate.replace(/[_.]/g, ' ').trim();
    if (fallbackQuery) {
      const [resolved] = await resolveEntityId(creds, fallbackQuery);
      if (resolved) return [resolved, null];
    }
    return [null, `Entity '${identifier}' not found`];
  }

  const states = await fetchStates(creds);
  const target = normalize(candidate);
  const allowedDomains = inferDomain(candidate);

  // Exact friendly name match
  const exact: string[] = [];
  for (const st of states) {
    const eid = st.entity_id;
    if (!eid || !eid.includes('.')) continue;
    const domain = eid.split('.')[0];
    if (!(ALLOWED_DOMAINS as readonly string[]).includes(domain)) continue;
    if (allowedDomains && !allowedDomains.includes(domain)) continue;
    const fname = normalize(st.attributes?.friendly_name || '');
    if (fname === target) exact.push(eid);
  }
  if (exact.length === 1) return [exact[0], null];
  if (exact.length > 1) return [null, `Multiple entities match: ${exact.slice(0, 5).join(', ')}`];

  // Partial match fallback
  const partial: string[] = [];
  for (const st of states) {
    const eid = st.entity_id;
    if (!eid || !eid.includes('.')) continue;
    const domain = eid.split('.')[0];
    if (!(ALLOWED_DOMAINS as readonly string[]).includes(domain)) continue;
    if (allowedDomains && !allowedDomains.includes(domain)) continue;
    const fname = normalize(st.attributes?.friendly_name || '');
    if (fname && (target.includes(fname) || fname.includes(target))) partial.push(eid);
  }
  if (partial.length === 1) return [partial[0], null];
  if (partial.length > 1) return [null, `Multiple entities partially match: ${partial.slice(0, 5).join(', ')}`];

  return [null, `Entity '${identifier}' not found`];
}
