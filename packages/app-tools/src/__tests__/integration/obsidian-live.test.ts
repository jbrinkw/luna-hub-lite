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

function emptyCtx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: {
      github_token: '',
      github_repo: '',
      github_api_url: '',
    },
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe.skipIf(skip)('Obsidian (Gitea) Live Integration Tests', () => {
  // =========================================================================
  // get_project_hierarchy
  // =========================================================================

  describe('get_project_hierarchy', () => {
    it('should list Luna and Research as roots with Lite as child of Luna', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_hierarchy.handler({}, ctx());
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(typeof data.hierarchy).toBe('string');

      const hierarchy = data.hierarchy as string;

      // Root-level projects present
      expect(hierarchy).toContain('Luna');
      expect(hierarchy).toContain('Research');

      // Lite appears as a child (indented with "- ")
      expect(hierarchy).toMatch(/- Lite/);

      // Hierarchy mentions at least 3 projects (Luna, Lite, Research)
      const projectLines = hierarchy.split('\n').filter((l: string) => l.trim().length > 0);
      expect(projectLines.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // get_project_text
  // =========================================================================

  describe('get_project_text', () => {
    it('should return project text by project_id (luna-lite)', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'luna-lite' }, ctx());
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('luna-lite');

      // Root page should contain the project description
      expect(data.root_page_text).toContain('Serverless refactor');

      // Note page should contain all 3 dated entries
      expect(data.note_page_text).toContain('3/5/26');
      expect(data.note_page_text).toContain('3/4/26');
      expect(data.note_page_text).toContain('3/1/26');
    });

    it('should resolve by display name with exact case (Research)', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'Research' }, ctx());
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('research');
      expect(data.root_page_text).toBeTruthy();
    });

    it('should resolve by display name case-insensitively (research)', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'research' }, ctx());
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('research');
      expect(data.root_page_text).toBeTruthy();
    });

    it('should return root_page_text but no notes for parent without Notes.md (luna-development)', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'luna-development' }, ctx());
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('luna-development');
      expect(data.root_page_text).toBeTruthy();

      // luna-development has no Notes.md — note_page_text should be null or empty
      expect(!data.note_page_text || data.note_page_text === '').toBe(true);
    });

    it('should return isError for a non-existent project', async () => {
      const result = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'nonexistent' }, ctx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('not found');
    });
  });

  // =========================================================================
  // get_notes_by_date_range
  // =========================================================================

  describe('get_notes_by_date_range', () => {
    it('should return at least 5 entries across both projects for a wide range', async () => {
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
      for (let i = 0; i < dates.length - 1; i++) {
        expect(dates[i] >= dates[i + 1]).toBe(true);
      }

      // Should include entries from both projects
      const files = data.entries.map((e: any) => e.file);
      expect(files.some((f: string) => f.includes('Lite'))).toBe(true);
      expect(files.some((f: string) => f.includes('Research'))).toBe(true);
    });

    it('should return exactly 1 entry for a single-day range (3/5/26)', async () => {
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

    it('should return 0 entries for a range with no matches (no error)', async () => {
      const result = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: '1/1/20', end_date: '1/2/20' },
        ctx(),
      );
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.entries.length).toBe(0);
      expect(result.isError).toBeFalsy();
    });

    it('should auto-swap when end_date is before start_date', async () => {
      // Normal order result for comparison
      const normalResult = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: '3/1/26', end_date: '3/6/26' },
        ctx(),
      );
      const normalData = parse(normalResult);

      // Swapped order: start=3/6/26 end=3/1/26
      const swappedResult = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: '3/6/26', end_date: '3/1/26' },
        ctx(),
      );
      const swappedData = parse(swappedResult);

      expect(swappedData.status).toBe('success');
      expect(swappedData.entries.length).toBe(normalData.entries.length);

      // Same dates should appear in both results
      const normalDates = normalData.entries.map((e: any) => e.date_str).sort();
      const swappedDates = swappedData.entries.map((e: any) => e.date_str).sort();
      expect(swappedDates).toEqual(normalDates);
    });

    it('should return error for invalid date format', async () => {
      const result = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: 'invalid', end_date: '3/6/26' },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('MM/DD/YY');
    });

    it('should include file, date, date_str, and content fields on each entry', async () => {
      const result = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: '3/1/26', end_date: '3/6/26' },
        ctx(),
      );
      const data = parse(result);

      expect(data.entries.length).toBeGreaterThan(0);

      for (const entry of data.entries) {
        expect(entry).toHaveProperty('file');
        expect(entry).toHaveProperty('date');
        expect(entry).toHaveProperty('date_str');
        expect(entry).toHaveProperty('content');

        expect(typeof entry.file).toBe('string');
        expect(typeof entry.date).toBe('string');
        expect(typeof entry.date_str).toBe('string');
        expect(typeof entry.content).toBe('string');

        // date should be ISO format (YYYY-MM-DD)
        expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // date_str should be MM/DD/YY format
        expect(entry.date_str).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}$/);
        // file should be a .md path
        expect(entry.file).toMatch(/\.md$/);
        // content should be non-empty
        expect(entry.content.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Missing credentials
  // =========================================================================

  describe('missing credentials', () => {
    it('should return error when credentials are empty', async () => {
      const noCredCtx = emptyCtx();

      const hierarchyResult = await obsidianTools.OBSIDIAN_get_project_hierarchy.handler({}, noCredCtx);
      expect(hierarchyResult.isError).toBe(true);
      expect(hierarchyResult.content[0].text.toLowerCase()).toContain('credentials');

      const textResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'luna-lite' }, noCredCtx);
      expect(textResult.isError).toBe(true);
      expect(textResult.content[0].text.toLowerCase()).toContain('credentials');

      const rangeResult = await obsidianTools.OBSIDIAN_get_notes_by_date_range.handler(
        { start_date: '3/1/26', end_date: '3/6/26' },
        noCredCtx,
      );
      expect(rangeResult.isError).toBe(true);
      expect(rangeResult.content[0].text.toLowerCase()).toContain('credentials');

      const updateResult = await obsidianTools.OBSIDIAN_update_project_note.handler(
        { project_id: 'research', content: 'test' },
        noCredCtx,
      );
      expect(updateResult.isError).toBe(true);
      expect(updateResult.content[0].text.toLowerCase()).toContain('credentials');
    });
  });

  // =========================================================================
  // update_project_note (mutations — run LAST)
  // =========================================================================

  describe('update_project_note', () => {
    it('should append content to a project note and verify by re-reading', async () => {
      const marker = `live-test-append-${Date.now()}`;

      const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
        { project_id: 'research', content: marker },
        ctx(),
      );
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('research');
      expect(data.note_file).toContain('Notes.md');

      // Verify the content was written by re-reading the project
      const readResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'research' }, ctx());
      const readData = parse(readResult);

      expect(readData.note_page_text).toContain(marker);
    });

    it('should append content under a specific section (Testing)', async () => {
      const marker = `section-test-${Date.now()}`;

      const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
        { project_id: 'research', content: marker, section_id: 'Testing' },
        ctx(),
      );
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('research');

      // Verify the section and content exist
      const readResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'research' }, ctx());
      const readData = parse(readResult);

      expect(readData.note_page_text).toContain('## Testing');
      expect(readData.note_page_text).toContain(marker);
    });

    it('should create a new section (Audit) when appending to luna-lite', async () => {
      const marker = `new-section-${Date.now()}`;

      const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
        { project_id: 'luna-lite', content: marker, section_id: 'Audit' },
        ctx(),
      );
      const data = parse(result);

      expect(data.status).toBe('success');
      expect(data.project_id).toBe('luna-lite');

      // Verify the new section was created with content
      const readResult = await obsidianTools.OBSIDIAN_get_project_text.handler({ project_id: 'luna-lite' }, ctx());
      const readData = parse(readResult);

      expect(readData.note_page_text).toContain('## Audit');
      expect(readData.note_page_text).toContain(marker);
    });

    it('should return isError for a non-existent project', async () => {
      const result = await obsidianTools.OBSIDIAN_update_project_note.handler(
        { project_id: 'nonexistent', content: 'test' },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('not found');
    });
  });
});
