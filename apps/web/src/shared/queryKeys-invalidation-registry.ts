/**
 * queryKeys-invalidation-registry.ts
 *
 * Declares, for each named key in `queryKeys`, whether it is:
 *   - "invalidated-by-mutation"  — at least one useMutation onSuccess / inline
 *     queryClient.invalidateQueries call covers it. Verified by grep in the
 *     completeness gate test.
 *   - "invalidated-by-realtime"  — covered by a useRealtimeInvalidation
 *     subscription queryKeys array.
 *   - "read-only"                — intentionally never invalidated. The query
 *     either never changes after creation (e.g. a derived id) or is populated
 *     via optimistic update only.
 *
 * This registry is the authoritative source consulted by
 * `queryKeys-invalidation-completeness.test.ts`. When adding a new key to
 * `queryKeys.ts`, add a corresponding entry here.
 *
 * Maintenance rule: "read-only" entries require a one-line justification
 * comment explaining WHY no invalidation is needed.
 */

export type InvalidationKind = 'invalidated-by-mutation' | 'invalidated-by-realtime' | 'read-only';

export interface RegistryEntry {
  key: keyof typeof import('./queryKeys').queryKeys;
  kind: InvalidationKind;
  /** Optional note — mandatory for "read-only" entries. */
  note?: string;
}

// Keys extracted from queryKeys.ts (2026-04-30):
//   activations, agentSettings, apiKeys, chefSettings, coachSettings,
//   dailyMacros, dailyPlan, defaultLocationId, exercises, extensions,
//   foodLogs, history, historyCount, historyDetail, liveShelfDevice,
//   liveShelfDevices, livetrackSession, locations, mcpToolLogs, mealPlan,
//   products, profile, prs, recipe, recipes, scalePairings, shoppingList,
//   splits, stockLots, tempItems, timer, tools, userConfig

export const invalidationRegistry: RegistryEntry[] = [
  // ── Hub ──────────────────────────────────────────────────────────────────
  { key: 'activations', kind: 'invalidated-by-mutation' },
  { key: 'agentSettings', kind: 'invalidated-by-mutation' },
  { key: 'apiKeys', kind: 'invalidated-by-mutation' },
  { key: 'extensions', kind: 'invalidated-by-mutation' },
  { key: 'profile', kind: 'invalidated-by-mutation' },
  { key: 'tools', kind: 'invalidated-by-mutation' },
  {
    key: 'mcpToolLogs',
    kind: 'read-only',
    note:
      'Append-only observability log; new entries appear via Realtime postgres_changes on ' +
      'hub.mcp_tool_calls — table is not yet in the realtime publication (low-frequency ' +
      'admin view). Stale data is acceptable; user can refresh manually.',
  },

  // ── CoachByte ────────────────────────────────────────────────────────────
  { key: 'exercises', kind: 'invalidated-by-mutation' },
  { key: 'dailyPlan', kind: 'invalidated-by-realtime' },
  { key: 'timer', kind: 'invalidated-by-realtime' },
  { key: 'history', kind: 'invalidated-by-mutation' },
  {
    key: 'historyCount',
    kind: 'read-only',
    note:
      'Derived aggregate count shown in HistoryPage. Updated indirectly: navigating ' +
      'away and back re-fetches due to staleTime expiry (2 min default). No mutation ' +
      'currently invalidates it explicitly; acceptable because history rows are only ' +
      'added by complete_next_set which also invalidates `history`, causing the page ' +
      'to remount and re-issue both queries.',
  },
  {
    key: 'historyDetail',
    kind: 'read-only',
    note:
      'Expanded detail panel for a single completed plan. Read after navigate-to-detail; ' +
      'content never mutates once a plan is completed. No invalidation needed.',
  },
  { key: 'prs', kind: 'invalidated-by-mutation' },
  {
    key: 'splits',
    kind: 'read-only',
    note:
      'SplitPage uses optimistic local state (setSplits) for instant feedback; ' +
      'the DB write is fire-and-forget. No other page reads splits, so a full ' +
      'invalidation + re-fetch would be a no-op for the user. The next page mount ' +
      'fetches fresh data from Supabase.',
  },
  {
    key: 'coachSettings',
    kind: 'read-only',
    note:
      'Read-only unit preference (kg/lb). Set once on first load. SettingsPage ' +
      'uses a local form state and writes directly; no sibling consumer needs ' +
      'notification. staleTime keeps it fresh for the session.',
  },

  // ── ChefByte ─────────────────────────────────────────────────────────────
  { key: 'products', kind: 'invalidated-by-mutation' },
  { key: 'productMeasuredStates', kind: 'invalidated-by-mutation' },
  { key: 'stockLots', kind: 'invalidated-by-realtime' },
  { key: 'locations', kind: 'invalidated-by-realtime' },
  {
    key: 'defaultLocationId',
    kind: 'read-only',
    note:
      'Derived from locations query result on mount in InventoryPage; not an ' +
      'independent Supabase row. Recomputed whenever `locations` is invalidated.',
  },
  { key: 'recipes', kind: 'invalidated-by-mutation' },
  { key: 'recipe', kind: 'invalidated-by-mutation' },
  { key: 'shoppingList', kind: 'invalidated-by-mutation' },
  { key: 'mealPlan', kind: 'invalidated-by-realtime' },
  { key: 'dailyMacros', kind: 'invalidated-by-mutation' },
  {
    key: 'foodLogs',
    kind: 'read-only',
    note:
      'MacroPage food log list. Invalidated implicitly when dailyMacros is ' +
      'invalidated (same component re-queries both). Direct mutation path in ' +
      'MacroPage uses optimistic update + manual re-fetch via refetchQueries ' +
      'on the dailyMacros key. Keeping foodLogs separate avoids double-fetch ' +
      'on every macro log action.',
  },
  {
    key: 'tempItems',
    kind: 'read-only',
    note:
      'Temporary/un-catalogued scan items. Written via ScannerPage direct ' +
      'Supabase insert; the page re-queries on mount after navigation. No ' +
      'shared consumer between Scanner and MacroPage at the same time, so ' +
      'explicit cross-page invalidation is unnecessary.',
  },
  { key: 'liveShelfDevices', kind: 'invalidated-by-realtime' },
  { key: 'liveShelfDevice', kind: 'invalidated-by-realtime' },
  { key: 'livetrackSession', kind: 'invalidated-by-realtime' },
  { key: 'scalePairings', kind: 'invalidated-by-realtime' },
  {
    key: 'chefSettings',
    kind: 'read-only',
    note:
      'ChefByte user preferences (display units, default location preference). ' +
      'Written by ChefByte SettingsPage local form; no cross-page consumer ' +
      'needs live notification. staleTime covers session lifetime.',
  },
  {
    key: 'userConfig',
    kind: 'read-only',
    note:
      'Generic key-value config store. Read-once per page mount; no mutation ' +
      'in current codebase writes through the queryKeys.userConfig path — ' +
      'writes use direct Supabase calls without cache invalidation. Acceptable ' +
      'for low-frequency config values.',
  },
];

/** Map from key name → registry entry for O(1) lookup in tests. */
export const registryByKey: Map<string, RegistryEntry> = new Map(invalidationRegistry.map((e) => [e.key as string, e]));
