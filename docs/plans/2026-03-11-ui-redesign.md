# UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace mixed Ionic/custom CSS with unified Tailwind CSS design system — clean, minimal, production-ready.

**Architecture:** Drop Ionic React entirely. Install Tailwind CSS v4. Build a thin shared component library with Tailwind. Migrate pages bottom-up: foundation → shared infra → Hub → CoachByte → ChefByte → cleanup.

**Tech Stack:** React 18, Tailwind CSS v4, Vite 6, Inter font, no Ionic

**Design doc:** `docs/plans/2026-03-11-ui-redesign-design.md`
**Before screenshots:** `docs/screenshots/before-redesign/` (20 pages)

---

## Phase 1: Foundation

### Task 1.1: Install Tailwind CSS v4

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/index.css`
- Modify: `apps/web/src/main.tsx`

**Step 1: Install Tailwind CSS v4 + Vite plugin**

```bash
cd apps/web && pnpm add -D tailwindcss @tailwindcss/vite
```

**Step 2: Add Vite plugin**

In `apps/web/vite.config.ts`, add:

```ts
import tailwindcss from '@tailwindcss/vite';
// add to plugins array: tailwindcss()
```

**Step 3: Create `apps/web/src/index.css`**

```css
@import 'tailwindcss';

@theme {
  --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  --color-surface: #ffffff;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-success: #059669;
  --color-success-hover: #047857;
  --color-warning: #f59e0b;
  --color-danger: #dc2626;
  --color-danger-hover: #b91c1c;

  --color-hub-accent: #2563eb;
  --color-coach-accent: #7c3aed;
  --color-chef-accent: #059669;
}

