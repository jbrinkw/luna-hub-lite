# Doc Restructuring Design

## Problem

The current planning docs are optimized for human review, not AI agent execution. Three test docs (1,872 lines) with massive overlap require 7+ file reads per session. Phases are too coarse for single-session work. No clear commit boundaries within phases.

## Solution: Session-Sized Briefs

Replace the 3 test docs with ~22 self-contained brief files in `docs/plans/briefs/`. Each brief is one session's work. The roadmap becomes a slim checklist index. `current-task.md` points to the active brief.

## What Changes

### Deleted

- `docs/plans/2026-03-01-test-architecture-design.md` (420 lines)
- `docs/plans/2026-03-01-comprehensive-test-plan.md` (1042 lines)
- `docs/plans/2026-03-02-feature-test-traceability.md` (410 lines)

All content absorbed into briefs. Zero information loss.

### Created

```
docs/plans/briefs/
  phase-02.md        # Test infrastructure
  phase-03a.md       # Auth flow
  phase-03b.md       # Hub DB
  phase-03c.md       # Hub layout shell
  phase-03d.md       # Hub pages (Account, Apps, MCP)
  phase-03e.md       # Hub pages (Tools, Extensions) + Hub tests
  phase-04a.md       # CoachByte DB tables + RLS
  phase-04b.md       # CoachByte DB functions + flow tests
  phase-05a.md       # CoachByte UI: Today + Timer
  phase-05b.md       # CoachByte UI: History + Split + PRs + Settings + browser tests
  phase-06a.md       # ChefByte DB: Products + Stock + consume_product
  phase-06b.md       # ChefByte DB: Recipes + Meal Plan + mark_meal_done
  phase-06c.md       # ChefByte DB: Shopping + Macros + Logging + flow tests
  phase-06d.md       # ChefByte DB: LiquidTrack + activation + types regen
  phase-06e.md       # analyze-product Edge Function
  phase-07a.md       # ChefByte UI: Scanner + Dashboard
  phase-07b.md       # ChefByte UI: Inventory + Shopping + Meal Plan
  phase-07c.md       # ChefByte UI: Recipes + Walmart + Settings + browser tests
  phase-08.md        # Remaining Edge Functions
  phase-09a.md       # MCP Worker: Core + Auth
  phase-09b.md       # MCP Worker: Tools + Extensions
  phase-10.md        # Integration + Polish
```

### Updated

- `memory/project-roadmap.md` — Slimmed to checklist index (~120 lines) linking to briefs
- `memory/patterns.md` — Gains test conventions + required skills sections
- `memory/decisions.md` — All 22 decisions archived as reviewed, active section reset
- `memory/current-task.md` — Gains `brief:` field pointing to current brief file
- `memory/MEMORY.md` — Updated session startup protocol
- `docs/apps/coachbyte.md` — Decision #6 (derived PRs), #9 (no Epley cap)
- `docs/apps/chefbyte.md` — Decision #22 (Liquid Log → liquidtrack_events)

## Brief Template

```markdown
# Phase XX: [Name]

> Previous: phase-XXx.md | Next: phase-XXx.md

## Skills

[Which skills to invoke for this work unit]

## Build

[Exact files to create/modify, tables, functions, components]

## Test (TDD)

[Test filenames + assertions — write test FIRST, then implement]

### pgTAP: `supabase/tests/<path>.test.sql`

- assertion 1
- assertion 2

### Unit: `apps/web/src/__tests__/unit/<path>.test.tsx`

- assertion 1

### Integration: `apps/web/src/__tests__/integration/<path>.test.ts`

- assertion 1

## Legacy Reference

[Specific file paths to check before building]

## Commit

`<type>: <message>`

## Acceptance

- [ ] criterion 1
- [ ] targeted tests pass: `<exact command>`
```

## Session Lifecycle

### Startup (2 reads max)

1. MEMORY.md auto-loads → read Current State
2. Read current-task.md → get brief path + recovery point
3. If resuming: pick up from "Next action"
4. If new work unit: read the brief → work

### During Work

- TDD: write tests first (RED), implement (GREEN)
- Use `context7` for library API lookups
- Decisions: check legacy code FIRST, then make the call

### Completion

1. Run targeted tests (brief specifies which commands)
2. Invoke `simplify` skill — review code quality
3. Invoke `verification-before-completion` skill — evidence before assertions
4. Commit with brief's commit message template
5. Check off work unit in roadmap
6. Update current-task.md → point to next brief
7. Session done → next session starts clean

### Phase Boundaries

- Invoke `requesting-code-review` skill after completing a full phase
- Run full test suite: `supabase test db` + `pnpm test` + `pnpm typecheck`

## Decision Process

```
Encounter ambiguity or design question
        ↓
Check legacy code FIRST (use legacy-reference.md for file paths)
        ↓
   Clear answer? → Use it. Log as "legacy-confirmed" in decisions.md
        ↓
   No legacy answer? → Make the call. Log as "new-decision" in decisions.md
```

## Required Skills (patterns.md)

### Every Work Unit

| Skill                            | When                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `test-driven-development`        | Before writing implementation code                                |
| `verification-before-completion` | Before claiming done                                              |
| `systematic-debugging`           | When any test fails                                               |
| `context7`                       | When using library APIs (Supabase, Ionic, Playwright, CF Workers) |

### Phase Boundaries

| Skill                    | When                          |
| ------------------------ | ----------------------------- |
| `requesting-code-review` | After completing a full phase |
| `simplify`               | After each work unit          |

### UI Phases (5, 7, 10)

| Skill             | When                              |
| ----------------- | --------------------------------- |
| `frontend-design` | When building UI components/pages |

### Situational

| Skill                         | When                                         |
| ----------------------------- | -------------------------------------------- |
| `dispatching-parallel-agents` | Multiple independent tasks                   |
| `claude-developer-platform`   | Phase 6e (analyze-product uses Claude Haiku) |
| `executing-plans`             | Starting any work unit from a brief          |

## Decision Changes from Legacy Review

### #6: Remove exercise_prs table → Derive PRs

- No stored PR table. Derive from completed_sets via Epley formula.
- UI shows estimated 1RM through 10RM as rep-range pills.
- "Tracked exercises" is implicit — any exercise with completed sets appears.
- Removes one table and simplifies complete_next_set function.

### #9: Remove Epley 10-rep cap

- Legacy formula: `load * (1 + reps/30)` with no cap.
- All reps feed the formula. Display capped at 10RM in UI.

### #22: Liquid Log → liquidtrack_events (not temp_items)

- Legacy writes manual liquid entries to `liquid_events` with `scale_id='manual'`.
- Our equivalent: write to `liquidtrack_events` with `device_id='manual'`.
- weight_before/weight_after = 0 for manual entries (matching legacy pattern).

## Doc Maintenance (Simplified)

| Document                                      | When to update                                |
| --------------------------------------------- | --------------------------------------------- |
| Spec docs (hub.md, coachbyte.md, chefbyte.md) | If user-facing behavior changes               |
| database.md                                   | If schema conventions change                  |
| patterns.md                                   | If new conventions discovered                 |
| decisions.md                                  | When design decisions made                    |
| Briefs                                        | Never — they're execution plans, already done |
| Roadmap                                       | Check off completed work units                |
| current-task.md                               | Every session end + work unit transitions     |
