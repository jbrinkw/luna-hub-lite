import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getMultipleBlobs, getBlobContent } from './git-api';
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
      // 1 call: get full tree
      const tree = await getTree(creds);
      const mdEntries = tree.filter((e) => e.path.endsWith('.md'));

      // Fetch all md files to build project map (capped at 20)
      const fileContents = await getMultipleBlobs(creds, mdEntries);
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

      // Get the project file content (may already be in fileContents)
      let rootText: string | null = null;
      const rootEntry = fileContents.get(proj.filePath);
      if (rootEntry) {
        rootText = rootEntry.content;
      } else {
        // Fetch individually if it wasn't in the capped batch
        const treeEntry = mdEntries.find((e) => e.path === proj.filePath);
        if (treeEntry) rootText = await getBlobContent(creds, treeEntry.sha);
      }

      // Get note file content
      let noteText: string | null = null;
      if (proj.noteFile) {
        const noteEntry = fileContents.get(proj.noteFile);
        if (noteEntry) {
          noteText = noteEntry.content;
        } else {
          const treeEntry = mdEntries.find((e) => e.path === proj.noteFile);
          if (treeEntry) noteText = await getBlobContent(creds, treeEntry.sha);
        }
      }

      return toolSuccess({
        status: 'success',
        project_id: found,
        root_page_path: proj.filePath,
        root_page_text: rootText,
        note_page_path: proj.noteFile,
        note_page_text: noteText,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
