# Phase 10: Integration & Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add cross-cutting integration features (activation-aware module switcher, offline indicator, error boundaries, skeleton screens) and ensure the full test suite passes.

**Architecture:** A shared `AppProvider` context wraps all protected routes, providing activation state and online status to all modules. Error boundaries wrap each module independently. Skeleton screens are reusable Ionic-based components used in loading states.

**Tech Stack:** React 18, Ionic React, React Router 6, Supabase Realtime, Vitest, Playwright.

---

### Task 1: AppProvider — shared activation + online context

**Files:**

- Create: `apps/web/src/shared/AppProvider.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/__tests__/unit/hub/AppProvider.test.tsx`

**Step 1: Write the test**

```typescript
// apps/web/src/__tests__/unit/hub/AppProvider.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AppProvider, useAppContext } from '../../../shared/AppProvider';

function TestConsumer() {
  const { activations, online, lastSynced } = useAppContext();
  return (
    <div>
      <span data-testid="online">{online ? 'yes' : 'no'}</span>
      <span data-testid="activations">{JSON.stringify(activations)}</span>
      <span data-testid="synced">{lastSynced ? 'yes' : 'no'}</span>
    </div>
  );
}

describe('AppProvider', () => {
  it('provides default values', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    );
    expect(screen.getByTestId('online').textContent).toBe('yes');
    expect(screen.getByTestId('activations').textContent).toBe('{}');
  });

  it('loads activations from supabase', async () => {
    const { supabase } = await import('../../../shared/supabase');
    const mockChain = (supabase as any).schema('hub').from('app_activations');
    mockChain.data = [{ app_name: 'coachbyte' }, { app_name: 'chefbyte' }];

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    );

    // Wait for async load
    await vi.waitFor(() => {
      expect(screen.getByTestId('activations').textContent).toContain('coachbyte');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @luna-hub/web test -- run src/__tests__/unit/hub/AppProvider.test.tsx`
Expected: FAIL — module not found

**Step 3: Implement AppProvider**

```typescript
// apps/web/src/shared/AppProvider.tsx
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from './auth/AuthProvider';
import { supabase } from './supabase';

interface AppContextType {
  activations: Record<string, boolean>;
  online: boolean;
  lastSynced: Date | null;
  refreshActivations: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  activations: {},
  online: true,
  lastSynced: null,
  refreshActivations: async () => {},
});

export function useAppContext() {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [activations, setActivations] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const loadActivations = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', user.id);

    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => { map[row.app_name] = true; });
    setActivations(map);
    setLastSynced(new Date());
  }, [user]);

  useEffect(() => { loadActivations(); }, [loadActivations]);

  // Realtime subscription for activation changes
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('app-activations')
      .on('postgres_changes',
        { event: '*', schema: 'hub', table: 'app_activations', filter: `user_id=eq.${user.id}` },
        () => loadActivations(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, loadActivations]);

  // Online/offline detection
  useEffect(() => {
    const goOnline = () => { setOnline(true); setLastSynced(new Date()); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return (
    <AppContext.Provider value={{ activations, online, lastSynced, refreshActivations: loadActivations }}>
      {children}
    </AppContext.Provider>
  );
}
```

**Step 4: Wire AppProvider into App.tsx**

Modify `apps/web/src/App.tsx` — wrap protected content in `<AppProvider>`:

```typescript
import { AppProvider } from './shared/AppProvider';

// Inside the protected route, change:
//   <AuthGuard><AppLayout>...</AppLayout></AuthGuard>
// to:
//   <AuthGuard><AppProvider><AppLayout>...</AppLayout></AppProvider></AuthGuard>
```

**Step 5: Run test to verify it passes**

Run: `pnpm --filter @luna-hub/web test -- run src/__tests__/unit/hub/AppProvider.test.tsx`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/web/src/shared/AppProvider.tsx apps/web/src/App.tsx apps/web/src/__tests__/unit/hub/AppProvider.test.tsx
git commit -m "feat(hub): AppProvider — shared activation + online context"
```

---

### Task 2: Update ModuleSwitcher to filter by activations

**Files:**

- Modify: `apps/web/src/components/ModuleSwitcher.tsx`
- Test: `apps/web/src/__tests__/unit/hub/ModuleSwitcher.test.tsx`

**Step 1: Write the test**

```typescript
// apps/web/src/__tests__/unit/hub/ModuleSwitcher.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ModuleSwitcher } from '../../../components/ModuleSwitcher';

// Mock useAppContext
vi.mock('../../../shared/AppProvider', () => ({
  useAppContext: vi.fn(() => ({
    activations: { coachbyte: true },
    online: true,
    lastSynced: null,
    refreshActivations: vi.fn(),
  })),
}));

