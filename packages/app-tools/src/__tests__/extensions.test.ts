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
const baseCtx = { userId: 'user-1', supabase: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obsidianCtx(overrides: Partial<Record<string, string>> = {}): ExtensionToolContext {
  return {
    ...baseCtx,
    credentials: {
      obsidian_api_key: 'obs-key-123',
      obsidian_url: 'https://obsidian.local:27124',
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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// Obsidian
// ===========================================================================

describe('OBSIDIAN_search_notes', () => {
  const handler = obsidianTools.OBSIDIAN_search_notes.handler;

  it('sends correct URL and Bearer auth on success', async () => {
    const searchResults = [{ filename: 'note.md', matches: [{ match: { start: 0, end: 5 } }] }];
    mockFetch.mockReturnValueOnce(mockFetchResponse(searchResults));

    const result = await handler({ query: 'test query' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(searchResults);

    // Verify fetch was called with correct URL and headers
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://obsidian.local:27124/search/simple/?query=test%20query');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer obs-key-123');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ query: 'test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Obsidian credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('OBSIDIAN_create_note', () => {
  const handler = obsidianTools.OBSIDIAN_create_note.handler;

  it('sends PUT with markdown content type on success', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('', true, 204));

    const result = await handler(
      { path: 'folder/new-note.md', content: '# Hello World' },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ path: 'folder/new-note.md', created: true });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://obsidian.local:27124/vault/folder%2Fnew-note.md');
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('text/markdown');
    expect(opts.headers.Authorization).toBe('Bearer obs-key-123');
    expect(opts.body).toBe('# Hello World');
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler(
      { path: 'folder/note.md', content: 'content' },
      obsidianCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Obsidian API error: 500');
  });
});

describe('OBSIDIAN_get_note', () => {
  const handler = obsidianTools.OBSIDIAN_get_note.handler;

  it('returns markdown text content on success', async () => {
    const markdown = '# My Note\n\nSome content here.';
    mockFetch.mockReturnValueOnce(mockFetchResponse(markdown));

    const result = await handler({ path: 'docs/my-note.md' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ path: 'docs/my-note.md', content: markdown });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://obsidian.local:27124/vault/docs%2Fmy-note.md');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Accept).toBe('text/markdown');
    expect(opts.headers.Authorization).toBe('Bearer obs-key-123');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ path: 'note.md' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Obsidian credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('OBSIDIAN_update_note', () => {
  const handler = obsidianTools.OBSIDIAN_update_note.handler;

  it('sends PUT with updated content on success', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('', true, 204));

    const result = await handler(
      { path: 'folder/existing.md', content: '# Updated Content' },
      obsidianCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ path: 'folder/existing.md', updated: true });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://obsidian.local:27124/vault/folder%2Fexisting.md');
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('text/markdown');
    expect(opts.headers.Authorization).toBe('Bearer obs-key-123');
    expect(opts.body).toBe('# Updated Content');
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));

    const result = await handler(
      { path: 'missing.md', content: 'content' },
      obsidianCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Obsidian API error: 404');
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

    const result = await handler(
      { project_id: 'proj-1', filter: 'today' },
      todoistCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(tasks);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('https://api.todoist.com/rest/v2/tasks');
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
    expect(url).toBe('https://api.todoist.com/rest/v2/tasks');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.content).toBe('Write tests');
    expect(body.project_id).toBe('proj-1');
    expect(body.due_string).toBe('tomorrow');
    expect(body.priority).toBe(3);
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Server Error', false, 500));

    const result = await handler({ content: 'Fail task' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 500');
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
    expect(url).toBe('https://api.todoist.com/rest/v2/tasks/task-abc/close');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Not Found', false, 404));

    const result = await handler({ task_id: 'missing-task' }, todoistCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Todoist API error: 404');
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
    expect(url).toBe('https://api.todoist.com/rest/v2/projects');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer todoist-key-456');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Home Assistant
// ===========================================================================

describe('HOMEASSISTANT_get_entity_state', () => {
  const handler = homeassistantTools.HOMEASSISTANT_get_entity_state.handler;

  it('sends correct entity_id in URL on success', async () => {
    const entity = { entity_id: 'light.living_room', state: 'on', attributes: { brightness: 255 } };
    mockFetch.mockReturnValueOnce(mockFetchResponse(entity));

    const result = await handler({ entity_id: 'light.living_room' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(entity);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/states/light.living_room');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer ha-key-789');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({ entity_id: 'light.test' }, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('HOMEASSISTANT_call_service', () => {
  const handler = homeassistantTools.HOMEASSISTANT_call_service.handler;

  it('sends domain/service in URL and body on success', async () => {
    const response = [{ entity_id: 'light.living_room', state: 'on' }];
    mockFetch.mockReturnValueOnce(mockFetchResponse(response));

    const result = await handler(
      {
        domain: 'light',
        service: 'turn_on',
        entity_id: 'light.living_room',
        data: { brightness: 200 },
      },
      haCtx(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(response);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/services/light/turn_on');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer ha-key-789');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.entity_id).toBe('light.living_room');
    expect(body.brightness).toBe(200);
  });

  it('returns toolError when API returns error', async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse('Internal Server Error', false, 500));

    const result = await handler(
      { domain: 'light', service: 'turn_on' },
      haCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Home Assistant API error: 500');
  });
});

describe('HOMEASSISTANT_get_entities', () => {
  const handler = homeassistantTools.HOMEASSISTANT_get_entities.handler;

  it('returns all entities on success', async () => {
    const entities = [
      { entity_id: 'light.living_room', state: 'on' },
      { entity_id: 'sensor.temperature', state: '22.5' },
      { entity_id: 'light.bedroom', state: 'off' },
    ];
    mockFetch.mockReturnValueOnce(mockFetchResponse(entities));

    const result = await handler({}, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://homeassistant.local:8123/api/states');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer ha-key-789');
  });

  it('filters entities by domain when domain arg is provided', async () => {
    const entities = [
      { entity_id: 'light.living_room', state: 'on' },
      { entity_id: 'sensor.temperature', state: '22.5' },
      { entity_id: 'light.bedroom', state: 'off' },
    ];
    mockFetch.mockReturnValueOnce(mockFetchResponse(entities));

    const result = await handler({ domain: 'light' }, haCtx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // Only light.* entities should be returned after filtering
    expect(parsed).toHaveLength(2);
    expect(parsed[0].entity_id).toBe('light.living_room');
    expect(parsed[1].entity_id).toBe('light.bedroom');
  });

  it('returns toolError when credentials are missing', async () => {
    const result = await handler({}, emptyCredentialsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Home Assistant credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
