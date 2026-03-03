import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { OBSIDIAN_search_notes } from './search-notes';
import { OBSIDIAN_create_note } from './create-note';
import { OBSIDIAN_get_note } from './get-note';
import { OBSIDIAN_update_note } from './update-note';

export const obsidianTools: Record<string, ExtensionToolDefinition> = {
  OBSIDIAN_search_notes,
  OBSIDIAN_create_note,
  OBSIDIAN_get_note,
  OBSIDIAN_update_note,
};
