import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_get_completed_tasks: ExtensionToolDefinition = {
  name: 'TODOIST_get_completed_tasks',
  extensionName: 'todoist',
  description:
    "Get tasks that were completed within a date range. Use for accountability: find out what the user actually checked off yesterday, last week, etc. Both `since` and `until` accept ISO 8601 date (YYYY-MM-DD) or datetime strings; a date-only value is treated by Todoist as that day's midnight UTC. To cover a full day inclusive, pass `since: '<day>T00:00:00Z'` and `until: '<nextday>T00:00:00Z'`. Returns each item with content, completed_at, project_id, and section_id.",
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'Start of range. ISO 8601 date (YYYY-MM-DD) or datetime (with Z). Inclusive.',
      },
      until: {
        type: 'string',
        description: 'End of range. ISO 8601 date or datetime. Use next-day midnight UTC to cover a whole day.',
      },
      project_id: { type: 'string', description: 'Optional — restrict to one project.' },
      limit: {
        type: 'number',
        description: 'Optional — max items (Todoist default 50, max 200).',
      },
    },
    required: ['since', 'until'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');
    if (!args.since || typeof args.since !== 'string')
      return toolError('since is required (ISO date or datetime string)');
    if (!args.until || typeof args.until !== 'string')
      return toolError('until is required (ISO date or datetime string)');

    try {
      const params = new URLSearchParams();
      params.set('since', args.since);
      params.set('until', args.until);
      if (args.project_id) params.set('project_id', String(args.project_id));
      if (args.limit) params.set('limit', String(args.limit));

      const url = `${TODOIST_API_BASE}/tasks/completed/by_completion_date?${params.toString()}`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      const data: unknown = await resp.json();
      // Todoist wraps this endpoint as { items: [...] }; `get-tasks` uses `results`.
      // Unwrap defensively.
      const items = Array.isArray(data)
        ? data
        : ((data as { items?: unknown }).items ?? (data as { results?: unknown }).results ?? data);
      return toolSuccess(items);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
