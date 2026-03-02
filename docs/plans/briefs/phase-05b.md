# Phase 05b: CoachByte UI — History + Split + PRs + Settings + Browser Tests
> Previous: phase-05a.md | Next: phase-06a.md

## Skills
test-driven-development, frontend-design, requesting-code-review (phase boundary)

## Build

**History page (`/coach/history`):**
- Day list table: Date, Summary, Sets (completed/total) columns
- Click day → expandable detail (same layout as Today, read-only)
- Exercise filter dropdown
- Keyset pagination: `WHERE plan_date < $cursor ORDER BY plan_date DESC LIMIT 20`, Load More button

**Split Planner page (`/coach/split`):**
- Vertical 7-day layout (Sunday through Saturday)
- Each day: editable table (Exercise, Reps, Load, Relative % checkbox, Rest, Order)
- Add Exercise button per day, delete/reorder per row
- Split notes textarea per day

**PR Tracker page (`/coach/prs`):**
- Exercise cards for every exercise with completed_sets history (no tracking management)
- Each card: exercise name, estimated 1RM (derived via Epley from completed_sets), rep-range pills (1RM through 10RM)
- Epley: `load * (1 + reps/30)`, no rep cap, 1-rep uses actual weight, 0-rep excluded
- PR alert toast when computed best exceeds previous session's best

**Settings page (`/coach/settings`):**
- Default rest duration input (persists to user_settings.default_rest_seconds)
- Plate calculator: bar weight input, available plates editor (add/remove plate sizes)
- Exercise library: search, list showing global + custom, delete button for custom only

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/coachbyte/HistoryList.test.tsx`
- Renders day rows with Date, Summary, Sets (completed/total) columns
- Click day → expands to show set details (exercise, reps, load)
- Load More button visible when more data available
- Click Load More → calls paginate callback with cursor value
- Exercise filter dropdown → calls filter callback
- Empty history → shows "No workout history" message

### Unit: `apps/web/src/__tests__/unit/coachbyte/SplitPlannerDay.test.tsx`
- Renders exercise rows with Exercise, Reps, Load, %, Rest, Order columns
- Add Exercise button appends empty row
- Delete button removes specific row
- Reorder (up/down buttons) updates order values
- Percentage toggle enables/disables relative load input
- Changes call save callback with updated template
- Split notes textarea renders and updates

### Unit: `apps/web/src/__tests__/unit/coachbyte/PrCard.test.tsx`
- Displays exercise name and estimated 1RM value (derived from completed_sets)
- Rep-range pills render (e.g., "5RM: 225lb", "3RM: 235lb") for 1RM through 10RM
- When new PR prop changes → fires toast notification
- No PR data → shows placeholder state

### Integration: `apps/web/src/__tests__/integration/coachbyte/history-pagination.test.ts`
- Insert 25 days of completed workout data
- Query page 1 (limit 20) → returns 20 results, ordered by date DESC
- Query with cursor (last date from page 1) → returns remaining 5
- Filter by exercise → only days containing that exercise returned
- Empty history → returns empty array

### Integration: `apps/web/src/__tests__/integration/coachbyte/split-crud.test.ts`
- Create split for weekday → template_sets stored correctly
- Update split → new template replaces old
- Bootstrap next day → uses updated template
- Delete split for weekday → next bootstrap creates empty plan

### Integration: `apps/web/src/__tests__/integration/coachbyte/set-completion.test.ts`
- complete_next_set → completed_set row created with correct exercise, reps, load
- Call again → creates next set in order (sequential enforcement)
- Override reps/load → stored in completed_set
- Derived PR computed correctly from completed_sets via Epley (no PR table)
- Verify completion returns rest_seconds from next planned set

### Integration: `apps/web/src/__tests__/integration/coachbyte/timer-operations.test.ts`
- Start timer (90s) → timer row with state=running, correct end_time
- Pause → state=paused, elapsed_before_pause stored
- Resume → state=running, recalculated end_time
- Expire (manipulate end_time to past) → state=expired
- Start new timer → replaces existing timer (one per user)

### Browser: `apps/web/e2e/coachbyte/workout.spec.ts`
- Navigate to /coach → Today page loads with set queue
- Complete a set → queue advances, completed section updates
- Override reps/load → stored values reflected
- Ad-hoc set form opens, submits, appears in completed
- Summary textarea saves notes

### Browser: `apps/web/e2e/coachbyte/timer.spec.ts`
- Timer starts after set completion, countdown visible
- Pause/resume toggles display
- Custom duration input starts new timer
- Tab blur + focus → timer recalculates from end_time
- Expired timer shows distinct state

### Browser: `apps/web/e2e/coachbyte/history.spec.ts`
- History page lists past workout days with summary
- Click day → detail expands showing sets
- Load More fetches additional days
- Exercise filter narrows results

### Browser: `apps/web/e2e/coachbyte/split-planner.spec.ts`
- Split page shows 7-day grid
- Add exercise to a day → row appears
- Edit reps/load/rest/order → persists on save
- Percentage toggle shows relative load input
- Split notes textarea saves

### Browser: `apps/web/e2e/coachbyte/prs.spec.ts`
- PR page shows exercise cards with 1RM estimates (derived from completed_sets)
- Rep-range pills (1RM-10RM) display correctly
- New PR triggers toast notification
- All exercises with history appear (no tracking management)

### Browser: `apps/web/e2e/coachbyte/settings.spec.ts`
- Default rest duration editable and persists
- Plate calculator: bar weight and available plates editable
- Exercise library: search works, global + custom exercises listed
- Custom exercise CRUD (add, delete), global exercises not deletable

## Legacy Reference
- `legacy/luna_ext_coachbyte/services/api/server.py` — REST routes for history, splits, timer (port logic to React)
- `legacy/luna_ext_coachbyte/tools/coachbyte_tools.py` — tool definitions showing data shapes

## Commit
`feat: coachbyte UI — history, split, PRs, settings + browser tests`

## Acceptance
- [ ] History page renders with keyset pagination and exercise filter
- [ ] Split Planner editable for all 7 days with CRUD + reorder
- [ ] PR Tracker shows derived 1RM (Epley from completed_sets, no PR table) + rep-range pills 1RM-10RM
- [ ] Settings page persists rest duration, plate config, exercise library CRUD
- [ ] No exercise_prs table referenced anywhere in UI code
- [ ] Unit tests pass: `pnpm --filter web exec vitest run src/__tests__/unit/coachbyte/`
- [ ] Integration tests pass: `pnpm --filter web exec vitest -c vitest.integration.config.ts run src/__tests__/integration/coachbyte/`
- [ ] Browser tests pass: `pnpm --filter web exec playwright test e2e/coachbyte/`
- [ ] Phase boundary full suite: `supabase test db && pnpm test && pnpm typecheck && pnpm --filter web exec playwright test e2e/coachbyte/`
