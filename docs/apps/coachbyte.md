# CoachByte

## Purpose

Strength training copilot: workout programming, set tracking, PR monitoring, rest timers.

## Features

### Today's Workout

- Displays the current day's plan queue (ordered list of planned sets)
- Each set shows exercise, target reps, target load, rest duration
- Plate breakdown display: loads are formatted with plate calculation showing plates per side (e.g. "185 (45,25)" means 45 lb bar + one 45 and one 25 per side). Weights at or below bar weight display as "bar". Plate breakdown appears in both the next-in-queue card and the completed sets table.
- Relative loads (percentage-based) display both the percentage and calculated weight based on current PRs (Epley 1RM estimate)
- Sets are completed sequentially in order — enforced in the database function (`complete_next_set` queries for the lowest-order incomplete set)
- Override reps/load on completion
- Validation error display: if reps or load inputs are not valid numbers, an inline error message ("Please enter valid numbers for reps and load.") is shown below the complete button for 4 seconds
- Automatic rest timer starts after each completion, seeded from the next set's rest duration
- PR toast notifications: after completing a set, the system computes the Epley 1RM for the just-completed set and compares it against all previous completed sets for that exercise. If the new e1RM exceeds the previous best, a success-colored IonToast appears at the top of the page showing "NEW PR! {exercise} e1RM: {value} lb (was {previous})". First-ever sets for an exercise also trigger a "First record!" toast.
- Inline editing of planned sets: reps, load, and rest seconds for queued (pending) sets are editable directly in the queue table via IonInput fields that save on blur. Realtime refresh is suppressed while editing to prevent input clobbering.
- Add/delete planned sets: a "+ Add Set" button below the queue table opens an exercise/reps/load form to insert a new planned set at the end of the queue. Each queued set has a delete button (X icon) to remove it.
- Delete completed sets with two-click confirmation: each completed set row has a "Remove" button that changes to "Confirm?" on first click (with a 3-second auto-reset timeout), then deletes on second click.
- Reset Plan button: a "Reset Plan" button above the workout grid uses two-click confirmation (changes to "Confirm Reset?" for 3 seconds). When confirmed, deletes the current daily plan (cascade deletes planned sets), then reloads which triggers `ensure_daily_plan` to regenerate from the split template.
- Workout notes textarea (`daily_plans.notes` column): a freeform text area for workout observations, saved with debounced save-on-blur (500ms debounce, immediate save on blur). Separate from the summary field.
- Summary field for session notes (debounced save-on-blur)
- Timer expired state: when the RestTimer component detects expiration, `handleTimerExpired` writes `state: 'expired'` to the timers DB row
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
- Each day shows template sets (exercise, reps, load, rest, order). Order numbers are displayed in the first column of each template set row.
- Supports relative loads (percentage of 1RM) in templates
- Split notes field for freeform programming context

### PR Tracker

- PRs derived from completed_sets — no separate PR storage table
- For each exercise with completed sets, the best load at each rep count is computed
- Epley 1RM formula: `load × (1 + reps/30)`. All reps feed the formula (no rep cap). 1-rep sets use actual weight (not Epley). Failed sets (0 reps) excluded.
- UI displays estimated 1RM and rep-range pills (chips showing e.g. "5 rep: 225 lb") for each tracked exercise
- 90-day default filter: PRs are computed from completed sets within the last 90 days by default. A "Load All History" button (shown when the filter is active) switches to all-time PR data. The current filter range is displayed as informational text below the PR cards.
- Tracked exercises persisted to DB: users can search for and add/remove exercises from their tracked list. The tracked exercise IDs are saved to `coachbyte.user_settings.pr_tracked_exercise_ids` (JSON array column). On load, if saved tracked IDs exist, only those exercises are shown; otherwise all exercises with history are displayed. Tracked exercise chips are shown below the PR cards with click-to-remove behavior.
- PR alerts when a computed best exceeds previous session's best (toast on TodayPage after set completion)

### History

- Keyset pagination: `WHERE user_id = $1 AND plan_date < $cursor ORDER BY plan_date DESC LIMIT 20`
- Empty days filtered out: only days with at least one completed set are displayed in the history list
- Each day expandable to show completed sets with exercise name, reps, load, and completion timestamp
- Human-friendly date formatting: dates displayed as "Mon, Mar 3" style via `Intl.DateTimeFormat`. Completion timestamps in the detail view display the time (e.g. "2:30 PM") using `Intl.DateTimeFormat` with hour/minute.
- Day summaries visible in list view
- Exercise filter: an IonSelect dropdown at the top allows filtering the history to only show days that have completed sets for the selected exercise. Filtering queries `completed_sets` by `exercise_id` to determine which plan IDs to display.

### Exercise Library

- Shared global exercise library seeded when a user activates CoachByte. Update strategy for the global library is deferred.
- Users can add custom exercises (scoped to their account)
- Global exercises have `user_id = NULL`, custom exercises have the user's ID
- Uniqueness: `UNIQUE(user_id, LOWER(name))` — case-insensitive per user. Global exercises enforced separately.

### Settings

- Default rest duration

## CoachByte UX (Ionic)

