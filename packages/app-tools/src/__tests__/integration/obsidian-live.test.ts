import { describe, it, expect } from 'vitest';
import { obsidianTools } from '../../../../../extensions/obsidian/tools';
import type { ExtensionToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Obsidian (Gitea) Live Integration Tests
// ---------------------------------------------------------------------------
// These tests hit a local Gitea instance with a pre-seeded Obsidian vault.
// They require GITEA_TOKEN in the environment. When absent the entire suite
// is skipped automatically.
//
// Seeded vault layout:
//   Projects/Luna/Luna.md          (project_id: luna-development)
//   Projects/Luna/Lite/Lite.md     (project_id: luna-lite, parent: luna-development)
//   Projects/Luna/Lite/Notes.md    (note_project_id: luna-lite, entries: 3/5/26, 3/4/26, 3/1/26)
//   Projects/Research/Research.md  (project_id: research)
//   Projects/Research/Notes.md     (note_project_id: research, entries: 3/6/26, 3/3/26)
// ---------------------------------------------------------------------------

const GITEA_TOKEN = process.env.GITEA_TOKEN;
const GITEA_REPO = process.env.GITEA_REPO || 'testuser/obsidian-vault';
const GITEA_URL = process.env.GITEA_URL || 'http://localhost:3000/api/v1';
const skip = !GITEA_TOKEN;

function ctx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: {
      github_token: GITEA_TOKEN!,
      github_repo: GITEA_REPO,
      github_api_url: GITEA_URL,
    },
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe.skipIf(skip)('Obsidian (Gitea) Live Integration Tests', () => {
  // -------------------------------------------------------------------------
  // get_project_hierarchy
  // -------------------------------------------------------------------------

  it('should return the project hierarchy with roots and children', async () => {
    const result = await obsidianTools.OBSIDIAN_get_project_hierarchy.handler({}, ctx());
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(typeof data.hierarchy).toBe('string');

    const hierarchy = data.hierarchy as string;

    // Should contain root-level projects
    expect(hierarchy).toMatch(/Luna/i);
    expect(hierarchy).toMatch(/Research/i);

    // Lite should appear as a child (indented with "- ")
    expect(hierarchy).toMatch(/- Lite/i);
  });

  // -------------------------------------------------------------------------
  // get_project_text — by project_id
  // -------------------------------------------------------------------------

  it('should return project text by project_id', async () => {
    const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'luna-lite' }, ctx());
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(data.project_id).toBe('luna-lite');

    // Root page should contain the project description
    expect(data.root_page_text).toContain('Serverless refactor');

    // Note page should contain dated entries
    expect(data.note_page_text).toContain('3/5/26');
    expect(data.note_page_text).toContain('3/4/26');
    expect(data.note_page_text).toContain('3/1/26');
  });

  // -------------------------------------------------------------------------
  // get_project_text — by display name
  // -------------------------------------------------------------------------

  it('should return project text by display name', async () => {
    const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'Research' }, ctx());
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(data.project_id).toBe('research');
    expect(data.root_page_text).toContain('General research notes');
    expect(data.note_page_text).toContain('3/6/26');
    expect(data.note_page_text).toContain('3/3/26');
  });

  // -------------------------------------------------------------------------
  // get_project_text — not found
  // -------------------------------------------------------------------------

  it('should return an error for a non-existent project', async () => {
    const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'nonexistent' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  // -------------------------------------------------------------------------
  // get_notes_by_date_range — wide range
  // -------------------------------------------------------------------------

  it('should return notes within a wide date range, newest first', async () => {
    const result = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
      { start_date: '3/1/26', end_date: '3/6/26' },
      ctx(),
    );
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries.length).toBeGreaterThanOrEqual(5);

    // Newest first: first entry date >= last entry date
    const dates = data.entries.map((e: any) => e.date);
    expect(dates[0] >= dates[dates.length - 1]).toBe(true);

    // Should include entries from both projects
    const files = data.entries.map((e: any) => e.file);
    expect(files.some((f: string) => f.includes('Lite'))).toBe(true);
    expect(files.some((f: string) => f.includes('Research'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // get_notes_by_date_range — narrow (single day)
  // -------------------------------------------------------------------------

  it('should return only matching entries for a single-day range', async () => {
    const result = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
      { start_date: '3/5/26', end_date: '3/5/26' },
      ctx(),
    );
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].date_str).toBe('3/5/26');
    expect(data.entries[0].content).toContain('extension parity');
  });

  // -------------------------------------------------------------------------
  // update_project_note — append content
  // -------------------------------------------------------------------------

  it("should append content to today's note entry", async () => {
    const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
      { project_id: 'research', content: 'Live test entry' },
      ctx(),
    );
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(data.project_id).toBe('research');
    expect(data.note_file).toContain('Notes.md');

    // Verify the content was written by re-reading the project
    const readResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'research' }, ctx());
    const readData = parse(readResult);

    expect(readData.note_page_text).toContain('Live test entry');
  });

  // -------------------------------------------------------------------------
  // update_project_note — with section
  // -------------------------------------------------------------------------

  it('should append content under a specific section', async () => {
    const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
      { project_id: 'research', content: 'Section test entry', section_id: 'Testing' },
      ctx(),
    );
    const data = parse(result);

    expect(data.status).toBe('success');
    expect(data.project_id).toBe('research');

    // Verify the section and content exist
    const readResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'research' }, ctx());
    const readData = parse(readResult);

    expect(readData.note_page_text).toContain('## Testing');
    expect(readData.note_page_text).toContain('Section test entry');
  });
});
