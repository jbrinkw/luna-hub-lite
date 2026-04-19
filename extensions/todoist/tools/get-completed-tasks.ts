import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { TODOIST_API_BASE } from './constants';

const DEFAULT_SINCE_DAYS = 7;

export const TODOIST_get_completed_tasks: ExtensionToolDefinition = {
  name: 'TODOIST_get_completed_tasks',
  extensionName: 'todoist',
  description:
    "Get tasks completed within a date range, defaulting to the user's Todoist Inbox project and the last 7 days. Use for accountability: see what was checked off recently. Both `since` and `until` are optional and accept ISO 8601 date (YYYY-MM-DD) or datetime strings. Omit both for the default 7-day window ending now (recommended — sidesteps timezone pitfalls since Todoist filters `completed_at` in UTC and a user's local-yesterday can straddle UTC midnight). Pass a wider `since` to look further back. Pass `project_id` to target a different project. Returns each item with content, completed_at, project_id, and section_id.",
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description:
          'Optional start of range. ISO 8601 date (YYYY-MM-DD) or datetime with Z. Inclusive. Defaults to 7 days before now.',
      },
      until: {
        type: 'string',
        description:
          "Optional end of range. ISO 8601 date or datetime. Defaults to ~1h after now (buffers clock skew; no real effect since completions can't be in the future).",
      },
      project_id: {
        type: 'string',
        description:
          'Optional — override the default inbox filter. Pass a specific Todoist project_id to target that project instead.',
      },
      limit: {
        type: 'number',
        description: 'Optional — max items (Todoist default 50, max 200).',
      },
    },
  },
  handler: async (args, ctx) => {
    const { todoist_api_key } = (ctx as ExtensionToolContext).credentials;
    if (!todoist_api_key) return toolError('Missing Todoist credentials (todoist_api_key)');

    // Build the UTC window. Defaults span the last 7 days through ~1h in the
    // future to sidestep timezone pitfalls — a user's local-yesterday often
    // straddles UTC midnight, and Todoist filters `completed_at` in UTC.
    const now = Date.now();
    const sinceStr: string =
      typeof args.since === 'string' && args.since.trim().length > 0
        ? args.since.trim()
        : new Date(now - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const untilStr: string =
      typeof args.until === 'string' && args.until.trim().length > 0
        ? args.until.trim()
        : new Date(now + 60 * 60 * 1000).toISOString();

    const authHeader = { Authorization: `Bearer ${todoist_api_key}` };

    try {
      // Resolve the target project_id. If the caller didn't pass one, look up
      // the user's inbox project — daily accountability commits live there by
      // default, and surfacing non-inbox projects in the brief creates noise.
      let projectId: string | undefined =
        typeof args.project_id === 'string' && args.project_id.trim().length > 0 ? args.project_id.trim() : undefined;

      if (!projectId) {
        const projResp = await fetch(`${TODOIST_API_BASE}/projects`, {
          method: 'GET',
          headers: authHeader,
        });
        if (!projResp.ok) {
          return toolError(`Todoist API error fetching projects: ${projResp.status} ${projResp.statusText}`);
        }
        const projData: unknown = await projResp.json();
        const projects: unknown[] = Array.isArray(projData)
          ? projData
          : ((projData as { results?: unknown[] }).results ?? (projData as { items?: unknown[] }).items ?? []);
        const inbox = projects.find(
          (p): p is { id: string | number; is_inbox_project?: boolean; inbox_project?: boolean } =>
            !!p &&
            typeof p === 'object' &&
            ((p as { is_inbox_project?: boolean }).is_inbox_project === true ||
              (p as { inbox_project?: boolean }).inbox_project === true),
        );
        if (!inbox || inbox.id === undefined || inbox.id === null) {
          return toolError(
            "Could not locate the user's Todoist inbox project. Pass `project_id` explicitly to override.",
          );
        }
        projectId = String(inbox.id);
      }

      const params = new URLSearchParams();
      params.set('since', sinceStr);
      params.set('until', untilStr);
      params.set('project_id', projectId);
      if (args.limit) params.set('limit', String(args.limit));

      const url = `${TODOIST_API_BASE}/tasks/completed/by_completion_date?${params.toString()}`;
      const resp = await fetch(url, { method: 'GET', headers: authHeader });

      if (!resp.ok) return toolError(`Todoist API error: ${resp.status} ${resp.statusText}`);

      const data: unknown = await resp.json();
      const items = Array.isArray(data)
        ? data
        : ((data as { items?: unknown }).items ?? (data as { results?: unknown }).results ?? data);
      return toolSuccess({ since: sinceStr, until: untilStr, project_id: projectId, items });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
