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
