# Hub App Launcher + Split Login Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the settings-first Hub landing with an app launcher home page, and redesign the login page as a split hero+form layout.

**Architecture:** Two independent UI changes. (1) New `HubHomePage` component at `/hub` index route — full-viewport app launcher cards for CoachByte/ChefByte with a settings link. Settings sub-pages (`/hub/account`, `/hub/apps`, etc.) keep their existing sidebar layout unchanged. (2) Login page becomes a two-column split layout — hero/branding on the left, login form on the right. Mobile stacks vertically. No DB, API, or auth changes.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4, Lucide React icons, React Router 6

---

## Context for the Implementer

### Key files you'll touch

- `apps/web/src/pages/hub/HubHomePage.tsx` (CREATE) — app launcher
- `apps/web/src/modules/hub/routes.tsx` — change index route from redirect-to-account to HubHomePage
- `apps/web/src/pages/Login.tsx` — split layout rewrite
- `apps/web/src/components/hub/HubLayout.tsx` — add "back to launcher" link in header for settings pages
- `apps/web/e2e/hub/auth.spec.ts` — update E2E expectations for new hub landing

### Patterns to follow

- **Tailwind classes** — all styling is utility-first Tailwind. No CSS modules, no styled-components. See any page in `apps/web/src/pages/` for examples.
- **Lucide icons** — `import { IconName } from 'lucide-react'`. Use `className="h-N w-N"` for sizing.
- **useAppContext()** — from `@/shared/AppProvider`. Returns `{ activations, activationsLoading }`. `activations` is `Record<string, boolean>` keyed by app name (`'coachbyte'`, `'chefbyte'`).
- **useNavigate()** — from `react-router-dom`. Use for programmatic navigation.
- **Component library** — `@/components/ui/Card`, `@/components/ui/Button`, `@/components/ui/Input`, `@/components/ui/Alert`, `@/components/ui/Skeleton`.
- **Test runner** — `pnpm --filter web test -- --run` for unit/integration tests. `pnpm --filter web exec tsc --noEmit` for type-check.
- **Commit style** — `feat(scope): description` or `refactor(scope): description`.

### App metadata

Each app needs: name, display name, description, icon, route, color theme.

- **CoachByte** — Fitness tracking. Icon: `Dumbbell`. Route: `/coach`. Color: blue.
- **ChefByte** — Nutrition & meal planning. Icon: `ChefHat`. Route: `/chef`. Color: emerald/green.

---

### Task 1: Create HubHomePage — App Launcher

**Files:**

- Create: `apps/web/src/pages/hub/HubHomePage.tsx`
- Create: `apps/web/src/__tests__/unit/hub/HubHomePage.test.tsx`

**Step 1: Write the test file**

Create `apps/web/src/__tests__/unit/hub/HubHomePage.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HubHomePage } from '@/pages/hub/HubHomePage';

// Mock AppProvider — return both apps active by default
const mockAppContext = {
  activations: { coachbyte: true, chefbyte: true } as Record<string, boolean>,
  activationsLoading: false,
  online: true,
  lastSynced: null as Date | null,
  dayStartHour: 6,
  refreshActivations: vi.fn(),
};
vi.mock('@/shared/AppProvider', () => ({
  useAppContext: () => mockAppContext,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <HubHomePage />
    </MemoryRouter>,
  );
}

describe('HubHomePage', () => {
  it('renders app launcher cards for active apps', () => {
    renderPage();
    expect(screen.getByTestId('app-card-coachbyte')).toBeInTheDocument();
    expect(screen.getByTestId('app-card-chefbyte')).toBeInTheDocument();
  });

  it('shows app names and descriptions', () => {
    renderPage();
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.getByText('ChefByte')).toBeInTheDocument();
  });

  it('renders navigation links to app routes', () => {
    renderPage();
    const coachLink = screen.getByTestId('app-card-coachbyte').closest('a');
    const chefLink = screen.getByTestId('app-card-chefbyte').closest('a');
    expect(coachLink).toHaveAttribute('href', '/coach');
    expect(chefLink).toHaveAttribute('href', '/chef');
  });

  it('hides inactive apps', () => {
    mockAppContext.activations = { coachbyte: true, chefbyte: false };
    renderPage();
    expect(screen.getByTestId('app-card-coachbyte')).toBeInTheDocument();
    expect(screen.queryByTestId('app-card-chefbyte')).not.toBeInTheDocument();
    // Reset
    mockAppContext.activations = { coachbyte: true, chefbyte: true };
  });

  it('shows empty state when no apps are active', () => {
    mockAppContext.activations = {};
    renderPage();
    expect(screen.getByTestId('no-active-apps')).toBeInTheDocument();
    // Reset
    mockAppContext.activations = { coachbyte: true, chefbyte: true };
  });

  it('shows settings link', () => {
    renderPage();
    const settingsLink = screen.getByTestId('hub-settings-link');
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink.closest('a')).toHaveAttribute('href', '/hub/account');
  });

  it('shows skeleton cards when activations are loading', () => {
    mockAppContext.activationsLoading = true;
    renderPage();
    expect(screen.getByTestId('launcher-loading')).toBeInTheDocument();
    // Reset
    mockAppContext.activationsLoading = false;
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- --run src/__tests__/unit/hub/HubHomePage.test.tsx`
Expected: FAIL — module not found

