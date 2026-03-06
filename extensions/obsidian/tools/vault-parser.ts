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
export function deriveDisplayName(filePath: string, projectId: string): string {
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
