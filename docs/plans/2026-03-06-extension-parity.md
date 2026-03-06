# Extension Feature Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite all 3 extensions (Obsidian, Todoist, Home Assistant) to match legacy functionality exactly, with real integration tests against live APIs.

**Architecture:** Extensions are serverless TypeScript tool handlers in `extensions/*/tools/`. They make HTTP calls to external APIs (GitHub-compatible Git API, Todoist REST v2, HA REST API). Tools are registered in the MCP Worker via `ExtensionToolDefinition`. Local testing uses Gitea (Docker, port 3000) for Git API and Home Assistant (Docker, port 8123). Todoist tests hit the real API.

**Tech Stack:** TypeScript, Vitest, Docker (Gitea + HA), Todoist REST v2, GitHub/Gitea Contents API, HA REST API

---

## Task 1: Set up Gitea Docker for local Git API testing

**Files:**

- Create: `scripts/setup-gitea.sh`

**Step 1: Write the Gitea setup script**

```bash
#!/usr/bin/env bash
# Sets up Gitea in Docker with a test user and vault repo.
# Idempotent — safe to run multiple times.
set -euo pipefail

GITEA_PORT=3000
GITEA_CONTAINER=luna-gitea-test
GITEA_URL="http://localhost:${GITEA_PORT}"
GITEA_USER=testuser
GITEA_PASS=testpass123
GITEA_EMAIL=test@luna.dev
REPO_NAME=obsidian-vault

# Start container if not running
if ! docker ps --format '{{.Names}}' | grep -q "^${GITEA_CONTAINER}$"; then
  docker rm -f "${GITEA_CONTAINER}" 2>/dev/null || true
  docker run -d \
    --name "${GITEA_CONTAINER}" \
    -p "${GITEA_PORT}:3000" \
    -e GITEA__security__INSTALL_LOCK=true \
    -e GITEA__server__ROOT_URL="${GITEA_URL}" \
    -e GITEA__server__OFFLINE_MODE=true \
    gitea/gitea:latest-rootless
  echo "Waiting for Gitea to start..."
  for i in $(seq 1 30); do
    if curl -sf "${GITEA_URL}/api/v1/version" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# Create admin user (idempotent — fails silently if exists)
docker exec "${GITEA_CONTAINER}" gitea admin user create \
  --username "${GITEA_USER}" \
  --password "${GITEA_PASS}" \
  --email "${GITEA_EMAIL}" \
  --admin 2>/dev/null || true

# Generate API token
TOKEN_RESP=$(curl -sf -X POST "${GITEA_URL}/api/v1/users/${GITEA_USER}/tokens" \
  -u "${GITEA_USER}:${GITEA_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"luna-test-$(date +%s)\",\"scopes\":[\"all\"]}" 2>/dev/null || echo '{}')
TOKEN=$(echo "${TOKEN_RESP}" | grep -o '"sha1":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "${TOKEN}" ]; then
  echo "Token already exists or creation failed, using basic auth for setup"
  AUTH_HEADER="-u ${GITEA_USER}:${GITEA_PASS}"
else
  AUTH_HEADER="-H \"Authorization: token ${TOKEN}\""
  echo "GITEA_TOKEN=${TOKEN}"
fi

# Create repo if it doesn't exist
REPO_CHECK=$(curl -sf -o /dev/null -w "%{http_code}" \
  -u "${GITEA_USER}:${GITEA_PASS}" \
  "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}" 2>/dev/null || echo "000")

if [ "${REPO_CHECK}" != "200" ]; then
  curl -sf -X POST "${GITEA_URL}/api/v1/user/repos" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${REPO_NAME}\",\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
  echo "Created repo ${GITEA_USER}/${REPO_NAME}"
fi

# Seed vault with test data — project pages + notes
seed_file() {
  local path="$1" content="$2"
  local b64=$(echo -n "${content}" | base64 -w 0)
  # Check if file exists
  local check=$(curl -sf -o /dev/null -w "%{http_code}" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}/contents/${path}" 2>/dev/null || echo "000")
  if [ "${check}" = "200" ]; then
    return 0  # Already seeded
  fi
  curl -sf -X POST \
    "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}/contents/${path}" \
    -u "${GITEA_USER}:${GITEA_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"${b64}\",\"message\":\"seed: ${path}\"}" >/dev/null
}

# Project: Luna Development (root)
seed_file "Projects/Luna/Luna.md" "---
project_id: luna-development
---

# Luna Development

Main development project for Luna Hub."

# Project: Luna Lite (child of Luna Development)
seed_file "Projects/Luna/Lite/Lite.md" "---
project_id: luna-lite
project_parent: luna-development
---

# Luna Lite

Serverless refactor of Luna Hub."

# Notes for Luna Lite
seed_file "Projects/Luna/Lite/Notes.md" "---
note_project_id: luna-lite
---

3/5/26

Started extension parity work.

## Milestones

Completed DB schema.

3/4/26

Set up Gitea for testing.

3/1/26

Initial project setup."

# Project: Research (root)
seed_file "Projects/Research/Research.md" "---
project_id: research
---

# Research

General research notes."

# Notes for Research
seed_file "Projects/Research/Notes.md" "---
note_project_id: research
---

3/6/26

Explored Home Assistant onboarding API.

3/3/26

Reviewed Obsidian sync architecture."

echo ""
echo "Gitea ready at ${GITEA_URL}"
echo "Repo: ${GITEA_USER}/${REPO_NAME}"
echo "User: ${GITEA_USER} / ${GITEA_PASS}"
[ -n "${TOKEN:-}" ] && echo "Token: ${TOKEN}"
```

**Step 2: Run the script**

