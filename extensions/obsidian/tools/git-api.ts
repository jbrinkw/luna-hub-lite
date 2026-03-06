import type { ExtensionToolContext } from '@luna-hub/app-tools';

const GITHUB_API = 'https://api.github.com';

export interface GitCredentials {
  token: string;
  repo: string; // "owner/repo"
  apiUrl: string; // base URL (no trailing slash)
}

export function getGitCredentials(ctx: ExtensionToolContext): GitCredentials | null {
  const { github_token, github_repo, github_api_url } = ctx.credentials;
  if (!github_token || !github_repo) return null;
  return {
    token: github_token,
    repo: github_repo,
    apiUrl: (github_api_url || GITHUB_API).replace(/\/+$/, ''),
  };
}

function repoUrl(creds: GitCredentials): string {
  return `${creds.apiUrl}/repos/${creds.repo}`;
}

function headers(creds: GitCredentials): Record<string, string> {
  // "token" style works with both GitHub and Gitea
  return {
    Authorization: `token ${creds.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/** Fetch a single file's content (decoded from base64). Returns null if 404. */
export async function getFileContent(
  creds: GitCredentials,
  path: string,
): Promise<{ content: string; sha: string } | null> {
  const url = `${repoUrl(creds)}/contents/${encodeURIComponent(path)}`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  const content = atob((data as { content: string }).content.replace(/\n/g, ''));
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
  const url = `${repoUrl(creds)}/contents/${encodeURIComponent(path)}`;
  const body: Record<string, string> = {
    message,
    content: btoa(content),
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

/** List all files in the repo recursively. Returns array of file paths. */
export async function listAllFiles(creds: GitCredentials): Promise<string[]> {
  const url = `${repoUrl(creds)}/git/trees/main?recursive=1`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return ((data as { tree: Array<{ type: string; path: string }> }).tree || [])
    .filter((node) => node.type === 'blob')
    .map((node) => node.path);
}

/** Fetch multiple files' content in parallel. Skips files that don't exist. */
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
