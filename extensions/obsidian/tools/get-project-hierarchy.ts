import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree } from './git-api';
import { buildProjectTree, type Project } from './vault-parser';

export const OBSIDIAN_get_project_hierarchy: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_project_hierarchy',
  extensionName: 'obsidian',
  description:
    'Return a simplified hierarchy of projects in the Obsidian vault: root project names and immediate child names. Projects are identified by folder convention (a folder with FolderName/FolderName.md).',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    try {
      // Single subrequest for all metadata.
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      // Collect root projects (parent null), sorted alphabetically.
      const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
      const roots: Project[] = [];
      for (const proj of projects.values()) {
        if (proj.parentId === null) roots.push(proj);
      }
      roots.sort((a, b) => collator.compare(a.displayName, b.displayName));

      // Format as root name with indented immediate children.
      const lines: string[] = [];
      for (const root of roots) {
        lines.push(root.displayName);
        for (const childId of root.childrenIds) {
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
