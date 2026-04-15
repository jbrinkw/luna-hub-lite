# Obsidian Folder-Convention Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace frontmatter-based project detection with folder-convention detection so the Obsidian extension scales to vaults of unlimited size within the Cloudflare Workers subrequest budget.

**Architecture:** The vault's folder tree becomes the source of truth for the project hierarchy. A folder is a project if it contains `FolderName/FolderName.md`. Parent-child is folder nesting. Notes file is `Notes.md` (case-insensitive) inside the project folder. Only the GitHub Git Trees API (1 subrequest) is needed for metadata; content fetches happen only when a tool explicitly needs file text.

**Tech Stack:** TypeScript, Cloudflare Workers, GitHub/Gitea Git API, vitest

**Parallelization strategy:**

- Task 1 (vault migration) and Tasks 2–3 (parser implementation + tests) are independent and can run in parallel.
- Tasks 4–7 (refactor each tool) depend on Task 2 but are independent of each other — can run in parallel.
- Task 8 (deploy + smoke test) depends on Tasks 4–7 AND Task 1.

---

## File Structure

### Files Modified

| File                                                   | Responsibility After Refactor                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/obsidian/tools/vault-parser.ts`            | Pure functions: `buildProjectTree(treeEntries)`, `resolveProject(projects, query)`, `parseNoteEntries(text)`, `formatDateShort(date)`. No frontmatter parsing. |
| `extensions/obsidian/tools/get-project-hierarchy.ts`   | Fetch tree → buildProjectTree → format text output.                                                                                                            |
| `extensions/obsidian/tools/get-project-text.ts`        | Fetch tree → buildProjectTree → resolveProject → fetch root file + notes file by SHA.                                                                          |
| `extensions/obsidian/tools/get-notes-by-date-range.ts` | Fetch tree → find notes files (optionally scoped by project_id) → fetch by SHA → parse entries.                                                                |
| `extensions/obsidian/tools/update-project-note.ts`     | Fetch tree → buildProjectTree → resolveProject → fetch existing notes via Contents API → build new content → write.                                            |

### Files Created

| File                                                    | Responsibility                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/mcp-worker/src/__tests__/obsidian-parser.test.ts` | Unit tests for `buildProjectTree` and `resolveProject`. Pure-function tests, no network. |

### Files Unchanged

| File                                   | Reason                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/obsidian/tools/git-api.ts` | All existing API functions (`getTree`, `getBlobContent`, `getMultipleBlobs`, `getFileContent`, `putFileContent`) are reused as-is. |
| `extensions/obsidian/tools/index.ts`   | Tool exports unchanged.                                                                                                            |
| `extensions/obsidian/config.json`      | No manifest changes.                                                                                                               |
| `apps/mcp-worker/package.json`         | No new dependencies.                                                                                                               |

### External Changes

Three files in the user's Obsidian vault at `github.com/jbrinkw/obsidian-vault` get moved to new paths (Task 1).

---

## Task 1: Vault Migration (parallel to Tasks 2–3)

**Stream A.** Move 3 root-level `.md` files into their own folders so they become projects under the new convention. This is a data-only change in an external GitHub repo — it does NOT touch any code in this repo.

**Context for the implementer:**

- GitHub repo: `jbrinkw/obsidian-vault`
- PAT (fine-grained, Contents: Read & write on the vault repo): `REDACTED_PAT_SEE_ENV_OR_USER_CREDS`
- Default branch: `main`
- GitHub Contents API: a "move" is two calls — `PUT /repos/{owner}/{repo}/contents/{newpath}` (create) then `DELETE /repos/{owner}/{repo}/contents/{oldpath}` (delete with sha).

Three files to move:
| From | To |
|------|-----|
| `Home Assistant.md` | `Home Assistant/Home Assistant.md` |
| `Project Mindhack.md` | `Project Mindhack/Project Mindhack.md` |
| `Project Sweaty Balls.md` | `Project Sweaty Balls/Project Sweaty Balls.md` |

**Files:** None in this repo. External changes only.

- [ ] **Step 1: Verify the three source files exist and capture their current SHAs**

Run this bash to fetch the current sha of each source file:

```bash
TOKEN="REDACTED_PAT_SEE_ENV_OR_USER_CREDS"
UA="User-Agent: luna-hub-mcp/1.0"
for path in "Home Assistant.md" "Project Mindhack.md" "Project Sweaty Balls.md"; do
  encoded=$(echo -n "$path" | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe='/'))")
  curl -s -H "Authorization: token $TOKEN" -H "$UA" \
    "https://api.github.com/repos/jbrinkw/obsidian-vault/contents/$encoded" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('$path', '->', d.get('sha','MISSING'))"
done
```

Expected output: three lines, each ending in a 40-character sha. If any prints `MISSING`, stop — that file doesn't exist and the migration cannot proceed without user input.

- [ ] **Step 2: For each file, copy content to the new path and delete the old**

For each of the three files, run this sequence (example shown for the first file; repeat with the other two paths):

```bash
TOKEN="REDACTED_PAT_SEE_ENV_OR_USER_CREDS"
UA="User-Agent: luna-hub-mcp/1.0"
OLD="Home Assistant.md"
NEW="Home Assistant/Home Assistant.md"

