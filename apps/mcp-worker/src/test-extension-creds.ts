/**
 * POST /test-extension-creds — Worker-side credential probe.
 *
 * R2 audit F5 closes the "browser-side probe is the wrong layer" gap.
 * Tests that fire from the user's browser confirm browser → upstream
 * reachability — but the production tool-call always runs from this
 * Worker, where IP allow-lists, CORS rules, and self-hosted endpoints
 * may behave differently. Doing the probe here gives the operator a
 * faithful preview of the real tool-call path.
 *
 * Auth: Supabase JWT in Authorization: Bearer (same scheme as
 * /v1/chat/completions). API keys NOT accepted — the Hub UI is the
 * only intended caller.
 *
 * Body:
 *   {
 *     extension: 'obsidian' | 'todoist' | 'homeassistant',
 *     creds: Record<string, string> | null,
 *     use_stored: boolean
 *   }
 *
 * When use_stored=true, the Worker pulls the user's encrypted creds
 * from hub.extension_settings via the existing
 * get_extension_credentials_admin RPC and probes with those. When
 * use_stored=false (or omitted), the Worker probes with the supplied
 * `creds` object — this path is used for first-time setup before the
 * user clicks Save.
 *
 * Response: 200 with { ok: boolean, message: string }. Worker errors
 * (parse, auth, etc.) return non-200 with { ok: false, message }.
 */

import { authenticateJwt } from './auth';
import { createServiceClient } from './supabase';
import { CORS_HEADERS } from './cors';

interface ProbeBody {
  extension?: string;
  creds?: Record<string, string> | null;
  use_stored?: boolean;
}

interface ProbeResult {
  ok: boolean;
  message: string;
}

