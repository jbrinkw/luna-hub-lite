# Production-Ready Performance Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the app from MVP-quality data fetching (manual useEffect + useState, full refetches, no caching) into a production-ready setup with TanStack Query, optimistic updates, smart Realtime, skeleton loaders, and proper UI polish.

**Architecture:** Replace all manual data fetching with TanStack Query (useQuery/useMutation). Add QueryClientProvider at the app root. Realtime subscriptions invalidate query keys instead of refetching everything. Mutations use optimistic updates. All loading states use skeleton components. Pages within modules get lazy-loaded. Context values get memoized.

**Tech Stack:** TanStack Query v5, React 18, Supabase JS v2, Vite 6, Tailwind CSS v4

---

## Task 1: Infrastructure Setup

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/shared/queryClient.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/vite.config.ts`
- Modify: `vercel.json`
- Modify: `apps/web/index.html`

### Step 1: Install TanStack Query

```bash
cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/web add @tanstack/react-query
```

### Step 2: Remove unused dayjs dependency

```bash
cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/web remove dayjs
```

### Step 3: Create QueryClient configuration

Create `apps/web/src/shared/queryClient.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000, // 2 minutes before considered stale
      gcTime: 10 * 60 * 1000, // 10 minutes in garbage collection
      refetchOnWindowFocus: true, // Refetch when tab regains focus
      retry: 1, // One retry on failure
    },
  },
});
```

### Step 4: Add QueryClientProvider to App.tsx

Wrap the protected route subtree with `QueryClientProvider` (inside `AuthProvider`, above `AuthGuard`):

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './shared/queryClient';

// In the App component, wrap:
<QueryClientProvider client={queryClient}>{/* existing routes */}</QueryClientProvider>;
```

### Step 5: Add Vite build optimizations

In `vite.config.ts`, add to `build`:

- `target: 'es2020'`
- `chunkSizeWarningLimit: 200`
- Add `'@tanstack/react-query'` to the vendor manual chunk

### Step 6: Add Vercel cache headers for hashed assets

In `vercel.json`, add headers for `/assets/*` with `Cache-Control: public, max-age=31536000, immutable`.

### Step 7: Self-host Inter font

Download Inter variable woff2, place in `apps/web/public/fonts/`, update `index.html` to use local `@font-face` instead of Google Fonts CDN. Remove the preconnect links.

### Step 8: Commit

```bash
git add -A && git commit -m "feat: TanStack Query infrastructure, build optimizations, font self-hosting"
```

---

## Task 2: Context Memoization + AuthGuard Splash

**Files:**

- Modify: `apps/web/src/shared/AppProvider.tsx`
- Modify: `apps/web/src/shared/auth/AuthProvider.tsx`
- Modify: `apps/web/src/components/AuthGuard.tsx`

### Step 1: Memoize AppProvider context value

Wrap the context value object in `useMemo` with dependencies: `[activations, activationsLoading, online, lastSynced, dayStartHour, loadActivations]`.

### Step 2: Memoize AuthProvider functions and context value

Wrap `signIn`, `signUp`, `signOut` in `useCallback`. Then wrap the context value in `useMemo`.

### Step 3: Branded AuthGuard splash

Replace the bare spinner in AuthGuard with a branded loading screen showing the app name "Luna Hub" above the spinner.

### Step 4: Commit

```bash
git commit -m "perf: memoize context values, branded auth splash"
```

---

## Task 3: Page-Level Code Splitting

**Files:**

- Modify: `apps/web/src/modules/chefbyte/routes.tsx`
- Modify: `apps/web/src/modules/coachbyte/routes.tsx`

### Step 1: Lazy-load ChefByte pages

