# Obsidian Extension: Folder-Based Project Model

**Date:** 2026-04-10
**Status:** Approved for implementation

## Problem

The current Obsidian extension requires reading frontmatter from every `.md` file to build the project map (fields: `project_id`, `project_parent`, `note_project_id`). Each file is one GitHub API subrequest. Cloudflare Workers have a 50 subrequest limit per invocation. With ~10 subrequests for auth/tree/overhead, we can fetch at most ~40 files per tool call.

The user's vault will grow to 400+ `.md` files. The current design does not scale beyond ~40 files. Additionally, the user actively edits the vault in Obsidian — so any index-based caching strategy must handle external edits robustly, and SHA-based invalidation approaches would still need to fetch changed files on rebuild.

## Goal

Make all 4 Obsidian tools work reliably for vaults of any size within the subrequest budget, with no staleness issues from external Obsidian edits.

## Design

Projects are identified by **folder convention** alone. No frontmatter is required or consulted for project identification, parent-child relationships, or notes linking. The repository tree — returned in a single API call — is the complete source of truth for the project hierarchy.

### Core Rules

**Project detection:** A folder is a project if it contains a markdown file whose stem matches the folder name (case-insensitive).

- `Eco AI/Eco AI.md` → project with display name "Eco AI"
- `gamegenai/gamegenai.md` → project with display name "gamegenai"
- `CoachByte/CoachByte.md` → project with display name "CoachByte"

**Canonical ID:** The project's canonical ID is its full folder path from the vault root (e.g., `luna-personal-assistant/CoachByte`). This guarantees global uniqueness even when multiple folders share the same name at different paths.

**Parent-child:** A project's parent is the nearest ancestor folder that is itself a project. Walk up the folder tree; the first ancestor containing a matching `FolderName/FolderName.md` is the parent. If no ancestor is a project, the project is a root.

**Transparent folders:** Folders that are not themselves projects are invisible to the hierarchy but pass through. A project nested inside non-project folders still links to its nearest ancestor project.

**Notes file:** The notes file for a project is a file named `Notes.md` or `notes.md` (case-insensitive match of the stem) directly inside the project folder. Only files inside the immediate project folder are considered — notes in sub-project folders belong to those sub-projects, not to ancestors.

**One notes file per project:** If multiple notes-style files exist in a project folder (unusual), the first in tree traversal order wins. Other files are treated as regular content.

### Nesting Examples

Arbitrary depth is supported. The tree walker imposes no depth limit.

```
Luna/
  Luna.md                          project: Luna (root)
  Notes.md                         Luna's notes
  CoachByte/
    CoachByte.md                   project: CoachByte (parent: Luna)
    Notes.md                       CoachByte's notes
    Analytics/
      Analytics.md                 project: Analytics (parent: CoachByte)
      Notes.md                     Analytics' notes
      GainsGraph/
        GainsGraph.md              project: GainsGraph (parent: Analytics)
        Notes.md                   GainsGraph's notes
```

**Transparent organizational folders:**

```
Personal/                           NOT a project (no Personal.md)
  Journal/
    Journal.md                     project: Journal (parent: null, root)
```

If the user later adds `Personal/Personal.md`, Journal automatically becomes a child of Personal on the next tool call.

### Reference Resolution

Tools accept three forms when referring to a project:

1. **Full path:** `luna-personal-assistant/CoachByte` — always unambiguous
2. **Folder name (case-insensitive):** `CoachByte` — if exactly one project folder has that name
3. **Ambiguous match:** Multiple folders share the name — tool returns an error with the list of candidate paths and asks the caller to disambiguate

Substring matching is not performed — the match must be exact (case-insensitive). This avoids unexpected matches.

### Tool Behavior

All four tools retain their current signatures and output shapes. The internal implementation changes; the external contract does not.

**get_project_hierarchy**

- Input: none
- Output: nested list of project display names with root projects at top level and children indented
- Implementation: fetch tree (1 subrequest), run tree walker, format output

**get_project_text**

- Input: `project_id` (any of the three reference forms above)
- Output: root page path + content, notes page path + content (if present)
- Implementation: fetch tree (1 subrequest), resolve project, fetch the project's root .md file by SHA (1 subrequest), fetch Notes.md by SHA if present (1 subrequest). Total: 2-3 subrequests regardless of vault size.

**get_notes_by_date_range**

- Input: `start_date`, `end_date` (MM/DD/YY)
- Output: array of dated entries newest-first
- Implementation: fetch tree (1 subrequest), identify all `Notes.md`/`notes.md` files across the vault, fetch their contents by SHA in parallel, parse dated entries. Number of notes fetches = number of project folders that have a notes file. A vault with 40 projects = 40 fetches.

**Subrequest consideration for get_notes_by_date_range:** This tool can still approach the subrequest limit for very large vaults. Mitigation:

- Cap at 40 notes files per call. If more exist, return a `truncated: true` flag and the count of omitted files.
- Accept an optional `project_id` argument to restrict the scan to a single project (and its descendants). This makes the common case — "show me notes from Project X last week" — cost 1-few subrequests regardless of vault size.
- When unrestricted, prefer notes files from projects at shallower depth (more commonly top-level "active" projects) within the 40-file cap.

**update_project_note**

- Input: `project_id`, `content`, optional `section_id`
- Output: status + file paths + action flags
- Implementation: fetch tree (1 subrequest), resolve project, fetch existing Notes.md if any (1 subrequest), build new content, write via Contents API (1 subrequest). Total: 2-3 subrequests.

### Migration Path

The user's current vault already mostly follows the convention. Concrete migration:

