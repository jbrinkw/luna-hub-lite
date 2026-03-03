import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const OBSIDIAN_get_note: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_note',
  extensionName: 'obsidian',
  description: 'Retrieve the content of a note from the Obsidian vault by its path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path of the note (e.g. "folder/note.md")' },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const { obsidian_api_key, obsidian_url } = (ctx as ExtensionToolContext).credentials;
    if (!obsidian_api_key || !obsidian_url) {
      return toolError('Missing Obsidian credentials (obsidian_api_key, obsidian_url)');
    }

    try {
      const url = `${obsidian_url}/vault/${encodeURIComponent(args.path)}`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${obsidian_api_key}`,
          Accept: 'text/markdown',
        },
      });

      if (!resp.ok) return toolError(`Obsidian API error: ${resp.status} ${resp.statusText}`);

      const content = await resp.text();
      return toolSuccess({ path: args.path, content });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