Replace all static imports in `chefbyte/routes.tsx` with `lazy()` imports. Keep `HomePage` eagerly loaded (it's the default landing page). Lazy-load: ScannerPage, InventoryPage, ShoppingPage, MealPlanPage, RecipesPage, RecipeFormPage, MacroPage, SettingsPage. Wrap Routes content in `<Suspense fallback={<PageSpinner />}>`.

### Step 2: Lazy-load CoachByte pages

Keep `TodayPage` eagerly loaded (default landing). Lazy-load: HistoryPage, SplitPage, PrsPage, SettingsPage. Wrap in Suspense.

### Step 3: Commit

```bash
git commit -m "perf: page-level code splitting for ChefByte and CoachByte"
```

---

## Task 4: Create Query Key Factory + Shared Hooks

**Files:**

- Create: `apps/web/src/shared/queryKeys.ts`
- Create: `apps/web/src/shared/useRealtimeInvalidation.ts`

### Step 1: Create query key factory

Create a centralized query key factory that all pages use. This ensures consistent key naming and makes invalidation reliable:

```ts
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
  splits: (userId: string) => ['splits', userId] as const,
  prs: (userId: string, range?: string) => ['prs', userId, range] as const,

  // ChefByte
  products: (userId: string) => ['products', userId] as const,
  stockLots: (userId: string) => ['stock-lots', userId] as const,
  locations: (userId: string) => ['locations', userId] as const,
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
};
```

### Step 2: Create useRealtimeInvalidation hook

A reusable hook that sets up a Supabase Realtime subscription and invalidates specific query keys on change:

```ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';

export function useRealtimeInvalidation(
  channelName: string,
  subscriptions: Array<{
    schema: string;
    table: string;
    filter?: string;
    queryKeys: readonly unknown[][];
  }>,
) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    let channel = supabase.channel(channelName);
    for (const sub of subscriptions) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: sub.schema,
          table: sub.table,
          filter: sub.filter ?? `user_id=eq.${user.id}`,
        },
        () => {
          for (const key of sub.queryKeys) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        },
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, channelName, queryClient]); // subscriptions is stable (defined at module level or useMemo)
}
```

### Step 3: Commit

```bash
git commit -m "feat: query key factory and useRealtimeInvalidation hook"
```

---

## Task 5: Hub Pages → TanStack Query

**Files:**

- Modify: `apps/web/src/pages/hub/AppsPage.tsx`
- Modify: `apps/web/src/pages/hub/AccountPage.tsx`
- Modify: `apps/web/src/pages/hub/McpSettingsPage.tsx`
- Modify: `apps/web/src/pages/hub/ExtensionsPage.tsx`
- Modify: `apps/web/src/pages/hub/ToolsPage.tsx`

### Pattern for each page:

1. Replace `useState` + `useEffect` data fetching with `useQuery`:
   - Remove: `const [data, setData] = useState(...)`
   - Remove: `const [loading, setLoading] = useState(true)`
   - Remove: `const loadData = useCallback(async () => { ... }, [user])`
   - Remove: `useEffect(() => { loadData() }, [loadData])`
   - Add: `const { data, isLoading } = useQuery({ queryKey: queryKeys.xxx(user.id), queryFn: async () => { /* supabase call */ } })`

2. Replace mutations with `useMutation`:
   - Add optimistic updates via `onMutate` (update cache immediately)
   - Rollback via `onError` (restore previous cache)
   - Invalidate via `onSettled`

3. Replace Realtime subscriptions with `useRealtimeInvalidation`

4. Replace loading text/spinner with skeleton components

### Specific notes per page:

- **AppsPage:** Remove duplicate `app_activations` fetch entirely — use `useAppContext().activations` which is already available. Use `useMutation` for activate/deactivate with optimistic toggle.

- **AccountPage:** `useQuery` for profile data. `useMutation` for profile save + password change. Replace loading with skeleton.

- **McpSettingsPage:** `useQuery` for API keys. `useMutation` for revoke/create. Add button loading states.

- **ExtensionsPage:** Already uses optimistic updates — just wrap in `useQuery`/`useMutation` for caching benefit.

- **ToolsPage:** Same as ExtensionsPage — already optimistic, just add query caching.

### Commit

```bash
git commit -m "feat: migrate Hub pages to TanStack Query"
```

---

## Task 6: CoachByte → TanStack Query + ExerciseProvider

**Files:**

- Create: `apps/web/src/shared/ExerciseProvider.tsx`
- Modify: `apps/web/src/modules/coachbyte/routes.tsx` (add ExerciseProvider wrapper)
- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/HistoryPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/SplitPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/PrsPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/SettingsPage.tsx`

### Step 1: Create ExerciseProvider

A lightweight context that fetches the exercise list once and shares it across all CoachByte pages. Uses `useQuery` internally:

```tsx
const { data: exercises = [] } = useQuery({
  queryKey: queryKeys.exercises(user.id),
  queryFn: async () => {
    const { data } = await coachbyte()
      .from('exercises')
      .select('*')
      .or(`is_global.eq.true,user_id.eq.${user.id}`)
      .order('name');
    return data ?? [];
  },
  staleTime: 5 * 60 * 1000, // exercises rarely change
});
```

### Step 2: Migrate TodayPage

This is the most complex page. Key changes:

- `useQuery` for daily plan (ensure_daily_plan RPC + planned_sets + completed_sets + daily_plans)
- `useQuery` for timer state
- `useMutation` for `complete_next_set` with optimistic update (move set from planned to completed locally)
- `useMutation` for add/delete planned sets with optimistic updates
- `useRealtimeInvalidation` for planned_sets, completed_sets, timers
- Debounced summary/notes save stays as-is (useRef pattern is correct)
- Replace "Loading workout..." with CardSkeleton

### Step 3: Migrate remaining CoachByte pages

- **HistoryPage:** `useQuery` with keyset pagination (keep existing cursor pattern). Parallelize planned_sets + completed_sets with Promise.all. Replace "Loading..." with ListSkeleton.
- **SplitPage:** `useQuery` for splits. `useMutation` for save with optimistic update. Replace "Loading..." with TableSkeleton.
- **PrsPage:** `useQuery` for computed PRs. Replace "Loading..." with CardSkeleton.
- **SettingsPage:** `useQuery` for exercises + settings. `useMutation` for add/delete exercises.

### Commit

```bash
git commit -m "feat: migrate CoachByte to TanStack Query, add ExerciseProvider"
```

---

## Task 7: ChefByte Simple Pages → TanStack Query

**Files:**

- Modify: `apps/web/src/pages/chefbyte/InventoryPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/ShoppingPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/RecipesPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/RecipeFormPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/SettingsPage.tsx`

### Pattern (same as Hub):

Each page: replace useState+useEffect with useQuery, mutations with useMutation+optimistic, Realtime with useRealtimeInvalidation, loading text with skeletons.

### Specific notes:

- **InventoryPage:** 3 parallel queries (products, stock_lots, locations) → single `useQuery` with Promise.all queryFn. `useMutation` for add/consume stock. Realtime invalidates stock-lots + products keys. Replace "Loading inventory..." with ListSkeleton.

- **ShoppingPage:** `useQuery` for shopping list. `useMutation` for toggle/add/remove with optimistic updates (toggle should instantly move item between purchased/unpurchased). Realtime invalidates shopping-list key. Replace "Loading..." with ListSkeleton.

- **RecipesPage:** `useQuery` for recipes + stock (parallel). Client-side filtering stays in useMemo. Replace "Loading..." with CardSkeleton grid.

- **RecipeFormPage:** `useQuery` for recipe data (edit mode). `useMutation` for save/delete. Debounced product search stays. Replace "Loading..." with CardSkeleton.

- **SettingsPage:** Multiple `useQuery` for products/devices/locations. Multiple `useMutation` for CRUD operations. Replace "Loading..." with ListSkeleton per tab.

### Commit

```bash
git commit -m "feat: migrate ChefByte simple pages to TanStack Query"
```

---

## Task 8: ChefByte Complex Pages → TanStack Query

**Files:**

- Modify: `apps/web/src/pages/chefbyte/MacroPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/MealPlanPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/HomePage.tsx`
- Modify: `apps/web/src/pages/chefbyte/ScannerPage.tsx`

### MacroPage:

- **5 sequential queries → single useQuery with Promise.all** (the biggest perf win):
  ```ts
  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.dailyMacros(user.id, dateStr), 'full'],
    queryFn: async () => {
      const [macrosRes, logsRes, tempRes, ltRes, mealsRes] = await Promise.all([
        chefbyte().rpc('get_daily_macros', { ... }),
        chefbyte().from('food_logs').select('...').eq(...),
        chefbyte().from('temp_items').select('...').eq(...),
        chefbyte().from('liquidtrack_events').select('...').eq(...),
        chefbyte().from('meal_plan_entries').select('...').eq(...),
      ]);
      return { macros, consumed, planned };
    },
  });
  ```
- `useMutation` for delete consumed item, add temp item, save targets, save taste profile — each with optimistic updates
- Realtime invalidates daily-macros, food-logs, temp-items keys
- Replace "Loading macros..." with MacroBarSkeleton + ListSkeleton
- **Parallelize 4 target macro upserts** in saveTargets mutation (Promise.all instead of sequential loop)

### MealPlanPage:

- 3 parallel queries via single useQuery with Promise.all
- `useMutation` for add/remove/complete meals with optimistic updates
- Realtime invalidates meal-plan, food-logs keys
- Replace "Loading meal plan..." with CardSkeleton

### HomePage:

- Multiple useQuery hooks for different sections (macros, inventory overview, meal plan, shopping):
  - `useQuery` for daily macros
  - `useQuery` for stock summary (products + lots grouped)
  - `useQuery` for today's meal plan
  - `useQuery` for shopping summary
- Each section can load independently (partial rendering)
- Realtime invalidates specific section keys instead of refetching all 10 queries
- Replace section loading states with individual skeletons

### ScannerPage:

- `useMutation` for barcode submit + action execution
- Cache locations query (fetch once on mount, reuse across scans)
- No Realtime needed (scanner is action-driven)
- Button loading states for scan actions

### Commit

```bash
git commit -m "feat: migrate ChefByte complex pages to TanStack Query"
```

---

## Task 9: UI Polish — Modal Animations + Button States

**Files:**

- Modify: `apps/web/src/components/shared/ModalOverlay.tsx`
- Modify: `apps/web/src/components/ui/Modal.tsx`
- Modify: Various pages (button loading states)

### Step 1: Add modal enter/exit CSS animations

Add CSS transition classes for modal backdrop (fade in 150ms) and card (fade+scale from 95% to 100% in 150ms). Use Tailwind's `transition` + `animate` utilities or a CSS keyframe in `index.css`.

For ModalOverlay: render the backdrop and card with opacity-0 initially, animate to opacity-100. On close, animate out before unmounting (use a brief timeout or `onTransitionEnd`).

Simpler approach: use CSS animation keyframes:

```css
@keyframes modal-in {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.modal-enter {
  animation: modal-in 150ms ease-out;
}
```

### Step 2: Add button loading states to mutation-heavy pages

For every button that triggers an async operation:

- Use the `useMutation().isPending` state to show a spinner and disable the button
- Key pages: InventoryPage (add/consume), ShoppingPage (toggle/add/remove), TodayPage (complete set), MacroPage (delete/add), MealPlanPage (add/complete), RecipeFormPage (save)

### Step 3: Commit

```bash
git commit -m "feat: modal animations, button loading states"
```

---

## Task 10: Migrate AppProvider to TanStack Query

**Files:**

- Modify: `apps/web/src/shared/AppProvider.tsx`

### Changes:

Replace the manual useState + useEffect + useCallback + loadingRef pattern with:

```tsx
const { data: activations = {}, isLoading: activationsLoading } = useQuery({
  queryKey: queryKeys.activations(user.id),
  queryFn: async () => {
    const { data } = await supabase.schema('hub').from('app_activations').select('app_name').eq('user_id', user.id);
    const map: Record<string, boolean> = {};
    (data || []).forEach((row) => {
      map[row.app_name] = true;
    });
    return map;
  },
  enabled: !!user,
});

const { data: dayStartHour = 0 } = useQuery({
  queryKey: queryKeys.profile(user?.id ?? ''),
  queryFn: async () => {
    const { data } = await supabase
      .schema('hub')
      .from('profiles')
      .select('day_start_hour')
      .eq('user_id', user!.id)
      .single();
    return data?.day_start_hour ?? 0;
  },
  enabled: !!user,
  staleTime: 10 * 60 * 1000,
});
```

Use `useRealtimeInvalidation` for activation changes. Remove the loadingRef dedup (TanStack Query handles this). Keep online/offline detection as-is. Memoize context value.

### Commit

```bash
git commit -m "refactor: migrate AppProvider to TanStack Query"
```

---

## Task 11: Cleanup, Tests, and Documentation

**Files:**

- Modify: Various test files
- Modify: `docs/apps/hub.md`, `docs/apps/coachbyte.md`, `docs/apps/chefbyte.md`
- Modify: `docs/architecture/database.md` (if query patterns documented)
- Modify: `CLAUDE.md` (add TanStack Query to tech stack)

### Step 1: Run full test suite, fix any broken tests

```bash
pnpm test && pnpm typecheck
```

Update test files that mock data fetching patterns to work with TanStack Query. Wrap test renders in `QueryClientProvider` with a fresh `QueryClient` per test.

### Step 2: Run production build and verify chunk sizes

```bash
pnpm build
```

Verify ChefByte chunk is split into multiple smaller chunks. Verify new TanStack Query chunk is in vendor.

### Step 3: Update documentation

- Update CLAUDE.md tech stack to include TanStack Query
- Update relevant docs to mention the query/mutation/Realtime patterns
- Update docs to reflect skeleton loading states

### Step 4: Commit

```bash
git commit -m "chore: fix tests, update docs for TanStack Query migration"
```

---

## Dependency Graph

```
Task 1 (Infrastructure) ──┬──> Task 4 (Hub pages)
                           ├──> Task 5 (Hub pages: AppsPage fix)
                           ├──> Task 10 (AppProvider)
                           └──> Task 4 (Query keys + hooks)

Task 2 (Context memo) ────────> independent

Task 3 (Code splitting) ──────> independent

Task 4 (Query keys) ──────┬──> Task 5 (Hub)
                           ├──> Task 6 (CoachByte)
                           ├──> Task 7 (ChefByte simple)
                           └──> Task 8 (ChefByte complex)

Task 9 (UI polish) ───────────> after Tasks 5-8

Task 11 (Cleanup) ────────────> after all
```

## Priority Order for Serial Execution

1 → 2 (parallel with 3) → 4 → 5 → 6 → 7 → 8 → 10 → 9 → 11
