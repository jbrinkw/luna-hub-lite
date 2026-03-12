# UX Refactor Plan — Luna Hub Lite

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the current functional-but-flat UI into a genuinely user-friendly experience through better information hierarchy, progressive disclosure, and polished interactions — without changing any functionality.

**Architecture:** Pure frontend refactor. No DB changes, no API changes, no new features. Every page gets evaluated for: information hierarchy, progressive disclosure, action clarity, and mobile usability. Shared components are enhanced, not replaced.

**Tech Stack:** React 18, Tailwind CSS v4, Lucide React, existing shared UI components

---

## Executive Summary — What's Wrong

The Tailwind migration gave us a clean visual foundation but preserved every layout problem from the Ionic version. The core issue: **every page dumps all content at once with equal visual weight.** There's no progressive disclosure, no information hierarchy, and no guidance for first-time users.

### The 5 Biggest Problems

1. **CoachByte Today is a wall of content** — 16-row editable table, duplicate timer displays (inline AND separate card), notes/summary at bottom. Users scroll for days.
2. **Inventory has 6 action buttons per row** — `+1 -1 +S -S Consume All` is intimidating. No one understands this on first sight.
3. **Hub Tools page is a wall of 36+ toggles** — SCREAMING_SNAKE_CASE names, no search, no collapse, no grouping explanation.
4. **ChefByte Dashboard has competing sections** — Alert badges, 4 action buttons, macro bars, meal prep, meals — all at the same visual level with no hierarchy.
5. **No mobile navigation on Hub** — SideNav is `hidden md:block`. On mobile, you're stuck.

---

## Page-by-Page Reflection

### Login Page

**Current:** Centered card, email/password, inline password-reset toggle, demo button.
**Problems:** No branding/identity. Password reset appears/disappears inline (confusing state change). Three submission flows compete (login, reset, demo).
**Plan:** Add app identity (name + tagline). Separate password reset into its own view state. Make demo button more prominent with explanation.

### Hub — Account

**Current:** Two cards (Profile + Change Password). Timezone is a raw `<select>` with 300+ options.
**Problems:** Timezone dropdown is unusable (no search). Day Start Hour needs context. No save confirmation feedback.
**Plan:** Replace timezone dropdown with searchable combobox. Add inline save confirmation (checkmark). Add helper text for Day Start Hour.

### Hub — Apps

**Current:** Two cards with activate/deactivate buttons.
**Problems:** Too simple for a full page. Cards have no visual identity for each app.
**Plan:** Add app descriptions and icons. Show app status more visually (active = vibrant card, inactive = muted).

### Hub — Tools

**Current:** Flat list of 36+ tool toggles with `SCREAMING_SNAKE_CASE` names.
**Problems:** Overwhelming. Names are developer-facing, not user-facing. No search, no collapse.
**Plan:** Collapsible groups (default collapsed). Human-readable names ("Complete Next Set" not "COACHBYTE_complete_next_set"). Add search filter. Show descriptions only on expand.

### Hub — Extensions

**Current:** Three cards with enable toggle + hidden credential forms.
**Problems:** Credentials are masked even for URLs. No indication of existing credential state.
**Plan:** Show credential status clearly ("Configured" vs "Not configured"). Don't mask URL fields. Add "test connection" feedback.

### Hub — MCP Keys

**Current:** Endpoint display + API key generator + key list.
**Problems:** No copy button on endpoint. No confirmation before revoking keys.
**Plan:** Add copy button to endpoint. Add revoke confirmation modal. Better empty state.

### Hub — Layout & Navigation

**Current:** Sidebar (desktop only) + module switcher bar.
**Problems:** No mobile nav at all. Module switcher is a third navigation pattern (Hub uses sidebar, Coach/Chef use tabs).
**Plan:** Add mobile hamburger drawer to Hub. Consider unifying navigation pattern across modules.

### CoachByte — Today (HIGHEST PRIORITY)

**Current:** Next In Queue box (with inline timer) → 16-row editable table → separate Rest Timer card → Completed Sets table → Notes → Summary. Full page screenshot is ~3 screens tall.
**Problems:**

- Timer appears TWICE — inline in the Next In Queue box AND as a separate Rest Timer card below the queue table. Confusing.
- 16-row queue table with editable inputs dominates the page. Users rarely need to edit future sets.
- Completed sets, notes, and summary are buried below 2 screens of content.
- No progressive disclosure — everything visible at once.

**Plan:**

- Make the **current exercise + timer the hero** — big, prominent, centered.
- **Remove the separate Rest Timer card** — the inline timer IS the timer. Consolidate controls.
- **Collapse the pending queue** — show "Next 2-3 upcoming" as preview cards, with "Show all (16)" expandable. Inline editing only in expanded view.
- **Collapse completed sets** — default collapsed, show count badge "Completed (5)".
- **Move notes/summary into a collapsible section** at the bottom.
- Net effect: Today page goes from 3 screens → 1 screen for the primary workout flow.

