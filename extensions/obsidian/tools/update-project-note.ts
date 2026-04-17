import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getFileContent, putFileContent } from './git-api';
import { buildProjectTree, resolveProject, formatDateShort } from './vault-parser';

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}):?\s*$/;

/** Parse MM/DD/YY into a local-midnight Date. Returns null on invalid format or impossible date. */
function parseMMDDYY(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1]);
  const dd = parseInt(m[2]);
  const yy = parseInt(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(2000 + yy, mm - 1, dd);
  if (d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

export const OBSIDIAN_update_project_note: ExtensionToolDefinition = {
  name: 'OBSIDIAN_update_project_note',
  extensionName: 'obsidian',
  description:
    'Append content to a dated note entry for a project. Defaults to today; pass `date` (MM/DD/YY) to backdate. If an entry for that date already exists, content is appended inside it (no new date header). Creates Notes.md and/or the entry as needed. Adds two blank lines after every insert. Optionally places content under a markdown section.',
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
      date: {
        type: 'string',
        description:
          'Optional MM/DD/YY date. Defaults to today. When set, the entry is created at the chronologically correct position (newest-first) if it does not already exist.',
      },
    },
    required: ['project_id', 'content'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');
    if (!args.content) return toolError('content is required');

    let targetDate: Date;
    let targetDateStr: string;
    if (args.date) {
      const parsed = parseMMDDYY(args.date);
      if (!parsed) return toolError('date must be in MM/DD/YY format');
      targetDate = parsed;
      targetDateStr = formatDateShort(parsed);
    } else {
      targetDate = new Date();
      targetDateStr = formatDateShort(targetDate);
    }

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

      let notePath = project.noteFilePath;
      let createdFile = false;
      let existingContent = '';
      let existingSha: string | undefined;

      if (notePath) {
        const fresh = await getFileContent(creds, notePath);
        if (fresh) {
          existingContent = fresh.content;
          existingSha = fresh.sha;
        } else {
          notePath = null;
        }
      }

      if (!notePath) {
        notePath = `${project.folderPath}/Notes.md`;
        createdFile = true;
        existingContent = '';
      }

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

      // Parse all date headers in the body with their line indices + Date values.
      const dateHeaders: Array<{ index: number; date: Date }> = [];
      let targetIdx = -1;
      const targetTs = targetDate.getTime();
      for (let i = 0; i < bodyLines.length; i++) {
        const m = bodyLines[i].trim().match(DATE_RE);
        if (!m) continue;
        const d = new Date(2000 + parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
        dateHeaders.push({ index: i, date: d });
        if (d.getTime() === targetTs) targetIdx = i;
      }

      const contentLine = args.content.trimEnd();
      let createdEntry = false;
      let appended = false;

      if (targetIdx === -1) {
        // No entry for the target date — insert a new one at the chronologically
        // correct position. Body is newest-first, so we insert before the first
        // existing header OLDER than target, else at EOF.
        let insertAt = bodyLines.length;
        for (const h of dateHeaders) {
          if (h.date.getTime() < targetTs) {
            insertAt = h.index;
            break;
          }
        }
        const newEntry = args.section_id
          ? [targetDateStr, '', `## ${args.section_id}`, '', contentLine, '', '', '']
          : [targetDateStr, '', contentLine, '', '', ''];
        bodyLines.splice(insertAt, 0, ...newEntry);
        createdEntry = true;
      } else {
        // Entry exists — append inside it.
        let entryEnd = bodyLines.length;
        for (const h of dateHeaders) {
          if (h.index > targetIdx) {
            entryEnd = h.index;
            break;
          }
        }

        if (args.section_id) {
          const secRe = new RegExp(
            `^\\s*#{1,6}\\s+${args.section_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
            'i',
          );
          let secIdx = -1;
          for (let i = targetIdx + 1; i < entryEnd; i++) {
            if (secRe.test(bodyLines[i])) {
              secIdx = i;
              break;
            }
          }
          if (secIdx === -1) {
            bodyLines.splice(entryEnd, 0, '', `## ${args.section_id}`, '', contentLine, '', '', '');
          } else {
            let secEnd = entryEnd;
            for (let i = secIdx + 1; i < entryEnd; i++) {
              if (/^\s*#{1,6}\s+/.test(bodyLines[i])) {
                secEnd = i;
                break;
              }
            }
            bodyLines.splice(secEnd, 0, contentLine, '', '', '');
          }
        } else {
          bodyLines.splice(entryEnd, 0, contentLine, '', '', '');
        }
        appended = true;
      }

      const newContent = [...fmLines, ...bodyLines].join('\n');

      await putFileContent(
        creds,
        notePath,
        newContent,
        `note: ${targetDateStr} ${args.section_id ? `[${args.section_id}] ` : ''}update`,
        existingSha,
      );

      return toolSuccess({
        status: 'success',
        project_id: project.id,
        note_file: notePath,
        created_file: createdFile,
        created_entry: createdEntry,
        appended,
        date_str: targetDateStr,
        backdated: Boolean(args.date),
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