# Fetch old file's content + sha
OLD_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$OLD', safe='/'))")
NEW_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$NEW', safe='/'))")
RESP=$(curl -s -H "Authorization: token $TOKEN" -H "$UA" "https://api.github.com/repos/jbrinkw/obsidian-vault/contents/$OLD_ENC")
OLD_SHA=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")
CONTENT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")

# Create new file (PUT). The content is already base64-encoded from the GET response.
curl -s -X PUT -H "Authorization: token $TOKEN" -H "$UA" -H "Content-Type: application/json" \
  "https://api.github.com/repos/jbrinkw/obsidian-vault/contents/$NEW_ENC" \
  -d "$(python3 -c "import json; print(json.dumps({'message': 'migrate: move $OLD into folder', 'content': '''$CONTENT'''}))")" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('CREATE:', d.get('commit', {}).get('sha', 'FAILED'))"

# Delete old file
curl -s -X DELETE -H "Authorization: token $TOKEN" -H "$UA" -H "Content-Type: application/json" \
  "https://api.github.com/repos/jbrinkw/obsidian-vault/contents/$OLD_ENC" \
  -d "{\"message\": \"migrate: remove $OLD (moved to folder)\", \"sha\": \"$OLD_SHA\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('DELETE:', d.get('commit', {}).get('sha', 'FAILED'))"
```

Repeat for `Project Mindhack.md` → `Project Mindhack/Project Mindhack.md` and `Project Sweaty Balls.md` → `Project Sweaty Balls/Project Sweaty Balls.md`.

Expected: each file prints `CREATE: <sha>` and `DELETE: <sha>`. If either prints `FAILED`, stop and report which file.

- [ ] **Step 3: Verify the new layout**

```bash
TOKEN="REDACTED_PAT_SEE_ENV_OR_USER_CREDS"
UA="User-Agent: luna-hub-mcp/1.0"
curl -s -H "Authorization: token $TOKEN" -H "$UA" \
  "https://api.github.com/repos/jbrinkw/obsidian-vault/git/trees/main?recursive=1" \
  | python3 -c "
import json, sys
tree = json.load(sys.stdin).get('tree', [])
paths = [n['path'] for n in tree if n['type']=='blob' and n['path'].endswith('.md')]
required = {'Home Assistant/Home Assistant.md', 'Project Mindhack/Project Mindhack.md', 'Project Sweaty Balls/Project Sweaty Balls.md'}
missing_new = [p for p in required if p not in paths]
lingering_old = [p for p in ['Home Assistant.md', 'Project Mindhack.md', 'Project Sweaty Balls.md'] if p in paths]
print('MISSING_NEW:', missing_new)
print('LINGERING_OLD:', lingering_old)
"
```

Expected: both lines print empty lists `[]`. Otherwise stop and report.

- [ ] **Step 4: No commit in this repo** — all changes were to the external vault repo. This task does not produce a commit in luna-hub-lite.

---

## Task 2: Rewrite vault-parser.ts with buildProjectTree + resolveProject

**Files:**

- Modify: `extensions/obsidian/tools/vault-parser.ts` (full rewrite — keep `parseNoteEntries` and `formatDateShort` unchanged)
- Test: `apps/mcp-worker/src/__tests__/obsidian-parser.test.ts` (create — covered in Task 3)

- [ ] **Step 1: Write the failing test**

Create `apps/mcp-worker/src/__tests__/obsidian-parser.test.ts` with the following initial content:

```ts
import { describe, it, expect } from 'vitest';
import { buildProjectTree, resolveProject } from '../../../../extensions/obsidian/tools/vault-parser';
import type { TreeEntry } from '../../../../extensions/obsidian/tools/git-api';

function blob(path: string, sha = `sha-${path}`): TreeEntry {
  return { path, sha, type: 'blob' };
}

