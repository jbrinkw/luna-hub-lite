import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';
import { fetchAllTodoistPages } from './paginate';

export const TODOIST_get_sections: ExtensionToolDefinition = {
  name: 'TODOIST_get_sections',
  extensionName: 'todoist',
  description: 'List sections in Todoist, optionally filtered by project ID.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter sections by project ID' },
    },
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const params = new URLSearchParams();
      if (args.project_id) params.set('project_id', args.project_id);

      const qs = params.toString();
      const url = `${TODOIST_API_BASE}/sections${qs ? `?${qs}` : ''}`;

      // v1 API paginates list responses via next_cursor — follow every page so
      // accounts with many sections aren't truncated at the first page.
      const all = await fetchAllTodoistPages(url, { Authorization: `Bearer ${todoist_api_key}` });
      return toolSuccess(all);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
