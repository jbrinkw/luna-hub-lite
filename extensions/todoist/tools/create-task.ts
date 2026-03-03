import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

const TODOIST_BASE = 'https://api.todoist.com/rest/v2';

export const TODOIST_create_task: ExtensionToolDefinition = {
  name: 'TODOIST_create_task',
  extensionName: 'todoist',
  description: 'Create a new task in Todoist with optional project, due date, and priority.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Task content / title' },
      project_id: { type: 'string', description: 'Project ID to add the task to' },
      due_string: { type: 'string', description: 'Natural language due date (e.g. "tomorrow", "every Monday")' },
      priority: { type: 'number', description: 'Priority from 1 (normal) to 4 (urgent)' },
    },
    required: ['content'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    const body: Record<string, unknown> = { content: args.content };
    if (args.project_id) body.project_id = args.project_id;
    if (args.due_string) body.due_string = args.due_string;
    if (args.priority) body.priority = args.priority;

    const resp = await fetch(`${TODOIST_BASE}/tasks`, {
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
  },
};