describe('buildProjectTree', () => {
  it('detects a flat root project from FolderName/FolderName.md pattern', () => {
    const entries: TreeEntry[] = [blob('Eco AI/Eco AI.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    const proj = projects.get('Eco AI');
    expect(proj).toBeDefined();
    expect(proj!.displayName).toBe('Eco AI');
    expect(proj!.rootFilePath).toBe('Eco AI/Eco AI.md');
    expect(proj!.parentId).toBeNull();
    expect(proj!.childrenIds).toEqual([]);
    expect(proj!.noteFilePath).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test -- obsidian-parser 2>&1 | tail -20`
Expected: FAIL — either `buildProjectTree is not exported` or `resolveProject is not exported` (depending on compile order).

- [ ] **Step 3: Rewrite vault-parser.ts with the new exports**

Replace the entire contents of `extensions/obsidian/tools/vault-parser.ts` with:

```ts
import type { TreeEntry } from './git-api';

/** A project resolved from the vault's folder tree. */
export interface Project {
  /** Canonical id: full folder path from vault root, e.g. "Luna/CoachByte". */
  id: string;
  /** Display name: the last segment of the folder path. */
  displayName: string;
  /** Same as id — kept for readability at call sites. */
  folderPath: string;
  /** Path to the project's root .md file (FolderName/FolderName.md). */
  rootFilePath: string;
  /** Git SHA of the root .md file (from the tree). */
  rootFileSha: string;
  /** Path to the project's Notes.md (case-insensitive match), if present. */
  noteFilePath: string | null;
  /** Git SHA of the Notes.md file, if present. */
  noteFileSha: string | null;
  /** Id of the nearest ancestor project folder, or null if this project is a root. */
  parentId: string | null;
  /** Ids of direct child projects, sorted alphabetically by displayName. */
  childrenIds: string[];
}

/**
 * Build the project map from a repository tree. Pure function — no network calls.
 *
 * Detection rules:
 * - A folder F is a project iff it contains a file F/X.md whose stem X matches
 *   the last segment of F (case-insensitive).
 * - The project's notes file is a sibling named "Notes.md" or "notes.md"
 *   (case-insensitive match on stem). First-in-tree-order wins.
 * - A project's parent is the nearest ancestor folder that is itself a project.
 *   Non-project folders are transparent (skipped).
 */
export function buildProjectTree(entries: TreeEntry[]): Map<string, Project> {
  // 1. Build a set of all blob paths for O(1) sibling lookups.
  const byPath = new Map<string, TreeEntry>();
  for (const e of entries) byPath.set(e.path, e);

  // 2. Identify project folders by scanning every .md blob.
  //    A project folder is one whose last segment matches the stem of a child .md file.
  const projectsByPath = new Map<string, Project>();
  for (const entry of entries) {
    if (!entry.path.endsWith('.md')) continue;
    const slashIdx = entry.path.lastIndexOf('/');
    if (slashIdx === -1) continue; // root-level files are not projects under this convention
    const dir = entry.path.slice(0, slashIdx);
    const fileName = entry.path.slice(slashIdx + 1);
    const stem = fileName.slice(0, -3); // strip .md
    const lastSeg = dir.slice(dir.lastIndexOf('/') + 1);
    if (stem.toLowerCase() !== lastSeg.toLowerCase()) continue;

    // Found a project folder — dir. If we've already registered it (duplicate would be strange), skip.
    if (projectsByPath.has(dir)) continue;
    projectsByPath.set(dir, {
      id: dir,
      displayName: lastSeg,
      folderPath: dir,
      rootFilePath: entry.path,
      rootFileSha: entry.sha,
      noteFilePath: null,
      noteFileSha: null,
      parentId: null,
      childrenIds: [],
    });
  }

  // 3. For each project, find its Notes.md / notes.md sibling.
  //    Iterate the tree in order so "first-in-tree-order wins" is deterministic.
  for (const entry of entries) {
    if (!entry.path.endsWith('.md')) continue;
    const slashIdx = entry.path.lastIndexOf('/');
    if (slashIdx === -1) continue;
    const dir = entry.path.slice(0, slashIdx);
    const fileName = entry.path.slice(slashIdx + 1);
    const stem = fileName.slice(0, -3);
    if (stem.toLowerCase() !== 'notes') continue;
    const proj = projectsByPath.get(dir);
    if (!proj) continue; // notes.md in a non-project folder — ignored
    if (proj.noteFilePath !== null) continue; // already have a notes file for this project
    proj.noteFilePath = entry.path;
    proj.noteFileSha = entry.sha;
  }

  // 4. Determine each project's parent by walking ancestor folders.
  for (const proj of projectsByPath.values()) {
    let cursor = proj.folderPath;
    while (true) {
      const slashIdx = cursor.lastIndexOf('/');
      if (slashIdx === -1) break; // no more ancestors
      cursor = cursor.slice(0, slashIdx);
      if (projectsByPath.has(cursor)) {
        proj.parentId = cursor;
        break;
      }
    }
  }

  // 5. Populate children arrays.
  for (const proj of projectsByPath.values()) {
    if (proj.parentId === null) continue;
    const parent = projectsByPath.get(proj.parentId);
    if (parent) parent.childrenIds.push(proj.id);
  }

  // 6. Sort children alphabetically by displayName for deterministic output.
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  for (const proj of projectsByPath.values()) {
    proj.childrenIds.sort((a, b) => {
      const pa = projectsByPath.get(a);
      const pb = projectsByPath.get(b);
      return collator.compare(pa?.displayName ?? a, pb?.displayName ?? b);
    });
  }

  return projectsByPath;
}

/**
 * Resolve a user query against the project map.
 *
 * Resolution order:
 *   1. Exact canonical id match (case-sensitive) — always wins if found.
 *   2. Case-insensitive exact displayName match — wins only if unique.
 *   3. Otherwise returns { project: null, ambiguous: [] } (not found) or
 *      { project: null, ambiguous: [multiple] } (multiple displayName matches).
 */
export function resolveProject(
  projects: Map<string, Project>,
  query: string,
): { project: Project | null; ambiguous: Project[] } {
  if (!query) return { project: null, ambiguous: [] };

  // 1. Exact canonical id.
  const exact = projects.get(query);
  if (exact) return { project: exact, ambiguous: [] };

  // 2. Case-insensitive displayName match.
  const q = query.toLowerCase();
  const nameMatches: Project[] = [];
  for (const proj of projects.values()) {
    if (proj.displayName.toLowerCase() === q) nameMatches.push(proj);
  }
  if (nameMatches.length === 1) return { project: nameMatches[0], ambiguous: [] };
  if (nameMatches.length > 1) return { project: null, ambiguous: nameMatches };

  return { project: null, ambiguous: [] };
}

// ───────────────────────────── Note-entry parsing ─────────────────────────────
// These helpers are independent of the project model and are kept as-is.

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}):?\s*$/;

export interface NoteEntry {
  date: Date;
  dateStr: string;
  content: string;
}

/** Parse dated entries from a Notes.md body (after any frontmatter). */
export function parseNoteEntries(text: string): NoteEntry[] {
  const lines = text.split('\n');

  // Skip frontmatter if present.
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

/** Format a Date as M/D/YY (matching the legacy note-entry header format). */
export function formatDateShort(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return `${m}/${day}/${yy}`;
}
```

- [ ] **Step 4: Run the first test — should PASS**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test -- obsidian-parser 2>&1 | tail -20`
Expected: PASS (1 test).

- [ ] **Step 5: Run typecheck to catch any breakage in the 4 tool files**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | tail -20`
Expected: errors in `get-project-hierarchy.ts`, `get-project-text.ts`, `get-notes-by-date-range.ts`, and `update-project-note.ts` — they import `buildProjects`, `linkNotes`, `rootsOf` which no longer exist. This is expected — Tasks 4–7 fix each file.

- [ ] **Step 6: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add extensions/obsidian/tools/vault-parser.ts apps/mcp-worker/src/__tests__/obsidian-parser.test.ts
git commit -m "refactor(obsidian): replace frontmatter parser with folder-convention project tree

Adds buildProjectTree and resolveProject as pure functions over a git tree.
Removes buildProjects, linkNotes, rootsOf, deriveDisplayName, parseFrontmatter.
Tool files still need updating; this commit intentionally leaves them failing
typecheck to be fixed in subsequent commits."
```

---

## Task 3: Comprehensive tests for buildProjectTree + resolveProject

**Files:**

- Modify: `apps/mcp-worker/src/__tests__/obsidian-parser.test.ts` (add tests)

- [ ] **Step 1: Append the additional test cases**

Add these `describe` blocks below the existing `describe('buildProjectTree', ...)` in `apps/mcp-worker/src/__tests__/obsidian-parser.test.ts` (keep the existing test):

```ts
import { describe, it, expect } from 'vitest';
import { buildProjectTree, resolveProject } from '../../../../extensions/obsidian/tools/vault-parser';
import type { TreeEntry } from '../../../../extensions/obsidian/tools/git-api';

function blob(path: string, sha = `sha-${path}`): TreeEntry {
  return { path, sha, type: 'blob' };
}

describe('buildProjectTree', () => {
  it('detects a flat root project from FolderName/FolderName.md pattern', () => {
    const entries: TreeEntry[] = [blob('Eco AI/Eco AI.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    const proj = projects.get('Eco AI');
    expect(proj).toBeDefined();
    expect(proj!.displayName).toBe('Eco AI');
    expect(proj!.rootFilePath).toBe('Eco AI/Eco AI.md');
    expect(proj!.parentId).toBeNull();
    expect(proj!.childrenIds).toEqual([]);
    expect(proj!.noteFilePath).toBeNull();
  });

  it('does not detect a project when stem does not match folder name', () => {
    const entries: TreeEntry[] = [blob('Eco AI/agents.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(0);
  });

  it('does not detect a project from a root-level .md file with no folder', () => {
    const entries: TreeEntry[] = [blob('standalone.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(0);
  });

  it('matches folder and file case-insensitively', () => {
    const entries: TreeEntry[] = [blob('gamegenai/GAMEGENAI.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    const proj = projects.get('gamegenai');
    expect(proj).toBeDefined();
    expect(proj!.displayName).toBe('gamegenai');
  });

  it('links a sibling Notes.md to its project', () => {
    const entries: TreeEntry[] = [blob('Eco AI/Eco AI.md', 'sha-root'), blob('Eco AI/Notes.md', 'sha-notes')];
    const projects = buildProjectTree(entries);
    const proj = projects.get('Eco AI');
    expect(proj!.noteFilePath).toBe('Eco AI/Notes.md');
    expect(proj!.noteFileSha).toBe('sha-notes');
  });

  it('links a lowercase notes.md to its project (case-insensitive)', () => {
    const entries: TreeEntry[] = [blob('CoachByte/CoachByte.md'), blob('CoachByte/notes.md', 'sha-notes')];
    const projects = buildProjectTree(entries);
    const proj = projects.get('CoachByte');
    expect(proj!.noteFilePath).toBe('CoachByte/notes.md');
    expect(proj!.noteFileSha).toBe('sha-notes');
  });

  it('does not link a Notes.md that lives in a non-project folder', () => {
    const entries: TreeEntry[] = [blob('Orphan/Notes.md'), blob('Luna/Luna.md')];
    const projects = buildProjectTree(entries);
    expect(projects.get('Luna')!.noteFilePath).toBeNull();
  });

  it('does not link a Notes.md from a sub-project to its ancestor', () => {
    const entries: TreeEntry[] = [
      blob('Luna/Luna.md'),
      blob('Luna/CoachByte/CoachByte.md'),
      blob('Luna/CoachByte/Notes.md', 'sha-child-notes'),
    ];
    const projects = buildProjectTree(entries);
    expect(projects.get('Luna')!.noteFilePath).toBeNull();
    expect(projects.get('Luna/CoachByte')!.noteFilePath).toBe('Luna/CoachByte/Notes.md');
  });

  it('builds one level of parent-child nesting', () => {
    const entries: TreeEntry[] = [blob('Luna/Luna.md'), blob('Luna/CoachByte/CoachByte.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.get('Luna')!.parentId).toBeNull();
    expect(projects.get('Luna/CoachByte')!.parentId).toBe('Luna');
    expect(projects.get('Luna')!.childrenIds).toEqual(['Luna/CoachByte']);
  });

  it('builds four levels of parent-child nesting', () => {
    const entries: TreeEntry[] = [blob('A/A.md'), blob('A/B/B.md'), blob('A/B/C/C.md'), blob('A/B/C/D/D.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(4);
    expect(projects.get('A')!.parentId).toBeNull();
    expect(projects.get('A/B')!.parentId).toBe('A');
    expect(projects.get('A/B/C')!.parentId).toBe('A/B');
    expect(projects.get('A/B/C/D')!.parentId).toBe('A/B/C');
    expect(projects.get('A')!.childrenIds).toEqual(['A/B']);
    expect(projects.get('A/B')!.childrenIds).toEqual(['A/B/C']);
    expect(projects.get('A/B/C')!.childrenIds).toEqual(['A/B/C/D']);
  });

  it('treats non-project folders as transparent when resolving parent', () => {
    // Personal/ is not a project (no Personal.md). Journal/ IS a project.
    // With a non-project folder between, Journal should be a root (no ancestor project).
    const entries: TreeEntry[] = [blob('Personal/Journal/Journal.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    expect(projects.get('Personal/Journal')!.parentId).toBeNull();
  });

  it('skips a non-project intermediate folder to find the nearest ancestor project', () => {
    // A is a project, A/X is NOT a project (no X.md), A/X/Y is a project.
    // Y's parent should be A (X is transparent).
    const entries: TreeEntry[] = [blob('A/A.md'), blob('A/X/Y/Y.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.get('A/X/Y')!.parentId).toBe('A');
    expect(projects.get('A')!.childrenIds).toEqual(['A/X/Y']);
  });

  it('sorts children alphabetically by displayName (case-insensitive)', () => {
    const entries: TreeEntry[] = [
      blob('Root/Root.md'),
      blob('Root/zebra/zebra.md'),
      blob('Root/Apple/Apple.md'),
      blob('Root/mango/mango.md'),
    ];
    const projects = buildProjectTree(entries);
    expect(projects.get('Root')!.childrenIds).toEqual(['Root/Apple', 'Root/mango', 'Root/zebra']);
  });

  it('allows duplicate display names at different paths (both tracked separately)', () => {
    const entries: TreeEntry[] = [blob('Left/Shared/Shared.md'), blob('Right/Shared/Shared.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.has('Left/Shared')).toBe(true);
    expect(projects.has('Right/Shared')).toBe(true);
  });

  it('ignores non-.md blobs when detecting projects', () => {
    const entries: TreeEntry[] = [blob('Luna/Luna.png'), blob('Luna/Luna.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    expect(projects.has('Luna')).toBe(true);
  });
});

describe('resolveProject', () => {
  const entries: TreeEntry[] = [
    blob('Luna/Luna.md'),
    blob('Luna/CoachByte/CoachByte.md'),
    blob('Other/CoachByte/CoachByte.md'),
    blob('Solo/Solo.md'),
  ];
  const projects = buildProjectTree(entries);

  it('returns the project for an exact canonical id', () => {
    const { project, ambiguous } = resolveProject(projects, 'Luna/CoachByte');
    expect(project).toBeDefined();
    expect(project!.id).toBe('Luna/CoachByte');
    expect(ambiguous).toEqual([]);
  });

  it('returns the project for a unique case-insensitive displayName', () => {
    const { project, ambiguous } = resolveProject(projects, 'solo');
    expect(project).toBeDefined();
    expect(project!.id).toBe('Solo');
    expect(ambiguous).toEqual([]);
  });

  it('returns ambiguous candidates when displayName matches multiple projects', () => {
    const { project, ambiguous } = resolveProject(projects, 'CoachByte');
    expect(project).toBeNull();
    expect(ambiguous.length).toBe(2);
    const ids = ambiguous.map((p) => p.id).sort();
    expect(ids).toEqual(['Luna/CoachByte', 'Other/CoachByte']);
  });

  it('returns null + empty ambiguous when no match exists', () => {
    const { project, ambiguous } = resolveProject(projects, 'Nonexistent');
    expect(project).toBeNull();
    expect(ambiguous).toEqual([]);
  });

  it('returns null + empty ambiguous for an empty query', () => {
    const { project, ambiguous } = resolveProject(projects, '');
    expect(project).toBeNull();
    expect(ambiguous).toEqual([]);
  });
});
```

- [ ] **Step 2: Run all parser tests — all should PASS**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test -- obsidian-parser 2>&1 | tail -30`
Expected: 18 tests passing (1 from Task 2 + 17 new). If any fail, fix the implementation in `vault-parser.ts`.

- [ ] **Step 3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/obsidian-parser.test.ts
git commit -m "test(obsidian): add unit tests for buildProjectTree and resolveProject"
```

---

## Task 4: Refactor get-project-hierarchy.ts

**Files:**

- Modify: `extensions/obsidian/tools/get-project-hierarchy.ts`

- [ ] **Step 1: Replace the entire file contents**

Overwrite `extensions/obsidian/tools/get-project-hierarchy.ts` with:

```ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree } from './git-api';
import { buildProjectTree, type Project } from './vault-parser';

export const OBSIDIAN_get_project_hierarchy: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_hierarchy',
  extensionName: 'obsidian',
  description:
    'Return a simplified hierarchy of projects in the Obsidian vault: root project names and immediate child names. Projects are identified by folder convention (a folder with FolderName/FolderName.md).',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    try {
      // Single subrequest for all metadata.
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      // Collect root projects (parent null), sorted alphabetically.
      const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
      const roots: Project[] = [];
      for (const proj of projects.values()) {
        if (proj.parentId === null) roots.push(proj);
      }
      roots.sort((a, b) => collator.compare(a.displayName, b.displayName));

      // Format as root name with indented immediate children.
      const lines: string[] = [];
      for (const root of roots) {
        lines.push(root.displayName);
        for (const childId of root.childrenIds) {
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

- [ ] **Step 2: Typecheck this file**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | grep get-project-hierarchy`
Expected: no output (this file's errors are gone). Other tool files may still have errors — those are fixed in Tasks 5–7.

- [ ] **Step 3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add extensions/obsidian/tools/get-project-hierarchy.ts
git commit -m "refactor(obsidian): get_project_hierarchy uses folder-convention project tree"
```

---

## Task 5: Refactor get-project-text.ts

**Files:**

- Modify: `extensions/obsidian/tools/get-project-text.ts`

- [ ] **Step 1: Replace the entire file contents**

Overwrite `extensions/obsidian/tools/get-project-text.ts` with:

```ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getBlobContent } from './git-api';
import { buildProjectTree, resolveProject } from './vault-parser';

export const OBSIDIAN_get_project_text: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_text',
  extensionName: 'obsidian',
  description:
    'Return the root project page text and note page text for a given project. The project argument is either its folder path (e.g. "Luna/CoachByte") or its folder name (e.g. "CoachByte") if unique in the vault.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Project folder path or folder name (case-insensitive).',
      },
    },
    required: ['project_id'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');

    try {
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      const { project, ambiguous } = resolveProject(projects, args.project_id);
      if (!project) {
        if (ambiguous.length > 0) {
          const candidates = ambiguous.map((p) => p.id).join(', ');
          return toolError(
            `Ambiguous project "${args.project_id}" — multiple matches. Use the full path. Candidates: ${candidates}`,
          );
        }
        return toolError(`Project not found: ${args.project_id}`);
      }

      // Fetch root file content by SHA.
      const rootText = await getBlobContent(creds, project.rootFileSha);

      // Fetch notes file content by SHA if present.
      let noteText: string | null = null;
      if (project.noteFileSha) {
        noteText = await getBlobContent(creds, project.noteFileSha);
      }

      return toolSuccess({
        status: 'success',
        project_id: project.id,
        display_name: project.displayName,
        root_page_path: project.rootFilePath,
        root_page_text: rootText,
        note_page_path: project.noteFilePath,
        note_page_text: noteText,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
```

- [ ] **Step 2: Typecheck this file**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | grep get-project-text`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add extensions/obsidian/tools/get-project-text.ts
git commit -m "refactor(obsidian): get_project_text uses folder-convention project tree + SHA-based fetch"
```

---

## Task 6: Refactor get-notes-by-date-range.ts

**Files:**

- Modify: `extensions/obsidian/tools/get-notes-by-date-range.ts`

- [ ] **Step 1: Replace the entire file contents**

Overwrite `extensions/obsidian/tools/get-notes-by-date-range.ts` with:

```ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getMultipleBlobs, type TreeEntry } from './git-api';
import { buildProjectTree, resolveProject, parseNoteEntries, type Project } from './vault-parser';

const MAX_NOTES_FILES = 40;

function parseDateArg(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) throw new Error('Dates must be in MM/DD/YY format');
  const month = parseInt(m[1]);
  const day = parseInt(m[2]);
  const year = 2000 + parseInt(m[3]);
  if (month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);
  if (day < 1 || day > 31) throw new Error(`Invalid day: ${day}`);
  const dt = new Date(year, month - 1, day);
  if (dt.getMonth() !== month - 1) throw new Error(`Invalid date: ${s} (day out of range for month)`);
  return dt;
}

/** Depth of a path by counting slashes (shallower = smaller). */
function depth(path: string): number {
  let n = 0;
  for (const c of path) if (c === '/') n++;
  return n;
}

/** Return the notes files for a project and all its descendant projects. */
function collectNoteFilesForSubtree(
  projects: Map<string, Project>,
  rootId: string,
): Array<{ path: string; sha: string }> {
  const out: Array<{ path: string; sha: string }> = [];
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const proj = projects.get(id);
    if (!proj) continue;
    if (proj.noteFilePath && proj.noteFileSha) {
      out.push({ path: proj.noteFilePath, sha: proj.noteFileSha });
    }
    for (const childId of proj.childrenIds) stack.push(childId);
  }
  return out;
}

/** Return all notes files in the vault, sorted shallowest-first for the 40-file cap. */
function collectAllNoteFiles(projects: Map<string, Project>): Array<{ path: string; sha: string }> {
  const out: Array<{ path: string; sha: string }> = [];
  for (const proj of projects.values()) {
    if (proj.noteFilePath && proj.noteFileSha) {
      out.push({ path: proj.noteFilePath, sha: proj.noteFileSha });
    }
  }
  out.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return out;
}

export const OBSIDIAN_get_notes_by_date_range: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_notes_by_date_range',
  extensionName: 'obsidian',
  description:
    'Return dated note entries within [start_date, end_date] (MM/DD/YY format), newest-first. Optionally restrict to a single project (and its descendants) via project_id.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date in MM/DD/YY format' },
      end_date: { type: 'string', description: 'End date in MM/DD/YY format' },
      project_id: {
        type: 'string',
        description:
          'Optional — restrict scan to this project and its descendants (folder path or unique folder name).',
      },
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
      const tree: TreeEntry[] = await getTree(creds);
      const projects = buildProjectTree(tree);

      // Choose which notes files to scan.
      let candidates: Array<{ path: string; sha: string }>;
      if (args.project_id) {
        const { project, ambiguous } = resolveProject(projects, args.project_id);
        if (!project) {
          if (ambiguous.length > 0) {
            const cands = ambiguous.map((p) => p.id).join(', ');
            return toolError(`Ambiguous project "${args.project_id}". Candidates: ${cands}`);
          }
          return toolError(`Project not found: ${args.project_id}`);
        }
        candidates = collectNoteFilesForSubtree(projects, project.id);
      } else {
        candidates = collectAllNoteFiles(projects);
      }

      const truncated = candidates.length > MAX_NOTES_FILES;
      const omittedCount = truncated ? candidates.length - MAX_NOTES_FILES : 0;
      const toFetch = candidates.slice(0, MAX_NOTES_FILES);

      const fileContents = await getMultipleBlobs(creds, toFetch, MAX_NOTES_FILES);

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
        status: truncated ? 'partial' : 'success',
        truncated,
        omitted_notes_files: omittedCount,
        scope: args.project_id ? `project: ${args.project_id}` : 'all',
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

- [ ] **Step 2: Typecheck this file**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | grep get-notes-by-date-range`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add extensions/obsidian/tools/get-notes-by-date-range.ts
git commit -m "refactor(obsidian): get_notes_by_date_range scans by project tree with optional scope"
```

---

## Task 7: Refactor update-project-note.ts

**Files:**

- Modify: `extensions/obsidian/tools/update-project-note.ts`

- [ ] **Step 1: Replace the entire file contents**

Overwrite `extensions/obsidian/tools/update-project-note.ts` with:

```ts
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getFileContent, putFileContent } from './git-api';
import { buildProjectTree, resolveProject, formatDateShort } from './vault-parser';

export const OBSIDIAN_update_project_note: ExtensionToolDefinition = {
  name: 'OBSIDIAN_update_project_note',
  extensionName: 'obsidian',
  description:
    "Append content to today's dated note entry for a project. Creates the Notes.md file and/or today's entry if needed. Optionally place content under a markdown section.",
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Project folder path or folder name (case-insensitive).',
      },
      content: { type: 'string', description: 'Content to append' },
      section_id: {
        type: 'string',
        description: 'Optional markdown section to place content under',
      },
    },
    required: ['project_id', 'content'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');
    if (!args.content) return toolError('content is required');

    try {
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      const { project, ambiguous } = resolveProject(projects, args.project_id);
      if (!project) {
        if (ambiguous.length > 0) {
          const cands = ambiguous.map((p) => p.id).join(', ');
          return toolError(`Ambiguous project "${args.project_id}". Candidates: ${cands}`);
        }
        return toolError(`Project not found: ${args.project_id}`);
      }

      const todayStr = formatDateShort(new Date());

      // Decide notes path: existing or derived.
      let notePath = project.noteFilePath;
      let createdFile = false;
      let existingContent = '';
      let existingSha: string | undefined;

      if (notePath) {
        // Fetch current Notes.md via Contents API for the Contents-API sha (putFileContent requires it).
        const fresh = await getFileContent(creds, notePath);
        if (fresh) {
          existingContent = fresh.content;
          existingSha = fresh.sha;
        } else {
          // Tree says file exists but Contents API returned 404 — treat as create.
          notePath = null;
        }
      }

      if (!notePath) {
        notePath = `${project.folderPath}/Notes.md`;
        createdFile = true;
        existingContent = '';
      }

      // Split existing content into frontmatter + body. New files have no frontmatter.
      const lines = existingContent.split('\n');
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

      // Find date headers in the body.
      const dateRe = /^(\d{1,2})\/(\d{1,2})\/(\d{2}):?\s*$/;
      let todayIdx = -1;
      const dateIndices: number[] = [];
      for (let i = 0; i < bodyLines.length; i++) {
        if (dateRe.test(bodyLines[i].trim())) {
          dateIndices.push(i);
          if (bodyLines[i].trim().replace(/:$/, '') === todayStr) todayIdx = i;
        }
      }

      const contentLine = args.content.trimEnd();
      let createdEntry = false;
      let appended = false;

      if (todayIdx === -1) {
        // Insert new dated entry at the top (before first existing date, or end of body if none).
        const insertAt = dateIndices.length > 0 ? dateIndices[0] : bodyLines.length;
        const newEntry = args.section_id
          ? [todayStr, '', `## ${args.section_id}`, '', contentLine]
          : [todayStr, '', contentLine];
        bodyLines.splice(insertAt, 0, ...newEntry);
        createdEntry = true;
      } else {
        // Find the end of today's entry (next date or EOF).
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
            bodyLines.splice(entryEnd, 0, '', `## ${args.section_id}`, '', contentLine);
          } else {
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
        notePath,
        newContent,
        `note: ${todayStr} ${args.section_id ? `[${args.section_id}] ` : ''}update`,
        existingSha,
      );

      return toolSuccess({
        status: 'success',
        project_id: project.id,
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

- [ ] **Step 2: Typecheck this file**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | grep update-project-note`
Expected: no output.

- [ ] **Step 3: Full typecheck across the worker — should now be clean**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck 2>&1 | tail -10`
Expected: no errors. The refactor is complete.

- [ ] **Step 4: Run ALL tests — parser tests plus any existing worker tests**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test 2>&1 | tail -30`
Expected: all tests pass. If existing mcp-worker tests fail due to stale snapshots / old obsidian behavior expectations, fix or update them before proceeding.

- [ ] **Step 5: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add extensions/obsidian/tools/update-project-note.ts
git commit -m "refactor(obsidian): update_project_note uses folder-convention project tree"
```

---

## Task 8: Deploy + smoke test against the migrated vault

**Depends on:** Tasks 1 (vault migration) AND Tasks 4–7 (code refactor) both complete.

**Files:** None. Runtime verification only.

- [ ] **Step 1: Deploy the worker**

Run: `cd /home/jeremy/luna-hub-lite/apps/mcp-worker && npx wrangler deploy 2>&1 | tail -5`
Expected: `Deployed luna-hub-mcp triggers` with a new Version ID.

- [ ] **Step 2: Smoke test — list hierarchy**

Set the API key first (use whichever `lh_...` key the user already has in Hub; fallback: use the existing test key `lh_test_77d710173f2a4ec88f419b39fdcda4e6` if present in the DB):

```bash
API_KEY="lh_test_77d710173f2a4ec88f419b39fdcda4e6"
curl -s --max-time 60 -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Call the Obsidian project hierarchy tool and list the projects you see"}],"max_tokens":500}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','ERROR'))"
```

Expected: a response mentioning the projects from the migrated vault (Eco AI, luna-personal-assistant or Luna, gamegenai, projectLookingGlass, Home Assistant, Project Mindhack, Project Sweaty Balls, Open Ethos, Project$1, ProjectFireLeuia, ProjectNoDingDong), including sub-projects under luna-personal-assistant (CoachByte, chefbyte, ProfessorByte, Universal Architecture).

If the response says "project not found" or lists only a subset, something is broken — return to the relevant task.

- [ ] **Step 3: Smoke test — read a specific project**

```bash
API_KEY="lh_test_77d710173f2a4ec88f419b39fdcda4e6"
curl -s --max-time 60 -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Read the CoachByte project from my Obsidian vault and summarize it in one sentence"}],"max_tokens":300}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','ERROR'))"
```

Expected: a one-sentence summary of CoachByte's content. If it returns "Ambiguous project" because CoachByte exists at multiple paths, that's actually correct behavior — try again asking for `luna-personal-assistant/CoachByte`.

- [ ] **Step 4: Smoke test — date range notes**

```bash
API_KEY="lh_test_77d710173f2a4ec88f419b39fdcda4e6"
curl -s --max-time 60 -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Fetch my Obsidian notes from 1/1/25 to 12/31/25 and list how many entries you got"}],"max_tokens":300}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','ERROR'))"
```

Expected: a count of dated entries found. Non-zero for 2025.

- [ ] **Step 5: Update MEMORY.md and current-task.md**

Run:

```bash
cd /home/jeremy/luna-hub-lite
ls ~/.claude/projects/-home-jeremy-luna-hub-lite/memory/current-task.md 2>/dev/null \
  && echo "update current-task.md with 'Obsidian folder-convention refactor complete'"
```

Update the memory files if they exist to reflect completion.

- [ ] **Step 6: Push**

```bash
cd /home/jeremy/luna-hub-lite
git push origin main
```

Expected: all Task 2–7 commits pushed.

---

## Self-Review Notes

- **Spec coverage:** Core rules (project detection, parent-child, notes linking, transparent folders), nesting examples, reference resolution, and the four tool behaviors are all implemented and tested. Migration path is Task 1. Backward compatibility (old frontmatter ignored but kept) is implicit — the new parser simply doesn't read frontmatter.
- **Types across tasks:** `Project`, `TreeEntry`, and `buildProjectTree`/`resolveProject` signatures are identical across all files that reference them.
- **No placeholders.** Every code step shows the complete code the engineer writes.
- **Task 8 dependency:** Cannot run before both Task 1 AND Tasks 4–7 have completed. Called out at the top of Task 8.