Run: `chmod +x scripts/setup-gitea.sh && bash scripts/setup-gitea.sh`
Expected: Gitea running on port 3000 with seeded vault repo

**Step 3: Commit**

```bash
git add scripts/setup-gitea.sh
git commit -m "chore: add Gitea Docker setup script for extension testing"
```

---

## Task 2: Set up Home Assistant Docker for local testing

**Files:**

- Create: `scripts/setup-ha.sh`

**Step 1: Write the HA setup script**

```bash
#!/usr/bin/env bash
# Sets up Home Assistant in Docker with programmatic onboarding.
# Outputs HA_TOKEN for use in tests.
set -euo pipefail

HA_PORT=8123
HA_CONTAINER=luna-ha-test
HA_URL="http://localhost:${HA_PORT}"
HA_USER=testuser
HA_PASS=testpass123
HA_NAME="Test User"
CLIENT_ID="http://localhost"

# Start container if not running
if ! docker ps --format '{{.Names}}' | grep -q "^${HA_CONTAINER}$"; then
  docker rm -f "${HA_CONTAINER}" 2>/dev/null || true
  docker run -d \
    --name "${HA_CONTAINER}" \
    -p "${HA_PORT}:8123" \
    homeassistant/home-assistant:latest
  echo "Waiting for HA to start (this takes 30-60s)..."
  for i in $(seq 1 90); do
    if curl -sf "${HA_URL}/api/" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  # Extra wait for onboarding to be ready
  sleep 5
fi

# Check if already onboarded
ONBOARD_CHECK=$(curl -sf "${HA_URL}/api/onboarding" 2>/dev/null || echo "[]")
if echo "${ONBOARD_CHECK}" | grep -q '"done":true' 2>/dev/null || echo "${ONBOARD_CHECK}" | grep -q '"step":"done"' 2>/dev/null; then
  echo "HA already onboarded."
  echo "HA_URL=${HA_URL}"
  echo "Use existing token from previous run."
  exit 0
fi

# Step 1: Create owner account
echo "Creating owner account..."
AUTH_RESP=$(curl -sf -X POST "${HA_URL}/api/onboarding/users" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"${CLIENT_ID}\",
    \"name\": \"${HA_NAME}\",
    \"username\": \"${HA_USER}\",
    \"password\": \"${HA_PASS}\",
    \"language\": \"en\"
  }")
AUTH_CODE=$(echo "${AUTH_RESP}" | grep -o '"auth_code":"[^"]*"' | cut -d'"' -f4)

if [ -z "${AUTH_CODE}" ]; then
  echo "Failed to get auth_code. Response: ${AUTH_RESP}"
  exit 1
fi

# Step 2: Exchange auth code for tokens
echo "Exchanging auth code for tokens..."
TOKEN_RESP=$(curl -sf -X POST "${HA_URL}/auth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=${AUTH_CODE}&client_id=${CLIENT_ID}")
ACCESS_TOKEN=$(echo "${TOKEN_RESP}" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "${ACCESS_TOKEN}" ]; then
  echo "Failed to get access_token. Response: ${TOKEN_RESP}"
  exit 1
fi

# Step 3: Complete remaining onboarding steps
echo "Completing onboarding steps..."
curl -sf -X POST "${HA_URL}/api/onboarding/core_config" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' >/dev/null 2>&1 || true

curl -sf -X POST "${HA_URL}/api/onboarding/analytics" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' >/dev/null 2>&1 || true

curl -sf -X POST "${HA_URL}/api/onboarding/integration" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${CLIENT_ID}\"}" >/dev/null 2>&1 || true

# Step 4: Create a long-lived access token via REST API
echo "Creating long-lived access token..."
LLAT_RESP=$(curl -sf -X POST "${HA_URL}/auth/long_lived_access_token" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"luna-test","lifespan":365}' 2>/dev/null || echo "")

# If the REST endpoint doesn't work, the short-lived token still works for testing
if [ -n "${LLAT_RESP}" ]; then
  LLAT=$(echo "${LLAT_RESP}" | tr -d '"')
  echo ""
  echo "HA_URL=${HA_URL}"
  echo "HA_TOKEN=${LLAT}"
else
  echo ""
  echo "HA_URL=${HA_URL}"
  echo "HA_TOKEN=${ACCESS_TOKEN}"
  echo "(Using short-lived token — valid for 30 min)"
fi
```

**Step 2: Run the script**

Run: `chmod +x scripts/setup-ha.sh && bash scripts/setup-ha.sh`
Expected: HA running on port 8123, onboarded, token printed

**Step 3: Commit**

```bash
git add scripts/setup-ha.sh
git commit -m "chore: add Home Assistant Docker setup script for extension testing"
```

---

## Task 3: Rewrite Obsidian extension — GitHub/Gitea API backend

**Files:**

- Modify: `extensions/obsidian/config.json`
- Delete: `extensions/obsidian/tools/search-notes.ts`, `create-note.ts`, `get-note.ts`, `update-note.ts`
- Create: `extensions/obsidian/tools/get-project-hierarchy.ts`
- Create: `extensions/obsidian/tools/get-project-text.ts`
- Create: `extensions/obsidian/tools/get-notes-by-date-range.ts`
- Create: `extensions/obsidian/tools/update-project-note.ts`
- Create: `extensions/obsidian/tools/git-api.ts` (shared helper)
- Modify: `extensions/obsidian/tools/index.ts`

### Step 1: Update config.json credentials

Change from `obsidian_api_key, obsidian_url` to `github_token, github_repo, github_api_url`.

