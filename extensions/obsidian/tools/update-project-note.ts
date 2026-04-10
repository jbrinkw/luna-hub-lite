import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getMultipleBlobs, getFileContent, putFileContent } from './git-api';
import { buildProjects, linkNotes, formatDateShort } from './vault-parser';

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
      // 1 call: get tree
      const tree = await getTree(creds);
      const mdEntries = tree.filter((e) => e.path.endsWith('.md'));

      // Fetch md files to build project map (capped at 20)
      const fileContents = await getMultipleBlobs(creds, mdEntries);
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
        // Try to get from cached blobs first, fall back to Contents API for sha
        const cached = fileContents.get(notePath);
        if (cached) {
          existingContent = cached.content;
          existingSha = cached.sha;
        } else {
          const file = await getFileContent(creds, notePath);
          if (file) {
            existingContent = file.content;
            existingSha = file.sha;
          }
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
            bodyLines.splice(entryEnd, 0, '\n', `## ${args.section_id}\n`, '\n', contentLine);
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
      // putFileContent needs the Contents API sha, not the blob sha
      // If we got sha from getFileContent it's correct; from blobs it may differ
      // Re-fetch via Contents API to get the correct sha for update
      if (existingSha && !createdFile) {
        const fresh = await getFileContent(creds, notePath!);
        if (fresh) existingSha = fresh.sha;
      }

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
