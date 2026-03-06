import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, listAllFiles, getMultipleFiles } from './git-api';
import { buildProjects, linkNotes, rootsOf } from './vault-parser';

export const OBSIDIAN_get_project_hierarchy: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_hierarchy',
  extensionName: 'obsidian',
  description:
    'Return a simplified hierarchy of projects in the Obsidian vault: root project names and immediate child names.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    try {
      const allFiles = await listAllFiles(creds);
      const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
      const fileContents = await getMultipleFiles(creds, mdFiles);

      const projects = buildProjects(fileContents);
      linkNotes(fileContents, projects);

      const lines: string[] = [];
      for (const rootId of rootsOf(projects)) {
        const root = projects.get(rootId)!;
        lines.push(root.displayName);
        for (const childId of root.children) {
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