```json
{
  "name": "obsidian",
  "displayName": "Obsidian Vault",
  "description": "Integration with Obsidian vault via GitHub-compatible Git API (GitHub, Gitea, etc.)",
  "credentialFields": ["github_token", "github_repo", "github_api_url"]
}
```

### Step 2: Create git-api.ts shared helper

This helper wraps the GitHub/Gitea Contents API. Both APIs share the same REST shape:

- `GET /repos/:owner/:repo/contents/:path` → file content (base64)
- `PUT /repos/:owner/:repo/contents/:path` → create/update file
- `GET /repos/:owner/:repo/git/trees/:sha?recursive=1` → list all files

```typescript
// extensions/obsidian/tools/git-api.ts
import type { ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';

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
  // GitHub: /repos/owner/repo  |  Gitea: /repos/owner/repo (same)
  return `${creds.apiUrl}/repos/${creds.repo}`;
}

function headers(creds: GitCredentials): Record<string, string> {
  // GitHub uses "Bearer", Gitea uses "token" — but both accept "token" style
  // Actually GitHub accepts both. Use Authorization: token X for compat.
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
  const content = atob(data.content.replace(/\n/g, ''));
  return { content, sha: data.sha };
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
  // Use git trees API for efficiency (single request)
  const url = `${repoUrl(creds)}/git/trees/main?recursive=1`;
  const resp = await fetch(url, { headers: headers(creds) });
  if (!resp.ok) throw new Error(`Git API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return (data.tree || []).filter((node: any) => node.type === 'blob').map((node: any) => node.path);
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
```

### Step 3: Create get-project-hierarchy.ts

Matches legacy `NOTES_GET_project_hierarchy` — lists all .md files, parses YAML frontmatter for `project_id`/`project_parent`, builds tree, returns simplified hierarchy.

```typescript
// extensions/obsidian/tools/get-project-hierarchy.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles } from './git-api';
import { buildProjects, linkNotes, rootsOf, type Project } from './vault-parser';

export const OBSIDIAN_get_project_hierarchy: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_hierarchy',
  extensionName: 'obsidian',
  description:
    'Return a simplified hierarchy of projects in the Obsidian vault: root project names and immediate child names.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    try {
      const allFiles = await listAllFiles(creds);
      const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
      const fileContents = await getMultipleFiles(creds, mdFiles);

      const projects = buildProjects(fileContents);
      linkNotes(fileContents, projects);

      const lines: string[] = [];
      for (const rootId of rootsOf(projects)) {
        const root = projects.get(rootId)!;
        lines.push(root.displayName);
        for (const childId of root.children) {
          const child = projects.get(childId);
          if (child) lines.push(`- ${child.displayName}`);
        }
        lines.push('');
      }
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      return toolSuccess({ status: 'success', hierarchy: lines.join('\n') });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
```

### Step 4: Create vault-parser.ts

Shared parsing logic — mirrors legacy `project_hierarchy.py` and `notes_tools.py` date parsing.

```typescript
// extensions/obsidian/tools/vault-parser.ts

export interface Project {
  projectId: string;
  filePath: string;
  displayName: string;
  parentId: string | null;
  children: string[];
  noteFile: string | null;
  frontmatter: Record<string, string>;
}

/** Parse YAML frontmatter from markdown text. Returns key-value pairs. */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const fm: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    let val = lines[i].slice(colonIdx + 1).trim();
    // Strip inline comments
    const commentIdx = val.indexOf(' #');
    if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    if (key) fm[key] = val;
  }
  return fm;
}

/** Derive display name from file path (prefer folder name if stem matches). */
function deriveDisplayName(filePath: string, projectId: string): string {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1];
  const stem = fileName.replace(/\.md$/, '');
  const parentDir = parts.length >= 2 ? parts[parts.length - 2] : '';
  if (stem.toLowerCase() === parentDir.toLowerCase()) return parentDir;
  return stem || projectId;
}

/** Build projects map from file contents. */
export function buildProjects(files: Map<string, { content: string; sha: string }>): Map<string, Project> {
  const projects = new Map<string, Project>();

  for (const [path, { content }] of files) {
    if (!path.endsWith('.md')) continue;
    const fm = parseFrontmatter(content);
    const pid = fm.project_id;
    if (!pid) continue;
    projects.set(pid, {
      projectId: pid,
      filePath: path,
      displayName: deriveDisplayName(path, pid),
      parentId: fm.project_parent || null,
      children: [],
      noteFile: null,
      frontmatter: fm,
    });
  }

  // Link children
  for (const proj of projects.values()) {
    if (proj.parentId && projects.has(proj.parentId)) {
      projects.get(proj.parentId)!.children.push(proj.projectId);
    }
  }

  // Sort children by display name
  for (const proj of projects.values()) {
    proj.children.sort((a, b) => {
      const pa = projects.get(a);
      const pb = projects.get(b);
      return (pa?.displayName || '').toLowerCase().localeCompare((pb?.displayName || '').toLowerCase());
    });
  }

  return projects;
}

/** Link *Notes.md files to projects via note_project_id frontmatter. */
export function linkNotes(files: Map<string, { content: string; sha: string }>, projects: Map<string, Project>): void {
  for (const [path, { content }] of files) {
    if (!path.endsWith('.md')) continue;
    const fm = parseFrontmatter(content);
    const nid = fm.note_project_id;
    if (!nid) continue;
    const proj = projects.get(nid);
    if (proj && !proj.noteFile) proj.noteFile = path;
  }
}

