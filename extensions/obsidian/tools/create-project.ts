import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getFileContent, putFileContent, deleteFileContent } from './git-api';
import { buildProjectTree } from './vault-parser';

/** Validate a single path segment. Trims, rejects empties + invalid chars. */
function isValidSegment(seg: string): boolean {
  if (!seg) return false;
  if (seg === '.' || seg === '..') return false;
  // GitHub allows most chars but disallow path separators, control chars, and a few
  // characters that tend to break in filesystem/Git clients.
  return !/[/\\\0<>:"|?*]/.test(seg);
}

export const OBSIDIAN_create_project: ExtensionToolDefinition = {
  name: 'OBSIDIAN_create_project',
  extensionName: 'obsidian',
  description:
    'Create a new project in the Obsidian vault. Commits `<path>/<name>.md` (root page) and `<path>/Notes.md` (empty notes file with frontmatter). By default the project is at the vault root; pass `parent_id` to nest under an existing project. Fails if the folder already contains the root file.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Project folder + root-file name (e.g. "Lunch Club"). Used as the last path segment and the stem of the root .md file.',
      },
      parent_id: {
        type: 'string',
        description:
          'Optional parent project (folder path or unique folder name). When set, the new project is created inside the parent folder.',
      },
      description: {
        type: 'string',
        description: 'Optional one-line description to include after the `# name` heading on the root page.',
      },
    },
    required: ['name'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    const rawName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!rawName) return toolError('name is required');
    if (!isValidSegment(rawName)) return toolError('name contains invalid path characters or is reserved (. / ..)');

    try {
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      let folderPath = rawName;
      if (args.parent_id) {
        // Resolve parent: exact path wins, else unique display-name match.
        let parent = projects.get(args.parent_id);
        if (!parent) {
          const q = String(args.parent_id).toLowerCase();
          const matches = Array.from(projects.values()).filter((p) => p.displayName.toLowerCase() === q);
          if (matches.length > 1) {
            const cands = matches.map((p) => p.id).join(', ');
            return toolError(`Ambiguous parent "${args.parent_id}". Candidates: ${cands}`);
          }
          if (matches.length === 1) parent = matches[0];
        }
        if (!parent) return toolError(`Parent project not found: ${args.parent_id}`);
        folderPath = `${parent.folderPath}/${rawName}`;
      }

      const rootPath = `${folderPath}/${rawName}.md`;
      const notesPath = `${folderPath}/Notes.md`;

      // Refuse to clobber an existing project. We check the Contents API rather
      // than just the tree because a user might recreate a recently-deleted
      // project before the next tree refresh propagates.
      const existingRoot = await getFileContent(creds, rootPath);
      if (existingRoot) {
        return toolError(`Project already exists: ${rootPath}`);
      }

      // Notes.md may or may not pre-exist — if it does we leave it alone and
      // only create the root file.
      const existingNotes = await getFileContent(creds, notesPath);

      const descLine = args.description ? `\n${String(args.description).trim()}\n` : '';
      const rootBody = `# ${rawName}\n${descLine}`;
      const rootSha = await putFileContent(creds, rootPath, rootBody, `project: create ${folderPath}`);

      let createdNotes = false;
      if (!existingNotes) {
        const notesBody = `---\nnote_project_id: ${rawName}\n---\n`;
        try {
          await putFileContent(creds, notesPath, notesBody, `project: notes skeleton ${folderPath}`);
        } catch (notesErr) {
          // B4-06: the two commits are non-atomic. If the Notes.md commit fails
          // after the root file was already created, roll the root file back so
          // the caller isn't left with a half-created project that the
          // existence probe would block on retry. Best-effort rollback; we still
          // surface the original Notes failure.
          try {
            await deleteFileContent(
              creds,
              rootPath,
              rootSha,
              `project: rollback ${folderPath} (Notes.md commit failed)`,
            );
          } catch (rollbackErr) {
            // Rollback itself failed — the root page is now orphaned. Log so the
            // operator can clean it up; we still surface the original Notes
            // failure (not this one) to the caller below.
            console.warn(`create_project: rollback of ${rootPath} failed:`, (rollbackErr as Error).message);
          }
          return toolError(`Failed to create Notes.md (rolled back root page): ${(notesErr as Error).message}`);
        }
        createdNotes = true;
      }

      return toolSuccess({
        status: 'success',
        project_id: folderPath,
        display_name: rawName,
        parent_id: args.parent_id ? (projects.get(args.parent_id)?.id ?? args.parent_id) : null,
        root_page_path: rootPath,
        note_page_path: notesPath,
        created_notes: createdNotes,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
