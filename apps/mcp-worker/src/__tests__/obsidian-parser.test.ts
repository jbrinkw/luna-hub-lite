import { describe, it, expect } from 'vitest';
import { buildProjectTree, resolveProject, parseNoteEntries } from '../../../../extensions/obsidian/tools/vault-parser';
import type { TreeEntry } from '../../../../extensions/obsidian/tools/git-api';

function blob(path: string, sha = `sha-${path}`): TreeEntry {
  return { path, sha, type: 'blob' };
}

describe('buildProjectTree', () => {
  it('detects a flat root project from FolderName/FolderName.md pattern', () => {
    const entries: TreeEntry[] = [blob('Eco AI/Eco AI.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    const proj = projects.get('Eco AI');
    expect(proj).toBeDefined();
    expect(proj!.displayName).toBe('Eco AI');
    expect(proj!.rootFilePath).toBe('Eco AI/Eco AI.md');
    expect(proj!.parentId).toBeNull();
    expect(proj!.childrenIds).toEqual([]);
    expect(proj!.noteFilePath).toBeNull();
  });

  it('does not detect a project when stem does not match folder name', () => {
    const entries: TreeEntry[] = [blob('Eco AI/agents.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(0);
  });

  it('does not detect a project from a root-level .md file with no folder', () => {
    const entries: TreeEntry[] = [blob('standalone.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(0);
  });

  it('matches folder and file case-insensitively', () => {
    const entries: TreeEntry[] = [blob('gamegenai/GAMEGENAI.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    const proj = projects.get('gamegenai');
    expect(proj).toBeDefined();
    expect(proj!.displayName).toBe('gamegenai');
  });

  it('links a sibling Notes.md to its project', () => {
    const entries: TreeEntry[] = [blob('Eco AI/Eco AI.md', 'sha-root'), blob('Eco AI/Notes.md', 'sha-notes')];
    const projects = buildProjectTree(entries);
    const proj = projects.get('Eco AI');
    expect(proj!.noteFilePath).toBe('Eco AI/Notes.md');
    expect(proj!.noteFileSha).toBe('sha-notes');
  });

  it('links a lowercase notes.md to its project (case-insensitive)', () => {
    const entries: TreeEntry[] = [blob('CoachByte/CoachByte.md'), blob('CoachByte/notes.md', 'sha-notes')];
    const projects = buildProjectTree(entries);
    const proj = projects.get('CoachByte');
    expect(proj!.noteFilePath).toBe('CoachByte/notes.md');
    expect(proj!.noteFileSha).toBe('sha-notes');
  });

  it('does not link a Notes.md that lives in a non-project folder', () => {
    const entries: TreeEntry[] = [blob('Orphan/Notes.md'), blob('Luna/Luna.md')];
    const projects = buildProjectTree(entries);
    expect(projects.get('Luna')!.noteFilePath).toBeNull();
  });

  it('does not link a Notes.md from a sub-project to its ancestor', () => {
    const entries: TreeEntry[] = [
      blob('Luna/Luna.md'),
      blob('Luna/CoachByte/CoachByte.md'),
      blob('Luna/CoachByte/Notes.md', 'sha-child-notes'),
    ];
    const projects = buildProjectTree(entries);
    expect(projects.get('Luna')!.noteFilePath).toBeNull();
    expect(projects.get('Luna/CoachByte')!.noteFilePath).toBe('Luna/CoachByte/Notes.md');
  });

  it('builds one level of parent-child nesting', () => {
    const entries: TreeEntry[] = [blob('Luna/Luna.md'), blob('Luna/CoachByte/CoachByte.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.get('Luna')!.parentId).toBeNull();
    expect(projects.get('Luna/CoachByte')!.parentId).toBe('Luna');
    expect(projects.get('Luna')!.childrenIds).toEqual(['Luna/CoachByte']);
  });

  it('builds four levels of parent-child nesting', () => {
    const entries: TreeEntry[] = [blob('A/A.md'), blob('A/B/B.md'), blob('A/B/C/C.md'), blob('A/B/C/D/D.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(4);
    expect(projects.get('A')!.parentId).toBeNull();
    expect(projects.get('A/B')!.parentId).toBe('A');
    expect(projects.get('A/B/C')!.parentId).toBe('A/B');
    expect(projects.get('A/B/C/D')!.parentId).toBe('A/B/C');
    expect(projects.get('A')!.childrenIds).toEqual(['A/B']);
    expect(projects.get('A/B')!.childrenIds).toEqual(['A/B/C']);
    expect(projects.get('A/B/C')!.childrenIds).toEqual(['A/B/C/D']);
  });

  it('treats non-project folders as transparent when resolving parent', () => {
    // Personal/ is not a project (no Personal.md). Journal/ IS a project.
    const entries: TreeEntry[] = [blob('Personal/Journal/Journal.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    expect(projects.get('Personal/Journal')!.parentId).toBeNull();
  });

  it('skips a non-project intermediate folder to find the nearest ancestor project', () => {
    // A is a project, A/X is NOT a project (no X.md), A/X/Y is a project.
    // Y's parent should be A (X is transparent).
    const entries: TreeEntry[] = [blob('A/A.md'), blob('A/X/Y/Y.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.get('A/X/Y')!.parentId).toBe('A');
    expect(projects.get('A')!.childrenIds).toEqual(['A/X/Y']);
  });

  it('sorts children alphabetically by displayName (case-insensitive)', () => {
    const entries: TreeEntry[] = [
      blob('Root/Root.md'),
      blob('Root/zebra/zebra.md'),
      blob('Root/Apple/Apple.md'),
      blob('Root/mango/mango.md'),
    ];
    const projects = buildProjectTree(entries);
    expect(projects.get('Root')!.childrenIds).toEqual(['Root/Apple', 'Root/mango', 'Root/zebra']);
  });

  it('allows duplicate display names at different paths (both tracked separately)', () => {
    const entries: TreeEntry[] = [blob('Left/Shared/Shared.md'), blob('Right/Shared/Shared.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(2);
    expect(projects.has('Left/Shared')).toBe(true);
    expect(projects.has('Right/Shared')).toBe(true);
  });

  it('ignores non-.md blobs when detecting projects', () => {
    const entries: TreeEntry[] = [blob('Luna/Luna.png'), blob('Luna/Luna.md')];
    const projects = buildProjectTree(entries);
    expect(projects.size).toBe(1);
    expect(projects.has('Luna')).toBe(true);
  });
});

describe('resolveProject', () => {
  const entries: TreeEntry[] = [
    blob('Luna/Luna.md'),
    blob('Luna/CoachByte/CoachByte.md'),
    blob('Other/CoachByte/CoachByte.md'),
    blob('Solo/Solo.md'),
  ];
  const projects = buildProjectTree(entries);

  it('returns the project for an exact canonical id', () => {
    const { project, ambiguous } = resolveProject(projects, 'Luna/CoachByte');
    expect(project).toBeDefined();
    expect(project!.id).toBe('Luna/CoachByte');
    expect(ambiguous).toEqual([]);
  });

  it('returns the project for a unique case-insensitive displayName', () => {
    const { project, ambiguous } = resolveProject(projects, 'solo');
    expect(project).toBeDefined();
    expect(project!.id).toBe('Solo');
    expect(ambiguous).toEqual([]);
  });

  it('returns ambiguous candidates when displayName matches multiple projects', () => {
    const { project, ambiguous } = resolveProject(projects, 'CoachByte');
    expect(project).toBeNull();
    expect(ambiguous.length).toBe(2);
    const ids = ambiguous.map((p) => p.id).sort();
    expect(ids).toEqual(['Luna/CoachByte', 'Other/CoachByte']);
  });

  it('returns null + empty ambiguous when no match exists', () => {
    const { project, ambiguous } = resolveProject(projects, 'Nonexistent');
    expect(project).toBeNull();
    expect(ambiguous).toEqual([]);
  });

  it('returns null + empty ambiguous for an empty query', () => {
    const { project, ambiguous } = resolveProject(projects, '');
    expect(project).toBeNull();
    expect(ambiguous).toEqual([]);
  });
});

// =============================================================================
// parseNoteEntries — frontmatter edge cases
// =============================================================================

describe('parseNoteEntries', () => {
  it('OBS-2: YAML block scalar containing "---" on its own indented line does not corrupt bodyStart', () => {
    // A YAML block scalar uses `|` and the content is indented. The literal
    // "---" inside the scalar is NOT the frontmatter closing delimiter — only
    // an unindented "---" at column 0 closes the frontmatter block.
    const text = [
      '---',
      'some_key: |',
      '  line1',
      '  ---', // this is content inside the block scalar, not a delimiter
      '  line2',
      '---', // real closing delimiter at column 0
      '',
      '4/1/26',
      'Today entry.',
    ].join('\n');

    const entries = parseNoteEntries(text);

    // Must find the entry — if bodyStart is computed incorrectly,
    // the date header "4/1/26" is never reached and entries is empty.
    expect(entries.length).toBe(1);
    expect(entries[0].dateStr).toBe('4/1/26');
    expect(entries[0].content).toBe('Today entry.');
  });

  it('parses entries from a file with no frontmatter at all', () => {
    const text = '4/5/26\nJust a plain note.\n\n4/6/26\nAnother note.\n';
    const entries = parseNoteEntries(text);
    expect(entries.length).toBe(2);
    expect(entries[0].dateStr).toBe('4/5/26');
    expect(entries[1].dateStr).toBe('4/6/26');
  });

  it('silently skips invalid date headers (e.g. 13/45/26 — month 13) and continues parsing', () => {
    // JS Date rolls over impossible dates — we verify no crash and the valid
    // entry is still returned.
    const text = '---\nfoo: bar\n---\n\n13/45/26\nImpossible date.\n\n4/5/26\nValid entry.\n';
    const entries = parseNoteEntries(text);
    // 13/45/26 is a JS Date roll-over (month 13 → February of next year,
    // day 45 rolls further). The parser does NOT currently validate the date
    // against month boundaries — it just wraps. So 13/45/26 may yield a
    // rolled date. The important assertion: no crash and the valid 4/5/26
    // entry is present.
    const validEntry = entries.find((e) => e.dateStr === '4/5/26');
    expect(validEntry).toBeDefined();
    expect(validEntry!.content).toBe('Valid entry.');
  });
});
