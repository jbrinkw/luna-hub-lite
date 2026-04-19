import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getFileContent, putFileContent } from './git-api';

interface Patch {
  find: string;
  replace: string;
}

/** Validate the patches array shape; returns { patches } on success or an error string. */
function validatePatches(raw: unknown): { patches: Patch[] } | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'patches must be a non-empty array';
  }
  const patches: Patch[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as unknown;
    if (!p || typeof p !== 'object') return `patches[${i}] must be an object`;
    const find = (p as { find?: unknown }).find;
    const replace = (p as { replace?: unknown }).replace;
    if (typeof find !== 'string' || find.length === 0) {
      return `patches[${i}].find must be a non-empty string`;
    }
    if (typeof replace !== 'string') {
      return `patches[${i}].replace must be a string`;
    }
    patches.push({ find, replace });
  }
  return { patches };
}

/**
 * Apply patches sequentially to `text`. Each patch's `find` must occur exactly
 * once in the current state (after prior patches have been applied). Throws on
 * 0 matches or 2+ matches. Returns the new text — caller decides when to write.
 */
export function applyPatches(text: string, patches: Patch[]): string {
  let next = text;
  for (let i = 0; i < patches.length; i++) {
    const { find, replace } = patches[i];
    const first = next.indexOf(find);
    if (first === -1) {
      throw new Error(`patch ${i + 1}: 'find' not found in file`);
    }
    const last = next.lastIndexOf(find);
    if (last !== first) {
      throw new Error(`patch ${i + 1}: 'find' matches more than once`);
    }
    next = next.slice(0, first) + replace + next.slice(first + find.length);
  }
  return next;
}

export const OBSIDIAN_patch_file: ExtensionToolDefinition = {
  name: 'OBSIDIAN_patch_file',
  extensionName: 'obsidian',
  description:
    "Apply one or more search-replace patches to any existing file in the Obsidian vault (project root docs, Notes.md, or any other text file). Takes a full path from the vault root, e.g. 'Daily Review/Notes.md' or 'luna-personal-assistant/CoachByte/CoachByte.md'. Each patch's `find` must match exactly once in the current file (errors on 0 or 2+ matches). Patches apply sequentially (patch N sees the result of patch N-1) and atomically — if any patch fails to match, none are written. Set `replace` to an empty string to delete the matched text. Use for surgical edits, section swaps, or cleaning up bad content written by a prior run. Fails if the file doesn't exist; use `update_project_note` to append to Notes.md and `create_project` to scaffold a new project.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          "Full path of the file from the vault root, case-sensitive (e.g. 'Daily Review/Daily Review.md' for a project root doc, 'Daily Review/Notes.md' for a notes file).",
      },
      patches: {
        type: 'array',
        description: 'Array of { find, replace } operations applied sequentially and atomically.',
        items: {
          type: 'object',
          properties: {
            find: {
              type: 'string',
              description:
                'Exact text to find in the current file. Must match exactly once after prior patches in this batch have been applied.',
            },
            replace: {
              type: 'string',
              description: 'Text to substitute in place of `find`. Empty string deletes the matched text.',
            },
          },
          required: ['find', 'replace'],
        },
      },
    },
    required: ['path', 'patches'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (typeof args.path !== 'string' || args.path.trim().length === 0) {
      return toolError('path is required');
    }
    const path = args.path.trim();

    const validated = validatePatches(args.patches);
    if (typeof validated === 'string') return toolError(validated);
    const { patches } = validated;

    try {
      // Fetch the file via Contents API (the SHA returned here is what
      // putFileContent needs; the tree's blob SHA is a different value).
      const fresh = await getFileContent(creds, path);
      if (!fresh) {
        return toolError(`File not found: ${path}`);
      }

      let nextContent: string;
      try {
        nextContent = applyPatches(fresh.content, patches);
      } catch (e) {
        return toolError((e as Error).message);
      }

      // Skip the PUT when patches are a no-op (avoids a spurious commit).
      if (nextContent === fresh.content) {
        return toolSuccess({
          status: 'success',
          path,
          patches_applied: patches.length,
          bytes_before: fresh.content.length,
          bytes_after: nextContent.length,
          unchanged: true,
        });
      }

      await putFileContent(creds, path, nextContent, `patch ${path} (${patches.length})`, fresh.sha);

      return toolSuccess({
        status: 'success',
        path,
        patches_applied: patches.length,
        bytes_before: fresh.content.length,
        bytes_after: nextContent.length,
        unchanged: false,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
