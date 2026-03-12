# Doc Restructuring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure 3 redundant test docs (1,872 lines) into 22 session-sized briefs, apply 3 decision changes, update process files.

**Architecture:** Source content from existing test docs + roadmap → generate self-contained briefs. Update spec docs with legacy-confirmed decision changes. Slim roadmap to index. Zero information loss.

**Tech Stack:** Markdown files only. No code changes.

---

## Task 1: Apply Decision #6 — Remove exercise_prs, Derive PRs

**Files:**

- Modify: `docs/apps/coachbyte.md`
- Modify: `docs/architecture/database.md`

**Step 1: Read current coachbyte.md and database.md**

**Step 2: Edit coachbyte.md**

- Remove any reference to `exercise_prs` table
- PR Tracker section: change to "PRs derived from completed_sets via Epley formula"
- Add: "UI shows estimated 1RM through 10RM as rep-range pills"
- Add: "Any exercise with completed sets appears in PR tracker (no separate tracking)"
- Remove "tracked exercise management" as a feature — replace with "exercises with history appear automatically"

**Step 3: Edit database.md**

- Remove `exercise_prs` from CoachByte schema table listing
- Update Business Logic table: remove PR upsert from complete_next_set description
- Note: complete_next_set just inserts completed_set row, no PR update

**Step 4: Commit**

```
fix: remove exercise_prs table, derive PRs from completed_sets (decision #6)
```

---

## Task 2: Apply Decision #9 — Remove Epley 10-rep Cap

**Files:**

- Modify: `docs/apps/coachbyte.md`

**Step 1: Read coachbyte.md**

**Step 2: Edit coachbyte.md**

- Find Epley formula reference, remove "capped at 10 reps" language
- Replace with: "Epley formula: `load × (1 + reps/30)`. All reps feed the formula. UI displays estimated 1RM through 10RM."

**Step 3: Commit**

```
fix: remove Epley 10-rep cap, use formula as-is (decision #9)
```

---

## Task 3: Apply Decision #22 — Liquid Log → liquidtrack_events

**Files:**

- Modify: `docs/apps/chefbyte.md`

**Step 1: Read chefbyte.md**

**Step 2: Edit chefbyte.md**

- Find Liquid Log reference (Dashboard section)
- Change write target from `temp_items` to `liquidtrack_events` with `device_id='manual'`
- Note: weight_before/weight_after = 0 for manual entries
- "Refill" checkbox sets `is_refill=true` on the event

**Step 3: Commit**

```
fix: Liquid Log writes to liquidtrack_events not temp_items (decision #22)
```

---

## Task 4: Create briefs directory

**Step 1: Create directory**

```bash
mkdir -p docs/plans/briefs
```

**Step 2: No commit yet** — commit with first batch of briefs.

---

## Task 5: Generate Phase 2–3 Briefs (6 files)

**Source docs to have open:**

- `docs/plans/2026-03-01-comprehensive-test-plan.md` (lines 1-470 for Hub)
- `docs/plans/2026-03-01-test-architecture-design.md` (lines 1-220 for structure + Hub)
- `memory/project-roadmap.md` (Phase 2-3 sections)
- `docs/apps/hub.md`
- `memory/legacy-reference.md` (Hub section)

**Files to create:**

- `docs/plans/briefs/phase-02.md` — Test infrastructure setup
  - Content from: roadmap Phase 2 checklist + test-architecture directory structure + test isolation strategy + test helper specs
- `docs/plans/briefs/phase-03a.md` — Auth flow
  - Content from: roadmap 3a + unit tests (AuthGuard, LoginForm, SignupForm) + integration (auth-lifecycle) + browser (auth.spec.ts) + legacy (AuthContext, Login, Signup, ProtectedRoute)
- `docs/plans/briefs/phase-03b.md` — Hub DB
  - Content from: roadmap 3b + pgTAP (api_keys, activation stub) + integration (app-activation hub-only) + legacy (hub schema)
- `docs/plans/briefs/phase-03c.md` — Hub layout shell
  - Content from: roadmap 3c + browser (navigation.spec.ts) + legacy (ExtensionManager, MCPToolManager for nav pattern)
- `docs/plans/briefs/phase-03d.md` — Hub pages: Account, Apps, MCP Settings
  - Content from: roadmap 3d (Account, Apps, MCP) + unit (AppActivationCard, ApiKeyGenerator) + integration (profile-crud, api-key-lifecycle, app-activation) + browser (profile, app-activation, api-keys specs)
- `docs/plans/briefs/phase-03e.md` — Hub pages: Tools, Extensions + full Hub test suite
  - Content from: roadmap 3d (Tools, Extensions) + unit (ToolToggle, ExtensionCard) + integration (tool-config, extension-settings) + Phase 3 acceptance criteria

