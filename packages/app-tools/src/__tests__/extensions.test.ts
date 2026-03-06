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
});

// ===========================================================================
// Todoist
// ===========================================================================

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

  it('returns error for unknown button', async () => {
    const result = await handler({ button: 'invalid_button' }, haCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown button');
    expect(mockFetch).not.toHaveBeenCalled();
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
