import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { OBSIDIAN_get_project_hierarchy } from './get-project-hierarchy';
import { OBSIDIAN_get_project_text } from './get-project-text';
import { OBSIDIAN_get_notes_by_date_range } from './get-notes-by-date-range';
import { OBSIDIAN_update_project_note } from './update-project-note';
import { OBSIDIAN_usage_guide } from './usage-guide';

export const obsidianTools: Record<string, ExtensionToolDefinition> = {
  OBSIDIAN_usage_guide,
  OBSIDIAN_get_project_hierarchy,
  OBSIDIAN_get_project_text,
  OBSIDIAN_get_notes_by_date_range,
  OBSIDIAN_update_project_note,
};
