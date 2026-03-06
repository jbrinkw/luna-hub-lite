import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_update_task: ExtensionToolDefinition = {
  name: 'TODOIST_update_task',
  extensionName: 'todoist',
  description: 'Update an existing Todoist task. Only provided fields are changed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The ID of the task to update' },
      content: { type: 'string', description: 'New task content / title' },
      description: { type: 'string', description: 'New task description' },
      due_string: { type: 'string', description: 'Natural language due date (e.g. "tomorrow", "every Monday")' },
      priority: { type: 'number', description: 'Priority from 1 (normal) to 4 (urgent)' },
    },
    required: ['task_id'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    try {
      const body: Record<string, unknown> = {};
      if (args.content !== undefined) body.content = args.content;
      if (args.description !== undefined) body.description = args.description;
      if (args.due_string !== undefined) body.due_string = args.due_string;
      if (args.priority !== undefined) body.priority = args.priority;

      const resp = await fetch(`${TODOIST_API_BASE}/tasks/${encodeURIComponent(args.task_id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${todoist_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      const data = await resp.json();
      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
