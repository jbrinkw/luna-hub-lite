import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const OBSIDIAN_update_note: ExtensionToolDefinition = {
  name: 'OBSIDIAN_update_note',
  extensionName: 'obsidian',
  description: 'Update (overwrite) an existing note in the Obsidian vault with new markdown content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path of the note (e.g. "folder/note.md")' },
      content: { type: 'string', description: 'New markdown content to replace the note with' },
    },
    required: ['path', 'content'],
  },
  handler: async (args, ctx) => {
    const { obsidian_api_key, obsidian_url } = (ctx as ExtensionToolContext).credentials;
    if (!obsidian_api_key || !obsidian_url) {
      return toolError('Missing Obsidian credentials (obsidian_api_key, obsidian_url)');
    }

    const url = `${obsidian_url}/vault/${encodeURIComponent(args.path)}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${obsidian_api_key}`,
        'Content-Type': 'text/markdown',
      },
      body: args.content,
    });

    if (!resp.ok) return toolError(`Obsidian API error: ${resp.status} ${resp.statusText}`);

    return toolSuccess({ path: args.path, updated: true });
  },
};
