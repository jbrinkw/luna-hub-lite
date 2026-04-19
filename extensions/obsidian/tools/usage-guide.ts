import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { toolSuccess } from '@luna-hub/app-tools';

const GUIDE = `# Obsidian Vault

## Model
Project = folder F with F/F.md (stem = folder, case-insensitive). Canonical ID = full path from root (e.g. \`luna-personal-assistant/CoachByte\`); bare folder name works if unique else ambiguous error. Parent = nearest ancestor project; non-project folders are transparent.

Notes.md = dated entries, newest-first:

    ---
    note_project_id: Foo
    ---
    4/14/26
    ## optional section
    body until next date

Date: MM/DD/YY[:] (year = 2000+YY).

## Content
- **Projects** (builds): \`Eco AI\`, \`gamegenai\`, \`Home Assistant\`, \`luna-personal-assistant/{chefbyte,CoachByte,ProfessorByte,Universal Architecture}\`, \`Open Ethos\`, \`Project*\`. Technical.
- **Journal** (personal): \`Journal/Notes.md\`, Day One import 9/7/24+. Diary, not work.

## Tools
- \`get_project_hierarchy\` — roots + immediate children.
- \`get_project_text(project_id)\` — full root + Notes.md. Can be 100KB+; prefer date-range.
- \`get_notes_by_date_range(start, end, project_id?)\` — MM/DD/YY, newest-first. 40-file cap (\`truncated\` flag); scope by project.
- \`update_project_note(project_id, content, section_id?, date?)\` — appends to that date's entry (default today). Repeat calls for the same date append into the existing entry (no new date header). Pass \`date\` (MM/DD/YY) to backdate; new backdated entries are placed chronologically (newest-first). Two blank lines trail every insert.
- \`create_project(name, parent_id?, description?)\` — scaffolds a new project: commits \`<path>/<name>.md\` (root page) and \`<path>/Notes.md\` (empty, with frontmatter). Defaults to vault root; \`parent_id\` nests it under an existing project.
- \`patch_file(path, patches[])\` — search-replace edits to ANY .md file in the vault (root docs, Notes.md, anything). Each patch's \`find\` must match exactly once. Patches apply sequentially and atomically (none commit if any fails to match). Empty \`replace\` deletes. Pass a full vault-relative path (e.g. \`Daily Review/Notes.md\`).
- \`get_morning_brief(project_id?)\` — bundled read for the morning accountability routine. Defaults to \`Daily Review\`. Returns root doc + last 7 days of vault-wide notes + full routine instructions. Call once when the user asks for their morning brief.

## Limits
Branch hardcoded to \`main\`. Case-insensitive bare name, case-sensitive path. "Today" = server clock.
`;

export const OBSIDIAN_usage_guide: ExtensionToolDefinition = {
  name: 'OBSIDIAN_usage_guide',
  extensionName: 'obsidian',
  requiresCredentials: false,
  description:
    'Obsidian vault primer. Call (no args) for full guide.\n\n' +
    'Project = folder F containing F/F.md. Optional sibling Notes.md holds dated entries: MM/DD/YY headers, newest-first, body until next date. Projects nest; parent = nearest ancestor project.\n\n' +
    "Content types: (1) projects = user's builds/ventures, technical notes; (2) Journal = personal diary (Day One import, 9/7/24+), same format different purpose — life entries, not work.\n\n" +
    'Tools: OBSIDIAN_{get_project_hierarchy, get_project_text, get_notes_by_date_range, update_project_note}.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => toolSuccess({ guide: GUIDE }),
};
