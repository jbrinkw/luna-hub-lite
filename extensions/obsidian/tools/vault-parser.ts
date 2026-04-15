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
  // 1. Identify project folders by scanning every .md blob.
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

    // Found a project folder — dir. If we've already registered it (duplicate), skip.
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

  // 2. For each project, find its Notes.md / notes.md sibling.
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

  // 3. Determine each project's parent by walking ancestor folders.
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

  // 4. Populate children arrays.
  for (const proj of projectsByPath.values()) {
    if (proj.parentId === null) continue;
    const parent = projectsByPath.get(proj.parentId);
    if (parent) parent.childrenIds.push(proj.id);
  }

  // 5. Sort children alphabetically by displayName for deterministic output.
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
