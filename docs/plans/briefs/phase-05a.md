# Phase 05a: CoachByte UI — Today's Workout + Rest Timer
> Previous: phase-04b.md | Next: phase-05b.md

## Skills
test-driven-development, test-quality-review, frontend-design, context7 (Ionic React, Supabase Realtime)

## Build

**Layout + Routing:**
- CoachByte layout shell with top navigation tabs: Today (default), History, Split, PRs, Settings
- Routes in App.tsx: `/coach`, `/coach/history`, `/coach/split`, `/coach/prs`, `/coach/settings`
- CoachByte nav component (IonTabs or custom tab bar)

**Today's Workout page (`/coach`):**
- `SetQueue` component — ordered list of planned sets, next incomplete highlighted, override inputs (reps, load) on active set, complete button
- `AdHocSetForm` component — exercise search/select, reps + load inputs, submit/cancel
- Two-column desktop layout: set queue (left), completed sets (right, read-only log)
- Summary textarea for session notes
- Relative loads display both percentage and resolved weight (e.g., "85% of 300 = 255lb")
- NULL resolved weight displays "---" with manual entry prompt

**Rest Timer component:**
- Large countdown display (mm:ss format)
- Pause/resume/reset buttons, custom duration input
- Realtime subscription on `coachbyte.timers` filtered by user_id
- Tab focus recovery: on visibility change, recalculate remaining from stored end_time
- Expired state renders distinct visual (e.g., "Timer expired" with reset option)

**Realtime subscriptions:**
- `coachbyte.timers` INSERT/UPDATE → timer state sync
- `coachbyte.planned_sets` INSERT/UPDATE/DELETE → set queue refresh
- `coachbyte.completed_sets` INSERT → completed log refresh

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/coachbyte/SetQueue.test.tsx`
- Renders planned sets in order (exercise name, target reps, target load, rest)
- Highlights the next incomplete set (first in queue)
- Active set shows override inputs (reps, load) pre-filled with targets
- Complete button calls completion callback with override values
- When no plan exists → shows "No workout planned" message
- Completed sets shown differently (strikethrough or moved to completed section)
- Relative loads display both percentage and resolved weight ("85% of 300 = 255lb")
- NULL resolved weight shows "---" with prompt

### Unit: `apps/web/src/__tests__/unit/coachbyte/RestTimer.test.tsx`
- Renders countdown from given duration (mm:ss format)
- Countdown updates via setInterval
- Pause button → interval cleared, display frozen
- Resume button → interval restarted from remaining time
- Custom duration input → starts new countdown
- Reset button → stops timer, returns to idle state
- When timer expires (0:00) → shows "Timer expired" state, different visual
- Large display format for desktop

### Unit: `apps/web/src/__tests__/unit/coachbyte/AdHocSetForm.test.tsx`
- Exercise search/select dropdown
- Reps and load inputs with numeric validation (positive integers/decimals only)
- Submit button calls add callback with set data (exercise_id, reps, load)
- Cancel button closes form
- Empty exercise selection → submit disabled

### Integration: `apps/web/src/__tests__/integration/coachbyte/realtime-subscriptions.test.ts`
- Subscribe to timer changes → make timer update via second client → subscriber receives change event
- Subscribe to completed_sets → complete a set via RPC → subscriber receives INSERT event
- Subscribe to planned_sets → add planned set → subscriber receives INSERT event
- Verify subscription filters by user_id (User B changes don't trigger User A's subscription)

### Quality gate
After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference
- `legacy/luna_ext_coachbyte/services/api/server.py` — REST routes for plan, set completion, timer (port logic)
- `legacy/luna_ext_coachbyte/tools/coachbyte_tools.py` — tool handlers showing data flow patterns

## Commit
`feat: coachbyte UI — today's workout + rest timer`

## Acceptance
- [ ] CoachByte routes registered at /coach/* with tab navigation
- [ ] Today page renders set queue, highlights active set, completes sequentially via RPC
- [ ] Ad-hoc set form adds unplanned sets
- [ ] Rest timer counts down, pauses/resumes, handles tab focus recovery
- [ ] Realtime subscriptions update timer + set displays without polling
- [ ] Two-column desktop layout (queue left, completed right)
- [ ] Unit tests pass: `pnpm --filter web exec vitest run src/__tests__/unit/coachbyte/SetQueue.test.tsx src/__tests__/unit/coachbyte/RestTimer.test.tsx src/__tests__/unit/coachbyte/AdHocSetForm.test.tsx`
- [ ] Integration tests pass: `pnpm --filter web exec vitest -c vitest.integration.config.ts run src/__tests__/integration/coachbyte/realtime-subscriptions.test.ts`
- [ ] Dev server renders Today page with functional timer: `pnpm dev` → open http://localhost:5173/coach
