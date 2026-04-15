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
