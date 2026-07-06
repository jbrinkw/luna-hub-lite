import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TODOIST_get_tasks } from './get-tasks';
import { TODOIST_get_projects } from './get-projects';
import { TODOIST_get_sections } from './get-sections';
import type { ExtensionToolContext } from '@luna-hub/app-tools';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function todoistCtx(): ExtensionToolContext {
  return { userId: 'u1', supabase: {} as any, credentials: { todoist_api_key: 'k' } };
}

/**
 * Two-page Todoist v1 response keyed on the `cursor` query param.
 * Page 1 (no cursor): `pageSize` items + next_cursor "CURSOR2".
 * Page 2 (cursor=CURSOR2): one item + next_cursor null.
 */
function mockTwoPages(makeItem: (i: number) => unknown, pageSize = 50) {
  mockFetch.mockImplementation((url: string) => {
    const u = new URL(url);
    const cursor = u.searchParams.get('cursor');
    if (cursor === 'CURSOR2') {
      return jsonOk({ results: [makeItem(pageSize)], next_cursor: null });
    }
    return jsonOk({
      results: Array.from({ length: pageSize }, (_, i) => makeItem(i)),
      next_cursor: 'CURSOR2',
    });
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// B4-03 — list endpoints must follow next_cursor, not silently truncate
// ===========================================================================
describe('B4-03: Todoist cursor pagination', () => {
  it('TODOIST_get_tasks returns items from ALL pages', async () => {
    mockTwoPages((i) => ({ id: String(i), content: `task ${i}` }));

    const result = await TODOIST_get_tasks.handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(result.content[0].text);
    expect(Array.isArray(items)).toBe(true);
    // 50 from page 1 + 1 from page 2. A single-page implementation returns 50.
    expect(items.length).toBe(51);
    // Both pages were actually fetched.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The second request carried the cursor from page 1.
    const secondUrl = new URL(mockFetch.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get('cursor')).toBe('CURSOR2');
  });

  it('TODOIST_get_projects returns items from ALL pages', async () => {
    mockTwoPages((i) => ({ id: String(i), name: `proj ${i}` }));

    const result = await TODOIST_get_projects.handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(result.content[0].text);
    expect(items.length).toBe(51);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('TODOIST_get_sections returns items from ALL pages', async () => {
    mockTwoPages((i) => ({ id: String(i), name: `sec ${i}` }));

    const result = await TODOIST_get_sections.handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(result.content[0].text);
    expect(items.length).toBe(51);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('TODOIST_get_tasks stops after a single page when next_cursor is null', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ results: [{ id: '1', content: 'only' }], next_cursor: null }));

    const result = await TODOIST_get_tasks.handler({}, todoistCtx());

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(result.content[0].text);
    expect(items.length).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('TODOIST_get_tasks preserves caller filters across paginated requests', async () => {
    mockTwoPages((i) => ({ id: String(i), content: `task ${i}` }));

    await TODOIST_get_tasks.handler({ filter: 'today', project_id: 'p9' }, todoistCtx());

    for (const call of mockFetch.mock.calls) {
      const u = new URL(call[0] as string);
      expect(u.searchParams.get('filter')).toBe('today');
      expect(u.searchParams.get('project_id')).toBe('p9');
    }
  });
});