/* Base styles */
body {
  font-family: var(--font-sans);
  background-color: theme(--color-slate-50);
  color: var(--color-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

**Step 4: Import index.css in main.tsx**

Add `import './index.css'` at top of `apps/web/src/main.tsx`. Keep existing Ionic CSS imports for now (removed in Phase 6).

**Step 5: Add Inter font**

In `apps/web/index.html`, add to `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

**Step 6: Verify dev server works**

```bash
pnpm --filter web dev
```

Expected: App loads with Inter font, Tailwind utilities work alongside existing Ionic styles.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): install Tailwind CSS v4 + Inter font"
```

---

### Task 1.2: Build Shared Component Library

**Files:**

- Create: `apps/web/src/components/ui/Button.tsx`
- Create: `apps/web/src/components/ui/Card.tsx`
- Create: `apps/web/src/components/ui/Input.tsx`
- Create: `apps/web/src/components/ui/Select.tsx`
- Create: `apps/web/src/components/ui/Toggle.tsx`
- Create: `apps/web/src/components/ui/Modal.tsx`
- Create: `apps/web/src/components/ui/Badge.tsx`
- Create: `apps/web/src/components/ui/Tabs.tsx`
- Create: `apps/web/src/components/ui/Table.tsx`
- Create: `apps/web/src/components/ui/Skeleton.tsx`
- Create: `apps/web/src/components/ui/ProgressBar.tsx`
- Create: `apps/web/src/components/ui/Alert.tsx`
- Create: `apps/web/src/components/ui/index.ts`

Build each component with Tailwind classes. Each component must:

- Accept a `className` prop for overrides
- Forward refs where appropriate
- Include `data-testid` support via spreading rest props
- Use semantic HTML elements

**Component specifications:**

**Button** — Variants: `primary`, `secondary`, `ghost`, `danger`, `success`. Sizes: `sm`, `md`, `lg`. Props: `loading`, `disabled`, `icon`.

**Card** — White bg, 1px border-slate-200, rounded-xl, p-5. Optional `header` and `footer` props.

**Input** — Label above, border, rounded-lg, focus ring blue-600. Types: text, password, number, email. Error state.

**Select** — Styled native select. Label, error state.

**Toggle** — Accessible switch. Label prop. Matches Tailwind UI toggle style.

**Modal** — Fixed backdrop (bg-black/50 + backdrop-blur-sm), centered card, escape to close, body scroll lock. `title`, `maxWidth`, `children`.

**Badge** — Rounded-full pill. Variants: `default`, `success`, `warning`, `danger`, `info`.

**Tabs** — Horizontal tab bar with underline active indicator. `items` array with `label`, `value`, `href`. Active state via colored underline + font-medium.

**Table** — Clean headers (text-xs uppercase tracking-wider text-slate-500), optional alternating rows. `columns` and `data` props or children-based.

**Skeleton** — Animated pulse placeholder. Variants: `text`, `card`, `table`, `macroBar`.

**ProgressBar** — Rounded-full bar. `value`, `max`, `color`, `label`, `sublabel`.

**Alert** — Inline banner. Variants: `info`, `warning`, `error`, `success`. Dismissible option.

**Step: Write all components**

Use the `frontend-design` skill for each component to ensure high design quality. Each component should be self-contained with Tailwind classes — no external CSS files.

**Step: Create barrel export**

`apps/web/src/components/ui/index.ts` — export all components.

**Step: Commit**

```bash
git add apps/web/src/components/ui/ && git commit -m "feat(ui): add shared Tailwind component library"
```

---

## Phase 2: Shared Infrastructure

### Task 2.1: Replace AppShell + AppLayout

**Files:**

- Modify: `packages/ui-kit/src/layout/AppShell.tsx` — remove IonApp, use plain div
- Modify: `apps/web/src/shared/layout/AppLayout.tsx` — remove IonLoading, use Skeleton
- Modify: `apps/web/src/App.tsx` — update if needed

**Step 1: Simplify AppShell**

Replace `<IonApp>` with `<div className="min-h-screen bg-slate-50">`. Update the export.

**Step 2: Simplify AppLayout**

Replace `<IonLoading>` with a centered spinner or skeleton. Use Tailwind for the loading state.

**Step 3: Verify app still loads**

**Step 4: Commit**

```bash
git commit -m "refactor(ui): replace IonApp/IonLoading with Tailwind equivalents"
```

### Task 2.2: Replace ModuleSwitcher

**Files:**

- Modify: `apps/web/src/components/ModuleSwitcher.tsx`

Replace `IonSegment`/`IonSegmentButton`/`IonLabel` with the new `Tabs` component or a custom segmented control built with Tailwind.

Design: Horizontal pills with active state. Each segment = link to module root.

**Commit after working.**

### Task 2.3: Replace OfflineIndicator

**Files:**

- Modify: `apps/web/src/components/OfflineIndicator.tsx`

Replace `IonText` and inline styles with Tailwind `Alert` component (warning variant). Keep the same conditional rendering logic.

**Commit after working.**

### Task 2.4: Replace SkeletonScreen

**Files:**

- Modify: `apps/web/src/components/SkeletonScreen.tsx`

Replace `IonSkeletonText` with new `Skeleton` component. Keep the 4 exported variants (ListSkeleton, CardSkeleton, MacroBarSkeleton, TableSkeleton).

**Commit after working.**

### Task 2.5: Upgrade ModalOverlay + MacroProgressBar

**Files:**

- Modify: `apps/web/src/components/shared/ModalOverlay.tsx`
- Modify: `apps/web/src/components/shared/MacroProgressBar.tsx`

These already don't use Ionic. Replace inline styles with Tailwind classes. Use the new `Modal` component pattern for ModalOverlay. Use the new `ProgressBar` for MacroProgressBar.

**Commit after working.**

---

## Phase 3: Hub Module + Auth Pages

### Task 3.1: Replace Hub Layout Components

**Files:**

- Modify: `apps/web/src/components/hub/HubLayout.tsx` — remove IonPage/IonContent/IonGrid/IonRow/IonCol
- Modify: `apps/web/src/components/hub/HubHeader.tsx` — remove IonHeader/IonToolbar/IonTitle/IonButtons
- Modify: `apps/web/src/components/hub/SideNav.tsx` — remove IonList/IonItem/IonLabel/IonIcon

**HubLayout:** Replace Ionic grid with Tailwind flex layout:

```
<div className="flex min-h-[calc(100vh-theme(spacing.14))]">
  <aside className="w-60 border-r border-slate-200 bg-white">...</aside>
  <main className="flex-1 p-6 max-w-4xl">...</main>
</div>
```

**HubHeader:** Clean header with `flex justify-between items-center h-14 px-6 border-b border-slate-200 bg-white`.

**SideNav:** Clean nav links with active indicator (left border or bg highlight). Use Lucide React icons instead of ionicons.

**Commit after working.**

### Task 3.2: Migrate Hub Pages

**Files:**

- Modify: `apps/web/src/pages/hub/AccountPage.tsx`
- Modify: `apps/web/src/pages/hub/AppsPage.tsx`
- Modify: `apps/web/src/pages/hub/ToolsPage.tsx`
- Modify: `apps/web/src/pages/hub/ExtensionsPage.tsx`
- Modify: `apps/web/src/pages/hub/McpSettingsPage.tsx`
- Modify: `apps/web/src/pages/hub/ResetPassword.tsx`
- Modify: `apps/web/src/components/hub/AppActivationCard.tsx`
- Modify: `apps/web/src/components/hub/ApiKeyGenerator.tsx`
- Modify: `apps/web/src/components/hub/ToolToggle.tsx`
- Modify: `apps/web/src/components/hub/ExtensionCard.tsx`

For each page:

1. Remove all Ionic imports (IonCard, IonButton, IonInput, IonToggle, IonText, IonAlert, IonChip, IonSelect, IonSelectOption, IonSpinner, IonItem, IonLabel, IonItemDivider)
2. Replace with new shared components (Button, Card, Input, Select, Toggle, Badge, Alert)
3. Preserve all data-testid attributes
4. Preserve all event handlers and business logic
5. Use Tailwind utilities for layout

**Commit per-page or batch by complexity.**

### Task 3.3: Migrate Auth Pages

**Files:**

- Modify: `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/pages/Signup.tsx`
- Modify: `apps/web/src/pages/OAuthConsent.tsx`

Replace IonPage/IonContent/IonCard with centered card layout using Tailwind:

```
<div className="min-h-screen flex items-center justify-center bg-slate-50">
  <Card className="w-full max-w-md">...</Card>
</div>
```

Replace IonInput with Input, IonButton with Button. Keep all form logic.

**Commit after working.**

---

## Phase 4: CoachByte Module

### Task 4.1: Migrate CoachLayout

**Files:**

- Modify: `apps/web/src/components/coachbyte/CoachLayout.tsx`

This already doesn't use Ionic. Replace CSS class references (`.coach-root`, `.coach-header`, `.coach-tabs`, etc.) with Tailwind classes directly in JSX. Use the `Tabs` component for navigation.

Header: `flex items-center h-14 px-6 border-b border-slate-200 bg-white`
Tab bar: Use new Tabs component with violet-600 accent for active state.
Mobile drawer: Restyle with Tailwind (translate-x transitions).

**Commit after working.**

### Task 4.2: Migrate CoachByte Components

**Files:**

- Modify: `apps/web/src/components/coachbyte/SetQueue.tsx`
- Modify: `apps/web/src/components/coachbyte/RestTimer.tsx`
- Modify: `apps/web/src/components/coachbyte/AdHocSetForm.tsx`

Replace `.btn-*`, `.card`, `.card-body`, `.card-header` CSS classes with Tailwind classes and shared components.

SetQueue: Use Table component for set queue, Card for "next in queue" section, Button for actions.
RestTimer: Use Card, large monospace display with Tailwind, Button for controls.
AdHocSetForm: Use Card, Input, Select, Button components.

**Commit after working.**

### Task 4.3: Migrate CoachByte Pages

**Files:**

- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/HistoryPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/SplitPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/PrsPage.tsx`
- Modify: `apps/web/src/pages/coachbyte/SettingsPage.tsx`

For each page: replace CSS class references with Tailwind classes and shared components. Preserve all data-testid attributes and business logic.

**Commit per-page or in small batches.**

---

## Phase 5: ChefByte Module

### Task 5.1: Migrate ChefLayout

**Files:**

- Modify: `apps/web/src/components/chefbyte/ChefLayout.tsx`

Same approach as CoachLayout — replace `.chef-root`, `.chef-header`, `.chef-tabs` with Tailwind. Use emerald-600 accent for active tab. Keep scanner button in header.

**Commit after working.**

### Task 5.2: Migrate ChefByte Dashboard + Macros

**Files:**

- Modify: `apps/web/src/pages/chefbyte/HomePage.tsx`
- Modify: `apps/web/src/pages/chefbyte/MacroPage.tsx`

Dashboard: Use Card for macro summary, Badge for alert badges, Button for quick actions. Clean grid layout for the 4 macro progress bars.

Macros: Use ProgressBar, Table, Card, Button, Modal components.

**Commit after working.**

### Task 5.3: Migrate ChefByte Meal Plan + Recipes

**Files:**

- Modify: `apps/web/src/pages/chefbyte/MealPlanPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/RecipesPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/RecipeFormPage.tsx`

MealPlan: Week sidebar + day detail panel. Use Card, Button, Badge, Toggle.
Recipes: Card grid for recipe cards with macro display and stock badges.
RecipeForm: Use Input, Select, Button, Table for ingredients.

**Commit per-page.**

### Task 5.4: Migrate ChefByte Scanner

**Files:**

- Modify: `apps/web/src/pages/chefbyte/ScannerPage.tsx`

This is the most complex page. Two-column layout:

- Left: Queue panel with barcode input, filter buttons, scrollable queue list
- Right: Mode selector grid, display, keypad, nutrition editor

Restyle with Tailwind. The keypad grid uses `grid grid-cols-4 gap-2`. Mode buttons use Button variants. Keep all scanner logic intact.

**Commit after working.**

### Task 5.5: Migrate ChefByte Shopping + Inventory

**Files:**

- Modify: `apps/web/src/pages/chefbyte/ShoppingPage.tsx`
- Modify: `apps/web/src/pages/chefbyte/InventoryPage.tsx`

Shopping: Checklist with Card sections, Input for add form, Button for actions.
Inventory: Grid-based table with stock indicators, action buttons. Use Badge for stock status.

**Commit after working.**

### Task 5.6: Migrate ChefByte Settings + WalmartTab

**Files:**

- Modify: `apps/web/src/pages/chefbyte/SettingsPage.tsx`
- Modify: `apps/web/src/components/chefbyte/WalmartTab.tsx`

Settings: Tab panel (Products, Walmart, LiquidTrack, Locations). Card grid for products.
WalmartTab: Progress bars, product cards with radio selection, batch action buttons.

**Commit after working.**

---

## Phase 6: Cleanup + QA

### Task 6.1: Remove Ionic Dependencies

**Files:**

- Modify: `apps/web/package.json` — remove `@ionic/react`, `ionicons`
- Modify: `apps/web/src/main.tsx` — remove all Ionic CSS imports
- Modify: `packages/ui-kit/src/theme/setup.ts` — remove `setupIonicReact`
- Delete: `apps/web/src/theme/variables.css`
- Delete: `apps/web/src/theme/chefbyte.css`
- Delete: `apps/web/src/theme/coachbyte.css`
- Modify: `packages/ui-kit/src/layout/AppShell.tsx` — clean up
- Modify: `packages/ui-kit/src/layout/ModuleLayout.tsx` — remove or simplify
- Modify: `packages/ui-kit/package.json` — remove `@ionic/react` dep

**Step 1: Remove Ionic CSS imports from main.tsx**

Remove all 10 `@ionic/react/css/*.css` imports and the 3 theme CSS imports.

**Step 2: Remove setupTheme/setupIonicReact**

**Step 3: Uninstall packages**

```bash
cd apps/web && pnpm remove @ionic/react ionicons
cd ../../packages/ui-kit && pnpm remove @ionic/react
```

**Step 4: Delete old CSS theme files**

**Step 5: Fix any remaining Ionic references**

Search codebase for any remaining `@ionic` or `ionicons` imports:

```bash
grep -r "@ionic\|ionicons" apps/web/src/ packages/ui-kit/src/
```

**Step 6: Verify build**

```bash
pnpm --filter web build
```

**Step 7: Commit**

```bash
git commit -m "chore(ui): remove Ionic React + old CSS theme files"
```

### Task 6.2: Install Lucide React Icons

**Files:**

- Modify: `apps/web/package.json`

```bash
cd apps/web && pnpm add lucide-react
```

Replace any remaining ionicons references with Lucide equivalents throughout the codebase.

**Commit after working.**

### Task 6.3: Visual QA Pass

**Process:**

1. Start dev server
2. Navigate to every page (use the 20 before-screenshots as reference)
3. For each page, verify:
   - All content is present (labels, data, buttons, forms)
   - Layout matches intent (sidebar, tabs, grids, cards)
   - Interactive elements work (buttons, toggles, modals, forms)
   - No visual regressions (overlapping elements, broken layouts)
   - Typography is consistent (Inter font, correct weights/sizes)
   - Colors are consistent (unified palette)
4. Take "after" screenshots to `docs/screenshots/after-redesign/`
5. Fix any issues found

**Commit after fixing issues.**

### Task 6.4: Update Tests

**Files:** Various test files that reference Ionic components

Search for Ionic-specific selectors in tests:

```bash
grep -r "ion-toggle\|ion-button\|ion-input\|ion-card\|IonButton\|IonToggle\|IonInput" apps/web/src/__tests__/ apps/web/src/**/*.test.* --include="*.ts" --include="*.tsx"
```

Update any test selectors that reference Ionic elements. Tests using `data-testid` should work without changes.

**Commit after working.**

### Task 6.5: Update Documentation

**Files:**

- Modify: `CLAUDE.md` — update Tech Stack section, remove Ionic references
- Modify: `docs/plans/2026-03-11-ui-redesign-design.md` — mark as complete

**Commit after working.**

### Task 6.6: Final Verification

Run the full test suite:

```bash
pnpm test && pnpm typecheck
```

Fix any failures. Commit.

---

## Execution Notes

- **Use `frontend-design` skill** for each component in Task 1.2 and for each page migration to ensure high design quality
- **Preserve all `data-testid` attributes** — tests depend on them
- **Keep all business logic intact** — only change UI layer
- **Commit frequently** — after each task or sub-task
- **Check dev server** after each phase to catch issues early
- **Before screenshots** are in `docs/screenshots/before-redesign/` for reference