### CoachByte — History

**Current:** Table with date, summary (truncated), sets ratio, expand button. Load More pagination.
**Problems:** Summary truncation without tooltip. No pagination context ("showing X of Y"). Expanded detail cards are heavy.
**Plan:** Add tooltip for truncated summaries. Show "Showing 1-20 of X" context. Make detail expansion lighter (inline row expansion instead of full card).

### CoachByte — Split

**Current:** 7-day accordion with editable tables (7 columns including controls).
**Problems:** "Rel%" checkbox is cryptic. Column headers are abbreviated. All 7 days visible simultaneously. No confirmation on Remove.
**Plan:** Default collapse rest days. Add tooltips for column headers. Replace "Rel%" checkbox with a clearer toggle label. Add common rest duration presets (30s, 60s, 90s, 120s).

### CoachByte — PRs

**Current:** PR cards per exercise with rep badges. Tracked exercises panel with search.
**Problems:** Tracked Exercises config panel competes with PR display. e1RM calculation is opaque.
**Plan:** Move Tracked Exercises into a collapsible config panel or settings gear icon. Add tooltip explaining Epley formula on hover over e1RM values.

### CoachByte — Settings

**Current:** Three cards (Defaults, Plate Calculator, Exercise Library).
**Problems:** Exercise list gets long. Auto-save has no visual feedback. Plates have no select all/none.
**Plan:** Add search to exercise list. Add save confirmation feedback (checkmark animation). Add select all/none for plates.

### ChefByte — Dashboard

**Current:** Macro bars → alert badges → 4 action buttons → meal prep section → meals section.
**Problems:** Alert badges (Below Min Stock: 4, Missing Prices: 5) and action buttons (Import Shopping List, Meal Plan → Cart, Taste Profile, Target Macros) all compete at the same visual level. No clear primary action.
**Plan:**

- Make macro progress bars the clear hero section with better visual treatment.
- Move alert badges into a compact notification strip (not big colored pills).
- Reduce action buttons — "Taste Profile" and "Target Macros" are settings, not daily actions. Move to settings or a "..." menu.
- Meal prep and meals sections: add visual distinction (prep = amber accent, meals = green accent).
- Add a clear "What to do next" flow for the day.

### ChefByte — Meal Plan

**Current:** Two-panel layout (week grid left, day detail right).
**Problems:** Two-panel can be cramped. Two-click delete pattern. Consumed items section competes with planning.
**Plan:** On mobile, stack panels vertically with the day selector as a horizontal scrollable strip. Add swipe-to-delete gesture. Visually separate "Planned" from "Consumed" with clear section headers and backgrounds.

### ChefByte — Recipes

**Current:** Card grid with search + filter pills.
**Problems:** Filter threshold editors are awkward (pencil icon for 2 of 5 filters). Description truncated at 60 chars.
**Plan:** Move threshold inputs into a filter popover/drawer instead of inline. Show full descriptions on recipe cards (or at least 2 lines). Add recipe hero image placeholder.

### ChefByte — Shopping

**Current:** Add form at top, To Buy list, Purchased list.
**Problems:** "Auto-Add Below Min Stock" button is hidden. Walmart link generation requires 2 steps.
**Plan:** Make "Auto-Add Below Min Stock" more prominent (call-to-action style). Streamline Walmart flow. Add visual checkmark animation when marking purchased.

### ChefByte — Inventory (HIGH PRIORITY)

**Current:** Table with 6 action buttons per row (+1, -1, +S, -S, Consume All).
**Problems:** 6 buttons per row is the #2 UX problem in the entire app. Cryptic labels (+S means "add one serving"?). Touch targets are small. Visual noise is extreme.
**Plan:**

- Replace inline buttons with **tap-to-expand detail row** — tap a product row to reveal action buttons in an expanded section below.
- In the expanded section, show stock info + clear labeled actions ("Add Container", "Remove Container", "Add Serving", "Remove Serving", "Consume All").
- Collapsed row shows: name, stock level (with visual bar), expiry, status dot.
- Net effect: Table goes from 6 visible buttons per row → 0 buttons until user taps.

### ChefByte — Scanner

**Current:** Two-column layout (barcode input + queue left, mode selector + keypad right).
**Problems:** All modes, controls, and the keypad visible at once. Nutrition editor fields are dense. Mode names are jargon-heavy ("Consume-NoMacros").
**Plan:**

- Simplify mode labels: "Purchase" → "Buy", "Consume+Macros" → "Eat (Track)", "Consume-NoMacros" → "Eat (Skip Tracking)", "Add to Shopping" → "Add to List".
- Make the active mode more visually prominent (larger selected state).
- On mobile, stack the layout with the scan input + current item on top, keypad below.
- Progressive disclosure for nutrition editor — only show when relevant (Purchase mode).

