import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

const TODOIST_BASE = 'https://api.todoist.com/rest/v2';

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

    const resp = await fetch(`${TODOIST_BASE}/projects`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${todoist_api_key}` },
    });

    if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

    const data = await resp.json();
    return toolSuccess(data);
  },
};
