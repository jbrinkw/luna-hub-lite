import type { ExtensionToolContext } from '@luna-hub/app-tools';

const GITHUB_API = 'https://api.github.com';

/** Decode base64 to UTF-8 string (handles multi-byte chars unlike atob) */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode UTF-8 string to base64 (handles multi-byte chars unlike btoa) */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface GitCredentials {
  token: string;
  repo: string; // "owner/repo"
  apiUrl: string; // base URL (no trailing slash)
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
}

/**
 * SSRF guard — reject user-supplied URLs that point at loopback, link-local,
 * cloud metadata, RFC1918, IPv6 loopback/link-local/ULA, mapped IPv4, or
 * non-http(s) schemes. Mirrors the ha-api.ts policy since the GitHub Enterprise
 * `github_api_url` is free-form user input exactly like `ha_url`.
 *
 * Returns the normalized origin (protocol + hostname + port, no trailing slash)
 * when the URL is safe, or null if blocked or unparseable.
 */
function validateGitApiUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const rawHost = parsed.hostname;
  const ipv6 = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : null;
  const host = ipv6 ?? rawHost;
  // IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.1) — extract embedded IPv4
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
  // origin drops trailing slashes and normalizes case — matches what the old
  // `(github_api_url || GITHUB_API).replace(/\/+$/, '')` produced.
  return parsed.origin;
}

export function getGitCredentials(ctx: ExtensionToolContext): GitCredentials | null {
  const { github_token, github_repo, github_api_url } = ctx.credentials;
  if (!github_token || !github_repo) return null;
  // Default GITHUB_API is a public hostname so skip the SSRF check on it.
  // Any user-supplied override (self-hosted GitHub Enterprise) MUST pass the
  // private-network / loopback filter — otherwise an attacker with write
  // access to their own extension settings could aim the Worker's fetch at
  // cloud metadata services or internal LAN IPs.
  let apiUrl: string;
  if (github_api_url && github_api_url.trim().length > 0) {
    const validated = validateGitApiUrl(github_api_url);
    if (!validated) return null;
    apiUrl = validated;
  } else {
    apiUrl = GITHUB_API;
  }
  return {
    token: github_token,
    repo: github_repo,
    apiUrl,
  };
}

function repoUrl(creds: GitCredentials): string {
  return `${creds.apiUrl}/repos/${creds.repo}`;
}

function headers(creds: GitCredentials): Record<string, string> {
  return {
    Authorization: `token ${creds.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'luna-hub-mcp/1.0',
  };
}

/**
 * Fetch the full repo tree in ONE call. Returns all blob entries with path + sha.
 * This is the only "list" call needed — everything else uses sha-based lookups.
 */
export async function getTree(creds: GitCredentials): Promise<TreeEntry[]> {
  const url = `${repoUrl(creds)}/git/trees/main?recursive=1`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as { tree: Array<{ type: string; path: string; sha: string }> };
  return (data.tree || [])
    .filter((node) => node.type === 'blob')
    .map((node) => ({ path: node.path, sha: node.sha, type: 'blob' as const }));
}

/**
 * Fetch a single file's content by SHA using the Blobs API (1 call).
 * More efficient than Contents API — no path encoding issues, works with SHA from tree.
 */
export async function getBlobContent(creds: GitCredentials, sha: string): Promise<string> {
  const url = `${repoUrl(creds)}/git/blobs/${sha}`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as { content: string; encoding: string };
  if (data.encoding === 'base64') {
    return base64ToUtf8(data.content);
  }
  return data.content;
}

/**
 * Fetch multiple files by SHA in parallel. Capped at maxFiles to stay within
 * the Cloudflare Workers subrequest limit.
 */
export async function getMultipleBlobs(
  creds: GitCredentials,
  entries: Array<{ path: string; sha: string }>,
  maxFiles = 40,
): Promise<Map<string, { content: string; sha: string }>> {
  const results = new Map<string, { content: string; sha: string }>();
  const toFetch = entries.slice(0, maxFiles);
  const fetches = toFetch.map(async (e) => {
    try {
      const content = await getBlobContent(creds, e.sha);
      results.set(e.path, { content, sha: e.sha });
    } catch {
      // Skip files that fail to fetch
    }
  });
  await Promise.all(fetches);
  return results;
}

/** Fetch a single file's content by path via Contents API. Returns null if 404. */
export async function getFileContent(
  creds: GitCredentials,
  path: string,
): Promise<{ content: string; sha: string } | null> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `${repoUrl(creds)}/contents/${encodedPath}`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  const content = base64ToUtf8((data as { content: string }).content);
  return { content, sha: (data as { sha: string }).sha };
}

/** Create or update a file. If sha is provided, it's an update. */
export async function putFileContent(
  creds: GitCredentials,
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `${repoUrl(creds)}/contents/${encodedPath}`;
  const body: Record<string, string> = {
    message,
    content: utf8ToBase64(content),
  };
  if (sha) body.sha = sha;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: headers(creds),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Git API error: ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`);
  }
}

// ── Legacy exports (kept for backward compat, but prefer getTree + getMultipleBlobs) ──

/** @deprecated Use getTree() instead */
export async function listAllFiles(creds: GitCredentials): Promise<string[]> {
  const tree = await getTree(creds);
  return tree.map((e) => e.path);
}

/** @deprecated Use getMultipleBlobs() instead — this makes N+0 subrequests */
export async function getMultipleFiles(
  creds: GitCredentials,
  paths: string[],
): Promise<Map<string, { content: string; sha: string }>> {
  const results = new Map<string, { content: string; sha: string }>();
  const fetches = paths.map(async (p) => {
    const file = await getFileContent(creds, p);
    if (file) results.set(p, file);
  });
  await Promise.all(fetches);
  return results;
}