### ChefByte — Recipe Form

**Current:** Long form with ingredient table (inline editable).
**Problems:** Add ingredient form is a long horizontal row. Table requires horizontal scroll.
**Plan:** Stack ingredient add form vertically on mobile. Use card-based ingredient list instead of table. Add visual macro summary that updates live.

### ChefByte — Macros

**Current:** Date nav, progress bars, consumed items table, planned items table.
**Problems:** Tables need horizontal scroll on mobile. No date picker for jumping. Taste Profile button buried.
**Plan:** Add date picker popover. Replace tables with card-based lists on mobile. Make progress bars larger and more visual (ring/donut option).

### ChefByte — Settings

**Current:** 4 sub-tabs (Products, Walmart, LiquidTrack, Locations).
**Problems:** Very feature-dense for one page. Product card grid heights vary.
**Plan:** Keep tab structure but add better visual hierarchy within each tab. Add copy button for LiquidTrack device keys. Standardize product card heights.

---

## Cross-Cutting Improvements

### 1. Save Feedback System

**Problem:** Auto-save features (notes, settings, inline edits) have zero visual confirmation.
**Solution:** Add a subtle "Saved" indicator — checkmark icon that fades in/out near the save trigger. Create a reusable `useSaveIndicator` hook.

### 2. Replace window.confirm() with Modal

**Problem:** Shopping, Inventory, and other pages use `window.confirm()` for destructive actions.
**Solution:** Use the existing Modal component for all confirmations. Create a reusable `ConfirmModal` component.

### 3. Hub Mobile Navigation

**Problem:** Hub SideNav is `hidden md:block`. No mobile nav.
**Solution:** Add hamburger menu that opens a slide-out drawer with the same nav items.

### 4. Empty State Improvements

**Problem:** Empty states are generic dashed boxes saying "No X yet."
**Solution:** Add contextual empty states with a clear CTA. Example: "No workout planned for today → [Set up your weekly split]" or "No meals planned → [Plan today's meals]".

### 5. Consistent Confirmation Patterns

**Problem:** Some pages use double-tap (Today), some use modals (Apps), some use window.confirm (Shopping).
**Solution:** Standardize on modal confirmations for all destructive actions.

---

## Implementation Order (by impact)

| Priority | Task                                  | Pages Affected                         | Effort |
| -------- | ------------------------------------- | -------------------------------------- | ------ |
| 1        | CoachByte Today redesign              | TodayPage, SetQueue, RestTimer         | HIGH   |
| 2        | Inventory row actions collapse        | InventoryPage                          | MEDIUM |
| 3        | Hub Tools collapsible groups + search | ToolsPage                              | MEDIUM |
| 4        | ChefByte Dashboard hierarchy          | HomePage                               | MEDIUM |
| 5        | Hub mobile navigation                 | HubLayout, SideNav                     | MEDIUM |
| 6        | Save feedback system                  | Cross-cutting (hook + indicator)       | LOW    |
| 7        | ConfirmModal component                | Cross-cutting (replace window.confirm) | LOW    |
| 8        | Scanner mode labels + layout          | ScannerPage                            | LOW    |
| 9        | Empty state improvements              | Cross-cutting (all pages)              | LOW    |
| 10       | Login branding + layout               | LoginPage                              | LOW    |
| 11       | CoachByte Split improvements          | SplitPage                              | LOW    |
| 12       | ChefByte Recipes filter popover       | RecipesPage                            | LOW    |
| 13       | Macros page improvements              | MacrosPage                             | LOW    |
| 14       | Recipe form mobile layout             | RecipeFormPage                         | LOW    |
| 15       | History pagination context            | HistoryPage                            | LOW    |
| 16       | PRs config panel collapse             | PRsPage                                | LOW    |
| 17       | Account timezone combobox             | AccountPage                            | LOW    |
| 18       | Extensions credential UX              | ExtensionsPage                         | LOW    |
| 19       | MCP Keys polish                       | MCPKeysPage                            | LOW    |
| 20       | Shopping list polish                  | ShoppingPage                           | LOW    |
| 21       | Meal Plan mobile stack                | MealPlanPage                           | LOW    |
| 22       | ChefByte Settings polish              | SettingsPage                           | LOW    |

---

## What This Plan Does NOT Do

- No new features (no charts, no analytics, no AI suggestions)
- No new routes or pages
- No database or API changes
- No dependency additions (everything uses existing Tailwind + Lucide + shared components)
- No mobile-first redesign (desktop-first per spec, but fixes the worst mobile gaps)

The goal is purely: **same features, dramatically better UX.**