**Step 3: Implement HubHomePage**

Create `apps/web/src/pages/hub/HubHomePage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useAppContext } from '@/shared/AppProvider';
import { Dumbbell, ChefHat, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface AppDef {
  name: string;
  displayName: string;
  description: string;
  icon: LucideIcon;
  route: string;
  color: string; // Tailwind bg class
  hoverColor: string; // Tailwind hover:bg class
  iconBg: string; // Tailwind bg class for icon circle
}

const APPS: AppDef[] = [
  {
    name: 'coachbyte',
    displayName: 'CoachByte',
    description: 'Workout plans, set tracking, PRs & rest timer',
    icon: Dumbbell,
    route: '/coach',
    color: 'bg-blue-600',
    hoverColor: 'hover:bg-blue-700',
    iconBg: 'bg-blue-500/20',
  },
  {
    name: 'chefbyte',
    displayName: 'ChefByte',
    description: 'Inventory, recipes, meal plans & macro tracking',
    icon: ChefHat,
    route: '/chef',
    color: 'bg-emerald-600',
    hoverColor: 'hover:bg-emerald-700',
    iconBg: 'bg-emerald-500/20',
  },
];

export function HubHomePage() {
  const { activations, activationsLoading } = useAppContext();

  const activeApps = APPS.filter((app) => activations[app.name]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="flex justify-between items-center h-14 px-6 border-b border-slate-200 bg-white">
        <h1 className="text-lg font-semibold text-slate-900">Luna Hub</h1>
        <Link
          to="/hub/account"
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          data-testid="hub-settings-link"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </header>

      {/* Main content — centered launcher */}
      <main className="flex-1 flex items-center justify-center px-6 py-12">
        {activationsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl" data-testid="launcher-loading">
            <div className="h-48 rounded-2xl bg-slate-200 animate-pulse" />
            <div className="h-48 rounded-2xl bg-slate-200 animate-pulse" />
          </div>
        ) : activeApps.length === 0 ? (
          <div className="text-center" data-testid="no-active-apps">
            <p className="text-slate-500 text-lg mb-4">No apps activated yet.</p>
            <Link to="/hub/apps" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">
              Activate an app to get started
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl">
            {activeApps.map((app) => {
              const Icon = app.icon;
              return (
                <Link
                  key={app.name}
                  to={app.route}
                  className={`${app.color} ${app.hoverColor} rounded-2xl p-8 text-white transition-all duration-200 hover:scale-[1.02] hover:shadow-lg group no-underline`}
                  data-testid={`app-card-${app.name}`}
                >
                  <div className={`inline-flex items-center justify-center w-14 h-14 rounded-xl ${app.iconBg} mb-4`}>
                    <Icon className="h-7 w-7 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">{app.displayName}</h2>
                  <p className="text-white/80 text-sm leading-relaxed">{app.description}</p>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- --run src/__tests__/unit/hub/HubHomePage.test.tsx`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add apps/web/src/pages/hub/HubHomePage.tsx apps/web/src/__tests__/unit/hub/HubHomePage.test.tsx
git commit -m "feat(hub): add app launcher home page component"
```

---

### Task 2: Wire HubHomePage into Routes

**Files:**

- Modify: `apps/web/src/modules/hub/routes.tsx`

**Step 1: Update routes**

Change the index route from `<Navigate to="/hub/account" replace />` to render `<HubHomePage />`. The HubHomePage has its own layout (no sidebar), so it does NOT use `HubLayout`.

```tsx
// Add import at top:
import { HubHomePage } from '@/pages/hub/HubHomePage';

