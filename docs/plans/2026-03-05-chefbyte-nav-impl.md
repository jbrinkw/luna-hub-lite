# ChefByte Navigation Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat 8-link ChefByte nav with a Scanner-first header + 5-tab layout. Move Walmart into Settings. Add notification dot for pending items.

**Architecture:** Rewrite `ChefLayout.tsx` to render a header (brand + Scanner button + hamburger) and a tab bar below it. Replace the current `nav-bar`/`nav-links` CSS with a new tab-based layout. Each page keeps wrapping in `<ChefLayout>` — only the shell changes. Walmart content moves into SettingsPage as a 4th tab.

**Tech Stack:** React 18, React Router 6, CSS (scoped under `.chef-root` in `chefbyte.css`)

**Design doc:** `docs/plans/2026-03-05-chefbyte-nav-redesign.md`

---

### Task 1: Rewrite ChefLayout — Header + Tab Bar

**Files:**

- Modify: `apps/web/src/components/chefbyte/ChefLayout.tsx`
- Modify: `apps/web/src/theme/chefbyte.css`

**Step 1: Rewrite ChefLayout.tsx**

Replace the entire file. The new layout has 3 sections:

1. **Header bar** — brand on left, Scanner button (accent) + hamburger on right
2. **Tab bar** — 5 tabs (Dashboard, Meal Plan, Recipes, Shopping, Inventory, Settings)
3. **Content area** — scrollable, renders children

```tsx
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

const tabs = [
  { to: '/chef', label: 'Dashboard', match: ['/chef', '/chef/home', '/chef/macros'] },
  { to: '/chef/meal-plan', label: 'Meal Plan', match: ['/chef/meal-plan'] },
  { to: '/chef/recipes', label: 'Recipes', match: ['/chef/recipes'] },
  { to: '/chef/shopping', label: 'Shopping', match: ['/chef/shopping'] },
  { to: '/chef/inventory', label: 'Inventory', match: ['/chef/inventory'] },
  { to: '/chef/settings', label: 'Settings', match: ['/chef/settings'] },
];

function isTabActive(tab: (typeof tabs)[number], pathname: string): boolean {
  // Dashboard tab matches exact /chef, /chef/home, /chef/macros
  if (tab.to === '/chef') {
    return pathname === '/chef' || pathname === '/chef/home' || pathname.startsWith('/chef/macros');
  }
  return pathname.startsWith(tab.to);
}

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isScanner = location.pathname === '/chef/scanner';

  return (
    <div className="chef-root">
      {/* Header */}
      <header className="chef-header" data-testid="chef-header">
        <Link to="/chef" className="chef-brand" onClick={() => setDrawerOpen(false)}>
          <span className="chef-brand-icon">🍳</span>
          <span className="chef-brand-text">ChefByte</span>
        </Link>
        <div className="chef-header-actions">
          <button
            className={`chef-scanner-btn ${isScanner ? 'active' : ''}`}
            onClick={() => navigate('/chef/scanner')}
            data-testid="scanner-btn"
          >
            📷 Scanner
          </button>
          <button
            className="chef-hamburger mobile-only"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            ☰
          </button>
        </div>
      </header>

      {/* Tab bar — hidden on scanner page */}
      {!isScanner && (
        <nav className="chef-tabs" data-testid="chef-tabs">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={`chef-tab ${isTabActive(tab, location.pathname) ? 'active' : ''}`}
            >
              {tab.label}
              {tab.to === '/chef/settings' && <SettingsDot />}
            </Link>
          ))}
        </nav>
      )}

      {/* Mobile drawer */}
      <div className={`chef-drawer ${drawerOpen ? 'open' : ''}`}>
        {drawerOpen && (
          <div className="chef-drawer-links">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={`chef-drawer-link ${isTabActive(tab, location.pathname) ? 'active' : ''}`}
                onClick={() => setDrawerOpen(false)}
              >
                {tab.label}
              </Link>
            ))}
            <button
              onClick={() => {
                setDrawerOpen(false);
                navigate('/hub/account');
              }}
              className="chef-drawer-link"
            >
              🏠 Hub
            </button>
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="chef-drawer-link danger"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="chef-content">{children}</div>
    </div>
  );
}

/* Notification dot — shows when Settings has pending items */
function SettingsDot() {
  // TODO: Task 3 will wire this to real data
  return null;
}
```

**Step 2: Replace CSS in chefbyte.css**

Remove the old nav-bar/nav-links/nav-brand/nav-burger/nav-drawer/nav-divider sections and replace with new header + tab bar styles. Keep all other sections (buttons, grids, scanner, recipes, settings tabs, responsive).

