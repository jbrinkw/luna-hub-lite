import type { ExtensionToolContext } from '@luna-hub/app-tools';
import { validateExternalUrl } from '../../_lib/ssrf';

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

export function getGitCredentials(ctx: ExtensionToolContext): GitCredentials | null {
  const { github_token, github_repo, github_api_url } = ctx.credentials;
  if (!github_token || !github_repo) return null;
  // Default GITHUB_API is a public hostname so skip the SSRF check on it.
  // Any user-supplied override (self-hosted GitHub Enterprise) MUST pass the
  // shared private-network / loopback filter (see extensions/_lib/ssrf.ts) —
  // otherwise an attacker with write access to their own extension settings
  // could aim the Worker's fetch at cloud metadata services or internal LAN
  // IPs.
  let apiUrl: string;
  if (github_api_url && github_api_url.trim().length > 0) {
    const validated = validateExternalUrl(github_api_url);
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
 *
 * Returns both the successfully-fetched content map and a `failedCount` so
 * callers can surface partial-failure metadata to the LLM instead of silently
 * dropping files that fail to fetch.
 */
export async function getMultipleBlobs(
  creds: GitCredentials,
  entries: Array<{ path: string; sha: string }>,
  maxFiles = 40,
): Promise<{ blobs: Map<string, { content: string; sha: string }>; failedCount: number }> {
  const blobs = new Map<string, { content: string; sha: string }>();
  let failedCount = 0;
  const toFetch = entries.slice(0, maxFiles);
  const fetches = toFetch.map(async (e) => {
    try {
      const content = await getBlobContent(creds, e.sha);
      blobs.set(e.path, { content, sha: e.sha });
    } catch {
      // Count the failure so callers can surface omission metadata
      failedCount++;
    }
  });
  await Promise.all(fetches);
  return { blobs, failedCount };
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