// Change index route:
<Route index element={<HubHomePage />} />;
```

**Step 2: Run full test suite**

Run: `pnpm --filter web test -- --run`
Expected: All tests pass. The HubHomePage renders at `/hub` now.

Run: `pnpm --filter web exec tsc --noEmit`
Expected: Clean

**Step 3: Commit**

```bash
git add apps/web/src/modules/hub/routes.tsx
git commit -m "feat(hub): wire launcher as hub index route"
```

---

### Task 3: Add Back-to-Hub Link in HubLayout Header

**Files:**

- Modify: `apps/web/src/components/hub/HubHeader.tsx`

**Step 1: Add a Home/back link**

When the user navigates into settings sub-pages (`/hub/account`, `/hub/tools`, etc.), they need a way back to the launcher. Add a "Luna Hub" link or home icon in the HubHeader that navigates to `/hub`.

In `apps/web/src/components/hub/HubHeader.tsx`, change the `<h1>` title to be a link back to `/hub`:

```tsx
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// Replace the static <h1>:
<div className="flex items-center gap-2">
  <Link to="/hub" className="text-slate-400 hover:text-slate-600 transition-colors" aria-label="Back to Hub">
    <ArrowLeft className="h-5 w-5" />
  </Link>
  <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
</div>;
```

**Step 2: Run type check and tests**

Run: `pnpm --filter web exec tsc --noEmit`
Run: `pnpm --filter web test -- --run`
Expected: All pass

**Step 3: Commit**

```bash
git add apps/web/src/components/hub/HubHeader.tsx
git commit -m "feat(hub): add back-to-launcher arrow in settings header"
```

---

### Task 4: Redesign Login Page — Split Layout

**Files:**

- Modify: `apps/web/src/pages/Login.tsx`

**Step 1: Rewrite Login.tsx to split layout**

The current login is a single centered card. Replace with a two-column layout:

- **Left column (hero):** Gradient background, Luna Hub branding, tagline, feature highlights with icons, prominent demo CTA.
- **Right column (form):** The existing login form (email, password, sign in, forgot password, sign up link).
- **Mobile:** Hero stacks above form, condensed (shorter hero, no feature list).

Preserve ALL existing functionality — form submission, demo login, forgot password view state, redirect logic, error handling. Do not change any business logic. Only change the layout/styling.

Replace the entire return JSX in `Login.tsx` with:

```tsx
return (
  <div className="min-h-screen flex flex-col md:flex-row">
    {/* Hero panel */}
    <div className="md:w-1/2 bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 text-white flex flex-col justify-center px-8 py-12 md:px-16 md:py-0">
      <div className="max-w-md mx-auto md:mx-0">
        <h1 className="text-4xl md:text-5xl font-extrabold mb-3 tracking-tight">Luna Hub</h1>
        <p className="text-lg text-slate-300 mb-8">Fitness. Nutrition. All in one place.</p>

        <div className="hidden md:flex flex-col gap-4 mb-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
              <Dumbbell className="h-5 w-5 text-blue-300" />
            </div>
            <div>
              <p className="font-semibold text-sm">CoachByte</p>
              <p className="text-xs text-slate-400">Workout plans, set tracking & PRs</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
              <ChefHat className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <p className="font-semibold text-sm">ChefByte</p>
              <p className="text-xs text-slate-400">Inventory, recipes & macro tracking</p>
            </div>
          </div>
        </div>

        {/* Mobile-only condensed tagline (no feature list) */}
        <div className="flex md:hidden gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <Dumbbell className="h-4 w-4 text-blue-300" />
          </div>
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
            <ChefHat className="h-4 w-4 text-emerald-300" />
          </div>
        </div>

        <div className="hidden md:block">
          <p className="text-xs text-slate-400 mb-2">Try with sample data — no signup needed</p>
          <Button
            variant="secondary"
            className="!bg-white/10 !border-white/20 !text-white hover:!bg-white/20 font-semibold"
            onClick={handleDemo}
            disabled={loading || demoLoading}
            loading={demoLoading}
          >
            Try Demo Account
          </Button>
        </div>
      </div>
    </div>

    {/* Form panel */}
    <div className="md:w-1/2 flex items-center justify-center px-6 py-12 md:py-0 bg-white">
      <div className="w-full max-w-sm">
        {view === 'login' ? (
          <>
            <h2 className="text-2xl font-bold text-slate-900 mb-1">Welcome back</h2>
            <p className="text-sm text-slate-500 mb-6">Sign in to your account</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <Alert variant="error">{error}</Alert>}
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Button type="submit" loading={loading} disabled={loading || demoLoading} className="w-full">
                Sign In
              </Button>
            </form>

            <div className="text-right mt-2">
              <button
                type="button"
                className="text-sm text-blue-600 hover:text-blue-700 hover:underline bg-transparent border-none cursor-pointer p-0"
                onClick={() => {
                  setView('reset');
                  setError(null);
                  setForgotMessage(null);
                }}
                data-testid="forgot-password-link"
              >
                Forgot password?
              </button>
            </div>

            {/* Mobile demo button (hero has it on desktop) */}
            <div className="md:hidden mt-6">
              <div className="flex items-center gap-3 mb-3">
                <hr className="flex-1 border-slate-200" />
                <span className="text-sm text-slate-500">or</span>
                <hr className="flex-1 border-slate-200" />
              </div>
              <p className="text-xs text-slate-500 mb-2 text-center">Try with sample data — no signup needed</p>
              <Button
                variant="secondary"
                className="w-full !bg-emerald-50 !border-emerald-300 !text-emerald-700 hover:!bg-emerald-100 font-semibold"
                onClick={handleDemo}
                disabled={loading || demoLoading}
                loading={demoLoading}
              >
                Try Demo Account
              </Button>
            </div>

            {/* Desktop separator + demo is in hero, so just show signup link */}
            <div className="hidden md:block">
              <div className="flex items-center gap-3 my-4">
                <hr className="flex-1 border-slate-200" />
                <span className="text-sm text-slate-500">or</span>
                <hr className="flex-1 border-slate-200" />
              </div>
            </div>

            <p className="text-center text-sm text-slate-600 mt-4">
              Don&apos;t have an account?{' '}
              <Link to="/signup" className="text-blue-600 hover:text-blue-700 hover:underline font-medium">
                Sign up
              </Link>
            </p>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Reset Password</h2>
            <form onSubmit={handleForgotPassword} data-testid="forgot-password-form" className="space-y-3">
              {error && <Alert variant="error">{error}</Alert>}
              {forgotMessage && (
                <Alert variant="success" data-testid="forgot-password-success">
                  {forgotMessage}
                </Alert>
              )}
              <Input
                label="Email"
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                autoComplete="email"
                required
                data-testid="forgot-email-input"
              />
              <Button type="submit" loading={forgotLoading} className="w-full" data-testid="send-reset-link-button">
                Send Reset Link
              </Button>
            </form>
            <div className="text-center mt-4">
              <button
                type="button"
                className="text-sm text-blue-600 hover:text-blue-700 hover:underline bg-transparent border-none cursor-pointer p-0"
                onClick={() => {
                  setView('login');
                  setError(null);
                  setForgotMessage(null);
                }}
                data-testid="back-to-login-link"
              >
                &larr; Back to login
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  </div>
);
```

You'll need to add these imports at the top of Login.tsx:

```tsx
import { Dumbbell, ChefHat } from 'lucide-react';
```

**Step 2: Run type check and tests**

Run: `pnpm --filter web exec tsc --noEmit`
Run: `pnpm --filter web test -- --run`
Expected: All pass

**Step 3: Commit**

```bash
git add apps/web/src/pages/Login.tsx
git commit -m "refactor(ui): split login page — hero panel + form panel"
```

---

### Task 5: Update E2E Tests for New Hub Landing

**Files:**

- Modify: `apps/web/e2e/hub/auth.spec.ts`

**Step 1: Update expectations**

The key E2E changes:

1. **Demo login test (line 159-167):** Currently expects `Display Name` input at `/hub`. Now `/hub` is the launcher, not AccountPage. Change to verify the launcher rendered instead:

   ```ts
   // OLD: await expect(page.getByLabel('Display Name')).toHaveValue('Demo User', { timeout: 30000 });
   // NEW: verify launcher is visible
   await expect(page.getByTestId('app-card-coachbyte').or(page.getByTestId('app-card-chefbyte'))).toBeVisible({
     timeout: 30000,
   });
   ```

2. **Logout test (line 106-123):** Currently clicks `button { name: /logout/i }` which is in HubHeader. The launcher has its own header without a logout button — it has a Settings link instead. After login, navigate to `/hub/account` to find the logout button, OR update the launcher header to include logout. Simplest fix: the launcher header should include a logout button. Add it in the `HubHomePage` header. Alternatively, update the E2E test to navigate to settings first.

   **Decision:** Add a logout button to the HubHomePage header (next to Settings link). This is good UX anyway — users should be able to log out from any page.

3. **Post-login redirect check (lines 35, 114, etc.):** These check `toHaveURL(/\/hub/)` which still works since `/hub` renders the launcher now.

4. **"Forgot password" toggle test (line 247-265):** Line 263 clicks `forgotBtn` again to hide the form, but `forgot-password-link` only exists in login view. After clicking it once, the view switches to reset and the element disappears. The `back-to-login-link` should be used instead. Fix this test.

**Step 2: Apply changes to `auth.spec.ts`**

For the demo login test, change the assertion after redirect:

```ts
// Replace the Display Name check with launcher visibility
await expect(page.getByTestId('hub-settings-link')).toBeVisible({ timeout: 30000 });
```

For the logout tests, after login navigates to `/hub`, navigate to `/hub/account` first to find the logout button, or add logout to launcher. **Preferred: add Logout to HubHomePage header.**

For the forgot password test, fix the second click:

```ts
// After clicking forgot-password-link, the view switches to reset.
// Click back-to-login-link to go back, then verify login form is visible again.
const backBtn = page.getByTestId('back-to-login-link');
await backBtn.click();
await expect(page.getByTestId('forgot-password-form')).not.toBeVisible();
```

**Step 3: Run E2E tests (if available) or type check**

Run: `pnpm --filter web exec tsc --noEmit`

**Step 4: Commit**

```bash
git add apps/web/e2e/hub/auth.spec.ts apps/web/src/pages/hub/HubHomePage.tsx
git commit -m "fix(e2e): update auth tests for hub launcher landing"
```

---

### Task 6: Visual Polish Pass

**Files:**

- Modify: `apps/web/src/pages/hub/HubHomePage.tsx` (if needed)
- Modify: `apps/web/src/pages/Login.tsx` (if needed)

**Step 1: Start dev server and visually verify**

Run: `pnpm --filter web dev`

Check these pages in the browser:

1. `/login` — verify split layout, hero on left, form on right, mobile stack
2. `/login` — click "Forgot password?" → verify reset form appears, "Back to login" works
3. `/login` — click "Try Demo Account" → verify redirect to `/hub`
4. `/hub` — verify launcher cards for active apps, Settings link, Logout button
5. `/hub/account` — verify back arrow to launcher, sidebar layout unchanged
6. Resize browser to mobile width — verify responsive behavior

**Step 2: Fix any visual issues found**

Adjust spacing, colors, font sizes as needed. Ensure:

- Cards have adequate padding and are readable
- Hero gradient looks good (not too dark, text is readable)
- Mobile layout doesn't have overflow issues
- Settings link and logout button are accessible

**Step 3: Run full test suite**

Run: `pnpm --filter web test -- --run`
Run: `pnpm --filter web exec tsc --noEmit`
Expected: All pass, clean types

**Step 4: Commit (if changes made)**

```bash
git add -u
git commit -m "refactor(ui): visual polish for launcher and login"
```

---

## E2E Test Impact Summary

| Test                                             | Impact                          | Fix                                |
| ------------------------------------------------ | ------------------------------- | ---------------------------------- |
| `login with valid credentials redirects to /hub` | URL check still works           | None                               |
| `logout redirects to /login`                     | Needs logout button on launcher | Add to HubHomePage header          |
| `demo login redirects to /hub with demo data`    | Display Name assertion breaks   | Assert launcher visibility instead |
| `forgot password link toggles reset form inline` | Second click on wrong element   | Use back-to-login-link             |
| All other auth tests                             | URL checks `/hub` still valid   | None                               |

## Test Count Impact

- +6 new unit tests (HubHomePage)
- 0 deleted tests
- ~3 E2E tests modified (not deleted)
