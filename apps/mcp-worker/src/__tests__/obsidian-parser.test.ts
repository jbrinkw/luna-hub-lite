import { describe, it, expect } from 'vitest';
import { buildProjectTree, resolveProject } from '../../../../extensions/obsidian/tools/vault-parser';
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
});

describe('resolveProject', () => {
  it('returns not-found for an empty project map', () => {
    const entries: TreeEntry[] = [];
    const projects = buildProjectTree(entries);
    const result = resolveProject(projects, 'anything');
    expect(result.project).toBeNull();
    expect(result.ambiguous).toEqual([]);
  });
});
