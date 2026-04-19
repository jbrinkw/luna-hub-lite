import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obsidianTools } from '../../../../extensions/obsidian/tools';
import { todoistTools } from '../../../../extensions/todoist/tools';
import { homeassistantTools } from '../../../../extensions/homeassistant/tools';
import type { ExtensionToolContext } from '../types';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockFetchResponse(body: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// Base context (userId and supabase not used by extension tools)
const baseCtx = { userId: 'user-1', supabase: {} as any };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obsidianCtx(overrides: Partial<Record<string, string>> = {}): ExtensionToolContext {
  return {
    ...baseCtx,
    credentials: {
      github_token: 'ghp-test-token',
      github_repo: 'testuser/vault',
      github_api_url: 'https://api.github.com',
      ...overrides,
    },
  };
}

function todoistCtx(overrides: Partial<Record<string, string>> = {}): ExtensionToolContext {
  return {
    ...baseCtx,
    credentials: {
      todoist_api_key: 'todoist-key-456',
      ...overrides,
    },
  };
}

function haCtx(overrides: Partial<Record<string, string>> = {}): ExtensionToolContext {
  return {
    ...baseCtx,
    credentials: {
      ha_api_key: 'ha-key-789',
      ha_url: 'https://homeassistant.local:8123',
      ...overrides,
    },
  };
}

function emptyCredentialsCtx(): ExtensionToolContext {
  return { ...baseCtx, credentials: {} };
}

// ---------------------------------------------------------------------------
// Obsidian mock data helpers
// ---------------------------------------------------------------------------

/** Mock a git trees API response followed by contents API responses for each .md file. */
function mockObsidianVault(files: Array<{ path: string; content: string; sha?: string }>) {
  // First call: GET /git/trees/main?recursive=1
  mockFetch.mockReturnValueOnce(
    mockFetchResponse({
      tree: files.map((f) => ({ type: 'blob', path: f.path })),
    }),
  );
  // Subsequent calls: GET /contents/{path} for each .md file
  for (const f of files.filter((f) => f.path.endsWith('.md'))) {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        content: btoa(f.content),
        sha: f.sha || 'sha-' + f.path.replace(/\//g, '-'),
      }),
    );
  }
}

const PROJECT_A_MD = `---
project_id: a
---
# Project A

This is the root page for project A.`;