/** Get root project IDs (no parent or parent not found). */
export function rootsOf(projects: Map<string, Project>): string[] {
  const roots: string[] = [];
  for (const [pid, proj] of projects) {
    if (!proj.parentId || !projects.has(proj.parentId)) roots.push(pid);
  }
  return roots.sort((a, b) => {
    const pa = projects.get(a);
    const pb = projects.get(b);
    return (pa?.displayName || '').toLowerCase().localeCompare((pb?.displayName || '').toLowerCase());
  });
}

/** Date regex matching MM/DD/YY with optional trailing colon. */
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}):?\s*$/;

export interface NoteEntry {
  date: Date;
  dateStr: string;
  content: string;
}

/** Parse dated entries from a Notes.md file body (after frontmatter). */
export function parseNoteEntries(text: string): NoteEntry[] {
  const lines = text.split('\n');

  // Skip frontmatter
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  const entries: NoteEntry[] = [];
  let currentDate: Date | null = null;
  let currentDateStr = '';
  let currentBody: string[] = [];

  function flush() {
    if (currentDate && currentDateStr) {
      entries.push({
        date: currentDate,
        dateStr: currentDateStr,
        content: currentBody.join('\n').trim(),
      });
    }
    currentDate = null;
    currentDateStr = '';
    currentBody = [];
  }

  for (let i = bodyStart; i < lines.length; i++) {
    const m = lines[i].trim().match(DATE_RE);
    if (m) {
      flush();
      const [, mm, dd, yy] = m;
      const year = 2000 + parseInt(yy);
      try {
        currentDate = new Date(year, parseInt(mm) - 1, parseInt(dd));
        currentDateStr = lines[i].trim().replace(/:$/, '');
      } catch {
        currentDate = null;
      }
    } else if (currentDate !== null) {
      currentBody.push(lines[i]);
    }
  }
  flush();

  return entries;
}

/** Format a date as M/D/YY (matching legacy format). */
export function formatDateShort(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return `${m}/${day}/${yy}`;
}
```

### Step 5: Create get-project-text.ts

```typescript
// extensions/obsidian/tools/get-project-text.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles } from './git-api';
import { buildProjects, linkNotes } from './vault-parser';