**Required moves (optional — only if the user wants these to be projects):**

```
Home Assistant.md        → Home Assistant/Home Assistant.md
Project Mindhack.md      → Project Mindhack/Project Mindhack.md
Project Sweaty Balls.md  → Project Sweaty Balls/Project Sweaty Balls.md
```

**Optional rename (for nicer names):**

```
luna-personal-assistant/ → Luna/
```

**No other changes required.** Existing frontmatter (`project_id`, `project_parent`, `note_project_id`, `project_root`) remains in place — it is simply ignored by the new parser. Users may remove it if they wish, but no change is required.

### Backward Compatibility

The frontmatter-based parser (`buildProjects`, `linkNotes`) is removed. Vaults that rely on arbitrary `project_id` values different from folder names will see those IDs become unreachable. For the user's current vault, the mapping of old IDs to new folder-based IDs is:

| Old project_id | New canonical ID (folder path)                     |
| -------------- | -------------------------------------------------- |
| `eco-ai`       | `Eco AI`                                           |
| `Luna`         | `luna-personal-assistant` (or `Luna` after rename) |
| `coachbyte`    | `luna-personal-assistant/CoachByte`                |
| `gamegenai`    | `gamegenai`                                        |

Any saved conversation history that refers to old IDs will fail the lookup and return an error with candidates — the LLM will re-query `get_project_hierarchy` to see the current names.

## Architecture

### File-level changes

**Modified:**

- `vault-parser.ts` — Remove `parseFrontmatter`, `buildProjects`, `linkNotes`, `rootsOf`, `deriveDisplayName`. Keep `parseNoteEntries` and `formatDateShort`. Add new function `buildProjectTree(treeEntries)` that returns the project map purely from path analysis.
- `get-project-hierarchy.ts` — Call `getTree` then `buildProjectTree`. Remove `getMultipleBlobs` call and `buildProjects`/`linkNotes` calls.
- `get-project-text.ts` — Call `getTree`, `buildProjectTree`, resolve project, fetch root file and Notes.md by SHA.
- `get-notes-by-date-range.ts` — Call `getTree`, find all Notes.md entries from tree, fetch by SHA (capped at 40).
- `update-project-note.ts` — Call `getTree`, `buildProjectTree`, resolve project, fetch existing Notes.md if any, build new content, write.

**Unchanged:**

- `git-api.ts` — The API client stays the same. `getMultipleBlobs` is retained but used less aggressively (only for cases like notes-by-date-range).
- `index.ts` — Tool exports unchanged.

### New function: `buildProjectTree`

```typescript
interface Project {
  id: string; // full folder path from vault root (e.g., "Luna/CoachByte")
  displayName: string; // folder name (e.g., "CoachByte")
  folderPath: string; // same as id
  rootFilePath: string; // FolderName/FolderName.md
  rootFileSha: string; // from tree
  noteFilePath: string | null; // FolderName/Notes.md (or notes.md) if present
  noteFileSha: string | null;
  parentId: string | null;
  childrenIds: string[];
}

function buildProjectTree(treeEntries: TreeEntry[]): Map<string, Project>;
```

**Algorithm:**

1. Build an index of paths → sha from tree entries
2. Identify project folders:
   - For each blob path ending in `.md`, split into `dir/file.md`
   - Extract file stem (remove `.md`)
   - Check if folder name (last segment of `dir`) matches file stem case-insensitively
   - If yes, `dir` is a project folder
3. For each project folder, identify its Notes.md:
   - Look for a sibling blob matching `/^notes\.md$/i`
4. For each project, determine parent:
   - Walk up the folder path one segment at a time
   - For each ancestor, check if it is a project folder
   - First ancestor that is a project folder is the parent
   - If none, parent is null
5. Populate children arrays by iterating and filling in each parent's children
6. Sort children alphabetically by display name
7. Return the map keyed by canonical ID (full path)

### Lookup Function

```typescript
function resolveProject(
  projects: Map<string, Project>,
  query: string,
): { project: Project | null; ambiguous: Project[] };
```

1. Exact match on canonical ID (path) — return immediately if found
2. Exact case-insensitive match on display name (folder name)
   - If exactly one match, return it
   - If multiple matches, return ambiguous list
3. Otherwise return null

### Subrequest Budget Summary

| Tool                    | Subrequests                              | Scales to                                |
| ----------------------- | ---------------------------------------- | ---------------------------------------- |
| get_project_hierarchy   | 1 (tree)                                 | Unlimited                                |
| get_project_text        | 2-3 (tree + 1-2 blobs)                   | Unlimited                                |
| get_notes_by_date_range | 1 (tree) + N (notes files, capped at 40) | 40 projects with notes; truncates beyond |
| update_project_note     | 2-3 (tree + 1 existing + 1 write)        | Unlimited                                |

## Testing Approach

Since the Obsidian extension is tested at the tool level with mocked contexts, the tests will:

1. Construct synthetic `TreeEntry[]` arrays representing various vault shapes
2. Call `buildProjectTree` and assert the returned project map
3. Cover: flat roots, 1-level nesting, 4-level nesting, transparent non-project folders, missing root file (not a project), ambiguous folder names at different paths, notes file variants (`Notes.md`, `notes.md`), absent notes file

## Not in Scope

- Alias files (`.luna-aliases.json`) for custom names — deferred. Users rename folders if they want different names.
- Multiple notes files per project — not supported.
- Non-markdown attachments in project folders — present in the tree but ignored; not a concern.
- Branches other than `main` — out of scope (existing behavior preserved).
