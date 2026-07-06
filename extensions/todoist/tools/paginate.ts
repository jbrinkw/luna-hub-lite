/**
 * Follow Todoist v1 cursor pagination for a list endpoint and return every row.
 *
 * The v1 API caps a single page (default ~50 rows) and returns
 * `{ results: [...], next_cursor: string | null }`. Reading only the first page
 * silently truncates large accounts. This walks `next_cursor` until exhausted,
 * re-issuing the request with `cursor=<next_cursor>` on each pass while
 * preserving the caller-supplied query params.
 *
 * @param baseUrl   Endpoint URL WITHOUT a cursor param (may already carry filters).
 * @param authHeader Authorization header to send on every page request.
 * @returns Accumulated `results` across all pages.
 * @throws Error with the HTTP status when any page request fails.
 */
export async function fetchAllTodoistPages(baseUrl: string, authHeader: Record<string, string>): Promise<unknown[]> {
  const acc: unknown[] = [];
  let cursor: string | null = null;
  // Hard cap to avoid an unbounded loop if the API ever returns a self-referential
  // or never-null cursor. 200 pages * 50 rows = 10k rows is well beyond any real
  // single-user Todoist account.
  const MAX_PAGES = 200;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(baseUrl);
    if (cursor) url.searchParams.set('cursor', cursor);

    const resp = await fetch(url.toString(), { method: 'GET', headers: authHeader });
    if (!resp.ok) {
      throw new Error(`Todoist API error: ${resp.status} ${resp.statusText}`);
    }

    const data: unknown = await resp.json();
    if (Array.isArray(data)) {
      // Defensive: a bare-array response has no cursor to follow.
      acc.push(...data);
      break;
    }

    const obj = (data ?? {}) as { results?: unknown[]; next_cursor?: string | null };
    if (Array.isArray(obj.results)) {
      acc.push(...obj.results);
    } else if (data && typeof data === 'object') {
      // Unknown shape with no `results` array — surface the raw object once and stop.
      acc.push(data);
      break;
    }

    const next = obj.next_cursor;
    if (typeof next === 'string' && next.length > 0) {
      cursor = next;
    } else {
      break;
    }
  }

  return acc;
}
