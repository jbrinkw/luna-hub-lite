import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getFileContent, putFileContent } from './git-api';
import { buildProjectTree, resolveProject } from './vault-parser';

interface Patch {
  find: string;
  replace: string;
}

/** Validate the patches array shape; returns null on success or an error message. */
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
      throw new Error(`patch ${i + 1}: 'find' not found in root doc`);
    }
    const last = next.lastIndexOf(find);
    if (last !== first) {
      throw new Error(`patch ${i + 1}: 'find' matches more than once`);
    }
    next = next.slice(0, first) + replace + next.slice(first + find.length);
  }
  return next;
}

export const OBSIDIAN_patch_project_root: ExtensionToolDefinition = {
  name: 'OBSIDIAN_patch_project_root',
  extensionName: 'obsidian',
  description:
    "Apply one or more search-replace patches to a project's root .md page. Each patch's `find` must match exactly once in the current file (errors on 0 or 2+ matches). Patches apply sequentially (patch N sees the result of patch N-1) and atomically — if any patch fails to match, none are written. Set `replace` to an empty string to delete the matched text. Use for surgical edits (toggle a checkbox, remove a line) or wholesale section swaps. Frontmatter is just text; patch it like anything else.",
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Project folder path or unique folder name (case-insensitive).',
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
    required: ['project_id', 'patches'],
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');
    if (!args.project_id) return toolError('project_id is required');

    const validated = validatePatches(args.patches);
    if (typeof validated === 'string') return toolError(validated);
    const { patches } = validated;

    try {
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      const { project, ambiguous } = resolveProject(projects, args.project_id);
      if (!project) {
        if (ambiguous.length > 0) {
          const cands = ambiguous.map((p) => p.id).join(', ');
          return toolError(`Ambiguous project "${args.project_id}". Candidates: ${cands}`);
        }
        return toolError(`Project not found: ${args.project_id}`);
      }

      // Fetch current root file via Contents API (the SHA returned here is what
      // putFileContent needs; the tree's blob SHA is a different value).
      const fresh = await getFileContent(creds, project.rootFilePath);
      if (!fresh) {
        return toolError(`Root file not found: ${project.rootFilePath}`);
      }

      let nextContent: string;
      try {
        nextContent = applyPatches(fresh.content, patches);
      } catch (e) {
        return toolError((e as Error).message);
      }

      // Avoid an empty commit when the patches happen to be no-ops.
      if (nextContent === fresh.content) {
        return toolSuccess({
          status: 'success',
          project_id: project.id,
          root_page_path: project.rootFilePath,
          patches_applied: patches.length,
          bytes_before: fresh.content.length,
          bytes_after: nextContent.length,
          unchanged: true,
        });
      }

      await putFileContent(
        creds,
        project.rootFilePath,
        nextContent,
        `root: patch ${project.id} (${patches.length})`,
        fresh.sha,
      );

      return toolSuccess({
        status: 'success',
        project_id: project.id,
        root_page_path: project.rootFilePath,
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