Replace the `.chef-root` base rule, the `box-sizing` rule, the `container` rule, and the entire **Navigation Bar** section with:

```css
/* Base */
.chef-root {
  --color-bg: #f7f7f9;
  --color-surface: #ffffff;
  --color-border: #e5e7eb;
  --color-text: #111827;
  --color-muted: #6b7280;
  --color-primary: #1e66f5;
  --color-success: #22c55e;
  --color-danger: #ef4444;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --content-max: 1200px;

  height: 100%;
  overflow-y: auto;
  background: var(--color-bg);
  font-family:
    'Inter',
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  color: var(--color-text);
  display: flex;
  flex-direction: column;
}

.chef-root *,
.chef-root *::before,
.chef-root *::after {
  box-sizing: border-box;
}

/* Header */
.chef-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-5);
  background: #fff;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.chef-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  text-decoration: none;
  color: var(--color-text);
  font-weight: 700;
  font-size: 22px;
}

.chef-brand-icon {
  font-size: 22px;
}

.chef-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.chef-scanner-btn {
  background: var(--color-primary);
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
}

.chef-scanner-btn:hover {
  filter: brightness(0.95);
}
.chef-scanner-btn.active {
  background: #0d4ecc;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
}

.chef-hamburger {
  display: none;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  font-size: 18px;
  color: #111;
}

/* Tab bar */
.chef-tabs {
  display: flex;
  gap: 0;
  background: #fff;
  border-bottom: 1px solid var(--color-border);
  padding: 0 var(--space-4);
  flex-shrink: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.chef-tab {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition:
    color 0.15s,
    border-color 0.15s;
  position: relative;
}

.chef-tab:hover {
  color: var(--color-text);
}

.chef-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

.chef-tab .settings-dot {
  width: 8px;
  height: 8px;
  background: var(--color-danger);
  border-radius: 50%;
  display: inline-block;
  margin-left: 4px;
  vertical-align: top;
}

/* Mobile drawer */
.chef-drawer {
  display: none;
  flex-direction: column;
  background: #fff;
  border-bottom: 1px solid var(--color-border);
  padding: 0 var(--space-4);
}

.chef-drawer.open {
  display: flex;
}

.chef-drawer-links {
  display: flex;
  flex-direction: column;
  padding: var(--space-2) 0;
}

.chef-drawer-link {
  display: block;
  padding: 10px var(--space-3);
  color: var(--color-text);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.chef-drawer-link:hover {
  background: #f3f4f6;
}
.chef-drawer-link.active {
  color: var(--color-primary);
  background: #eff6ff;
}
.chef-drawer-link.danger {
  color: var(--color-danger);
}

/* Content */
.chef-content {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-4);
  max-width: var(--content-max);
  width: 100%;
  margin: 0 auto;
}
```

Keep the `.chef-root .container` rule but it will be used less — `.chef-content` handles max-width and padding now.

Remove these old rules entirely:

- `.chef-root .nav-bar`
- `.chef-root .nav-brand`
- `.chef-root .nav-links`
- `.chef-root .nav-link`, `.chef-root .nav-link:hover`, `.chef-root .nav-link-active`
- `.chef-root .nav-divider`
- `.chef-root .nav-burger`
- `.chef-root .nav-drawer`

Update the responsive section:

```css
@media (max-width: 900px) {
  .chef-tabs {
    display: none;
  }
  .chef-hamburger {
    display: inline-flex;
  }
}
```

Remove the old `@media (max-width: 900px)` rules for `.nav-links`, `.nav-burger`, `.nav-bar`, `.nav-brand`, `.nav-drawer.open`. Keep the scanner-container and week-grid responsive rules.

**Step 3: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (ChefLayout interface unchanged — still accepts `title` + `children`)

**Step 4: Run tests**

Run: `pnpm --filter web test -- --run`
Expected: PASS (tests mock ChefLayout or test page content, not nav structure)

**Step 5: Visual verification**

Start dev server, navigate to `/chef/home`, verify:

- Header shows brand + Scanner button
- Tab bar shows 5 tabs + Settings
- Active tab highlights correctly
- Clicking Scanner button navigates to `/chef/scanner`
- Scanner page hides tab bar
- Content scrolls

**Step 6: Commit**

```bash
git add apps/web/src/components/chefbyte/ChefLayout.tsx apps/web/src/theme/chefbyte.css
git commit -m "feat(chefbyte): replace nav bar with header + tab bar layout

Scanner gets dedicated header button, 5 tabs below for main sections.
Tab bar hidden on Scanner page. Mobile shows hamburger drawer."
```

---

### Task 2: Remove Wrapper `<div className="container">` from Pages

