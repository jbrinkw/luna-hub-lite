import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

export const TODOIST_complete_task: ExtensionToolDefinition = {
  name: 'TODOIST_complete_task',
  extensionName: 'todoist',
  description:
    "Mark a Todoist task as complete by its task ID. By default the task is closed via POST /tasks/{id}/close, which moves it into Todoist's completed log (shows up in TODOIST_get_completed_tasks). Pass `delete: true` to instead permanently delete the task (DELETE /tasks/{id}) — useful for dropped items or backlog cleanup that shouldn't appear in the accountability audit trail. Deleted tasks cannot be recovered and will NOT appear in the completed log.",
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The ID of the task to complete' },
      delete: {
        type: 'boolean',
        description:
          'When true, permanently delete the task instead of closing it. Deleted tasks do not appear in the completed log. Default false.',
      },
    },
    required: ['task_id'],
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');
    if (!args.task_id) return toolError('task_id is required');

    const shouldDelete = args.delete === true;
    const url = shouldDelete
      ? `${TODOIST_API_BASE}/tasks/${encodeURIComponent(args.task_id)}`
      : `${TODOIST_API_BASE}/tasks/${encodeURIComponent(args.task_id)}/close`;
    const method = shouldDelete ? 'DELETE' : 'POST';

    try {
      const resp = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${todoist_api_key}` },
      });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      return toolSuccess({
        task_id: args.task_id,
        completed: !shouldDelete,
        deleted: shouldDelete,
      });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
