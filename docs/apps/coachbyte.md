# CoachByte

## Purpose

Strength training copilot: workout programming, set tracking, PR monitoring, rest timers.

## Features

### Today's Workout
- Displays the current day's plan queue (ordered list of planned sets)
- Each set shows exercise, target reps, target load, rest duration
- Relative loads (percentage-based) display both the percentage and calculated weight based on current PRs (Epley 1RM estimate)
- Sets are completed sequentially in order — enforced in the database function (`complete_next_set` queries for the lowest-order incomplete set)
- Override reps/load on completion
- Automatic rest timer starts after each completion, seeded from the next set's rest duration
- Summary field for session notes
- Ad-hoc sets not in the plan
- Offline indicator — write buttons disabled when offline

### Day Lifecycle
- When the user opens the app, a database function ensures today's log exists using `private.get_logical_date()` to determine "today"
- `UNIQUE(user_id, plan_date)` constraint + `INSERT ... ON CONFLICT DO NOTHING` ensures idempotent bootstrap. The entire bootstrap (create log + copy template) runs in a single transaction.
- If no planned sets exist, copies the matching weekday's split template into planned sets
- Relative loads are resolved to concrete weights using current PR data at bootstrap time. Rounding: nearest 5 lbs (2.5 kg for metric). Both raw percentage and resolved weight are stored so the calculation is explainable. If no PR exists for an exercise, resolved weight is `null` — displayed as "—" with prompt to enter manually. User overrides at completion time.
- Intra-day PR changes do not retroactively update already-resolved planned sets. If the user wants updated weights, they delete today's plan (delete button) which forces a fresh reload from the current split template.
- Days are only created when the user opens the app — no pre-generation of future days
- Day cleanup is a side effect of bootstrap: when creating today's plan, also delete the previous day's plan if it has zero completed sets. Only the immediately preceding day is checked, not the entire history.
- Split template edits apply to future bootstraps only. Already-created daily plans are independent copies.
- If the active split template for today's weekday has zero exercises, bootstrap creates an empty daily plan. The user can add ad-hoc sets or ignore the day.

### Rest Timer
- Large countdown display (desktop: panel alongside workout view; post-MVP mobile: full-screen overlay)
- Timer state machine stored in DB: `state` (running/paused/expired), `end_time`, `paused_at`, `duration_seconds`, `elapsed_before_pause`. Remaining time computed dynamically.
- State transitions use atomic guards: `UPDATE timers SET state = 'paused', paused_at = NOW() WHERE user_id = $1 AND state = 'running'` — second device's update affects 0 rows.
- Expiration detection: `UPDATE timers SET state = 'expired' WHERE user_id = $1 AND state = 'running' AND end_time <= NOW()`. Exactly-once via atomic WHERE.
- Realtime subscription fires only when timer row changes (not every tick)
- Manual timer control (start custom duration, pause, reset)
- Syncs across devices and is readable/settable by MCP agent
- Tab/window focus recovery: when the browser tab regains focus, recalculate remaining time from stored `end_time`. If expired, immediately show "Timer expired."

### Weekly Split Planner
- 7-day template grid (Sunday–Saturday)
- Each day shows template sets (exercise, reps, load, rest, order)
- Supports relative loads (percentage of 1RM) in templates
- Split notes field for freeform programming context

### PR Tracker
- Tracked exercises list (user selects which to monitor)
- Actual PRs aggregated from completed sets (best load at each rep count per exercise)
- Epley 1RM calculation rules: 1-rep sets use actual weight (not Epley), failed sets (0 reps) excluded, e1RM capped at 10 reps (accuracy degrades beyond 10)
- PR update uses atomic improvement guard: `UPDATE exercise_prs SET e1rm = $1 WHERE user_id = $2 AND exercise_id = $3 AND e1rm < $1`
- PR alerts when a new best is logged

### History
- Keyset pagination: `WHERE user_id = $1 AND plan_date < $cursor ORDER BY plan_date DESC LIMIT 20`
- Each day expandable to show planned vs completed sets
- Day summaries visible in list view
- Filterable by exercise

### Exercise Library
- Shared global exercise library seeded when a user activates CoachByte. Update strategy for the global library is deferred.
- Users can add custom exercises (scoped to their account)
- Global exercises have `user_id = NULL`, custom exercises have the user's ID
- Uniqueness: `UNIQUE(user_id, LOWER(name))` — case-insensitive per user. Global exercises enforced separately.

### Settings
- Default rest duration
- Tracked exercise management

## CoachByte UX (Ionic)

Desktop-first with responsive design.

**Navigation:** Top navigation bar with tabs: Today (default landing) / History / Split / PRs / Settings.

**Pages:**

- **Today's Workout** (default landing page): Next-in-queue completion section at top showing current exercise, target reps/load, override inputs, complete button, and inline countdown timer (seeded from next set's rest duration). Timer controls: pause/resume, reset, start custom duration. Below: two-column layout — set queue on left (remaining planned sets with exercise, reps, load, rest), completed sets on right (read-only log of finished sets). Ad-hoc set button. Summary textarea at bottom for session notes. Relative loads show both percentage and calculated weight (e.g., "85% of 371").
- **History**: Day list table with Date, Summary, Sets (completed/total) columns. Filter by exercise dropdown. Click a day to open its detail (same layout as Today's Workout, read-only for past days). Keyset pagination with Load More.
- **Split Planner**: Vertical day-by-day layout (Sunday through Saturday). Each day has a label and editable table: Exercise, Reps, Load, Relative (% checkbox), Rest, Order. Add Exercise button per day. Split notes textarea at bottom.
- **PR Tracker**: Exercise cards — each card shows exercise name, estimated 1RM, and rep-range pills (e.g., "5 rep: 225 lb", "3 rep: 235 lb"). Tracked exercise management section below: text input to add exercises, existing tracked exercises shown as removable pills. PR alerts as toast notifications.
- **Settings**: Default rest duration input. Plate calculator settings (bar weight, available plate sizes). Exercise library with search, showing global and custom exercises with delete for custom.

**Shared across layouts:**
- Toast notifications for set completed, PR alerts
- Offline indicator (disabled buttons + "no connection" banner)

## CoachByte MCP Tools

| Tool | Purpose |
|------|---------|
| `COACHBYTE_get_today_plan` | Return today's plan queue with resolved loads |
| `COACHBYTE_complete_next_set` | Complete the next set in order (rep/load overrides) |
| `COACHBYTE_log_set` | Log an ad-hoc set not in the plan |
| `COACHBYTE_update_plan` | Add or modify planned sets for today |
| `COACHBYTE_update_summary` | Set today's session notes |
| `COACHBYTE_get_history` | Return past N days of training data |
| `COACHBYTE_get_split` | Fetch weekly split template |
| `COACHBYTE_update_split` | Replace a weekday's template sets |
| `COACHBYTE_set_timer` | Start or reset the rest timer |
| `COACHBYTE_get_timer` | Read current timer state |
| `COACHBYTE_get_prs` | PR data for tracked exercises |

## CoachByte Technical Notes

- **No edge functions required.** All operations are Supabase client SDK calls or database function RPCs via Supavisor.
- **Realtime subscriptions** on `planned_sets`, `completed_sets`, and `timer` tables filtered by `user_id`. Additional filtering (today's log) applied client-side.
- **Bootstrap function** is idempotent and safe for concurrent calls (UNIQUE constraint + ON CONFLICT).
- **Day boundary** computed via `private.get_logical_date()`, stored as `logical_date` on daily plans and completed sets.
- **Global exercise seed** runs as part of CoachByte activation.