The old ChefLayout wrapped children in `<div className="container">`. The new layout uses `.chef-content` which already has max-width + padding. Pages that have their own `<div className="container">` wrapper will now get double padding/max-width.

**Files:**

- Modify: All 10 ChefByte page files

**Step 1: Audit each page**

Check if pages add their own `<div className="container">` inside the `<ChefLayout>` wrapper. If they don't, no change needed — `chef-content` handles it.

Since the old `ChefLayout` had `<div className="container">{children}</div>`, and pages render inside that, most pages should be fine. The new `chef-content` replaces `container`.

**Step 2: Run typecheck + tests**

Run: `pnpm --filter web typecheck && pnpm --filter web test -- --run`
Expected: PASS

**Step 3: Commit if any changes**

---

### Task 3: Move Walmart into Settings as 4th Tab

**Files:**

- Modify: `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- Modify: `apps/web/src/modules/chefbyte/routes.tsx`

**Step 1: Add Walmart tab to SettingsPage**

In `SettingsPage.tsx`, change the Tab type and tabs array:

```tsx
type Tab = 'products' | 'walmart' | 'liquidtrack' | 'locations';

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'products', label: 'Products', icon: '📦' },
  { id: 'walmart', label: 'Walmart', icon: '🏪' },
  { id: 'liquidtrack', label: 'LiquidTrack', icon: '🥤' },
  { id: 'locations', label: 'Locations', icon: '📍' },
];
```

**Step 2: Extract Walmart content into SettingsPage**

Move the core rendering logic from `WalmartPage.tsx` into a `WalmartTab` component inside `SettingsPage.tsx`. The Walmart page's types, hooks, and render logic should be inlined as a new section in the settings page, rendered when `activeTab === 'walmart'`.

Keep the WalmartPage.tsx file but have it redirect to settings: `<Navigate to="/chef/settings?tab=walmart" replace />`.

Alternatively, since this is a big move and WalmartPage is ~500 lines, extract the Walmart content into a separate component file `apps/web/src/components/chefbyte/WalmartTab.tsx` and import it in SettingsPage.

**Step 3: Support `?tab=` query param in SettingsPage**

Add URL search param support so alert badges on Dashboard can deep-link to `/chef/settings?tab=walmart`:

```tsx
const [searchParams] = useSearchParams();
const initialTab = (searchParams.get('tab') as Tab) || 'products';
const [activeTab, setActiveTab] = useState<Tab>(tabs.some((t) => t.id === initialTab) ? initialTab : 'products');
```

Add `import { useSearchParams } from 'react-router-dom';`

**Step 4: Update routes**

In `routes.tsx`, keep the `/chef/walmart` route but redirect to settings:

```tsx
<Route path="walmart" element={<Navigate to="/chef/settings?tab=walmart" replace />} />
```

**Step 5: Run typecheck + tests**

Run: `pnpm --filter web typecheck && pnpm --filter web test -- --run`
Fix any test failures from Walmart page tests that expect standalone rendering.

**Step 6: Commit**

```bash
git commit -m "feat(chefbyte): move Walmart into Settings as 4th tab

/chef/walmart now redirects to /chef/settings?tab=walmart.
Settings supports ?tab= query param for deep linking."
```

---

### Task 4: Wire Settings Notification Dot

**Files:**

- Modify: `apps/web/src/components/chefbyte/ChefLayout.tsx`
- Create: `apps/web/src/hooks/useSettingsAlerts.ts`

**Step 1: Create the hook**

```tsx
// apps/web/src/hooks/useSettingsAlerts.ts
import { useEffect, useState } from 'react';
import { chefbyte } from '@/shared/supabase';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useSettingsAlerts() {
  const { user } = useAuth();
  const [hasAlerts, setHasAlerts] = useState(false);

  useEffect(() => {
    if (!user) return;

    async function check() {
      // Products missing walmart link (not marked as not-on-walmart)
      const { count: missingLinks } = await chefbyte
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .is('walmart_link', null)
        .eq('is_placeholder', false);

      // Products missing price
      const { count: missingPrices } = await chefbyte
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .is('price', null)
        .eq('is_placeholder', false);

      // Placeholder products
      const { count: placeholders } = await chefbyte
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .eq('is_placeholder', true);

      setHasAlerts((missingLinks ?? 0) > 0 || (missingPrices ?? 0) > 0 || (placeholders ?? 0) > 0);
    }

    check();
  }, [user]);

  return hasAlerts;
}
```

**Step 2: Wire into ChefLayout**

Replace the placeholder `SettingsDot` component:

```tsx
import { useSettingsAlerts } from '@/hooks/useSettingsAlerts';

