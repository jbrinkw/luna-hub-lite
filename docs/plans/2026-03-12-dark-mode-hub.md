# Material Dark Mode — Hub Pages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Material Design-inspired dark mode to the app infrastructure and all Hub module pages, using CSS custom properties that swap on a `.dark` class.

**Architecture:** Expand the existing `@theme` tokens in `index.css` into a comprehensive semantic token system (surfaces, text, borders, status colors). Add a `.dark` selector that overrides every token with Material Dark values (dark gray surfaces, white text at varying opacity, desaturated accents). Create a `ThemeProvider` context that detects system preference, persists user choice to localStorage, and exposes a toggle. Migrate all shared UI components and Hub-specific components/pages from hardcoded Tailwind classes (`bg-white`, `text-slate-900`, etc.) to semantic token classes (`bg-surface`, `text-text`, `border-border`).

**Tech Stack:** React 18, Tailwind CSS v4 (`@theme` + CSS custom properties), localStorage

**Material Dark Design Tokens:**

- Base surface: `#121212` (Material baseline dark)
- Elevated surfaces: progressively lighter grays (`#1e1e1e`, `#2d2d2d`, `#383838`)
- Text: `rgba(255,255,255,0.87)` high emphasis, `rgba(255,255,255,0.60)` medium, `rgba(255,255,255,0.38)` disabled
- Primary accent: lighter blue (`#60a5fa` / blue-400) instead of `#2563eb`
- Borders: `rgba(255,255,255,0.12)` (Material divider spec)
- Status colors: lighter variants (emerald-400, amber-400, red-400) for readability on dark

---

## Chunk 1: Infrastructure + ThemeProvider

### Task 1: Expand CSS token system + dark overrides

**Files:**

- Modify: `apps/web/src/index.css`

This is the foundation. We define a comprehensive semantic token palette in `@theme`, then override every token under a `.dark` selector. Tailwind v4 generates utility classes from `@theme` values (e.g., `--color-surface` → `bg-surface`), and those utilities read the CSS custom property at runtime, so overriding the variable under `.dark` changes the rendered color with zero JS.

- [ ] **Step 1: Replace the existing `@theme` block and body styles with the expanded token system**

```css
@import 'tailwindcss';

@theme {
  --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* ── Surfaces ── */
  --color-surface: #ffffff;
  --color-surface-raised: #ffffff;
  --color-surface-overlay: #ffffff;
  --color-surface-sunken: #f8fafc;
  --color-surface-hover: #f1f5f9;

  /* ── Text ── */
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
  --color-text-tertiary: #94a3b8;
  --color-text-disabled: #cbd5e1;
  --color-text-inverse: #ffffff;

  /* ── Borders ── */
  --color-border: #e2e8f0;
  --color-border-light: #f1f5f9;
  --color-border-strong: #cbd5e1;

  /* ── Primary ── */
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-text: #ffffff;
  --color-primary-subtle: #eff6ff;

  /* ── Status ── */
  --color-success: #059669;
  --color-success-hover: #047857;
  --color-success-subtle: #ecfdf5;
  --color-success-text: #065f46;
  --color-warning: #f59e0b;
  --color-warning-subtle: #fffbeb;
  --color-warning-text: #92400e;
  --color-danger: #dc2626;
  --color-danger-hover: #b91c1c;
  --color-danger-subtle: #fef2f2;
  --color-danger-text: #991b1b;
  --color-info-subtle: #eff6ff;
  --color-info-text: #1e40af;

  /* ── Module Accents ── */
  --color-hub-accent: #2563eb;
  --color-coach-accent: #7c3aed;
  --color-chef-accent: #059669;

  /* ── Focus ring ── */
  --color-focus-ring: rgb(37 99 235 / 0.4);

  /* ── Skeleton ── */
  --color-skeleton: #e2e8f0;
  --color-skeleton-highlight: #cbd5e1;

  /* ── Backdrop ── */
  --color-backdrop: rgb(0 0 0 / 0.5);

  /* ── Code ── */
  --color-code-bg: #f1f5f9;
  --color-code-text: #1e293b;

  /* ── Animations ── */
  --animate-fade-in: fade-in 0.3s ease-out;
  --animate-modal-backdrop: modal-backdrop 150ms ease-out;
  --animate-modal-card: modal-card 150ms ease-out;
}

/* ── Material Dark Overrides ── */
.dark {
  --color-surface: #1e1e1e;
  --color-surface-raised: #2d2d2d;
  --color-surface-overlay: #383838;
  --color-surface-sunken: #121212;
  --color-surface-hover: #383838;

  --color-text: rgba(255, 255, 255, 0.87);
  --color-text-secondary: rgba(255, 255, 255, 0.6);
  --color-text-tertiary: rgba(255, 255, 255, 0.38);
  --color-text-disabled: rgba(255, 255, 255, 0.25);
  --color-text-inverse: #0f172a;

  --color-border: rgba(255, 255, 255, 0.12);
  --color-border-light: rgba(255, 255, 255, 0.06);
  --color-border-strong: rgba(255, 255, 255, 0.2);

  --color-primary: #60a5fa;
  --color-primary-hover: #93c5fd;
  --color-primary-text: #0f172a;
  --color-primary-subtle: rgba(96, 165, 250, 0.12);

  --color-success: #34d399;
  --color-success-hover: #6ee7b7;
  --color-success-subtle: rgba(52, 211, 153, 0.12);
  --color-success-text: #34d399;
  --color-warning: #fbbf24;
  --color-warning-subtle: rgba(251, 191, 36, 0.12);
  --color-warning-text: #fbbf24;
  --color-danger: #f87171;
  --color-danger-hover: #fca5a5;
  --color-danger-subtle: rgba(248, 113, 113, 0.12);
  --color-danger-text: #f87171;
  --color-info-subtle: rgba(96, 165, 250, 0.12);
  --color-info-text: #60a5fa;

  --color-hub-accent: #60a5fa;
  --color-coach-accent: #a78bfa;
  --color-chef-accent: #34d399;

  --color-focus-ring: rgb(96 165 250 / 0.4);

  --color-skeleton: #383838;
  --color-skeleton-highlight: #4a4a4a;

  --color-backdrop: rgb(0 0 0 / 0.7);

  --color-code-bg: #2d2d2d;
  --color-code-text: rgba(255, 255, 255, 0.87);

  color-scheme: dark;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes modal-backdrop {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes modal-card {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

body {
  font-family: var(--font-sans);
  background-color: var(--color-surface-sunken);
  color: var(--color-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

- [ ] **Step 2: Verify the dev server still renders correctly in light mode**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter web dev`
Expected: App renders with same light appearance (body bg now uses `--color-surface-sunken` which is `#f8fafc` = slate-50)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/index.css
git commit -m "feat: expand CSS token system with Material Dark overrides"
```

---

### Task 2: Create ThemeProvider context

**Files:**

- Create: `apps/web/src/shared/ThemeProvider.tsx`

The ThemeProvider handles three concerns: (1) detect system `prefers-color-scheme` on first load, (2) persist user's explicit choice to `localStorage`, (3) toggle `.dark` class on `<html>`. It uses `useSyncExternalStore` pattern for the media query listener to stay React 18-idiomatic.

- [ ] **Step 1: Create ThemeProvider**

```tsx
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** Resolved theme (never 'system') */
  theme: 'light' | 'dark';
  /** User preference (may be 'system') */
  preference: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'luna-theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'system';
}