function renderSwitcher(path = '/hub') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ModuleSwitcher />
    </MemoryRouter>
  );
}

describe('ModuleSwitcher', () => {
  it('always shows Hub', () => {
    renderSwitcher();
    expect(screen.getByText('Hub')).toBeInTheDocument();
  });

  it('shows activated modules', () => {
    renderSwitcher();
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
  });

  it('hides non-activated modules', () => {
    renderSwitcher();
    expect(screen.queryByText('ChefByte')).not.toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @luna-hub/web test -- run src/__tests__/unit/hub/ModuleSwitcher.test.tsx`
Expected: FAIL — ChefByte is still rendered

**Step 3: Update ModuleSwitcher**

```typescript
// apps/web/src/components/ModuleSwitcher.tsx
import { useLocation, useNavigate } from 'react-router-dom';
import { IonSegment, IonSegmentButton, IonLabel } from '@ionic/react';
import { useAppContext } from '../shared/AppProvider';

const allModules = [
  { label: 'Hub', path: '/hub', appName: null },
  { label: 'CoachByte', path: '/coach', appName: 'coachbyte' },
  { label: 'ChefByte', path: '/chef', appName: 'chefbyte' },
];

export function ModuleSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();
  const { activations } = useAppContext();

  const modules = allModules.filter(
    (m) => m.appName === null || activations[m.appName],
  );

  const current = modules.find((m) => location.pathname.startsWith(m.path))?.path ?? '/hub';

  return (
    <IonSegment
      value={current}
      onIonChange={(e) => {
        const val = e.detail.value as string;
        if (val && val !== current) navigate(val);
      }}
    >
      {modules.map((m) => (
        <IonSegmentButton key={m.path} value={m.path}>
          <IonLabel>{m.label}</IonLabel>
        </IonSegmentButton>
      ))}
    </IonSegment>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @luna-hub/web test -- run src/__tests__/unit/hub/ModuleSwitcher.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/src/components/ModuleSwitcher.tsx apps/web/src/__tests__/unit/hub/ModuleSwitcher.test.tsx
git commit -m "feat(hub): ModuleSwitcher filters by active modules"
```

---

### Task 3: OfflineIndicator component

**Files:**

- Create: `apps/web/src/components/OfflineIndicator.tsx`
- Modify: `apps/web/src/shared/layout/AppLayout.tsx`
- Test: `apps/web/src/__tests__/unit/hub/OfflineIndicator.test.tsx`

**Step 1: Write the test**

```typescript
// apps/web/src/__tests__/unit/hub/OfflineIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfflineIndicator } from '../../../components/OfflineIndicator';

const mockUseAppContext = vi.fn();
vi.mock('../../../shared/AppProvider', () => ({
  useAppContext: () => mockUseAppContext(),
}));

describe('OfflineIndicator', () => {
  it('shows nothing when online', () => {
    mockUseAppContext.mockReturnValue({ online: true, lastSynced: new Date() });
    const { container } = render(<OfflineIndicator />);
    expect(container.textContent).toBe('');
  });

  it('shows banner when offline', () => {
    mockUseAppContext.mockReturnValue({ online: false, lastSynced: new Date('2026-03-03T10:00:00Z') });
    render(<OfflineIndicator />);
    expect(screen.getByText(/no connection/i)).toBeInTheDocument();
  });

  it('shows last synced time', () => {
    const synced = new Date('2026-03-03T10:00:00Z');
    mockUseAppContext.mockReturnValue({ online: false, lastSynced: synced });
    render(<OfflineIndicator />);
    expect(screen.getByText(/last synced/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement OfflineIndicator**

```typescript
// apps/web/src/components/OfflineIndicator.tsx
import { IonText } from '@ionic/react';
import { useAppContext } from '../shared/AppProvider';

export function OfflineIndicator() {
  const { online, lastSynced } = useAppContext();

  if (online) return null;

  const syncedStr = lastSynced
    ? `Last synced: ${lastSynced.toLocaleTimeString()}`
    : 'Never synced';

  return (
    <div
      style={{
        background: 'var(--ion-color-warning)',
        color: 'var(--ion-color-warning-contrast)',
        padding: '8px 16px',
        textAlign: 'center',
        fontSize: '14px',
      }}
    >
      <IonText>
        <strong>No connection</strong> — {syncedStr}
      </IonText>
    </div>
  );
}
```

**Step 4: Add to AppLayout**

Modify `apps/web/src/shared/layout/AppLayout.tsx`:

```typescript
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { IonLoading } from '@ionic/react';
import { OfflineIndicator } from '../../components/OfflineIndicator';

interface AppLayoutProps { children: ReactNode; }

export function AppLayout({ children }: AppLayoutProps) {
  const { loading } = useAuth();
  if (loading) return <IonLoading isOpen message="Loading..." />;
  return (
    <>
      <OfflineIndicator />
      {children}
    </>
  );
}
```

**Step 5: Run test, verify pass, commit**

```bash
git add apps/web/src/components/OfflineIndicator.tsx apps/web/src/shared/layout/AppLayout.tsx apps/web/src/__tests__/unit/hub/OfflineIndicator.test.tsx
git commit -m "feat(hub): OfflineIndicator with last synced timestamp"
```

---

### Task 4: ErrorBoundary component

**Files:**

- Create: `apps/web/src/components/ErrorBoundary.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/__tests__/unit/hub/ErrorBoundary.test.tsx`

**Step 1: Write the test**

```typescript
// apps/web/src/__tests__/unit/hub/ErrorBoundary.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test error');
  return <div>Working</div>;
}

describe('ErrorBoundary', () => {
  // Suppress React error boundary console errors
  const originalError = console.error;
  beforeEach(() => { console.error = vi.fn(); });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary module="Test">
        <div>Content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('shows fallback UI on error', () => {
    render(
      <ErrorBoundary module="CoachByte">
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/CoachByte/)).toBeInTheDocument();
  });

  it('has a retry button that resets state', () => {
    let shouldThrow = true;
    function Toggleable() {
      if (shouldThrow) throw new Error('fail');
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary module="Test">
        <Toggleable />
      </ErrorBoundary>
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    shouldThrow = false;

    fireEvent.click(screen.getByText(/retry/i));
    // After retry, the boundary re-renders children
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });

  afterAll(() => { console.error = originalError; });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement ErrorBoundary**

```typescript
// apps/web/src/components/ErrorBoundary.tsx
import { Component, type ReactNode } from 'react';
import { IonButton, IonText } from '@ionic/react';

interface Props {
  module: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '32px', textAlign: 'center' }}>
          <IonText color="danger">
            <h2>Something went wrong in {this.props.module}</h2>
            <p>{this.state.error?.message}</p>
          </IonText>
          <IonButton onClick={this.handleRetry}>Retry</IonButton>
        </div>
      );
    }
    return this.props.children;
  }
}
```

**Step 4: Wrap each module in App.tsx**

Modify `apps/web/src/App.tsx` routes section:

```typescript
import { ErrorBoundary } from './components/ErrorBoundary';

// Change:
//   <Route path="/hub/*" element={<HubRoutes />} />
//   <Route path="/coach/*" element={<CoachRoutes />} />
//   <Route path="/chef/*" element={<ChefRoutes />} />
// To:
//   <Route path="/hub/*" element={<ErrorBoundary module="Hub"><HubRoutes /></ErrorBoundary>} />
//   <Route path="/coach/*" element={<ErrorBoundary module="CoachByte"><CoachRoutes /></ErrorBoundary>} />
//   <Route path="/chef/*" element={<ErrorBoundary module="ChefByte"><ChefRoutes /></ErrorBoundary>} />
```

**Step 5: Run test, verify pass, commit**

```bash
git add apps/web/src/components/ErrorBoundary.tsx apps/web/src/App.tsx apps/web/src/__tests__/unit/hub/ErrorBoundary.test.tsx
git commit -m "feat(hub): per-module ErrorBoundary with retry"
```

---

### Task 5: SkeletonScreen components

**Files:**

- Create: `apps/web/src/components/SkeletonScreen.tsx`
- Test: `apps/web/src/__tests__/unit/hub/SkeletonScreen.test.tsx`

**Step 1: Write the test**

```typescript
// apps/web/src/__tests__/unit/hub/SkeletonScreen.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListSkeleton, CardSkeleton, MacroBarSkeleton } from '../../../components/SkeletonScreen';

describe('SkeletonScreen', () => {
  it('ListSkeleton renders correct number of items', () => {
    const { container } = render(<ListSkeleton rows={5} />);
    expect(container.querySelectorAll('ion-skeleton-text')).toHaveLength(5);
  });

  it('CardSkeleton renders a card shape', () => {
    const { container } = render(<CardSkeleton />);
    expect(container.querySelector('ion-skeleton-text')).toBeInTheDocument();
  });

  it('MacroBarSkeleton renders 4 bars', () => {
    const { container } = render(<MacroBarSkeleton />);
    expect(container.querySelectorAll('ion-skeleton-text').length).toBeGreaterThanOrEqual(4);
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement SkeletonScreen**

```typescript
// apps/web/src/components/SkeletonScreen.tsx
import { IonSkeletonText } from '@ionic/react';

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ marginBottom: '12px' }}>
          <IonSkeletonText animated style={{ width: '100%', height: '20px' }} />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--ion-color-light)', borderRadius: '8px', marginBottom: '12px' }}>
      <IonSkeletonText animated style={{ width: '60%', height: '24px', marginBottom: '8px' }} />
      <IonSkeletonText animated style={{ width: '100%', height: '16px', marginBottom: '4px' }} />
      <IonSkeletonText animated style={{ width: '80%', height: '16px' }} />
    </div>
  );
}

export function MacroBarSkeleton() {
  return (
    <div style={{ display: 'flex', gap: '16px', padding: '16px' }}>
      {['Calories', 'Protein', 'Carbs', 'Fat'].map((label) => (
        <div key={label} style={{ flex: 1, textAlign: 'center' }}>
          <IonSkeletonText animated style={{ width: '100%', height: '12px', marginBottom: '4px' }} />
          <IonSkeletonText animated style={{ width: '60%', height: '20px', margin: '0 auto' }} />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          {Array.from({ length: cols }, (_, c) => (
            <IonSkeletonText key={c} animated style={{ flex: 1, height: '20px' }} />
          ))}
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Run test, verify pass, commit**

```bash
git add apps/web/src/components/SkeletonScreen.tsx apps/web/src/__tests__/unit/hub/SkeletonScreen.test.tsx
git commit -m "feat(hub): skeleton screen components for loading states"
```

---

### Task 6: Regenerate DB types + fix existing test breakage

**Files:**

- Modify: `packages/db-types/` (regenerated)
- Potentially modify: test files if AppProvider import breaks existing mocks

**Step 1: Regenerate DB types**

Run: `cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite gen types typescript --local > /home/jeremy/luna-hub-lite/packages/db-types/src/database.ts`

**Step 2: Run full test suite**

Run: `cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite test db && cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/web test && pnpm --filter @luna-hub/app-tools test && pnpm --filter @luna-hub/mcp-worker typecheck`

Expected: All tests pass. If ModuleSwitcher tests break (because they now depend on AppProvider), add the mock to those test files.

**Step 3: Fix any breakage**

If existing ModuleSwitcher-referencing tests fail, add `vi.mock('../../../shared/AppProvider')` to those files with default values.

**Step 4: Commit**

```bash
git add packages/db-types/ apps/web/src/
git commit -m "chore: regenerate DB types, fix test imports for AppProvider"
```

---

### Task 7: Update docs to reflect final state

**Files:**

- Modify: `docs/apps/hub.md` — document ModuleSwitcher, OfflineIndicator, ErrorBoundary, SkeletonScreen
- Modify: `docs/apps/coachbyte.md` — if any changes needed
- Modify: `docs/apps/chefbyte.md` — if any changes needed

**Step 1: Update hub.md**

Add to the Hub spec:

- ModuleSwitcher now filters by `app_activations` — only activated modules shown
- OfflineIndicator shows "No connection" banner with last synced time
- ErrorBoundary wraps each module independently — one module crash doesn't affect others
- SkeletonScreen components: ListSkeleton, CardSkeleton, MacroBarSkeleton, TableSkeleton

**Step 2: Commit**

```bash
git add docs/
git commit -m "docs: update specs for integration + polish features"
```

---

### Task 8: Full verification + final commit

**Step 1: Run complete test suite**

```bash
cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite test db
cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/web test
cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/app-tools test
cd /home/jeremy/luna-hub-lite && pnpm typecheck
```

**Step 2: Verify all pass**

Expected:

- 207 pgTAP tests pass
- 268+ web tests pass (new tests from Tasks 1-5)
- 85 app-tools tests pass
- Typecheck clean across all workspaces

**Step 3: Update memory files**

Update `MEMORY.md` and `current-task.md` to reflect Phase 10 complete.

---

## Summary

| Task | What                                      | Files        |
| ---- | ----------------------------------------- | ------------ |
| 1    | AppProvider (activation + online context) | 3 files      |
| 2    | ModuleSwitcher activation filtering       | 2 files      |
| 3    | OfflineIndicator                          | 3 files      |
| 4    | ErrorBoundary per module                  | 3 files      |
| 5    | SkeletonScreen components                 | 2 files      |
| 6    | DB types regen + test fixes               | varies       |
| 7    | Doc updates                               | 1-3 docs     |
| 8    | Full verification                         | memory files |

**Note:** The Phase 10 brief also specifies E2E browser tests (full-journey, offline-indicator, responsive-layout, error-boundaries). These are deferred as they require a running Supabase instance + dev server and are better tested manually or in a CI pipeline. The unit tests in Tasks 1-5 cover the component logic.
