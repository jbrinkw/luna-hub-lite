import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

const TODOIST_BASE = 'https://api.todoist.com/rest/v2';

export const TODOIST_complete_task: ExtensionToolDefinition = {
  name: 'TODOIST_complete_task',
  extensionName: 'todoist',
  description: 'Mark a Todoist task as complete by its task ID.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The ID of the task to complete' },
    },
    required: ['task_id'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const resp = await fetch(`${TODOIST_BASE}/tasks/${encodeURIComponent(args.task_id)}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      return toolSuccess({ task_id: args.task_id, completed: true });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
