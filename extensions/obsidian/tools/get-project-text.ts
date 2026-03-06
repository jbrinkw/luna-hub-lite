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
