import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { TODOIST_get_tasks } from './get-tasks';
import { TODOIST_get_task } from './get-task';
import { TODOIST_create_task } from './create-task';
import { TODOIST_update_task } from './update-task';
import { TODOIST_complete_task } from './complete-task';
import { TODOIST_get_projects } from './get-projects';
import { TODOIST_get_sections } from './get-sections';

export const todoistTools: Record<string, ExtensionToolDefinition> = {
  TODOIST_get_tasks,
  TODOIST_get_task,
  TODOIST_create_task,
  TODOIST_update_task,
  TODOIST_complete_task,
  TODOIST_get_projects,
  TODOIST_get_sections,
};
