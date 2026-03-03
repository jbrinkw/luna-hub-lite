import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const OBSIDIAN_search_notes: ExtensionToolDefinition = {
  name: 'OBSIDIAN_search_notes',
  extensionName: 'obsidian',
  description: 'Search notes in the Obsidian vault by text query. Returns matching file paths and content excerpts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text' },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    const { obsidian_api_key, obsidian_url } = (ctx as ExtensionToolContext).credentials;
    if (!obsidian_api_key || !obsidian_url) {
      return toolError('Missing Obsidian credentials (obsidian_api_key, obsidian_url)');
    }

    try {
      const url = `${obsidian_url}/search/simple/?query=${encodeURIComponent(args.query)}`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${obsidian_api_key}`,
          Accept: 'application/json',
        },
      });

      if (!resp.ok) return toolError(`Obsidian API error: ${resp.status} ${resp.statusText}`);

      const data = await resp.json();
      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