Desktop-first with responsive design.

**Navigation:** Top navigation bar with tabs: Today (default landing) / History / Split / PRs / Settings.

**Pages:**

- **Today's Workout** (default landing page): Reset Plan button (two-click confirm) at top right. Next-in-queue completion section showing current exercise, target reps/load with plate breakdown (e.g. "185 (45,25) lb"), override inputs, complete button, ad-hoc set button, and validation error display. Below: two-column layout — set queue on left (remaining planned sets with inline-editable reps, load, and rest fields; delete button per set; "+ Add Set" button), completed sets on right (log of finished sets with plate breakdown, two-click remove per set). Workout notes textarea below completed sets for freeform observations. Countdown timer panel (pause/resume/reset/start custom) alongside workout view. Summary textarea at bottom for session notes. PR toast notifications on new personal records. Relative loads show both percentage and calculated weight (e.g., "85% of 371").
- **History**: Day list table with Date (human-friendly, e.g. "Mon, Mar 3"), Summary, Sets (completed/total) columns. Empty days (zero completed sets) are filtered out. Exercise filter dropdown (IonSelect) to show only days containing the selected exercise. Click a day to expand its detail card showing completed sets with exercise, reps, load, and completion time. Keyset pagination with Load More.
- **Split Planner**: Vertical day-by-day layout (Sunday through Saturday). Each day has a label and editable table: Order number (#), Exercise, Reps, Load, Relative (% checkbox), Rest, and delete button. Add Exercise button and Save button per day. Split notes textarea per day.
- **PR Tracker**: Exercise cards for tracked exercises — each card shows exercise name, estimated 1RM, and rep-range chips (e.g. "5 rep: 225 lb"). 90-day default date filter with "Showing PRs from last 90 days" info text and "Load All History" button. Tracked exercises management card: search input to find and add exercises, IonChip list of tracked exercises with click-to-remove. Tracked exercise selections persisted to DB (`pr_tracked_exercise_ids`). PR alerts as toast notifications (on TodayPage).
- **Settings**: Default rest duration input. Plate calculator settings (bar weight, available plate sizes). Exercise library with search, showing global and custom exercises with delete for custom.

**Shared across layouts:**

- Toast notifications for set completed, PR alerts
- Offline indicator (disabled buttons + "no connection" banner)

## CoachByte MCP Tools

| Tool                          | Purpose                                                                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COACHBYTE_get_today_plan`    | Return today's plan queue with resolved loads                                                                                                                                                             |
| `COACHBYTE_complete_next_set` | Complete the next set in order (rep/load overrides)                                                                                                                                                       |
| `COACHBYTE_log_set`           | Log an ad-hoc set not in the plan                                                                                                                                                                         |
| `COACHBYTE_update_plan`       | Add or modify planned sets for today                                                                                                                                                                      |
| `COACHBYTE_update_summary`    | Set today's session notes                                                                                                                                                                                 |
| `COACHBYTE_get_history`       | Return past N days of training data                                                                                                                                                                       |
| `COACHBYTE_get_split`         | Fetch weekly split template                                                                                                                                                                               |
| `COACHBYTE_update_split`      | Replace a weekday's template sets                                                                                                                                                                         |
| `COACHBYTE_get_exercises`     | Get all exercises for the user, with optional search filter (case-insensitive name match)                                                                                                                 |
| `COACHBYTE_set_timer`         | Start or reset the rest timer                                                                                                                                                                             |
| `COACHBYTE_get_timer`         | Read current timer state and remaining seconds. Detects expired timers: if a running timer's `end_time` has passed, writes `state: 'done'` to DB and returns `state: 'done'` with `remaining_seconds: 0`. |
| `COACHBYTE_pause_timer`       | Pause a running rest timer. Stores elapsed time so it can be resumed later. Returns remaining seconds.                                                                                                    |
| `COACHBYTE_resume_timer`      | Resume a paused rest timer. Computes a new `end_time` from the remaining duration.                                                                                                                        |
| `COACHBYTE_reset_timer`       | Reset (delete) the current rest timer, returning to idle state.                                                                                                                                           |
| `COACHBYTE_get_prs`           | PR data for tracked exercises                                                                                                                                                                             |

## CoachByte Technical Notes

- **No edge functions required.** All operations are Supabase client SDK calls or database function RPCs via Supavisor.
- **Data fetching:** All pages use TanStack Query (`useQuery`/`useMutation`) for server state management. Query keys defined in `src/shared/queryKeys.ts`. Exercises use a shared query key (`queryKeys.exercises`) for cross-page cache deduplication.
- **Realtime invalidation:** `useRealtimeInvalidation` hook subscribes to Supabase Realtime `postgres_changes` and invalidates specific TanStack Query keys when rows change. Used on `planned_sets`, `completed_sets`, and `timers` tables (TodayPage), filtered by `user_id`.
- **Bootstrap function** is idempotent and safe for concurrent calls (UNIQUE constraint + ON CONFLICT).
- **Day boundary** computed via `private.get_logical_date()`, stored as `logical_date` on daily plans and completed sets.
- **Global exercise seed** runs as part of CoachByte activation.
