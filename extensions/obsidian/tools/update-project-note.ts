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
