import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

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

      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      const data: any = await resp.json();
      // v1 API wraps list responses in { results: [...] }
      return toolSuccess(Array.isArray(data) ? data : (data.results ?? data));
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