function jsonResponse(body: ProbeResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Probe a single extension's credentials by hitting a minimal,
 * read-only upstream endpoint. Returns { ok, message }.
 *
 * Obsidian and Todoist are wired up here. Home Assistant is FLAGGED
 * (FLAG-03 in UX_AUDIT_HUB_MCP_LIVETRACK_FLAGS.md) — the user's HA
 * instance may be LAN-only, so we surface a clear "test not yet
 * supported" instead of silently failing or pretending it worked.
 */
export async function probeUpstream(extension: string, creds: Record<string, string>): Promise<ProbeResult> {
  if (extension === 'obsidian') {
    const repo = (creds.github_repo ?? '').trim();
    const token = (creds.github_token ?? '').trim();
    const apiBase = ((creds.github_api_url ?? '').trim() || 'https://api.github.com').replace(/\/$/, '');
    if (!repo || !token) return { ok: false, message: 'Repo + Token are required.' };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { ok: false, message: 'Repo must be in the form owner/repo.' };
    }
    try {
      const res = await fetch(`${apiBase}/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Authentication rejected (${res.status}). Check the token.` };
      }
      if (res.status === 404) {
        return { ok: false, message: 'Repo not found. Check the owner/repo and that the token can see it.' };
      }
      if (!res.ok) return { ok: false, message: `Upstream returned HTTP ${res.status}.` };
      return { ok: true, message: 'Repo reachable with this token.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Network error.' };
    }
  }
  if (extension === 'todoist') {
    const token = (creds.todoist_api_key ?? '').trim();
    if (!token) return { ok: false, message: 'API token is required.' };
    try {
      const res = await fetch('https://api.todoist.com/rest/v2/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Authentication rejected (${res.status}). Check the token.` };
      }
      if (!res.ok) return { ok: false, message: `Todoist returned HTTP ${res.status}.` };
      const json = (await res.json()) as unknown;
      const count = Array.isArray(json) ? json.length : 0;
      return { ok: true, message: `Token works. ${count} project${count === 1 ? '' : 's'} visible.` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Network error.' };
    }
  }
  if (extension === 'homeassistant') {
    // FLAG-03 closure. Probe `{ha_url}/api/` with the long-lived token.
    // HA returns `{"message":"API running."}` on success. The Worker
    // can only reach internet-accessible HA instances; LAN-only setups
    // (192.168.*, 10.*, *.local, homeassistant.local) will time out
    // here. We surface that as a clear "LAN-only host" message instead
    // of a generic Network error so the user knows the cred itself
    // might be valid.
    const url = (creds.ha_url ?? '').trim();
    const token = (creds.ha_token ?? '').trim();
    if (!url || !token) return { ok: false, message: 'Base URL + token are required.' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: 'Base URL is not a valid URL (include http:// or https://).' };
    }
    const host = parsed.hostname;
    const isPrivate =
      /^(192\.168\.|10\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      host.endsWith('.internal');
    if (isPrivate) {
      return {
        ok: false,
        message:
          "Your HA URL points to a private/LAN address. The cloud Worker can't reach LAN-only hosts; expose HA via a public hostname (Cloudflare Tunnel, Nabu Casa, etc.) to enable testing.",
      };
    }
    try {
      const apiBase = url.replace(/\/$/, '');
      const res = await fetch(`${apiBase}/api/`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        // Short timeout so a stalled HA box doesn't burn 30s of Worker
        // CPU. AbortSignal.timeout is supported on Cloudflare Workers.
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Authentication rejected (${res.status}). Check the long-lived token.` };
      }
      if (res.status === 404) {
        return {
          ok: false,
          message: '404 from /api/. Confirm the base URL points to your HA root (no trailing /api).',
        };
      }
      if (!res.ok) return { ok: false, message: `HA returned HTTP ${res.status}.` };
      return { ok: true, message: 'HA reachable with this token.' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error.';
      // AbortSignal.timeout produces a TimeoutError which surfaces as
      // a clear "host is unreachable" signal; bubble it as a hint.
      if (msg.includes('timeout') || msg.includes('aborted')) {
        return {
          ok: false,
          message: 'Timed out reaching HA. Confirm the URL is publicly accessible and HA is running.',
        };
      }
      return { ok: false, message: msg };
    }
  }
  return { ok: false, message: 'Live test not yet supported for this extension.' };
}

export async function handleTestExtensionCreds(
  request: Request,
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string },
): Promise<Response> {
  // Auth: JWT only. API keys are deliberately NOT accepted — the Hub
  // UI is the only intended caller and it always has a session JWT.
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, message: 'Authentication required.' }, 401);
  }
  const token = authHeader.slice(7);
  const supabase = createServiceClient(env);
  const userId = await authenticateJwt(supabase, token);
  if (!userId) {
    return jsonResponse({ ok: false, message: 'Invalid or expired session.' }, 401);
  }

  let body: ProbeBody;
  try {
    body = (await request.json()) as ProbeBody;
  } catch {
    return jsonResponse({ ok: false, message: 'Invalid JSON body.' }, 400);
  }

  const extension = (body.extension ?? '').trim().toLowerCase();
  if (!extension) {
    return jsonResponse({ ok: false, message: 'Missing extension name.' }, 400);
  }

  let creds: Record<string, string> = {};
  if (body.use_stored) {
    // Pull encrypted creds from hub.extension_settings via the same
    // RPC the tool-executor uses at runtime. This is exactly the
    // "would the next tool call work?" question the operator wants
    // answered after Save.
    const { data: decryptedJson, error: decryptErr } = await supabase
      .schema('hub')
      .rpc('get_extension_credentials_admin', {
        p_user_id: userId,
        p_extension_name: extension,
      });
    if (decryptErr || !decryptedJson) {
      return jsonResponse({ ok: false, message: 'No saved credentials found for this extension.' }, 200);
    }
    try {
      creds = JSON.parse(decryptedJson);
    } catch {
      return jsonResponse({ ok: false, message: 'Failed to parse saved credentials.' }, 200);
    }
  } else {
    if (!body.creds || typeof body.creds !== 'object') {
      return jsonResponse({ ok: false, message: 'Missing credentials.' }, 400);
    }
    creds = body.creds as Record<string, string>;
  }

  const result = await probeUpstream(extension, creds);
  return jsonResponse(result, 200);
}
