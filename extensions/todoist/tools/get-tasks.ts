import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_get_tasks: ExtensionToolDefinition = {
  name: 'TODOIST_get_tasks',
  extensionName: 'todoist',
  description: 'Get tasks from Todoist, optionally filtered by project or filter expression.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter tasks by project ID' },
      filter: { type: 'string', description: 'Todoist filter expression (e.g. "today", "overdue")' },
    },
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const params = new URLSearchParams();
      if (args.project_id) params.set('project_id', args.project_id);
      if (args.filter) params.set('filter', args.filter);

      const qs = params.toString();
      const url = `${TODOIST_API_BASE}/tasks${qs ? `?${qs}` : ''}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      const data = await resp.json();
      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
