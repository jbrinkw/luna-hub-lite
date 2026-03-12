export const queryKeys = {
  // Hub
  activations: (userId: string) => ['activations', userId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  apiKeys: (userId: string) => ['api-keys', userId] as const,
  tools: (userId: string) => ['tools', userId] as const,
  extensions: (userId: string) => ['extensions', userId] as const,

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
  liquidtrackEvents: (userId: string, date: string) => ['lt-events', userId, date] as const,
  devices: (userId: string) => ['devices', userId] as const,
  userConfig: (userId: string, key: string) => ['user-config', userId, key] as const,
  chefSettings: (userId: string) => ['chef-settings', userId] as const,
};
