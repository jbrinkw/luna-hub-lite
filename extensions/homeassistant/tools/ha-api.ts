import type { ExtensionToolContext } from '@luna-hub/app-tools';
import { ALLOWED_DOMAINS } from './constants';

export interface HACredentials {
  token: string;
  url: string;
}

export function getHACredentials(ctx: ExtensionToolContext): HACredentials | null {
  const { ha_api_key, ha_url } = ctx.credentials;
  if (!ha_api_key || !ha_url) return null;
  return { token: ha_api_key, url: ha_url.replace(/\/+$/, '') };
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