export const OBSIDIAN_get_project_text: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_text',
  extensionName: 'obsidian',
  description: 'Return the root project page text and note page text for a given project_id or display name.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project ID or display name to look up' },
    },
    required: ['project_id'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');

    try {
      const allFiles = await listAllFiles(creds);
      const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
      const fileContents = await getMultipleFiles(creds, mdFiles);
      const projects = buildProjects(fileContents);
      linkNotes(fileContents, projects);

      // Resolve by project_id or display name (case-insensitive)
      const query = args.project_id.toLowerCase();
      let found: string | undefined;
      for (const [pid, proj] of projects) {
        if (pid.toLowerCase() === query || proj.displayName.toLowerCase() === query) {
          found = pid;
          break;
        }
      }
      if (!found) return toolError(`Project not found: ${args.project_id}`);

      const proj = projects.get(found)!;
      const rootFile = fileContents.get(proj.filePath);
      const noteFile = proj.noteFile ? fileContents.get(proj.noteFile) : null;

      return toolSuccess({
        status: 'success',
        project_id: found,
        root_page_path: proj.filePath,
        root_page_text: rootFile?.content ?? null,
        note_page_path: proj.noteFile,
        note_page_text: noteFile?.content ?? null,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
```

### Step 6: Create get-notes-by-date-range.ts

```typescript
// extensions/obsidian/tools/get-notes-by-date-range.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles } from './git-api';
import { parseNoteEntries } from './vault-parser';

function parseDateArg(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) throw new Error('Dates must be in MM/DD/YY format');
  return new Date(2000 + parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

export const OBSIDIAN_get_notes_by_date_range: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_notes_by_date_range',
  extensionName: 'obsidian',
  description: 'Return dated note entries within [start_date, end_date] (MM/DD/YY format), newest-first.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date in MM/DD/YY format' },
      end_date: { type: 'string', description: 'End date in MM/DD/YY format' },
    },
    required: ['start_date', 'end_date'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    let startDt: Date, endDt: Date;
    try {
      startDt = parseDateArg(args.start_date);
      endDt = parseDateArg(args.end_date);
    } catch (e) {
      return toolError((e as Error).message);
    }
    if (endDt < startDt) [startDt, endDt] = [endDt, startDt];

    try {
      const allFiles = await listAllFiles(creds);
      const noteFiles = allFiles.filter((f) => /notes\.md$/i.test(f));
      const fileContents = await getMultipleFiles(creds, noteFiles);

      const results: Array<{ file: string; date: string; date_str: string; content: string }> = [];

      for (const [path, { content }] of fileContents) {
        const entries = parseNoteEntries(content);
        for (const entry of entries) {
          if (entry.date >= startDt && entry.date <= endDt) {
            results.push({
              file: path,
              date: entry.date.toISOString().split('T')[0],
              date_str: entry.dateStr,
              content: entry.content,
            });
          }
        }
      }

      results.sort((a, b) => b.date.localeCompare(a.date));

      return toolSuccess({
        status: 'success',
        start_date: args.start_date,
        end_date: args.end_date,
        entries: results,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
```

### Step 7: Create update-project-note.ts

```typescript
// extensions/obsidian/tools/update-project-note.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles, getFileContent, putFileContent } from './git-api';
import { buildProjects, linkNotes, parseNoteEntries, formatDateShort, parseFrontmatter } from './vault-parser';

export const OBSIDIAN_update_project_note: ExtensionToolDefinition = {
  name: 'OBSIDIAN_update_project_note',
  extensionName: 'obsidian',
  description:
    "Append content to today's dated note entry for a project. Creates file/entry if needed. Optionally place under a markdown section.",
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project ID or display name' },
      content: { type: 'string', description: 'Content to append' },
      section_id: { type: 'string', description: 'Optional markdown section to place content under' },
    },
    required: ['project_id', 'content'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');
    if (!args.content) return toolError('content is required');

    try {
      const allFiles = await listAllFiles(creds);
      const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
      const fileContents = await getMultipleFiles(creds, mdFiles);
      const projects = buildProjects(fileContents);
      linkNotes(fileContents, projects);

      // Resolve project
      const query = args.project_id.toLowerCase();
      let found: string | undefined;
      for (const [pid, proj] of projects) {
        if (pid.toLowerCase() === query || proj.displayName.toLowerCase() === query) {
          found = pid;
          break;
        }
      }
      if (!found) return toolError(`Project not found: ${args.project_id}`);

      const proj = projects.get(found)!;
      const todayStr = formatDateShort(new Date());
      let notePath = proj.noteFile;
      let createdFile = false;
      let existingContent = '';
      let existingSha: string | undefined;

      if (notePath) {
        const file = await getFileContent(creds, notePath);
        if (file) {
          existingContent = file.content;
          existingSha = file.sha;
        }
      }

      if (!notePath || (!existingSha && !notePath)) {
        // Derive notes path from project file path
        const projDir = proj.filePath.split('/').slice(0, -1).join('/');
        notePath = projDir ? `${projDir}/Notes.md` : 'Notes.md';
        createdFile = true;
        existingContent = `---\nnote_project_id: ${found}\n---\n\n`;
      }

      // Parse existing content and build new content
      const lines = existingContent.split('\n');

      // Find frontmatter end
      let bodyStart = 0;
      if (lines[0]?.trim() === '---') {
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim() === '---') {
            bodyStart = i + 1;
            break;
          }
        }
      }
      const fmLines = lines.slice(0, bodyStart);
      const bodyLines = lines.slice(bodyStart);

      // Find today's entry
      const dateRe = /^(\d{1,2})\/(\d{1,2})\/(\d{2}):?\s*$/;
      let todayIdx = -1;
      const dateIndices: number[] = [];
      for (let i = 0; i < bodyLines.length; i++) {
        if (dateRe.test(bodyLines[i].trim())) {
          dateIndices.push(i);
          if (bodyLines[i].trim().replace(/:$/, '') === todayStr) todayIdx = i;
        }
      }

      let createdEntry = false;
      let appended = false;
      const contentLine = args.content.endsWith('\n') ? args.content : args.content + '\n';

      if (todayIdx === -1) {
        // Insert new entry at top (before first date or end of body)
        const insertAt = dateIndices.length > 0 ? dateIndices[0] : bodyLines.length;
        const newEntry = args.section_id
          ? [`${todayStr}\n`, '\n', `## ${args.section_id}\n`, '\n', contentLine]
          : [`${todayStr}\n`, '\n', contentLine];
        bodyLines.splice(insertAt, 0, ...newEntry);
        createdEntry = true;
      } else {
        // Find entry end
        let entryEnd = bodyLines.length;
        for (const di of dateIndices) {
          if (di > todayIdx) {
            entryEnd = di;
            break;
          }
        }

        if (args.section_id) {
          const secRe = new RegExp(
            `^\\s*#{1,6}\\s+${args.section_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
            'i',
          );
          let secIdx = -1;
          for (let i = todayIdx + 1; i < entryEnd; i++) {
            if (secRe.test(bodyLines[i])) {
              secIdx = i;
              break;
            }
          }
          if (secIdx === -1) {
            // Add new section at end of entry
            bodyLines.splice(entryEnd, 0, '\n', `## ${args.section_id}\n`, '\n', contentLine);
          } else {
            // Find section end
            let secEnd = entryEnd;
            for (let i = secIdx + 1; i < entryEnd; i++) {
              if (/^\s*#{1,6}\s+/.test(bodyLines[i])) {
                secEnd = i;
                break;
              }
            }
            bodyLines.splice(secEnd, 0, contentLine);
          }
        } else {
          bodyLines.splice(entryEnd, 0, contentLine);
        }
        appended = true;
      }

      const newContent = [...fmLines, ...bodyLines].join('\n');
      await putFileContent(
        creds,
        notePath!,
        newContent,
        `note: ${todayStr} ${args.section_id ? `[${args.section_id}] ` : ''}update`,
        existingSha,
      );

      return toolSuccess({
        status: 'success',
        project_id: found,
        note_file: notePath,
        created_file: createdFile,
        created_entry: createdEntry,
        appended,
        date_str: todayStr,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
```

### Step 8: Update index.ts

```typescript
// extensions/obsidian/tools/index.ts
import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { OBSIDIAN_get_project_hierarchy } from './get-project-hierarchy';
import { OBSIDIAN_get_project_text } from './get-project-text';
import { OBSIDIAN_get_notes_by_date_range } from './get-notes-by-date-range';
import { OBSIDIAN_update_project_note } from './update-project-note';

export const obsidianTools: Record<string, ExtensionToolDefinition> = {
  OBSIDIAN_get_project_hierarchy,
  OBSIDIAN_get_project_text,
  OBSIDIAN_get_notes_by_date_range,
  OBSIDIAN_update_project_note,
};
```

### Step 9: Delete old files, commit

```bash
rm extensions/obsidian/tools/search-notes.ts extensions/obsidian/tools/create-note.ts \
   extensions/obsidian/tools/get-note.ts extensions/obsidian/tools/update-note.ts
git add extensions/obsidian/
git commit -m "feat(obsidian): rewrite to GitHub/Gitea API backend matching legacy tools"
```

---

## Task 4: Add missing Todoist tools (get_sections, get_task, update_task) + enhance create_task

**Files:**

- Create: `extensions/todoist/tools/get-sections.ts`
- Create: `extensions/todoist/tools/get-task.ts`
- Create: `extensions/todoist/tools/update-task.ts`
- Modify: `extensions/todoist/tools/create-task.ts` (add section_id, description)
- Modify: `extensions/todoist/tools/index.ts`

### Step 1: Create get-sections.ts

```typescript
// extensions/todoist/tools/get-sections.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_get_sections: ExtensionToolDefinition = {
  name: 'TODOIST_get_sections',
  extensionName: 'todoist',
  description: 'List sections, optionally filtered by project ID.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter sections by project ID' },
    },
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const params = new URLSearchParams();
      if (args.project_id) params.set('project_id', args.project_id);
      const qs = params.toString();
      const url = `${TODOIST_API_BASE}/sections${qs ? `?${qs}` : ''}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);
      return toolSuccess(await resp.json());
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
```

### Step 2: Create get-task.ts

```typescript
// extensions/todoist/tools/get-task.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_get_task: ExtensionToolDefinition = {
  name: 'TODOIST_get_task',
  extensionName: 'todoist',
  description: 'Get a single Todoist task by its ID.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to retrieve' },
    },
    required: ['task_id'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const resp = await fetch(`${TODOIST_API_BASE}/tasks/${encodeURIComponent(args.task_id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);
      return toolSuccess(await resp.json());
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
```

### Step 3: Create update-task.ts

```typescript
// extensions/todoist/tools/update-task.ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_update_task: ExtensionToolDefinition = {
  name: 'TODOIST_update_task',
  extensionName: 'todoist',
  description: 'Update an existing Todoist task. Only provided fields are changed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to update' },
      content: { type: 'string', description: 'New task content / title' },
      description: { type: 'string', description: 'New task description' },
      due_string: { type: 'string', description: 'New due date (e.g. "tomorrow")' },
      priority: { type: 'number', description: 'New priority (1-4)' },
    },
    required: ['task_id'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const body: Record<string, unknown> = {};
      if (args.content !== undefined) body.content = args.content;
      if (args.description !== undefined) body.description = args.description;
      if (args.due_string !== undefined) body.due_string = args.due_string;
      if (args.priority !== undefined) body.priority = args.priority;

      const resp = await fetch(`${TODOIST_API_BASE}/tasks/${encodeURIComponent(args.task_id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${todoist_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);
      return toolSuccess(await resp.json());
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
```

### Step 4: Enhance create-task.ts — add section_id and description

Add `section_id` and `description` to the `inputSchema.properties` and handler body construction.

### Step 5: Update index.ts

```typescript
import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { TODOIST_get_tasks } from './get-tasks';
import { TODOIST_get_task } from './get-task';
import { TODOIST_get_projects } from './get-projects';
import { TODOIST_get_sections } from './get-sections';
import { TODOIST_create_task } from './create-task';
import { TODOIST_update_task } from './update-task';
import { TODOIST_complete_task } from './complete-task';

export const todoistTools: Record<string, ExtensionToolDefinition> = {
  TODOIST_get_tasks,
  TODOIST_get_task,
  TODOIST_get_projects,
  TODOIST_get_sections,
  TODOIST_create_task,
  TODOIST_update_task,
  TODOIST_complete_task,
};
```

### Step 6: Commit

```bash
git add extensions/todoist/
git commit -m "feat(todoist): add get_sections, get_task, update_task + enhance create_task"
```

---

## Task 5: Rewrite Home Assistant extension — match legacy 5-tool set

**Files:**

- Delete: `extensions/homeassistant/tools/call-service.ts`, `get-entities.ts`, `get-entity-state.ts`
- Create: `extensions/homeassistant/tools/constants.ts`
- Create: `extensions/homeassistant/tools/ha-api.ts` (shared helper)
- Create: `extensions/homeassistant/tools/nl-formatters.ts`
- Create: `extensions/homeassistant/tools/get-devices.ts`
- Create: `extensions/homeassistant/tools/get-entity-status.ts`
- Create: `extensions/homeassistant/tools/turn-on.ts`
- Create: `extensions/homeassistant/tools/turn-off.ts`
- Create: `extensions/homeassistant/tools/tv-remote.ts`
- Modify: `extensions/homeassistant/tools/index.ts`

### Step 1: Create constants.ts

```typescript
// extensions/homeassistant/tools/constants.ts
export const ALLOWED_DOMAINS = ['light', 'switch', 'fan', 'media_player'] as const;
export type AllowedDomain = (typeof ALLOWED_DOMAINS)[number];
```

### Step 2: Create ha-api.ts — shared helper with entity resolution

Port the legacy `_resolve_entity_id` logic: accepts entity_id OR friendly_name, does exact match then partial match, infers domain from keywords.

```typescript
// extensions/homeassistant/tools/ha-api.ts
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
    // Fall through to try friendly name resolution
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
```

### Step 3: Create nl-formatters.ts

Direct TypeScript port of legacy `nl_formatters.py`.

```typescript
// extensions/homeassistant/tools/nl-formatters.ts

export function formatDevicesList(
  devices: Array<{ entity_id: string; domain: string; state: string; friendly_name: string }>,
): string {
  if (!devices.length) return 'No devices found in your Home Assistant setup.';

  const groups: Record<string, typeof devices> = { light: [], switch: [], fan: [], media_player: [] };
  for (const d of devices) {
    if (groups[d.domain]) groups[d.domain].push(d);
  }

  const labels: Record<string, string> = {
    light: 'Lights',
    switch: 'Switches',
    fan: 'Fans',
    media_player: 'Media Players',
  };
  const parts: string[] = [];
  for (const [domain, label] of Object.entries(labels)) {
    const items = groups[domain];
    if (!items?.length) continue;
    parts.push(`\n**${label}:**`);
    for (const d of items) {
      parts.push(`  - ${d.friendly_name} (${d.entity_id}): ${d.state}`);
    }
  }

  return `Found ${devices.length} device${devices.length !== 1 ? 's' : ''} in your home:\n${parts.join('\n')}`;
}

export function formatEntityStatus(
  entityId: string,
  state: string | null,
  attributes: Record<string, any>,
  friendlyName?: string,
): string {
  const name = friendlyName || attributes?.friendly_name || entityId;
  if (!state) return `The ${name} (${entityId}) status is unknown.`;

  const domain = entityId.split('.')[0];
  if (domain === 'media_player' && state === 'playing') {
    const parts = [`The ${name} (${entityId}) is playing`];
    const title = attributes?.media_title;
    const artist = attributes?.media_artist;
    if (title) parts.push(artist ? `'${title}' by ${artist}` : `'${title}'`);
    if (attributes?.app_name) parts.push(`via ${attributes.app_name}`);
    if (attributes?.volume_level != null) parts.push(`at ${Math.round(attributes.volume_level * 100)}% volume`);
    return parts.join(' ') + '.';
  }

  return `The ${name} (${entityId}) is ${state}.`;
}

export function formatActionResult(
  entityId: string,
  action: string,
  success: boolean,
  friendlyName?: string,
  errorMessage?: string,
): string {
  const name = friendlyName || entityId;
  if (!success) return errorMessage || `I couldn't ${action.replace('_', ' ')} the ${name}.`;
  if (action === 'turn_on') return `I've turned on the ${name}.`;
  if (action === 'turn_off') return `I've turned off the ${name}.`;
  return `I've performed the ${action.replace('_', ' ')} action on the ${name}.`;
}

export function formatTvRemoteAction(
  button: string,
  remoteEntity: string,
  success: boolean,
  errorMessage?: string,
): string {
  if (!success) return errorMessage || `I couldn't send the '${button}' command to your TV.`;

  const deviceName = remoteEntity.includes('.')
    ? remoteEntity
        .split('.')[1]
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : 'your TV';
  const b = button.toLowerCase().trim();

  // App launches
  if (b.startsWith('open ') || b.startsWith('launch ')) {
    const app = b.split(' ').slice(1).join(' ');
    return `I've launched ${app.charAt(0).toUpperCase() + app.slice(1)} on ${deviceName}.`;
  }
  const apps = ['youtube', 'netflix', 'spotify', 'disney', 'disney+'];
  if (apps.includes(b)) return `I've launched ${b.charAt(0).toUpperCase() + b.slice(1)} on ${deviceName}.`;

  const nav: Record<string, string> = {
    up: 'moved up',
    down: 'moved down',
    left: 'moved left',
    right: 'moved right',
    ok: 'pressed OK',
    enter: 'pressed Enter',
    select: 'pressed Select',
    back: 'pressed Back',
    home: 'pressed Home',
  };
  if (nav[b]) return `I've ${nav[b]} on ${deviceName}.`;

  const media: Record<string, string> = {
    play: 'started playback',
    pause: 'paused playback',
    'play/pause': 'toggled playback',
    stop: 'stopped playback',
    next: 'skipped to the next track',
    previous: 'gone back to the previous track',
    rewind: 'rewound',
    'fast forward': 'fast forwarded',
    ff: 'fast forwarded',
  };
  if (media[b]) return `I've ${media[b]} on ${deviceName}.`;

  const vol: Record<string, string> = {
    mute: 'muted',
    'volume up': 'turned up the volume',
    'vol up': 'turned up the volume',
    'volume down': 'turned down the volume',
    'vol down': 'turned down the volume',
  };
  if (vol[b]) return `I've ${vol[b]} on ${deviceName}.`;

  return `I've sent the '${button}' command to ${deviceName}.`;
}
```

### Step 4: Create 5 tool files

**get-devices.ts**: List devices in allowed domains with NL formatting.

**get-entity-status.ts**: Accept entity_id/friendly_name, resolve, return NL formatted status.

**turn-on.ts**: Resolve entity, call `{domain}/turn_on`, NL response.

**turn-off.ts**: Same pattern, `turn_off`.

**tv-remote.ts**: Button/app mapping, `remote.turn_on`/`remote.send_command`. Port the legacy `_parse_tv_remote_intent` command map and app map.

Each follows the `ExtensionToolDefinition` pattern. The handler uses `getHACredentials`, `resolveEntityId`, and NL formatters.

### Step 5: Update index.ts, delete old files, commit

```bash
rm extensions/homeassistant/tools/call-service.ts extensions/homeassistant/tools/get-entities.ts \
   extensions/homeassistant/tools/get-entity-state.ts
git add extensions/homeassistant/
git commit -m "feat(ha): rewrite to 5-tool legacy set with NL formatters and TV remote"
```

---

## Task 6: Update mocked unit tests for new tool signatures

**Files:**

- Modify: `packages/app-tools/src/__tests__/extensions.test.ts`

Rewrite the existing mocked test file to cover all new tools with the new signatures. The test structure stays the same (mock fetch globally, test success/error/missing-creds for each tool), but tool names, context helpers, and expected URLs change.

Key changes:

- Obsidian context: `github_token`, `github_repo`, `github_api_url` instead of `obsidian_api_key`, `obsidian_url`
- Obsidian tools: `OBSIDIAN_get_project_hierarchy`, `OBSIDIAN_get_project_text`, `OBSIDIAN_get_notes_by_date_range`, `OBSIDIAN_update_project_note`
- Todoist: Add tests for `TODOIST_get_sections`, `TODOIST_get_task`, `TODOIST_update_task`
- HA: New tool names `HOMEASSISTANT_get_devices`, `HOMEASSISTANT_get_entity_status`, `HOMEASSISTANT_turn_on`, `HOMEASSISTANT_turn_off`, `HOMEASSISTANT_tv_remote`
- HA context: same credentials `ha_api_key`, `ha_url`

### Commit

```bash
git add packages/app-tools/src/__tests__/extensions.test.ts
git commit -m "test: update mocked extension tests for new tool signatures"
```

---

## Task 7: Write live integration tests — Todoist

**Files:**

- Create: `packages/app-tools/src/__tests__/integration/todoist-live.test.ts`

These tests hit the real Todoist API with the provided key. They create real tasks, read them, update them, complete them, and verify everything round-trips.

**Test outline:**

1. `get_projects` — verify returns array with at least Inbox
2. `create_task` — create task with content + due_string + priority, verify returned ID
3. `get_task` — fetch by ID, verify content matches
4. `get_tasks` — list all, verify created task appears
5. `get_sections` — list sections for Inbox project
6. `update_task` — update content + priority, verify changes
7. `complete_task` — complete the task
8. Cleanup: delete task via API if test fails mid-way

**Environment:** `TODOIST_API_KEY` env var (the provided key).

```typescript
// packages/app-tools/src/__tests__/integration/todoist-live.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { todoistTools } from '../../../../extensions/todoist/tools';
import type { ExtensionToolContext } from '../../types';

const TODOIST_API_KEY = process.env.TODOIST_API_KEY;
const skip = !TODOIST_API_KEY;

function ctx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: { todoist_api_key: TODOIST_API_KEY! },
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe.skipIf(skip)('Todoist live integration', () => {
  const createdTaskIds: string[] = [];

  afterAll(async () => {
    // Cleanup: delete any created tasks
    for (const id of createdTaskIds) {
      await fetch(`https://api.todoist.com/rest/v2/tasks/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TODOIST_API_KEY}` },
      }).catch(() => {});
    }
  });

  it('lists projects including Inbox', async () => {
    const result = await todoistTools.TODOIST_get_projects.handler({}, ctx());
    const projects = parse(result);
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.some((p: any) => p.is_inbox_project)).toBe(true);
  });

  // ... (remaining tests follow same pattern)
});
```

### Commit

```bash
git add packages/app-tools/src/__tests__/integration/todoist-live.test.ts
git commit -m "test(todoist): add live integration tests against real API"
```

---

## Task 8: Write live integration tests — Obsidian (Gitea)

**Files:**

- Create: `packages/app-tools/src/__tests__/integration/obsidian-live.test.ts`

Tests hit the local Gitea instance. Environment: `GITEA_URL`, `GITEA_TOKEN`, `GITEA_REPO`.

**Test outline:**

1. `get_project_hierarchy` — verify returns seeded hierarchy (Luna Development, Research)
2. `get_project_text` — fetch luna-lite by project_id, verify root + notes content
3. `get_project_text` — fetch by display name ("Research"), verify works
4. `get_notes_by_date_range` — query 3/1/26 to 3/6/26, verify seeded entries returned
5. `update_project_note` — append to luna-lite, re-read and verify content added
6. `update_project_note` — append under section, verify section created
7. Error cases: missing project, invalid dates

### Commit

```bash
git add packages/app-tools/src/__tests__/integration/obsidian-live.test.ts
git commit -m "test(obsidian): add live integration tests against Gitea"
```

---

## Task 9: Write live integration tests — Home Assistant

**Files:**

- Create: `packages/app-tools/src/__tests__/integration/ha-live.test.ts`

Tests hit the local HA instance. Environment: `HA_URL`, `HA_TOKEN`.

**Test outline:**

1. `get_devices` — verify returns NL formatted string (may be empty on fresh install, that's OK)
2. `get_entity_status` — get status of a known entity (or verify graceful error)
3. `turn_on` / `turn_off` — if entities exist, toggle one; verify NL response format
4. `tv_remote` — send a command (may fail if no remote entity — verify error message)
5. Entity resolution — test friendly name lookup

### Commit

```bash
git add packages/app-tools/src/__tests__/integration/ha-live.test.ts
git commit -m "test(ha): add live integration tests against Docker HA"
```

---

## Task 10: Run full test suite + typecheck, fix issues

**Step 1:** `cd packages/app-tools && pnpm test` — run mocked tests
**Step 2:** Set env vars and run live tests:

```bash
export TODOIST_API_KEY="1e70ab7e143689d09ece3f478d82430de8e4d73e"
export GITEA_URL="http://localhost:3000/api/v1"
export GITEA_TOKEN="<from setup script>"
export GITEA_REPO="testuser/obsidian-vault"
export HA_URL="http://localhost:8123"
export HA_TOKEN="<from setup script>"
pnpm test:integration
```

**Step 3:** `pnpm run typecheck` (all packages)
**Step 4:** Fix any issues found

### Commit

```bash
git add -A
git commit -m "fix: resolve test and typecheck issues from extension rewrite"
```

---

## Task 11: Update docs and memory

**Files:**

- Modify: `docs/apps/hub.md` (update extension descriptions)
- Modify: `extensions/obsidian/config.json` (already done in Task 3)
- Modify: `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/current-task.md`

### Commit

```bash
git add docs/ extensions/
git commit -m "docs: update extension descriptions for feature parity rewrite"
```