const NOTES_A_MD = `---
note_project_id: a
---

3/5/26:
Some notes for March 5th.

3/1/26:
Earlier notes for March 1st.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// Obsidian
// ===========================================================================

describe('OBSIDIAN_usage_guide', () => {
  const tool = obsidianTools.OBSIDIAN_usage_guide;

  it('declares extensionName and opts out of credentials', () => {
    expect(tool.extensionName).toBe('obsidian');
    expect(tool.requiresCredentials).toBe(false);
  });

  it('returns a guide payload without making network calls', async () => {
    const result = await tool.handler({}, { ...baseCtx, credentials: {} } as ExtensionToolContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.guide).toBe('string');
    expect(parsed.guide).toContain('Project =');
    expect(parsed.guide).toContain('Journal');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mentions all four companion tools in the guide body', async () => {
    const result = await tool.handler({}, { ...baseCtx, credentials: {} } as ExtensionToolContext);
    const { guide } = JSON.parse(result.content[0].text) as { guide: string };
    expect(guide).toContain('get_project_hierarchy');
    expect(guide).toContain('get_project_text');
    expect(guide).toContain('get_notes_by_date_range');
    expect(guide).toContain('update_project_note');
  });
});

describe('OBSIDIAN_get_project_hierarchy', () => {
  const handler = obsidianTools.OBSIDIAN_get_project_hierarchy.handler;

  it('returns hierarchy string on success', async () => {
    mockObsidianVault([
      { path: 'Projects/A/A.md', content: PROJECT_A_MD },
      { path: 'Projects/A/Notes.md', content: NOTES_A_MD },
    ]);

    const result = await handler({}, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.hierarchy).toBeDefined();
    expect(typeof parsed.hierarchy).toBe('string');
    // The hierarchy should mention the project name
    expect(parsed.hierarchy).toContain('A');
  });

  it('returns error when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when Git API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({}, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({}, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('OBSIDIAN_get_project_text', () => {
  const handler = obsidianTools.OBSIDIAN_get_project_text.handler;

  it('returns root_page_text and note_page_text on success', async () => {
    mockObsidianVault([
      { path: 'Projects/A/A.md', content: PROJECT_A_MD },
      { path: 'Projects/A/Notes.md', content: NOTES_A_MD },
    ]);

    const result = await handler({ project_id: 'a' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.project_id).toBe('a');
    expect(parsed.root_page_text).toContain('# Project A');
    expect(parsed.note_page_text).toContain('3/5/26');
  });

  it('returns error when project is not found', async () => {
    mockObsidianVault([{ path: 'Projects/A/A.md', content: PROJECT_A_MD }]);

    const result = await handler({ project_id: 'nonexistent' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project not found');
  });

  it('returns error when credentials are missing', async () => {
    const result = await handler({ project_id: 'a' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when Git API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({ project_id: 'a' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ project_id: 'a' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('OBSIDIAN_get_notes_by_date_range', () => {
  const handler = obsidianTools.OBSIDIAN_get_notes_by_date_range.handler;

  it('returns entries within the date range', async () => {
    mockObsidianVault([{ path: 'Projects/A/Notes.md', content: NOTES_A_MD }]);

    const result = await handler({ start_date: '3/1/26', end_date: '3/6/26' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBe(2);
  });

  it('filters out entries outside the date range', async () => {
    mockObsidianVault([{ path: 'Projects/A/Notes.md', content: NOTES_A_MD }]);

    const result = await handler({ start_date: '3/4/26', end_date: '3/6/26' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entries.length).toBe(1);
    expect(parsed.entries[0].date_str).toBe('3/5/26');
  });

  it('returns error for invalid date format', async () => {
    const result = await handler({ start_date: 'invalid', end_date: '3/6/26' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('MM/DD/YY');
  });

  it('returns error when credentials are missing', async () => {
    const result = await handler({ start_date: '3/1/26', end_date: '3/6/26' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when Git API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({ start_date: '3/1/26', end_date: '3/6/26' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ start_date: '3/1/26', end_date: '3/6/26' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('OBSIDIAN_update_project_note', () => {
  const handler = obsidianTools.OBSIDIAN_update_project_note.handler;

  it('appends content and returns success', async () => {
    // First: listAllFiles + getMultipleFiles (trees + contents for each .md)
    mockObsidianVault([
      { path: 'Projects/A/A.md', content: PROJECT_A_MD, sha: 'sha-a' },
      { path: 'Projects/A/Notes.md', content: NOTES_A_MD, sha: 'sha-notes' },
    ]);
    // Then: getFileContent for the notes file (to get existing content + sha)
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        content: btoa(NOTES_A_MD),
        sha: 'sha-notes',
      }),
    );
    // Then: putFileContent (PUT)
    mockFetch.mockReturnValueOnce(mockFetchResponse({ content: {} }, true, 200));

    const result = await handler({ project_id: 'a', content: 'test note' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.project_id).toBe('a');
    // Either created_entry or appended should be true
    expect(parsed.created_entry === true || parsed.appended === true).toBe(true);
  });

  it('returns error when project is not found', async () => {
    mockObsidianVault([{ path: 'Projects/A/A.md', content: PROJECT_A_MD }]);

    const result = await handler({ project_id: 'nonexistent', content: 'test' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project not found');
  });

  it('returns error when credentials are missing', async () => {
    const result = await handler({ project_id: 'a', content: 'test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when Git API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({ project_id: 'a', content: 'test' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ project_id: 'a', content: 'test' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });

  it('rejects invalid `date` arg', async () => {
    mockObsidianVault([
      { path: 'Projects/A/A.md', content: PROJECT_A_MD },
      { path: 'Projects/A/Notes.md', content: NOTES_A_MD },
    ]);

    const result = await handler({ project_id: 'Projects/A', content: 'x', date: 'not-a-date' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('MM/DD/YY');
  });

  // Tight mock builder: tree → Notes.md contents → PUT. Avoids mockObsidianVault
  // which queues extra per-file content responses that can get consumed out of
  // order by getFileContent.
  function mockUpdateFlow(existing: string) {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        tree: [
          { type: 'blob', path: 'Projects/A/A.md' },
          { type: 'blob', path: 'Projects/A/Notes.md' },
        ],
      }),
    );
    mockFetch.mockReturnValueOnce(mockFetchResponse({ content: btoa(existing), sha: 'sha-notes' }));
    mockFetch.mockReturnValueOnce(mockFetchResponse({}, true, 200));
  }

  function putBodyText(): string {
    const putCall = mockFetch.mock.calls.find(([, o]: any) => o?.method === 'PUT');
    return atob(JSON.parse((putCall as any)[1].body).content);
  }

  it('same-date repeat call appends inside the existing entry (no duplicate header)', async () => {
    const existing = `---\nnote_project_id: a\n---\n\n4/14/26\nfirst entry\n`;
    mockUpdateFlow(existing);

    const result = await handler({ project_id: 'Projects/A', content: 'second entry', date: '4/14/26' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.appended).toBe(true);
    expect(parsed.created_entry).toBe(false);

    const written = putBodyText();
    const headerMatches = written.match(/^4\/14\/26$/gm) || [];
    expect(headerMatches.length).toBe(1);
    expect(written).toContain('first entry');
    expect(written).toContain('second entry');
  });

  it('backdate inserts a new entry chronologically between existing dates', async () => {
    const existing = `---\nnote_project_id: a\n---\n\n4/14/26\nnewer\n\n4/10/26\nolder\n`;
    mockUpdateFlow(existing);

    const result = await handler({ project_id: 'Projects/A', content: 'middle entry', date: '4/12/26' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created_entry).toBe(true);
    expect(parsed.backdated).toBe(true);
    expect(parsed.date_str).toBe('4/12/26');

    const written = putBodyText();
    const idx14 = written.indexOf('4/14/26');
    const idx12 = written.indexOf('4/12/26');
    const idx10 = written.indexOf('4/10/26');
    expect(idx14).toBeGreaterThanOrEqual(0);
    expect(idx12).toBeGreaterThan(idx14);
    expect(idx10).toBeGreaterThan(idx12);
  });

  it('leaves two blank lines after every insert', async () => {
    const existing = `---\nnote_project_id: a\n---\n\n4/14/26\nfirst\n`;
    mockUpdateFlow(existing);

    await handler({ project_id: 'Projects/A', content: 'second', date: '4/14/26' }, obsidianCtx());

    const written = putBodyText();
    expect(written).toMatch(/second\n\n\n/);
  });
});

describe('OBSIDIAN_create_project', () => {
  const handler = obsidianTools.OBSIDIAN_create_project.handler;

  // Tight mock: tree → root existence probe → notes existence probe → PUT root → PUT notes.
  function mockCreateFlow(
    options: {
      treePaths?: Array<{ path: string }>;
      rootExists?: boolean;
      notesExists?: boolean;
    } = {},
  ) {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({ tree: (options.treePaths ?? []).map((n) => ({ type: 'blob', ...n })) }),
    );
    // Root existence probe: 404 = doesn't exist
    if (options.rootExists) {
      mockFetch.mockReturnValueOnce(mockFetchResponse({ content: btoa('# existing'), sha: 'sha-root' }));
    } else {
      mockFetch.mockReturnValueOnce(mockFetchResponse({}, false, 404));
    }
    // Notes existence probe
    if (options.notesExists) {
      mockFetch.mockReturnValueOnce(
        mockFetchResponse({ content: btoa('---\nnote_project_id: x\n---\n'), sha: 'sha-notes' }),
      );
    } else {
      mockFetch.mockReturnValueOnce(mockFetchResponse({}, false, 404));
    }
    // PUT root + PUT notes
    mockFetch.mockReturnValueOnce(mockFetchResponse({}, true, 200));
    mockFetch.mockReturnValueOnce(mockFetchResponse({}, true, 200));
  }

  function putCalls() {
    return mockFetch.mock.calls.filter(([, o]: any) => o?.method === 'PUT');
  }

  it('returns error when credentials are missing', async () => {
    const result = await handler({ name: 'NewProject' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid names (path separators, reserved segments)', async () => {
    for (const bad of ['', '   ', '..', '.', 'foo/bar', 'a<b', 'a|b']) {
      mockFetch.mockReset();
      const result = await handler({ name: bad }, obsidianCtx());
      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    }
  });

  it('creates root + notes at the vault root when no parent_id is given', async () => {
    mockCreateFlow({ treePaths: [] });

    const result = await handler({ name: 'NewProject' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.project_id).toBe('NewProject');
    expect(parsed.root_page_path).toBe('NewProject/NewProject.md');
    expect(parsed.note_page_path).toBe('NewProject/Notes.md');
    expect(parsed.created_notes).toBe(true);
    expect(parsed.parent_id).toBeNull();

    const puts = putCalls();
    expect(puts.length).toBe(2);
    const rootPut = puts[0];
    const notesPut = puts[1];
    expect(rootPut[0]).toContain('/contents/NewProject/NewProject.md');
    expect(notesPut[0]).toContain('/contents/NewProject/Notes.md');
    // Root file has the heading; notes file has the frontmatter
    const rootBody = atob(JSON.parse(rootPut[1].body).content);
    const notesBody = atob(JSON.parse(notesPut[1].body).content);
    expect(rootBody).toContain('# NewProject');
    expect(notesBody).toContain('note_project_id: NewProject');
  });

  it('nests under a parent project when parent_id is given (full path)', async () => {
    mockCreateFlow({
      treePaths: [{ path: 'Parent/Parent.md' }],
    });

    const result = await handler({ name: 'Child', parent_id: 'Parent' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.project_id).toBe('Parent/Child');
    expect(parsed.root_page_path).toBe('Parent/Child/Child.md');
    expect(parsed.note_page_path).toBe('Parent/Child/Notes.md');
    expect(parsed.parent_id).toBe('Parent');
  });

  it('writes the description into the root page when provided', async () => {
    mockCreateFlow({ treePaths: [] });

    await handler({ name: 'P1', description: 'A short blurb.' }, obsidianCtx());

    const rootPut = putCalls()[0];
    const rootBody = atob(JSON.parse(rootPut[1].body).content);
    expect(rootBody).toContain('# P1');
    expect(rootBody).toContain('A short blurb.');
  });

  it('refuses to clobber an existing project', async () => {
    mockCreateFlow({ treePaths: [], rootExists: true });

    const result = await handler({ name: 'Existing' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project already exists');
    expect(putCalls().length).toBe(0);
  });

  it('skips Notes.md creation if it already exists', async () => {
    mockCreateFlow({ treePaths: [], notesExists: true });

    const result = await handler({ name: 'WithNotes' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created_notes).toBe(false);
    // Only the root PUT should have fired.
    expect(putCalls().length).toBe(1);
  });

  it('errors when parent_id cannot be resolved', async () => {
    // Only tree + no probes (we should short-circuit before hitting Contents API)
    mockFetch.mockReturnValueOnce(mockFetchResponse({ tree: [] }));

    const result = await handler({ name: 'Orphan', parent_id: 'DoesNotExist' }, obsidianCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Parent project not found');
    expect(putCalls().length).toBe(0);
  });
});

describe('OBSIDIAN_patch_file', () => {
  const handler = obsidianTools.OBSIDIAN_patch_file.handler;

  // Tight mock: Contents-API fetch → PUT. No tree call — patch_file takes the
  // path directly, no project resolution step.
  function mockPatchFlow(fileContent: string) {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ content: btoa(fileContent), sha: 'sha-file' }));
    mockFetch.mockReturnValueOnce(mockFetchResponse({}, true, 200));
  }

  function lastPutBody(): string | null {
    const putCall = mockFetch.mock.calls.find(([, o]: any) => o?.method === 'PUT');
    if (!putCall) return null;
    return atob(JSON.parse((putCall as any)[1].body).content);
  }

  function putCalls() {
    return mockFetch.mock.calls.filter(([, o]: any) => o?.method === 'PUT');
  }

  const PATH = 'Projects/A/A.md';

  it('returns error when credentials are missing', async () => {
    const result = await handler({ path: PATH, patches: [{ find: 'a', replace: 'b' }] }, emptyCredentialsCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing path', async () => {
    const result = await handler({ patches: [{ find: 'a', replace: 'b' }] }, obsidianCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('path is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects empty patches array', async () => {
    const result = await handler({ path: PATH, patches: [] }, obsidianCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed patches (missing find / non-string replace / empty find)', async () => {
    const cases = [
      [{ replace: 'x' }],
      [{ find: '', replace: 'x' }],
      [{ find: 'foo', replace: 123 }],
      [{ find: 'foo' }],
    ];
    for (const patches of cases) {
      mockFetch.mockReset();
      const result = await handler({ path: PATH, patches }, obsidianCtx());
      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    }
  });

  it('toggles a checkbox via a single patch', async () => {
    const body = `# Project A\n\n## Week of 4/13/26\n- [ ] ship it\n- [ ] write tests\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [{ find: '- [ ] ship it', replace: '- [x] ship it' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.patches_applied).toBe(1);
    expect(parsed.path).toBe(PATH);
    expect(parsed.unchanged).toBe(false);

    const written = lastPutBody();
    expect(written).toContain('- [x] ship it');
    expect(written).toContain('- [ ] write tests');
    expect(written).not.toContain('- [ ] ship it');
  });

  it('works on a Notes.md path (not just root docs)', async () => {
    const notesBody = `---\nnote_project_id: a\n---\n\n4/18/26\n\n## Plan correction\nbad block\n`;
    mockPatchFlow(notesBody);

    const result = await handler(
      {
        path: 'Projects/A/Notes.md',
        patches: [{ find: '\n## Plan correction\nbad block\n', replace: '' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const written = lastPutBody()!;
    expect(written).not.toContain('Plan correction');
    expect(written).toContain('note_project_id: a');
    expect(written).toContain('4/18/26');
  });

  it('deletes matched text when replace is empty', async () => {
    const body = `# Project A\n\n- [ ] keep me\n- [ ] drop me\n- [ ] keep me too\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [{ find: '- [ ] drop me\n', replace: '' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const written = lastPutBody()!;
    expect(written).not.toContain('drop me');
    expect(written).toContain('- [ ] keep me');
    expect(written).toContain('- [ ] keep me too');
  });

  it('applies multiple patches in one call atomically and sequentially', async () => {
    const body = `# Project A\n\n- [ ] one\n- [ ] two\n- [ ] three\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [
          { find: '- [ ] one', replace: '- [x] one' },
          { find: '- [ ] two\n', replace: '' },
          { find: '- [ ] three', replace: '- [~] three [rolls: 1]' },
        ],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.patches_applied).toBe(3);

    const written = lastPutBody()!;
    expect(written).toContain('- [x] one');
    expect(written).not.toContain('- [ ] two');
    expect(written).toContain('- [~] three [rolls: 1]');
  });

  it('lets a later patch find text written by an earlier patch (sequential semantics)', async () => {
    const body = `# Project A\n\nALPHA\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [
          { find: 'ALPHA', replace: 'BETA' },
          { find: 'BETA', replace: 'GAMMA' },
        ],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    expect(lastPutBody()).toContain('GAMMA');
  });

  it('errors and writes nothing when find is not present (atomic)', async () => {
    const body = `# Project A\n\n- [ ] present\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [
          { find: '- [ ] present', replace: '- [x] present' },
          { find: '- [ ] missing', replace: '- [x] missing' },
        ],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'find' not found");
    expect(putCalls().length).toBe(0);
  });

  it('errors and writes nothing when find matches more than once', async () => {
    const body = `# Project A\n\n- [ ] dup\n- [ ] dup\n`;
    mockPatchFlow(body);

    const result = await handler(
      {
        path: PATH,
        patches: [{ find: '- [ ] dup', replace: '- [x] dup' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('more than once');
    expect(putCalls().length).toBe(0);
  });

  it('replaces a whole section in one patch', async () => {
    const body = `# Project A\n\n` + `## Week of 4/13/26\n\n- [ ] old1\n- [ ] old2\n\n` + `## Active Projects\n- foo\n`;
    mockPatchFlow(body);

    const oldSection = `## Week of 4/13/26\n\n- [ ] old1\n- [ ] old2\n`;
    const newSection = `## Week of 4/20/26\n\n- [ ] new1\n- [ ] new2\n- [ ] new3\n`;
    const result = await handler(
      {
        path: PATH,
        patches: [{ find: oldSection, replace: newSection }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const written = lastPutBody()!;
    expect(written).toContain('## Week of 4/20/26');
    expect(written).not.toContain('## Week of 4/13/26');
    expect(written).toContain('## Active Projects');
    expect(written).toContain('- foo');
  });

  it('preserves frontmatter when no patch touches it', async () => {
    const body = `---\nproject_id: a\n---\n# Project A\n\n- [ ] item\n`;
    mockPatchFlow(body);

    await handler(
      {
        path: PATH,
        patches: [{ find: '- [ ] item', replace: '- [x] item' }],
      },
      obsidianCtx(),
    );

    const written = lastPutBody()!;
    expect(written.startsWith('---\nproject_id: a\n---')).toBe(true);
  });

  it('skips the PUT when patches result in no change', async () => {
    const body = `# Project A\n\n- [x] same\n`;
    // Only fetch — NO put expected
    mockFetch.mockReturnValueOnce(mockFetchResponse({ content: btoa(body), sha: 'sha-file' }));

    const result = await handler(
      {
        path: PATH,
        patches: [{ find: '- [x] same', replace: '- [x] same' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.unchanged).toBe(true);
    expect(putCalls().length).toBe(0);
  });

  it('errors when the file does not exist (404 from Contents API)', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({}, false, 404));

    const result = await handler(
      {
        path: 'nope/nowhere.md',
        patches: [{ find: 'x', replace: 'y' }],
      },
      obsidianCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found');
    expect(putCalls().length).toBe(0);
  });
});

describe('OBSIDIAN_get_morning_brief', () => {
  const handler = obsidianTools.OBSIDIAN_get_morning_brief.handler;

  // Helper: yyyy-mm-dd for today/offset, using local midnight.
  function offsetDate(daysAgo: number): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d;
  }
  function mmddyy(d: Date): string {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    return `${m}/${day}/${yy}`;
  }
  // URL-aware mock: keyed by sha for blob fetches, always returns the right tree for /git/trees.
  // Order-independent so parallel fetches in the handler don't need careful queuing.
  function mockMorningFlow(vault: { files: Array<{ path: string; content: string; sha?: string }> }) {
    const files = vault.files;
    const bySha = new Map<string, string>();
    const treeEntries = files.map((f) => {
      const sha = f.sha || `sha-${f.path.replace(/[/.]/g, '-')}`;
      bySha.set(sha, f.content);
      return { type: 'blob', path: f.path, sha };
    });

    // UTF-8 safe base64 (btoa alone rejects non-Latin1 chars like em-dash).
    const utf8b64 = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    mockFetch.mockImplementation((url: unknown) => {
      if (typeof url !== 'string') return mockFetchResponse({}, false, 404);
      if (url.includes('/git/trees/')) {
        return mockFetchResponse({ tree: treeEntries });
      }
      const m = url.match(/\/git\/blobs\/([^/?]+)/);
      if (m) {
        const content = bySha.get(m[1]);
        if (content === undefined) return mockFetchResponse({}, false, 404);
        return mockFetchResponse({ content: utf8b64(content), encoding: 'base64' });
      }
      return mockFetchResponse({}, false, 404);
    });
  }

  const ROOT_DOC = `# Daily Review

## 5-Year Arc
Top school PhD.

## 2026
- [ ] Submit paper

## April 2026
- [ ] Ship ChefByte v1 cloud

## Week of 4/13/26
- [ ] Ship barcode flow
`;

  it('returns error when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a clear error pointing at create_project when Daily Review is missing', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ tree: [] }));

    const result = await handler({}, obsidianCtx());
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg).toContain('Daily Review');
    expect(msg).toContain('not found');
    expect(msg).toContain('OBSIDIAN_create_project');
  });

  it('returns root doc + recent_notes + routine_instructions on success', async () => {
    const today = mmddyy(offsetDate(0));
    const twoDaysAgo = mmddyy(offsetDate(2));
    const notesContent = `---\nnote_project_id: Daily Review\n---\n\n${today}\nMorning Brief goes here.\n\n${twoDaysAgo}\nEarlier entry.\n`;
    mockMorningFlow({
      files: [
        { path: 'Daily Review/Daily Review.md', content: ROOT_DOC },
        { path: 'Daily Review/Notes.md', content: notesContent },
      ],
    });

    const result = await handler({}, obsidianCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.project_id).toBe('Daily Review');
    expect(parsed.root_doc.text).toContain('# Daily Review');
    expect(parsed.root_doc.text).toContain('## 2026');
    expect(parsed.recent_notes.window_days).toBe(7);
    expect(Array.isArray(parsed.recent_notes.entries)).toBe(true);
    expect(parsed.recent_notes.entries.length).toBeGreaterThanOrEqual(2);
    expect(typeof parsed.routine_instructions).toBe('string');
    expect(parsed.routine_instructions).toContain('MORNING ROUTINE INSTRUCTIONS');
    expect(parsed.routine_instructions).toContain('STEP 1');
  });

  it('filters entries to the last 7 days (inclusive), newest-first', async () => {
    const today = mmddyy(offsetDate(0));
    const sixDaysAgo = mmddyy(offsetDate(6));
    const eightDaysAgo = mmddyy(offsetDate(8));

    const notesContent =
      `---\nnote_project_id: Daily Review\n---\n\n` +
      `${today}\nToday entry.\n\n` +
      `${sixDaysAgo}\nSix days ago entry.\n\n` +
      `${eightDaysAgo}\nOutside window — eight days ago.\n`;

    mockMorningFlow({
      files: [
        { path: 'Daily Review/Daily Review.md', content: ROOT_DOC },
        { path: 'Daily Review/Notes.md', content: notesContent },
      ],
    });

    const result = await handler({}, obsidianCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const entries = parsed.recent_notes.entries as Array<{
      date: string;
      content: string;
      date_str: string;
    }>;

    // 8-days-ago entry must be out; today + 6-days-ago must be in
    expect(entries.some((e) => e.content.includes('Outside window'))).toBe(false);
    expect(entries.some((e) => e.content.includes('Today entry'))).toBe(true);
    expect(entries.some((e) => e.content.includes('Six days ago entry'))).toBe(true);

    // Newest-first
    expect(entries[0].date >= entries[entries.length - 1].date).toBe(true);
    const dates = entries.map((e) => e.date);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });

  it('pulls notes unscoped (from other projects too, not just Daily Review)', async () => {
    const today = mmddyy(offsetDate(0));
    const morningNotes = `---\nnote_project_id: Daily Review\n---\n\n${today}\nMR entry.\n`;
    const journalNotes = `---\nnote_project_id: Journal\n---\n\n${today}\nJournal entry.\n`;
    const coachNotes = `---\nnote_project_id: coach\n---\n\n${today}\nCoach entry.\n`;

    mockMorningFlow({
      files: [
        { path: 'Daily Review/Daily Review.md', content: ROOT_DOC },
        { path: 'Daily Review/Notes.md', content: morningNotes },
        { path: 'Journal/Journal.md', content: '# Journal\n' },
        { path: 'Journal/Notes.md', content: journalNotes },
        { path: 'coach/coach.md', content: '# coach\n' },
        { path: 'coach/Notes.md', content: coachNotes },
      ],
    });

    const result = await handler({}, obsidianCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const entries = parsed.recent_notes.entries as Array<{ file: string; content: string }>;

    const fileSet = new Set(entries.map((e) => e.file));
    expect(fileSet.has('Daily Review/Notes.md')).toBe(true);
    expect(fileSet.has('Journal/Notes.md')).toBe(true);
    expect(fileSet.has('coach/Notes.md')).toBe(true);
  });

  it('accepts a custom project_id', async () => {
    const today = mmddyy(offsetDate(0));
    const customRoot = `# Custom Daily\n\n## 2026\n- [ ] x\n`;
    const customNotes = `---\nnote_project_id: Custom Daily\n---\n\n${today}\nHi.\n`;

    mockMorningFlow({
      files: [
        { path: 'Custom Daily/Custom Daily.md', content: customRoot },
        { path: 'Custom Daily/Notes.md', content: customNotes },
      ],
    });

    const result = await handler({ project_id: 'Custom Daily' }, obsidianCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.project_id).toBe('Custom Daily');
    expect(parsed.root_doc.text).toContain('# Custom Daily');
  });

  it('surfaces truncation metadata when notes files exceed the 40-file cap', async () => {
    // Synthesize 45 projects, each with a Notes.md.
    const today = mmddyy(offsetDate(0));
    const files: Array<{ path: string; content: string }> = [
      { path: 'Daily Review/Daily Review.md', content: ROOT_DOC },
      { path: 'Daily Review/Notes.md', content: `---\nx: y\n---\n\n${today}\nmr\n` },
    ];
    for (let i = 0; i < 45; i++) {
      files.push({ path: `p${i}/p${i}.md`, content: `# p${i}\n` });
      files.push({ path: `p${i}/Notes.md`, content: `---\nx: y\n---\n\n${today}\np${i}\n` });
    }
    mockMorningFlow({ files });

    const result = await handler({}, obsidianCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.recent_notes.truncated).toBe(true);
    expect(parsed.recent_notes.omitted_notes_files).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Todoist
// ===========================================================================

describe('TODOIST_get_completed_tasks', () => {
  const handler = todoistTools.TODOIST_get_completed_tasks.handler;

  const PROJECTS_RESP = {
    results: [
      { id: 'proj-work', name: 'Work', is_inbox_project: false },
      { id: 'proj-inbox', name: 'Inbox', is_inbox_project: true },
      { id: 'proj-side', name: 'Side', is_inbox_project: false },
    ],
  };

  it('defaults to filtering by the inbox project when project_id is omitted', async () => {
    const items = [
      { content: 'Ship barcode flow', completed_at: '2026-04-17T14:00:00Z' },
      { content: 'Recruiter outreach', completed_at: '2026-04-17T16:30:00Z' },
    ];
    mockFetch.mockReturnValueOnce(mockFetchResponse(PROJECTS_RESP));
    mockFetch.mockReturnValueOnce(mockFetchResponse({ items }));

    const result = await handler({ since: '2026-04-17T00:00:00Z', until: '2026-04-18T00:00:00Z' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(items);
    expect(parsed.project_id).toBe('proj-inbox');
    expect(parsed.since).toBe('2026-04-17T00:00:00Z');
    expect(parsed.until).toBe('2026-04-18T00:00:00Z');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [projectsUrl] = mockFetch.mock.calls[0];
    expect(projectsUrl).toContain('https://api.todoist.com/api/v1/projects');

    const [completedUrl, completedOpts] = mockFetch.mock.calls[1];
    expect(completedUrl).toContain('https://api.todoist.com/api/v1/tasks/completed/by_completion_date');
    expect(completedUrl).toContain('project_id=proj-inbox');
    expect(completedUrl).toContain('since=2026-04-17T00%3A00%3A00Z');
    expect(completedUrl).toContain('until=2026-04-18T00%3A00%3A00Z');
    expect(completedOpts.method).toBe('GET');
    expect(completedOpts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('defaults to a 7-day window ending ~now when since/until are omitted', async () => {
    const before = Date.now();
    mockFetch.mockReturnValueOnce(mockFetchResponse(PROJECTS_RESP));
    mockFetch.mockReturnValueOnce(mockFetchResponse({ items: [] }));

    const result = await handler({}, todoistCtx());
    const after = Date.now();

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    // since should be roughly 7 days before "now"
    const sinceMs = Date.parse(parsed.since);
    const untilMs = Date.parse(parsed.until);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
    // until should be slightly after now (1h buffer)
    expect(untilMs).toBeGreaterThan(after);
    expect(untilMs).toBeLessThan(after + 2 * 60 * 60 * 1000);

    // The completed-endpoint URL should reflect both computed defaults
    const [, completedCall] = mockFetch.mock.calls;
    const [completedUrl] = completedCall;
    expect(completedUrl).toContain(`since=${encodeURIComponent(parsed.since)}`);
    expect(completedUrl).toContain(`until=${encodeURIComponent(parsed.until)}`);
  });

  it('accepts `since` alone and fills in `until` from the default', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(PROJECTS_RESP));
    mockFetch.mockReturnValueOnce(mockFetchResponse({ items: [] }));

    const result = await handler({ since: '2026-04-01T00:00:00Z' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.since).toBe('2026-04-01T00:00:00Z');
    expect(parsed.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips the inbox lookup when project_id is passed explicitly', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ items: [] }));

    await handler(
      {
        since: '2026-04-17',
        until: '2026-04-18',
        project_id: 'proj-9',
        limit: 100,
      },
      todoistCtx(),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/tasks/completed/by_completion_date');
    expect(url).toContain('project_id=proj-9');
    expect(url).toContain('limit=100');
  });

  it('errors when the inbox project cannot be located', async () => {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        results: [
          { id: 'proj-a', name: 'A', is_inbox_project: false },
          { id: 'proj-b', name: 'B', is_inbox_project: false },
        ],
      }),
    );

    const result = await handler({ since: '2026-04-17', until: '2026-04-18' }, todoistCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('inbox');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('surfaces a clear error when the /projects lookup fails', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server error', false, 500));

    const result = await handler({ since: '2026-04-17', until: '2026-04-18' }, todoistCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fetching projects');
    expect(result.content[0].text).toContain('500');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ since: '2026-04-17', until: '2026-04-18' }, emptyCredentialsCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError on completed-endpoint API error (with explicit project_id)', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Forbidden', false, 403));
    const result = await handler({ since: '2026-04-17', until: '2026-04-18', project_id: 'proj-9' }, todoistCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 403');
  });

  it('returns toolError on network failure during inbox lookup', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network down'));
    const result = await handler({ since: '2026-04-17', until: '2026-04-18' }, todoistCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network down');
  });
});

describe('TODOIST_get_tasks', () => {
  const handler = todoistTools.TODOIST_get_tasks.handler;

  it('sends correct URL with query params on success', async () => {
    const tasks = [{ id: 't1', content: 'Buy milk' }];
    mockFetch.mockReturnValueOnce(mockFetchResponse(tasks));

    const result = await handler({ project_id: 'proj-1', filter: 'today' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(tasks);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('https://api.todoist.com/api/v1/tasks');
    expect(url).toContain('project_id=proj-1');
    expect(url).toContain('filter=today');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Forbidden', false, 403));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 403');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_get_task', () => {
  const handler = todoistTools.TODOIST_get_task.handler;

  it('sends correct URL for single task on success', async () => {
    const task = { id: 'task-1', content: 'Test task', project_id: 'proj-1' };
    mockFetch.mockReturnValueOnce(mockFetchResponse(task));

    const result = await handler({ task_id: 'task-1' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(task);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/tasks/task-1');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ task_id: 'task-1' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));

    const result = await handler({ task_id: 'missing' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 404');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ task_id: 'task-1' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_create_task', () => {
  const handler = todoistTools.TODOIST_create_task.handler;

  it('sends POST with correct body on success', async () => {
    const created = { id: 't2', content: 'Write tests', project_id: 'proj-1' };
    mockFetch.mockReturnValueOnce(mockFetchResponse(created));

    const result = await handler(
      { content: 'Write tests', project_id: 'proj-1', due_string: 'tomorrow', priority: 3 },
      todoistCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(created);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/tasks');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.content).toBe('Write tests');
    expect(body.project_id).toBe('proj-1');
    expect(body.due_string).toBe('tomorrow');
    expect(body.priority).toBe(3);
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ content: 'Fail task' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({ content: 'Fail task' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 500');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ content: 'Fail task' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_update_task', () => {
  const handler = todoistTools.TODOIST_update_task.handler;

  it('sends POST with updated fields on success', async () => {
    const updated = { id: 'task-1', content: 'Updated task', priority: 2 };
    mockFetch.mockReturnValueOnce(mockFetchResponse(updated));

    const result = await handler({ task_id: 'task-1', content: 'Updated task', priority: 2 }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(updated);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/tasks/task-1');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.content).toBe('Updated task');
    expect(body.priority).toBe(2);
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ task_id: 'task-1' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));

    const result = await handler({ task_id: 'missing' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 404');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ task_id: 'task-1' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_complete_task', () => {
  const handler = todoistTools.TODOIST_complete_task.handler;

  it('sends POST to close endpoint on success', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('', true, 204));

    const result = await handler({ task_id: 'task-abc' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ task_id: 'task-abc', completed: true });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/tasks/task-abc/close');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ task_id: 'task-abc' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));

    const result = await handler({ task_id: 'missing-task' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 404');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ task_id: 'task-abc' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_get_projects', () => {
  const handler = todoistTools.TODOIST_get_projects.handler;

  it('returns projects list on success', async () => {
    const projects = [
      { id: 'p1', name: 'Inbox' },
      { id: 'p2', name: 'Work' },
    ];
    mockFetch.mockReturnValueOnce(mockFetchResponse(projects));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(projects);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/projects');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 500');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

describe('TODOIST_get_sections', () => {
  const handler = todoistTools.TODOIST_get_sections.handler;

  it('returns sections list on success', async () => {
    const sections = [
      { id: 's1', project_id: 'proj-1', name: 'Backlog' },
      { id: 's2', project_id: 'proj-1', name: 'In Progress' },
    ];
    mockFetch.mockReturnValueOnce(mockFetchResponse(sections));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(sections);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/api/v1/sections');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('sends project_id as query param when provided', async () => {
    const sections = [{ id: 's1', project_id: 'proj-1', name: 'Backlog' }];
    mockFetch.mockReturnValueOnce(mockFetchResponse(sections));

    const result = await handler({ project_id: 'proj-1' }, todoistCtx());

    expect(result.isError).toBeUndefined();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('project_id=proj-1');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 500');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({}, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error: Network failure');
  });
});

// ===========================================================================
// Home Assistant
// ===========================================================================

const haEntityLight = {
  entity_id: 'light.living_room',
  state: 'on',
  attributes: { friendly_name: 'Living Room Light', brightness: 255 },
};

const haEntitySwitch = {
  entity_id: 'switch.bedroom_fan',
  state: 'off',
  attributes: { friendly_name: 'Bedroom Fan' },
};

const haEntitySensor = {
  entity_id: 'sensor.temperature',
  state: '22.5',
  attributes: { friendly_name: 'Temperature' },
};

describe('HOMEASSISTANT_get_devices', () => {
  const handler = homeassistantTools.HOMEASSISTANT_get_devices.handler;

  it('returns formatted devices list on success', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse([haEntityLight, haEntitySwitch, haEntitySensor]));

    const result = await handler({}, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // Should contain formatted string and devices array
    expect(parsed.formatted).toBeDefined();
    expect(typeof parsed.formatted).toBe('string');
    expect(parsed.formatted).toContain('Living Room Light');
    // sensor.temperature should be filtered out (not in ALLOWED_DOMAINS)
    expect(parsed.devices).toHaveLength(2);
    expect(parsed.devices[0].entity_id).toBe('light.living_room');
    expect(parsed.devices[1].entity_id).toBe('switch.bedroom_fan');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/states');
    expect(opts.headers.Authorization).toBe('Bearer ha-key-789');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({}, haCtx());

    expect(result.isError).toBe(true);
    // The error is thrown by fetchStates and caught as "Network error"
    expect(result.content[0].text).toContain('HA API error: 500');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({}, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('HOMEASSISTANT_get_entity_status', () => {
  const handler = homeassistantTools.HOMEASSISTANT_get_entity_status.handler;

  it('returns formatted entity status on success', async () => {
    // resolveEntityId: checks if entity_id looks valid (light.* is in ALLOWED_DOMAINS)
    //   -> getEntityState (GET /api/states/light.living_room) - resolve check
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));
    // Then handler calls getEntityState again for the full state
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted).toBeDefined();
    expect(parsed.formatted).toContain('Living Room Light');
    expect(parsed.formatted).toContain('on');
    expect(parsed.entity_id).toBe('light.living_room');
    expect(parsed.state).toBe('on');
  });

  it('returns error when entity is not found', async () => {
    // resolveEntityId: getEntityState returns 404 (null)
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));
    // resolveEntityId fallback: fetchStates (GET /api/states)
    mockFetch.mockReturnValueOnce(mockFetchResponse([]));

    const result = await handler({ entity_id: 'light.nonexistent' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ entity_id: 'light.test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when no identifier provided', async () => {
    const result = await handler({}, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('entity_id or friendly_name');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('HOMEASSISTANT_turn_on', () => {
  const handler = homeassistantTools.HOMEASSISTANT_turn_on.handler;

  it('resolves entity, gets friendly name, calls service, and returns formatted result', async () => {
    // 1. resolveEntityId -> getEntityState (resolve check)
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));
    // 2. getEntityState (for friendly name)
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));
    // 3. callService (POST turn_on)
    mockFetch.mockReturnValueOnce(mockFetchResponse([haEntityLight]));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted).toContain('turned on');
    expect(parsed.formatted).toContain('Living Room Light');
    expect(parsed.entity_id).toBe('light.living_room');
    expect(parsed.action).toBe('turn_on');
    expect(parsed.success).toBe(true);

    // Verify the service call
    const serviceCall = mockFetch.mock.calls[2];
    expect(serviceCall[0]).toBe('https://homeassistant.local:8123/api/services/light/turn_on');
    expect(serviceCall[1].method).toBe('POST');
    const serviceBody = JSON.parse(serviceCall[1].body);
    expect(serviceBody.entity_id).toBe('light.living_room');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ entity_id: 'light.test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when no identifier provided', async () => {
    const result = await handler({}, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('entity_id or friendly_name');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('HOMEASSISTANT_turn_off', () => {
  const handler = homeassistantTools.HOMEASSISTANT_turn_off.handler;

  it('resolves entity, gets friendly name, calls service, and returns formatted result', async () => {
    // 1. resolveEntityId -> getEntityState (resolve check)
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));
    // 2. getEntityState (for friendly name)
    mockFetch.mockReturnValueOnce(mockFetchResponse(haEntityLight));
    // 3. callService (POST turn_off)
    mockFetch.mockReturnValueOnce(mockFetchResponse([{ ...haEntityLight, state: 'off' }]));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted).toContain('turned off');
    expect(parsed.formatted).toContain('Living Room Light');
    expect(parsed.entity_id).toBe('light.living_room');
    expect(parsed.action).toBe('turn_off');
    expect(parsed.success).toBe(true);

    // Verify the service call
    const serviceCall = mockFetch.mock.calls[2];
    expect(serviceCall[0]).toBe('https://homeassistant.local:8123/api/services/light/turn_off');
    expect(serviceCall[1].method).toBe('POST');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ entity_id: 'light.test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when no identifier provided', async () => {
    const result = await handler({}, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('entity_id or friendly_name');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network failure');
  });
});

describe('HOMEASSISTANT_tv_remote', () => {
  const handler = homeassistantTools.HOMEASSISTANT_tv_remote.handler;

  it('launches an app via remote.turn_on service', async () => {
    // callService (POST /api/services/remote/turn_on)
    mockFetch.mockReturnValueOnce(mockFetchResponse([]));

    const result = await handler({ button: 'spotify' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted).toContain('launched');
    expect(parsed.formatted).toContain('Spotify');
    expect(parsed.success).toBe(true);
    expect(parsed.button).toBe('spotify');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/services/remote/turn_on');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.entity_id).toBe('remote.living_room_tv');
    expect(body.activity).toBe('com.spotify.tv.android');
  });

  it('sends a navigation command via remote.send_command service', async () => {
    // callService (POST /api/services/remote/send_command)
    mockFetch.mockReturnValueOnce(mockFetchResponse([]));

    const result = await handler({ button: 'up' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.formatted).toContain('moved up');
    expect(parsed.success).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/services/remote/send_command');
    const body = JSON.parse(opts.body);
    expect(body.command).toBe('DPAD_UP');
    expect(body.entity_id).toBe('remote.living_room_tv');
  });

  it('passes unknown button through as raw uppercase command (legacy behavior)', async () => {
    // Legacy: unknown buttons are sent as uppercase command strings
    mockFetch.mockReturnValueOnce(mockFetchResponse([]));

    const result = await handler({ button: 'power' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/services/remote/send_command');
    const body = JSON.parse(opts.body);
    expect(body.command).toBe('POWER');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ button: 'up' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns toolError when missing button argument', async () => {
    const result = await handler({ button: '' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required argument: button');
  });

  it('returns toolError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await handler({ button: 'play' }, haCtx());

    expect(result.isError).toBe(true);
    // tv_remote formats error via formatTvRemoteAction, which passes the raw error message
    expect(result.content[0].text).toContain('Network failure');
  });
});