function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export type { Theme };

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme>(getStoredPreference);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);

  const resolved = preference === 'system' ? systemTheme : preference;

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Apply .dark class whenever resolved theme changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    setPreference(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // localStorage unavailable
    }
  }, []);

  return <ThemeContext.Provider value={{ theme: resolved, preference, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

- [ ] **Step 2: Add FOUC prevention script to `apps/web/index.html`**

Add a blocking inline script in `<head>` (after the font style block, before `<title>`) that applies `.dark` before first paint:

```html
<script>
  (function () {
    var t = localStorage.getItem('luna-theme');
    if (t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  })();
</script>
```

This prevents the white flash that would otherwise occur because `useEffect` runs after first paint.

- [ ] **Step 3: Wire ThemeProvider into the app root**

Modify: `apps/web/src/App.tsx`

Import `ThemeProvider` from `@/shared/ThemeProvider`. Wrap it around the `<QueryClientProvider>` — it must be the outermost provider so all components can access theme state:

```tsx
import { ThemeProvider } from './shared/ThemeProvider';

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>{/* ... existing tree unchanged ... */}</QueryClientProvider>
    </ThemeProvider>
  );
}
```

Also migrate the `PageSpinner` and 404 page in the same file:

PageSpinner:

```
border-slate-200 → border-border-strong
border-t-blue-600 → border-t-primary
```

404 page: Replace inline `style` attributes with Tailwind classes:

```tsx
<div className="p-8 text-center">
  <h2>Page not found</h2>
  <p>The page you requested does not exist.</p>
  <a href="/hub" className="text-primary hover:text-primary-hover hover:underline">
    Go to Hub
  </a>
</div>
```

- [ ] **Step 4: Verify dev server boots with ThemeProvider active**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter web dev`
Expected: App loads normally. No `.dark` class on `<html>` if system is light mode. If system is dark mode, `.dark` class is present. No white flash on load.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shared/ThemeProvider.tsx apps/web/src/App.tsx apps/web/index.html
git commit -m "feat: add ThemeProvider with system detection, localStorage persistence, and FOUC prevention"
```

---

### Task 3: Create ThemeToggle component

**Files:**

- Create: `apps/web/src/components/ui/ThemeToggle.tsx`

A simple 3-state toggle button: Light / System / Dark. Uses icons from lucide-react. Compact enough to fit in headers.

- [ ] **Step 1: Create ThemeToggle component**

```tsx
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/shared/ThemeProvider';
import type { Theme } from '@/shared/ThemeProvider';

const options: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

export function ThemeToggle() {
  const { preference, setTheme } = useTheme();

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5 gap-0.5">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-label={`${label} theme`}
          aria-pressed={preference === value}
          className={[
            'inline-flex items-center justify-center rounded-md p-1.5 transition-colors',
            preference === value ? 'bg-surface-hover text-text' : 'text-text-tertiary hover:text-text-secondary',
          ].join(' ')}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
```

Note: The `Theme` type must be exported from `ThemeProvider.tsx`. Add `export` to the `type Theme = 'light' | 'dark' | 'system'` line.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/ThemeToggle.tsx apps/web/src/shared/ThemeProvider.tsx
git commit -m "feat: add ThemeToggle component (light/system/dark)"
```

---

## Chunk 2: Shared UI Components Migration

Migrate all shared UI components from hardcoded Tailwind classes to semantic tokens. After this chunk, every shared component renders correctly in both light and dark mode. Each component is a small, self-contained change.

**Token mapping reference** (use for all tasks in this chunk):

| Light class              | Token class                     | Purpose                        |
| ------------------------ | ------------------------------- | ------------------------------ |
| `bg-white`               | `bg-surface`                    | Card/panel backgrounds         |
| `bg-slate-50`            | `bg-surface-sunken`             | Page backgrounds, sunken areas |
| `bg-slate-100`           | `bg-surface-hover`              | Hover states, active tabs      |
| `bg-slate-200`           | `bg-skeleton`                   | Skeleton loading               |
| `border-slate-200`       | `border-border`                 | Default borders                |
| `border-slate-100`       | `border-border-light`           | Light dividers                 |
| `border-slate-300`       | `border-border-strong`          | Input borders                  |
| `text-slate-900`         | `text-text`                     | Primary text                   |
| `text-slate-700`         | `text-text` (or keep)           | High-emphasis text             |
| `text-slate-600`         | `text-text-secondary`           | Secondary text                 |
| `text-slate-500`         | `text-text-secondary`           | Secondary text                 |
| `text-slate-400`         | `text-text-tertiary`            | Tertiary/icon text             |
| `text-slate-300`         | `text-text-disabled`            | Disabled text                  |
| `hover:bg-slate-50`      | `hover:bg-surface-hover`        | Hover backgrounds              |
| `hover:bg-slate-100`     | `hover:bg-surface-hover`        | Hover backgrounds              |
| `bg-blue-600`            | `bg-primary`                    | Primary buttons                |
| `hover:bg-blue-700`      | `hover:bg-primary-hover`        | Primary button hover           |
| `text-blue-600`          | `text-primary`                  | Primary links                  |
| `bg-blue-50`             | `bg-primary-subtle`             | Primary subtle bg              |
| `focus:ring-blue-500/40` | `focus-visible:ring-focus-ring` | Focus rings                    |
| `bg-emerald-50`          | `bg-success-subtle`             | Success backgrounds            |
| `text-emerald-700/800`   | `text-success-text`             | Success text                   |
| `border-emerald-500`     | `border-success`                | Success borders                |
| `bg-amber-50`            | `bg-warning-subtle`             | Warning backgrounds            |
| `text-amber-700/800`     | `text-warning-text`             | Warning text                   |
| `border-amber-500`       | `border-warning`                | Warning borders                |
| `bg-red-50`              | `bg-danger-subtle`              | Danger backgrounds             |
| `text-red-600/800`       | `text-danger-text`              | Danger text                    |
| `border-red-500`         | `border-danger`                 | Danger borders                 |
| `bg-blue-50`             | `bg-info-subtle`                | Info backgrounds               |
| `text-blue-700/800`      | `text-info-text`                | Info text                      |

**Important:** Some classes must stay hardcoded — specifically the colored app cards on HubHomePage (`bg-blue-600`, `bg-emerald-600`) which are intentionally vibrant and don't change between themes. The Login hero gradient also stays hardcoded. Module accent colors in non-Hub layouts (CoachByte violet, ChefByte emerald) are out of scope.

---

### Task 4: Migrate Card component

**Files:**

- Modify: `apps/web/src/components/ui/Card.tsx`

- [ ] **Step 1: Replace hardcoded classes with token classes**

```
Card:       bg-white → bg-surface,  border-slate-200 → border-border
CardHeader: border-slate-200 → border-border
CardTitle:  text-slate-900 → text-text
CardFooter: border-slate-200 → border-border,  bg-slate-50 → bg-surface-sunken
```

Full updated file:

```tsx
import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className, ...rest }: CardProps) {
  return (
    <div
      className={['bg-surface border border-border rounded-xl overflow-hidden', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardHeader({ children, className, ...rest }: CardHeaderProps) {
  return (
    <div className={['px-5 py-4 border-b border-border', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children: ReactNode;
}

export function CardTitle({ children, className, ...rest }: CardTitleProps) {
  return (
    <h3 className={['text-lg font-semibold text-text', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </h3>
  );
}

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardContent({ children, className, ...rest }: CardContentProps) {
  return (
    <div className={['p-5', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function CardFooter({ children, className, ...rest }: CardFooterProps) {
  return (
    <div
      className={['px-5 py-4 border-t border-border bg-surface-sunken', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Card.tsx
git commit -m "refactor: migrate Card component to semantic tokens"
```

---

### Task 5: Migrate Button component

**Files:**

- Modify: `apps/web/src/components/ui/Button.tsx`

- [ ] **Step 1: Replace variant classes and focus ring with token classes**

Update `variantClasses`:

```tsx
const variantClasses = {
  primary: 'bg-primary text-primary-text hover:bg-primary-hover focus-visible:ring-focus-ring',
  secondary: 'bg-surface text-text border border-border-strong hover:bg-surface-hover focus-visible:ring-focus-ring',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text focus-visible:ring-focus-ring',
  danger: 'bg-danger text-white hover:bg-danger-hover focus-visible:ring-focus-ring',
  success: 'bg-success text-white hover:bg-success-hover focus-visible:ring-focus-ring',
} as const;
```

Keep `focus-visible:ring-offset-2` but add `focus-visible:ring-offset-surface` so the offset color matches the background in both themes. The full className array:

```tsx
className={[
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
  variantClasses[variant],
  sizeClasses[size],
  isDisabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : '',
  className,
]
  .filter(Boolean)
  .join(' ')}
```

**Note on dark-mode danger/success contrast:** The dark tokens use `#f87171` (danger) and `#34d399` (success) as bg colors. White text on `#f87171` has ~2.4:1 contrast. This is acceptable for buttons (large text + intentional brand color), but if it looks off visually during verification (Task 24), adjust dark-mode danger to `#ef4444` and success to `#10b981` for better contrast.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Button.tsx
git commit -m "refactor: migrate Button component to semantic tokens"
```

---

### Task 6: Migrate Input component

**Files:**

- Modify: `apps/web/src/components/ui/Input.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
label:  text-slate-700 → text-text-secondary
input:  text-slate-900 → text-text
        placeholder:text-slate-400 → placeholder:text-text-tertiary
        border-slate-300 → border-border-strong
        focus:ring-blue-500/40 → focus:ring-focus-ring
        focus:border-blue-500 → focus:border-primary
error:  border-red-300 → border-danger
        focus:ring-red-500/40 → focus:ring-focus-ring (same ring, border changes)
        focus:border-red-500 → focus:border-danger
error text: text-red-600 → text-danger-text
hint:   text-slate-500 → text-text-secondary
```

Add `bg-surface` to the input element (currently inherits, but dark mode needs explicit bg).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Input.tsx
git commit -m "refactor: migrate Input component to semantic tokens"
```

---

### Task 7: Migrate Select component

**Files:**

- Modify: `apps/web/src/components/ui/Select.tsx`

- [ ] **Step 1: Replace hardcoded classes**

Same mapping as Input:

```
label:   text-slate-700 → text-text-secondary
select:  text-slate-900 → text-text,  bg-white → bg-surface
         border-slate-300 → border-border-strong
         focus:ring-blue-500/40 → focus:ring-focus-ring
         focus:border-blue-500 → focus:border-primary
chevron: text-slate-400 → text-text-tertiary
error:   text-red-600 → text-danger-text
hint:    text-slate-500 → text-text-secondary
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Select.tsx
git commit -m "refactor: migrate Select component to semantic tokens"
```

---

### Task 8: Migrate Alert component

**Files:**

- Modify: `apps/web/src/components/ui/Alert.tsx`

- [ ] **Step 1: Replace variant classes**

```tsx
const variantClasses = {
  info: 'bg-info-subtle border-primary text-info-text',
  warning: 'bg-warning-subtle border-warning text-warning-text',
  error: 'bg-danger-subtle border-danger text-danger-text',
  success: 'bg-success-subtle border-success text-success-text',
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Alert.tsx
git commit -m "refactor: migrate Alert component to semantic tokens"
```

---

### Task 9: Migrate Modal component

**Files:**

- Modify: `apps/web/src/components/ui/Modal.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
backdrop:   bg-black/50 → bg-backdrop
dialog:     bg-white → bg-surface-raised
title bar:  border-slate-200 → border-border
title text: text-slate-900 → text-text
close btn:  text-slate-400 → text-text-tertiary
            hover:text-slate-600 → hover:text-text-secondary
            hover:bg-slate-100 → hover:bg-surface-hover
            focus-visible:ring-blue-500/40 → focus-visible:ring-focus-ring
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Modal.tsx
git commit -m "refactor: migrate Modal component to semantic tokens"
```

---

### Task 10: Migrate Badge component

**Files:**

- Modify: `apps/web/src/components/ui/Badge.tsx`

- [ ] **Step 1: Replace variant classes**

```tsx
const variantClasses = {
  default: 'bg-surface-hover text-text-secondary',
  success: 'bg-success-subtle text-success-text',
  warning: 'bg-warning-subtle text-warning-text',
  danger: 'bg-danger-subtle text-danger-text',
  info: 'bg-info-subtle text-info-text',
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Badge.tsx
git commit -m "refactor: migrate Badge component to semantic tokens"
```

---

### Task 11: Migrate Toggle component

**Files:**

- Modify: `apps/web/src/components/ui/Toggle.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
switch track off: bg-slate-200 → bg-border-strong
switch track on:  bg-blue-600 → bg-primary
thumb:            bg-white → bg-surface (keep white in both themes)
focus ring:       ring-blue-500/40 → ring-focus-ring
                  ring-offset-2 → remove offset
label text:       text-slate-700 → text-text
```

Actually, the toggle thumb should stay pure white in both themes for contrast. Use `bg-white` for the thumb, which is fine — it's intentional contrast, not a surface.

```
switch track off: bg-slate-200 → bg-border-strong
switch track on:  bg-blue-600 → bg-primary
focus ring:       focus-visible:ring-blue-500/40 → focus-visible:ring-focus-ring
                  remove ring-offset-2
label text:       text-slate-700 → text-text
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Toggle.tsx
git commit -m "refactor: migrate Toggle component to semantic tokens"
```

---

### Task 12: Migrate Skeleton component

**Files:**

- Modify: `apps/web/src/components/ui/Skeleton.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
Skeleton base:      bg-slate-200 → bg-skeleton
CardSkeleton:       bg-white → bg-surface,  border-slate-200 → border-border
TableSkeleton:      border-slate-200 → border-border
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Skeleton.tsx
git commit -m "refactor: migrate Skeleton component to semantic tokens"
```

---

### Task 13: Migrate Tabs component

**Files:**

- Modify: `apps/web/src/components/ui/Tabs.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
active tab:     bg-slate-100 → bg-surface-hover,  text-slate-900 → text-text
inactive tab:   text-slate-500 → text-text-secondary
hover:          hover:text-slate-700 → hover:text-text
                hover:bg-slate-50 → hover:bg-surface-hover
focus ring:     focus-visible:ring-blue-500/40 → focus-visible:ring-focus-ring
badge:          bg-slate-200 → bg-surface-hover,  text-slate-600 → text-text-secondary
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/Tabs.tsx
git commit -m "refactor: migrate Tabs component to semantic tokens"
```

---

### Task 14: Migrate remaining small UI components

**Files:**

- Modify: `apps/web/src/components/ui/ConfirmModal.tsx`
- Modify: `apps/web/src/components/ui/SaveIndicator.tsx`
- Modify: `apps/web/src/components/ui/ProgressBar.tsx`

- [ ] **Step 1: ConfirmModal — update text class**

```
text-slate-600 → text-text-secondary
```

(The rest comes from Modal and Button which are already migrated.)

- [ ] **Step 2: SaveIndicator — update text class**

```
text-emerald-600 → text-success
```

- [ ] **Step 3: ProgressBar — update classes**

```
label text:     text-slate-700 → text-text
sublabel text:  text-slate-500 → text-text-secondary
percentage:     text-slate-500 → text-text-secondary
track bg:       bg-slate-100 → bg-surface-hover
```

The colored fill bars (`bg-blue-600`, `bg-blue-300`) are passed via `color` prop by callers — leave those alone, they're intentionally vibrant.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/ConfirmModal.tsx apps/web/src/components/ui/SaveIndicator.tsx apps/web/src/components/ui/ProgressBar.tsx
git commit -m "refactor: migrate ConfirmModal, SaveIndicator, ProgressBar to semantic tokens"
```

---

## Chunk 3: Hub Layout + Components + Pages

Migrate all Hub-specific layout components, Hub-specific components, and Hub pages. After this chunk, the entire Hub module renders correctly in dark mode.

---

### Task 15: Migrate AppShell + OfflineIndicator + AuthGuard + ActivationGuard + ErrorBoundary

**Files:**

- Modify: `packages/ui-kit/src/layout/AppShell.tsx`
- Modify: `apps/web/src/components/OfflineIndicator.tsx`
- Modify: `apps/web/src/components/AuthGuard.tsx`
- Modify: `apps/web/src/components/ActivationGuard.tsx`
- Modify: `apps/web/src/components/ErrorBoundary.tsx`

- [ ] **Step 1: AppShell**

```
bg-slate-50 → bg-surface-sunken
```

- [ ] **Step 2: OfflineIndicator**

```
bg-amber-50 → bg-warning-subtle
border-amber-200 → border-warning
text-amber-800 → text-warning-text
```

- [ ] **Step 3: AuthGuard**

```
text-slate-800 → text-text
border-slate-300 → border-border-strong
border-t-blue-600 → border-t-primary
```

- [ ] **Step 4: ActivationGuard**

Same spinner pattern as AuthGuard:

```
border-slate-200 → border-border-strong
border-t-blue-600 → border-t-primary
```

- [ ] **Step 5: ErrorBoundary**

```
text-red-600 → text-danger-text  (heading + error message)
bg-blue-600 → bg-primary  (retry button)
text-white → text-primary-text
hover:bg-blue-700 → hover:bg-primary-hover
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui-kit/src/layout/AppShell.tsx apps/web/src/components/OfflineIndicator.tsx apps/web/src/components/AuthGuard.tsx apps/web/src/components/ActivationGuard.tsx apps/web/src/components/ErrorBoundary.tsx
git commit -m "refactor: migrate AppShell, OfflineIndicator, AuthGuard, ActivationGuard, ErrorBoundary to semantic tokens"
```

---

### Task 16: Migrate HubHeader + SideNav

**Files:**

- Modify: `apps/web/src/components/hub/HubHeader.tsx`
- Modify: `apps/web/src/components/hub/SideNav.tsx`

- [ ] **Step 1: HubHeader**

```
border-slate-200 → border-border
bg-white → bg-surface
text-slate-400 → text-text-tertiary  (back arrow)
hover:text-slate-600 → hover:text-text-secondary
text-slate-900 → text-text  (title)
```

Add `ThemeToggle` to the header, placed before the logout button:

```tsx
import { ThemeToggle } from '@/components/ui/ThemeToggle';

// Inside the div with gap-2.5, before the logout Button:
<ThemeToggle />;
```

- [ ] **Step 2: SideNav**

```
active:   border-blue-600 → border-hub-accent
          bg-blue-50 → bg-primary-subtle
          text-blue-700 → text-primary
inactive: text-slate-600 → text-text-secondary
          hover:bg-slate-50 → hover:bg-surface-hover
          hover:text-slate-900 → hover:text-text
focus ring: focus-visible:ring-blue-500/40 → focus-visible:ring-focus-ring
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/hub/HubHeader.tsx apps/web/src/components/hub/SideNav.tsx
git commit -m "refactor: migrate HubHeader (+ ThemeToggle) and SideNav to semantic tokens"
```

---

### Task 17: Migrate HubLayout

**Files:**

- Modify: `apps/web/src/components/hub/HubLayout.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
page bg:        bg-slate-50 → bg-surface-sunken
hamburger btn:  border-slate-300 → border-border-strong
                text-slate-700 → text-text
                hover:bg-slate-50 → hover:bg-surface-hover
mobile drawer:  bg-white → bg-surface
                border-slate-200 → border-border
active nav:     text-blue-700 → text-primary
                bg-blue-50 → bg-primary-subtle
inactive nav:   text-slate-700 → text-text
                hover:bg-slate-100 → hover:bg-surface-hover
logout:         text-red-600 → text-danger
                hover:bg-red-50 → hover:bg-danger-subtle
sidebar:        bg-white → bg-surface
                border-slate-200 → border-border
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/hub/HubLayout.tsx
git commit -m "refactor: migrate HubLayout to semantic tokens"
```

---

### Task 18: Migrate Hub-specific components

**Files:**

- Modify: `apps/web/src/components/hub/AppActivationCard.tsx`
- Modify: `apps/web/src/components/hub/ExtensionCard.tsx`
- Modify: `apps/web/src/components/hub/ApiKeyGenerator.tsx`
- Modify: `apps/web/src/components/hub/ToolToggle.tsx`

- [ ] **Step 1: AppActivationCard**

```
modal text: text-slate-600 → text-text-secondary
```

(Card, Badge, Button, Modal are already token-based.)

- [ ] **Step 2: ExtensionCard**

```
description:       text-slate-600 → text-text-secondary
border divider:    border-slate-100 → border-border-light
active indicator:  border-l-emerald-500 → border-l-success
```

- [ ] **Step 3: ApiKeyGenerator**

```
key display bg:   bg-slate-50 → bg-surface-sunken
                  border-slate-200 → border-border
label text:       text-slate-700 → text-text
code element:     bg-white → bg-surface
                  border-slate-200 → border-border
key list:         divide-slate-100 → divide-border-light
                  border-slate-200 → border-border
key row bg:       bg-white → bg-surface
key icon:         text-slate-400 → text-text-tertiary
key name:         text-slate-900 → text-text
key date:         text-slate-500 → text-text-secondary
empty icon:       text-slate-300 → text-text-disabled
empty text:       text-slate-500 → text-text-secondary
revoke btn:       text-red-600 → text-danger
                  hover:text-red-700 → hover:text-danger-hover
                  hover:bg-red-50 → hover:bg-danger-subtle
```

- [ ] **Step 4: ToolToggle**

```
container:    bg-white → bg-surface,  border-slate-200 → border-border
dividers:     divide-slate-100 → divide-border-light
tool name:    text-slate-900 → text-text
description:  text-slate-500 → text-text-secondary
empty state:  text-slate-500 → text-text-secondary
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/hub/AppActivationCard.tsx apps/web/src/components/hub/ExtensionCard.tsx apps/web/src/components/hub/ApiKeyGenerator.tsx apps/web/src/components/hub/ToolToggle.tsx
git commit -m "refactor: migrate Hub components (AppActivation, Extension, ApiKey, ToolToggle) to semantic tokens"
```

---

### Task 19: Migrate HubHomePage

**Files:**

- Modify: `apps/web/src/pages/hub/HubHomePage.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
page bg:            bg-slate-50 → bg-surface-sunken
header:             border-slate-200 → border-border
                    bg-white → bg-surface
title:              text-slate-900 → text-text
email:              text-slate-500 → text-text-secondary
logout btn:         text-slate-500 → text-text-secondary
                    hover:bg-slate-100 → hover:bg-surface-hover
                    hover:text-slate-700 → hover:text-text
section headings:   text-slate-400 → text-text-tertiary
settings nav:       bg-white → bg-surface
                    border-slate-200 → border-border
settings items:     hover:bg-slate-50 → hover:bg-surface-hover
                    border-slate-100 → border-border-light
icon bg:            bg-slate-100 → bg-surface-hover
icon:               text-slate-500 → text-text-secondary
item title:         text-slate-900 → text-text
item desc:          text-slate-500 → text-text-secondary
skeleton bg:        bg-slate-200 → bg-skeleton
skeleton circles:   bg-slate-300 → bg-skeleton-highlight
no-apps card:       bg-white → bg-surface
                    border-slate-200 → border-border
                    text-slate-500 → text-text-secondary
activate link:      bg-blue-600 → bg-primary
                    hover:bg-blue-700 → hover:bg-primary-hover
                    text-white → text-primary-text
```

**Keep unchanged:** The colored app launcher cards (`bg-blue-600`, `bg-emerald-600`) stay hardcoded — they're branded surfaces that should remain vibrant in both themes. The `text-white` and `bg-white/20` on those cards also stay.

Also add `ThemeToggle` next to the logout button in the header:

```tsx
import { ThemeToggle } from '@/components/ui/ThemeToggle';
// In the header div with gap-3:
<ThemeToggle />;
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/hub/HubHomePage.tsx
git commit -m "refactor: migrate HubHomePage to semantic tokens (+ ThemeToggle)"
```

---

### Task 20: Migrate AccountPage

**Files:**

- Modify: `apps/web/src/pages/hub/AccountPage.tsx`

- [ ] **Step 1: Replace hardcoded classes**

Most of the page uses Card, Input, Select, Button, Alert which are already migrated. Only page-specific inline classes need updating:

```
timezone label:     text-slate-700 → text-text-secondary
timezone input:     border-slate-300 → border-border-strong
                    text-slate-900 → text-text
                    placeholder:text-slate-400 → placeholder:text-text-tertiary
                    focus:ring-blue-500/40 → focus:ring-focus-ring
                    focus:border-blue-500 → focus:border-primary
chevron icon:       text-slate-400 → text-text-tertiary
dropdown list:      border-slate-200 → border-border
                    bg-white → bg-surface-raised
highlight option:   bg-blue-50 → bg-primary-subtle
                    text-blue-900 → text-primary
normal option:      text-slate-900 → text-text
no results:         text-slate-500 → text-text-secondary
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/hub/AccountPage.tsx
git commit -m "refactor: migrate AccountPage to semantic tokens"
```

---

### Task 21: Migrate ToolsPage

**Files:**

- Modify: `apps/web/src/pages/hub/ToolsPage.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
search input:       border-slate-200 → border-border
                    bg-white → bg-surface
                    focus:ring-blue-500/40 → focus:ring-focus-ring
                    focus:border-blue-400 → focus:border-primary
                    placeholder:text-slate-400 → placeholder:text-text-tertiary
search icon:        text-slate-400 → text-text-tertiary
clear btn:          text-slate-400 → text-text-tertiary
                    hover:text-slate-600 → hover:text-text-secondary
group card:         bg-white → bg-surface
                    border-slate-200 → border-border
group header:       hover:bg-slate-50 → hover:bg-surface-hover
chevron:            text-slate-400 → text-text-tertiary
group label:        text-slate-700 → text-text
badge count:        text-slate-500 → text-text-secondary
                    bg-slate-100 → bg-surface-hover
tool list divider:  divide-slate-100 → divide-border-light
                    border-slate-100 → border-border-light
tool name:          text-slate-900 → text-text
tool description:   text-slate-500 → text-text-secondary
tool code name:     text-slate-400 → text-text-tertiary
no results:         text-slate-500 → text-text-secondary
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/hub/ToolsPage.tsx
git commit -m "refactor: migrate ToolsPage to semantic tokens"
```

---

### Task 22: Migrate McpSettingsPage

**Files:**

- Modify: `apps/web/src/pages/hub/McpSettingsPage.tsx`

- [ ] **Step 1: Replace hardcoded classes**

```
code element:   bg-slate-100 → bg-code-bg
                text-slate-800 → text-code-text
```

(Rest comes from Card, Button, ApiKeyGenerator which are already migrated.)

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/hub/McpSettingsPage.tsx
git commit -m "refactor: migrate McpSettingsPage to semantic tokens"
```

---

### Task 23: Migrate Login + ResetPassword + Signup + OAuthConsent pages

**Files:**

- Modify: `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/pages/hub/ResetPassword.tsx`
- Modify: `apps/web/src/pages/Signup.tsx`
- Modify: `apps/web/src/pages/OAuthConsent.tsx`

- [ ] **Step 1: Login page**

The hero panel (left side) stays hardcoded — it's a dark gradient (`bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900`) that looks great in both themes.

Form panel (right side):

```
bg:             bg-white → bg-surface
title:          text-slate-900 → text-text
subtitle:       text-slate-500 → text-text-secondary
forgot link:    text-blue-600 → text-primary
                hover:text-blue-700 → hover:text-primary-hover
divider hr:     border-slate-200 → border-border
"or" text:      text-slate-500 → text-text-secondary
demo note:      text-slate-400 → text-text-tertiary
signup text:    text-slate-600 → text-text-secondary
signup link:    text-blue-600 → text-primary
                hover:text-blue-700 → hover:text-primary-hover
```

- [ ] **Step 2: ResetPassword page**

```
bg: bg-slate-50 → bg-surface-sunken
```

(Card, Input, Button, Alert are already token-based.)

- [ ] **Step 3: Signup page**

```
bg:           bg-slate-50 → bg-surface-sunken
bottom text:  text-slate-600 → text-text-secondary
login link:   text-blue-600 → text-primary
              hover:text-blue-700 → hover:text-primary-hover
```

(Card, Input, Button, Alert are already token-based.)

- [ ] **Step 4: OAuthConsent page**

```
page bg (3 instances):  bg-slate-50 → bg-surface-sunken
loading text:           text-slate-500 → text-text-secondary
app name text:          text-slate-700 → text-text
details box:            bg-slate-50 → bg-surface-sunken
                        border-slate-200 → border-border
details text:           text-slate-500 → text-text-secondary
note text:              text-slate-500 → text-text-secondary
```

(Card, Button, Alert are already token-based.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Login.tsx apps/web/src/pages/hub/ResetPassword.tsx apps/web/src/pages/Signup.tsx apps/web/src/pages/OAuthConsent.tsx
git commit -m "refactor: migrate Login, ResetPassword, Signup, OAuthConsent pages to semantic tokens"
```

---

### Task 24: Final verification + build check

- [ ] **Step 1: Run typecheck**

Run: `cd /home/jeremy/luna-hub-lite && pnpm typecheck`
Expected: No type errors

- [ ] **Step 2: Run build**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter web build`
Expected: Clean build, no errors

- [ ] **Step 3: Visual verification in dev server**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter web dev`

Manually verify in browser:

1. Light mode: All Hub pages look identical to before
2. Click dark mode toggle: All Hub pages render with Material Dark theme
3. System mode: Follows OS preference
4. Refresh page: Theme preference persists via localStorage
5. Login page: Hero stays dark, form panel adapts to theme
6. Check all Hub sub-pages: Account, Apps, Tools, Extensions, MCP Settings

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: dark mode visual adjustments"
```

---

## Summary

| Chunk | Tasks | Description                                                                      |
| ----- | ----- | -------------------------------------------------------------------------------- |
| 1     | 1-3   | CSS tokens + ThemeProvider (with FOUC script) + ThemeToggle                      |
| 2     | 4-14  | All shared UI components → semantic tokens                                       |
| 3     | 15-24 | Hub layout, components, pages (inc. Signup, OAuth, ErrorBoundary) + verification |

**Total files modified:** ~30
**New files:** 2 (`ThemeProvider.tsx`, `ThemeToggle.tsx`)
**Modified non-obvious files:** `index.html` (FOUC script), `App.tsx` (ThemeProvider wrap + PageSpinner + 404)
**Estimated commits:** ~16

**Out of scope (future work):**

- CoachByte pages/layout
- ChefByte pages/layout
- Module-specific accent colors in CoachByte/ChefByte layouts
- User profile DB setting for theme (currently localStorage-only)
- PWA theme-color meta tag updates
- `::selection` styling and scrollbar colors
- Smooth theme transition animation (`transition: background-color 200ms`)
