/**
 * Profile query keys — H-13 / PROFILE-CACHE.
 *
 * The `hub.profiles` row is read by four independent consumers, each of which
 * `.select(...)`s a DIFFERENT subset of columns:
 *   - AccountPage      → `full`              (display_name, timezone, day_start_hour, unit_system)
 *   - AppProvider      → `dayStart`          (bare number day_start_hour)
 *   - useUnitSystem    → `unitSystem`        ({ unit_system })
 *   - ClassifierTab    → `classifierFallback`({ chefbyte_classifier_fallback_enabled })
 *
 * TanStack Query v5 dedupes strictly by key and shares ONE cached `data`
 * entry per key. When all four shared a single `['profile', userId]` key, the
 * first consumer to mount (AppProvider, which wraps every protected route)
 * cached a bare NUMBER; within its staleTime the others read that number and
 * mis-derived their field (e.g. a metric user got 'imperial' because
 * `(number).unit_system === undefined`). Giving each consumer a DISTINCT key
 * eliminates the cross-shape collision.
 */
export const profileKeys = {
  /** Full-row read used by AccountPage (and the back-compat `profile` alias). */
  full: (userId: string) => ['profile', userId, 'full'] as const,
  /** Bare `day_start_hour` number read by AppProvider. */
  dayStart: (userId: string) => ['profile', userId, 'dayStart'] as const,
  /** `{ unit_system }` read by useUnitSystem. */
  unitSystem: (userId: string) => ['profile', userId, 'unitSystem'] as const,
  /** `{ chefbyte_classifier_fallback_enabled }` read by ClassifierTab. */
  classifierFallback: (userId: string) => ['profile', userId, 'classifierFallback'] as const,
} as const;

export const queryKeys = {
  // Hub
  activations: (userId: string) => ['activations', userId] as const,
  /**
   * Back-compat alias for the AccountPage full-row profile read. The other
   * three profile consumers (AppProvider, useUnitSystem, ClassifierTab) read
   * their own DISTINCT `profileKeys.*` keys to avoid the cross-shape cache
   * collision documented on `profileKeys` above (H-13 / PROFILE-CACHE).
   */
  profile: (userId: string) => profileKeys.full(userId),
  apiKeys: (userId: string) => ['api-keys', userId] as const,
  tools: (userId: string) => ['tools', userId] as const,
  extensions: (userId: string) => ['extensions', userId] as const,
  agentSettings: (userId: string) => ['agent-settings', userId] as const,
  mcpToolLogs: (userId: string, namespace: string) => ['mcp-tool-logs', userId, namespace] as const,

  // CoachByte
  exercises: (userId: string) => ['exercises', userId] as const,
  dailyPlan: (userId: string, date: string) => ['daily-plan', userId, date] as const,
  timer: (userId: string) => ['timer', userId] as const,
  history: (userId: string) => ['history', userId] as const,
  historyDetail: (userId: string, planId: string) => ['history-detail', userId, planId] as const,
  historyCount: (userId: string) => ['history-count', userId] as const,
  splits: (userId: string) => ['splits', userId] as const,
  prs: (userId: string, range?: string) => ['prs', userId, range] as const,
  coachSettings: (userId: string) => ['coach-settings', userId] as const,

  // ChefByte
  products: (userId: string) => ['products', userId] as const,
  productMeasuredStates: (userId: string) => ['product-measured-states', userId] as const,
  stockLots: (userId: string) => ['stock-lots', userId] as const,
  locations: (userId: string) => ['locations', userId] as const,
  defaultLocationId: (userId: string) => ['default-location-id', userId] as const,
  recipes: (userId: string) => ['recipes', userId] as const,
  recipe: (recipeId: string) => ['recipe', recipeId] as const,
  shoppingList: (userId: string) => ['shopping-list', userId] as const,
  mealPlan: (userId: string, date: string) => ['meal-plan', userId, date] as const,
  dailyMacros: (userId: string, date: string) => ['daily-macros', userId, date] as const,
  foodLogs: (userId: string, date: string) => ['food-logs', userId, date] as const,
  tempItems: (userId: string, date: string) => ['temp-items', userId, date] as const,
  liveShelfDevices: (userId: string) => ['live-shelf-devices', userId] as const,
  liveShelfDevice: (userId: string) => ['live-shelf-device', userId] as const,
  livetrackSession: (userId: string, sessionId: string | null) => ['livetrack-session', userId, sessionId] as const,
  scalePairings: (userId: string) => ['scale-pairings', userId] as const,
  userConfig: (userId: string, key: string) => ['user-config', userId, key] as const,
  chefSettings: (userId: string) => ['chef-settings', userId] as const,
  scannerState: (userId?: string) => ['chefbyte', 'scannerState', userId] as const,
  scanTransactions: (userId?: string) => ['chefbyte', 'scanTransactions', userId] as const,
};
