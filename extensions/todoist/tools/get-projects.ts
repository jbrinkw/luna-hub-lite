import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';
import { fetchAllTodoistPages } from './paginate';

export const TODOIST_get_projects: ExtensionToolDefinition = {
  name: 'TODOIST_get_projects',
  extensionName: 'todoist',
  description: 'List all projects in the Todoist account.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      // v1 API paginates list responses via next_cursor — follow every page so
      // accounts with many projects aren't truncated at the first page.
      const all = await fetchAllTodoistPages(`${TODOIST_API_BASE}/projects`, {
        Authorization: `Bearer ${todoist_api_key}`,
      });
      return toolSuccess(all);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