**Step 1: Read source docs** (all listed above)

**Step 2: Write all 6 brief files** following the template from design doc. Each ~60-100 lines. Include:

- Skills section
- Build section (exact files/tables)
- Test section (TDD assertions from comprehensive-test-plan)
- Legacy Reference (from legacy-reference.md)
- Commit message
- Acceptance criteria with exact test commands

**Step 3: Commit**

```
docs: generate phase 2-3 briefs (test infra + hub module)
```

---

## Task 6: Generate Phase 4–5 Briefs (4 files)

**Source docs to have open:**

- `docs/plans/2026-03-01-comprehensive-test-plan.md` (CoachByte sections)
- `docs/plans/2026-03-01-test-architecture-design.md` (CoachByte sections)
- `memory/project-roadmap.md` (Phase 4-5)
- `docs/apps/coachbyte.md` (updated with decision #6, #9)
- `memory/legacy-reference.md` (CoachByte section)

**Files to create:**

- `docs/plans/briefs/phase-04a.md` — CoachByte DB tables + RLS
  - Tables: exercises, user_settings, daily_plans, planned_sets, completed_sets, splits, timers
  - Tests: exercise_rls.test.sql, activation_coachbyte.test.sql
  - NOTE: No exercise_prs table (decision #6)
- `docs/plans/briefs/phase-04b.md` — CoachByte DB functions + flow tests
  - Functions: ensure_daily_plan, complete_next_set (no PR upsert), RPC wrappers
  - Tests: ensure_daily_plan.test.sql, complete_next_set.test.sql, timer_states.test.sql
  - Flow tests: coachbyte-workout.flow, coachbyte-timer.flow
  - Integration: app-activation-coachbyte.test.ts
- `docs/plans/briefs/phase-05a.md` — CoachByte UI: Today + Timer
  - Components: SetQueue, RestTimer, AdHocSetForm, session notes
  - Unit tests + realtime subscription integration test
- `docs/plans/briefs/phase-05b.md` — CoachByte UI: History + Split + PRs + Settings + browser tests
  - Components: HistoryList, SplitPlannerDay, PrCard (derived PRs), Settings page
  - All CoachByte browser tests (workout, timer, history, split-planner, prs, settings specs)

**Step 1: Read source docs**

**Step 2: Write all 4 brief files**

**Step 3: Commit**

```
docs: generate phase 4-5 briefs (coachbyte DB + UI)
```

---

## Task 7: Generate Phase 6 Briefs (5 files)

**Source docs to have open:**

- `docs/plans/2026-03-01-comprehensive-test-plan.md` (ChefByte DB sections)
- `docs/plans/2026-03-01-test-architecture-design.md` (ChefByte sections)
- `memory/project-roadmap.md` (Phase 6)
- `docs/apps/chefbyte.md` (updated with decision #22)
- `memory/legacy-reference.md` (ChefByte sections)

**Files to create:**

- `docs/plans/briefs/phase-06a.md` — Products + Stock + consume_product
  - Tables: products, stock_lots
  - Function: private.consume_product + chefbyte.consume_product wrapper
  - Tests: product-crud, stock-lot-operations integration + consume_product.test.sql
- `docs/plans/briefs/phase-06b.md` — Recipes + Meal Plan + mark_meal_done
  - Tables: recipes, recipe_ingredients, meal_plan (with CHECK, consider type column)
  - Function: private.mark_meal_done + wrapper
  - Tests: recipe-with-ingredients, meal-plan integration + mark_meal_done.test.sql
- `docs/plans/briefs/phase-06c.md` — Shopping + Macros + Logging + flow tests
  - Tables: shopping_list, food_logs, temp_items, target_macros
  - Functions: get_daily_macros, sync_meal_plan_to_shopping, import_shopping_to_inventory + wrappers
  - Tests: shopping-list, macro-logging integration + get_daily_macros.test.sql, sync_shopping.test.sql
  - All 3 ChefByte flow tests
- `docs/plans/briefs/phase-06d.md` — LiquidTrack + activation + types regen
  - Tables: liquidtrack_devices, liquidtrack_events (supports device_id='manual' for Liquid Log)
  - Extend activate_app with ChefByte branch
  - Tests: activation_chefbyte.test.sql, app-activation-chefbyte.test.ts
  - DB types regeneration
- `docs/plans/briefs/phase-06e.md` — analyze-product Edge Function
  - Edge function: OpenFoodFacts → Claude Haiku → 4-4-9 validation
  - Tests: analyze-product.test.ts (HTTP integration)

**Step 1: Read source docs**

**Step 2: Write all 5 brief files**

**Step 3: Commit**

```
docs: generate phase 6 briefs (chefbyte DB + edge function)
```

---

## Task 8: Generate Phase 7–10 Briefs (7 files)

**Source docs to have open:**

- `docs/plans/2026-03-01-comprehensive-test-plan.md` (ChefByte UI + MCP sections)
- `docs/plans/2026-03-01-test-architecture-design.md` (browser tests + MCP)
- `memory/project-roadmap.md` (Phase 7-10)
- `docs/apps/chefbyte.md`, `docs/mcp/guide.md`
- `memory/legacy-reference.md`

**Files to create:**

- `docs/plans/briefs/phase-07a.md` — ChefByte UI: Scanner + Dashboard
  - Components: ScannerModeSelector, TransactionQueue, NutritionEditor, MacroCard, TempItemForm, Dashboard
  - Liquid Log writes to liquidtrack_events (decision #22)
- `docs/plans/briefs/phase-07b.md` — ChefByte UI: Inventory + Shopping + Meal Plan
  - Components: InventoryGroup, ShoppingListItem, MealPlanDayCard
  - Integration: realtime-subscriptions (chefbyte)
- `docs/plans/briefs/phase-07c.md` — ChefByte UI: Recipes + Walmart + Settings + browser tests
  - Components: RecipeIngredientEditor, RecipeFilterBar, Walmart page, Settings (Products + LiquidTrack tabs)
  - All ChefByte browser tests (9 spec files)
- `docs/plans/briefs/phase-08.md` — Remaining Edge Functions
  - walmart-scrape + liquidtrack edge functions
  - Integration tests for both
- `docs/plans/briefs/phase-09a.md` — MCP Worker: Core + Auth
  - SSE transport, API key auth, OAuth 2.1 PKCE, Durable Objects session
  - Unit tests: auth, tool-dispatch, tool-registry, oauth
- `docs/plans/briefs/phase-09b.md` — MCP Worker: Tools + Extensions
  - 11 CoachByte tools, 19 ChefByte tools, extension tools
  - Integration: SSE connection, tool-execution, tool-filtering, extension-tools
  - Flow: cross-module.flow.test.ts
- `docs/plans/briefs/phase-10.md` — Integration + Polish
  - Cross-module nav, offline indicator, error boundaries, loading states
  - Browser tests: full-journey, offline-indicator, responsive-layout, error-boundaries
  - Final docs update

**Step 1: Read source docs**

**Step 2: Write all 7 brief files**

**Step 3: Commit**

```
docs: generate phase 7-10 briefs (chefbyte UI + edge functions + MCP + polish)
```

---

## Task 9: Slim Roadmap to Checklist Index

**Files:**

- Modify: `memory/project-roadmap.md`

**Step 1: Read current roadmap**

**Step 2: Rewrite roadmap** as slim checklist (~120 lines):

```markdown
## Phase 1: Setup [DONE]

## Phase 2: Test Infrastructure

- [ ] 2: Test infra → docs/plans/briefs/phase-02.md

## Phase 3: Hub Module

- [ ] 3a: Auth flow → docs/plans/briefs/phase-03a.md
- [ ] 3b: Hub DB → docs/plans/briefs/phase-03b.md
- [ ] 3c: Layout shell → docs/plans/briefs/phase-03c.md
- [ ] 3d: Account + Apps + MCP pages → docs/plans/briefs/phase-03d.md
- [ ] 3e: Tools + Extensions + Hub tests → docs/plans/briefs/phase-03e.md
      ...
```

Each entry: checkbox + brief name + file path. Phase acceptance criteria stay (1-2 lines each).

**Step 3: Commit**

```
docs: slim roadmap to checklist index with brief links
```

---

## Task 10: Update patterns.md

**Files:**

- Modify: `memory/patterns.md`

**Step 1: Read current patterns.md**

**Step 2: Add new sections:**

**Required Skills section:**

```markdown
## Required Skills

### Every Work Unit

- `test-driven-development` — before writing implementation code
- `verification-before-completion` — before claiming done
- `systematic-debugging` — when any test fails
- `context7` — when using library APIs

### Phase Boundaries

- `requesting-code-review` — after completing a full phase
- `simplify` — after each work unit

### UI Phases (5, 7, 10)

- `frontend-design` — when building UI components/pages

### Situational

- `dispatching-parallel-agents` — multiple independent tasks
- `claude-developer-platform` — Phase 6e (analyze-product)
- `executing-plans` — starting work unit from brief
```

**Decision Process section:**

```markdown
## Decision Process

1. Check legacy code FIRST (use legacy-reference.md)
2. Clear answer? → Use it. Log as "legacy-confirmed"
3. No answer? → Make the call. Log as "new-decision"
```

**Test Conventions section** (migrated from test-architecture-design.md):

```markdown
## Test Conventions

- Test isolation: each test creates unique user via admin API, cleanup in afterEach
- RLS isolates test data — interference = real bug
- Global seed data (exercises) seeded once in migration, never per-test
- External APIs always mocked (OpenFoodFacts, Claude, Walmart)
- TDD at file level: write all assertions → RED → implement → GREEN
- pgTAP tests: supabase/tests/<schema>/
- Unit tests: apps/web/src/**tests**/unit/<module>/
- Integration tests: apps/web/src/**tests**/integration/<module>/
- Flow tests: apps/web/src/**tests**/flows/
- Browser tests: apps/web/e2e/{hub,coachbyte,chefbyte,cross-module}/
```

**Update Context Window Management** to reference briefs:

```markdown
## Context Window Management

- Session startup: read current-task.md → read the brief it points to → work
- ascii-layouts.md is 63KB — extract only the relevant section per page
- Legacy code — use legacy-reference.md. Don't explore the whole tree.
- Spec docs — read only if brief references them
```

**Step 3: Commit**

```
docs: add required skills, decision process, test conventions to patterns.md
```

---

## Task 11: Archive decisions.md

**Files:**

- Modify: `memory/decisions.md`

**Step 1: Read current decisions.md**

**Step 2: Restructure:**

- Move all 22 decisions to an `## Archived (Reviewed)` section at bottom
- Mark #1-4 as `user-confirmed`, #5-22 as `reviewed-approved`
- Mark #6, #9, #22 as `reviewed-changed` with note about the change
- Reset active section:

```markdown
# Design Decisions Log

## Active Decisions

_No pending decisions._

## Archived (Reviewed 2026-03-02)

[all 22 decisions here, status updated]
```

**Step 3: Commit**

```
docs: archive all 22 reviewed decisions
```

---

## Task 12: Update MEMORY.md + current-task.md

**Files:**

- Modify: `memory/MEMORY.md`
- Modify: `memory/current-task.md`

**Step 1: Read both files**

**Step 2: Update MEMORY.md:**

- Session Startup Protocol → new 2-read process
- Current State → "Working on: Phase 2 next"
- Flagged decisions → "All reviewed and archived"
- Add brief reference to Memory Files section

**Step 3: Update current-task.md:**

```markdown
## Status: IDLE

Doc restructuring complete. Ready for Phase 2.

### Current brief

docs/plans/briefs/phase-02.md

### Next action

Read the Phase 2 brief and begin test infrastructure setup.
```

**Step 4: Commit**

```
docs: update memory files for brief-based workflow
```

---

## Task 13: Delete Old Test Docs

**Files:**

- Delete: `docs/plans/2026-03-01-test-architecture-design.md`
- Delete: `docs/plans/2026-03-01-comprehensive-test-plan.md`
- Delete: `docs/plans/2026-03-02-feature-test-traceability.md`

**Step 1: Verify all content is absorbed**

- Grep for key terms from each doc in the briefs directory
- Spot check: flow test descriptions, pgTAP assertions, browser test specs
- Count: all 97 test files mentioned somewhere in briefs

**Step 2: Delete files**

```bash
git rm docs/plans/2026-03-01-test-architecture-design.md
git rm docs/plans/2026-03-01-comprehensive-test-plan.md
git rm docs/plans/2026-03-02-feature-test-traceability.md
```

**Step 3: Commit**

```
docs: remove old test docs (content absorbed into briefs)
```

---

## Task 14: Final Verification

**Step 1: Check file counts**

```bash
ls docs/plans/briefs/ | wc -l  # expect 22
```

**Step 2: Verify brief structure** — spot check 3 briefs (one per module):

- phase-03b.md (Hub DB)
- phase-04b.md (CoachByte functions)
- phase-06a.md (ChefByte Products+Stock)
  Each should have: Skills, Build, Test, Legacy Reference, Commit, Acceptance sections.

**Step 3: Verify roadmap links** — every brief path in roadmap should exist as a file.

**Step 4: Verify spec changes** — coachbyte.md has no exercise_prs, no Epley cap. chefbyte.md has Liquid Log → liquidtrack_events.

**Step 5: Verify patterns.md** — has Required Skills, Decision Process, Test Conventions sections.

**Step 6: Run typecheck** (sanity — no code changed, should still pass)

```bash
pnpm typecheck
```

**Step 7: Final commit if any fixes needed**

```
docs: fix any issues found in verification
```

---

## Execution Strategy

Tasks 1-3 (decision changes) are sequential — each edits spec docs.
Task 4 (mkdir) is trivial.
Tasks 5-8 (brief generation) can run as **parallel agents** — each batch is independent.
Tasks 9-12 (memory/process updates) are sequential.
Task 13 (delete old docs) depends on 5-8 being complete.
Task 14 (verification) is last.

**Recommended:** Subagent-driven in this session. Use `dispatching-parallel-agents` for Tasks 5-8 (4 agents generating briefs in parallel). Sequential for everything else.