function SettingsDot() {
  const hasAlerts = useSettingsAlerts();
  if (!hasAlerts) return null;
  return <span className="settings-dot" data-testid="settings-dot" />;
}
```

**Step 3: Run typecheck + tests**

Run: `pnpm --filter web typecheck && pnpm --filter web test -- --run`
Expected: PASS

**Step 4: Visual verification**

Navigate to `/chef/home`. Settings tab should show a red dot if demo account has any products missing prices/links or placeholders.

**Step 5: Commit**

```bash
git add apps/web/src/hooks/useSettingsAlerts.ts apps/web/src/components/chefbyte/ChefLayout.tsx
git commit -m "feat(chefbyte): add notification dot to Settings tab

Shows red dot when products have missing Walmart links, missing prices,
or are placeholders."
```

---

### Task 5: Update Routes — Dashboard Index + Macros Sub-page

**Files:**

- Modify: `apps/web/src/modules/chefbyte/routes.tsx`

**Step 1: Update route config**

```tsx
<Route index element={<Navigate to="/chef/home" replace />} />
```

This already redirects `/chef` to `/chef/home` which is correct — the Dashboard tab links to `/chef` but the actual content is at `/chef/home`. The `isTabActive` function in ChefLayout handles matching both paths to the Dashboard tab.

No changes needed here unless we want `/chef` to render HomePage directly instead of redirecting. Keep the redirect for now — it's simpler.

**Step 2: Verify macros sub-page**

Macros is already at `/chef/macros` and works as a sub-page. The Dashboard tab active state matches `/chef/macros` via the `isTabActive` function. The Macros page should add a back link to Dashboard — but that's page content, not routing.

**Step 3: Commit if any changes**

---

### Task 6: Delete ChefNav.tsx (Dead Code)

**Files:**

- Delete: `apps/web/src/components/chefbyte/ChefNav.tsx`

**Step 1: Check for imports**

```bash
grep -r "ChefNav" apps/web/src/
```

If no imports (it's already replaced by ChefLayout's nav), delete the file.

**Step 2: Commit**

```bash
git rm apps/web/src/components/chefbyte/ChefNav.tsx
git commit -m "chore: remove unused ChefNav component"
```

---

### Task 7: Update E2E Tests for New Nav Structure

**Files:**

- Modify: `apps/web/e2e/chefbyte/*.spec.ts` (any that reference old nav selectors)

**Step 1: Search for old nav selectors**

```bash
grep -rn 'chef-nav\|nav-bar\|nav-link\|nav-brand' apps/web/e2e/
```

**Step 2: Update selectors**

Replace references to old nav structure with new `data-testid` selectors:

- `[data-testid="chef-nav"]` -> `[data-testid="chef-header"]`
- `[data-testid="chef-tabs"]` for tab bar
- `[data-testid="scanner-btn"]` for Scanner button
- Navigation via tab clicks instead of nav-link clicks

**Step 3: Run E2E tests**

Run: `pnpm --filter web e2e` (or relevant E2E test command)
Fix any failures.

**Step 4: Commit**

```bash
git commit -m "test(chefbyte): update E2E selectors for new nav layout"
```

---

### Task 8: Update Docs

**Files:**

- Modify: `docs/apps/chefbyte.md` — update the "ChefByte UX" section to reflect new nav structure
- Modify: `docs/ascii-layouts.md` — update ChefByte layout diagrams to show header + tabs instead of side nav

**Step 1: Update chefbyte.md**

Replace the "Navigation" paragraph in the "ChefByte UX (Ionic)" section with:

```
**Navigation:** Header bar with brand and Scanner button (always visible, accent-colored).
Below the header, a tab bar with 5 tabs: Dashboard (default landing), Meal Plan, Recipes,
Shopping, Inventory, Settings. Scanner page hides the tab bar. Walmart is a sub-tab of
Settings. Settings tab shows a notification dot when products have missing prices, Walmart
links, or are placeholders. Mobile: hamburger menu replaces tab bar. Macros is a sub-page
of Dashboard (click macro summary to drill in).
```

**Step 2: Commit**

```bash
git commit -m "docs: update ChefByte nav docs for tab-based layout"
```

---

## Task Order & Dependencies

```
Task 1 (ChefLayout + CSS) ──→ Task 2 (container cleanup)
                           ──→ Task 3 (Walmart → Settings)
                           ──→ Task 4 (notification dot)
                           ──→ Task 5 (routes)
                           ──→ Task 6 (delete ChefNav)
Task 1-6 ──→ Task 7 (E2E tests)
Task 1-7 ──→ Task 8 (docs)
```

Tasks 2-6 can run in parallel after Task 1 completes. Task 7 depends on all UI changes. Task 8 is last.
