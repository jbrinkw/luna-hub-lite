import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { TODOIST_get_tasks } from './get-tasks';
import { TODOIST_create_task } from './create-task';
import { TODOIST_complete_task } from './complete-task';
import { TODOIST_get_projects } from './get-projects';

export const todoistTools: Record<string, ExtensionToolDefinition> = {
  TODOIST_get_tasks,
  TODOIST_create_task,
  TODOIST_complete_task,
  TODOIST_get_projects,
};
