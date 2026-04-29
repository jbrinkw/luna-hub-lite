# UX Audit — CoachByte Web

Read-only audit; the dev server wasn't reachable on `:5173` so this is a static walk of `apps/web/src/pages/coachbyte/*` + `apps/web/src/components/coachbyte/*`. Note: the brief listed an `ExercisesPage.tsx` but the file does not exist — the exercise library is a card inside `pages/coachbyte/SettingsPage.tsx:246-307`. Tabs are Today / History / Split / PRs / Settings (`components/coachbyte/CoachLayout.tsx:14-20`).

## Overall impression

CoachByte is a serious training tool with strong engineering. The DB-backed timer state machine (`supabase/migrations/20260425040000_timer_state_machine_rpcs.sql`) survives reload, refresh, second-device, and MCP. Realtime invalidation with per-table channels + heartbeat (`shared/useRealtimeInvalidation.ts:86-310`) is well above the bar. Sequential completion via `complete_next_set` (`supabase/migrations/20260303030435_coachbyte_functions.sql:149-224`) keeps focus tight.

But the gym-phone experience falls short of the engineering. The Today page buries "Next in Queue" under a header bar, tab row, h2 title, date, and Reset Plan button (`pages/coachbyte/TodayPage.tsx:617-676`). And the single biggest gap: **no sound, vibration, system notification, or screen wake-lock anywhere in the app.** `grep`s for `Audio|Notification|vibrate|wakeLock` in `apps/web/src` return zero hits. A user mid-rest who locks the phone or glances away has no way to know rest is over except by checking the screen. For a gym tool this is category-defining.

## Per-flow

### Open + find today's plan

`/coach` lands directly on Today. Plan auto-generates from `splits[weekday]` via `ensure_daily_plan` with relative-load resolution (`coachbyte_functions.sql:11-141`). The green "Next in Queue" card is large and clear once visible.

Issues:

- **Vertical noise.** On 375×667 the green card likely sits below the fold. The destructive `Reset Plan` button gets equal weight to the workout title (`TodayPage.tsx:618-630`) — it should be tucked away, not a peer of the h2.
- **No "what split is this".** Plan was bootstrapped from Tuesday's split but Today never says so. No breadcrumb to the source template.
- **No "improvise today" path beyond Reset.** "Reset Plan" deletes + re-bootstraps from the SAME split (`TodayPage.tsx:573-589`). To use a different day's plan: edit Split → save → Reset. Ad-hoc sets exist (`AdHocSetForm.tsx`) but layer ON TOP of the existing queue — they don't cancel it.

### Complete a set

Flow: prefilled reps + load from `nextSet.target_reps/load` (`SetQueue.tsx:54-55`) → Complete → `complete_next_set` RPC returns next set's `rest_seconds` → client starts timer → second query computes PR (`TodayPage.tsx:343-356`) → invalidate → re-render.

Works:

- Prefill saves a tap when on target.
- "Coming Up" preview of next 3 sets is good (`SetQueue.tsx:269-298`).

Hurts:

- **No optimistic update.** `completeSetMutation` is `onSuccess`-only (`TodayPage.tsx:318-370`); the green card waits for the round-trip. On gym wifi, 200-1000ms of "did it save?" per set.
- **No "I failed this set" affordance.** You'd type 0 reps and Complete; PR check excludes `actual_reps > 0` (`coachbyte_functions.sql:110`) but the UI just records what you typed. A "Failed" button that records partial reps, skips PR, and ends rest fast is missing.
- **No undo.** Once logged, the only fix is: expand "Completed" (collapsed by default — `TodayPage.tsx:230`) → two-click Remove. A 5s "Set logged — Undo" toast would be the standard fix.
- **No "saving" state on the Complete button.** `useSaveIndicator` is wired to notes/summary (`TodayPage.tsx:233-234`) but not the workout writes — inconsistent.
- **Read-only Exercise input wastes a column** (`SetQueue.tsx:215-223`). It duplicates the 2xl-bold name displayed 3 inches above.
- **No "last time I did this".** `grep` confirms it: nothing surfaces the previous session's reps × load on the Today card. This is the single most useful number to show a lifter mid-workout.
- **PR-detection bug (subtle):** `if (r === reps && l === load) continue;` (`TodayPage.tsx:353`) excludes any prior set that happened to match — meant to exclude the just-logged set itself, but should compare on `completed_set_id` from the response. Edge case: hitting the same reps×load twice may misreport PR status.

### Rest timer

Strongest piece architecturally. State machine in DB, end_time computed server-side, unique `(user_id)` enforces "one active timer." UI countdown derived from `end_time` (`TodayPage.tsx:594-606`).

Works:

- 3xl mobile / 5xl desktop display (`SetQueue.tsx:162-164`) — readable across the room.
- Auto-start on completion using next set's `rest_seconds` (`TodayPage.tsx:330-333`).
- Realtime sync across devices (`TodayPage.tsx:303`).
- Visibility-change re-derives remaining from `end_time` (`RestTimer.tsx:78-87, TodayPage.tsx:594-606`) — correct when tab returns to foreground.

The largest UX gap in the app:

- **No sound on expiry.** Zero `Audio` / `play()` calls in `apps/web/src`.
- **No vibration.** `navigator.vibrate` unused.
- **No system notification.** `Notification.requestPermission` unused.
- **No screen wake-lock.** `navigator.wakeLock` unused. iOS/Android dim then sleep during rest unless requested. A phone set on the bench loses the timer when the user most needs it.
- **Pause/Resume/Reset are `sm` (`min-h-[36px]`)** — below the 44px tap-target minimum (`Button.tsx:12`, used at `SetQueue.tsx:171,177,183`). Sweaty hands will mis-tap.
- **No "+15s/-15s extend" affordance.** Mid-rest "I need more" requires reset or new custom timer.
- **"Skip rest" is conflated with "Reset"** (deletes the timer row — `migrations/.../20260425040000:305-318`). Mental-model mismatch — users expect "skip = I'm ready, log my next set".
- **Custom-duration input** is a bare number input (`SetQueue.tsx:191-201`), no presets — but Split's rest field has 30/60/90/120 chips, so the pattern exists.

### History browse

`HistoryPage.tsx`, keyset paginated 20/page (line 29-30, 48-95).

Works:

- Keyset pagination is correct (`lt(plan_date, cursor) limit 21` then slice — no offset drift).
- Empty days filtered out (line 251).
- Mobile cards / desktop table split is clean.

Hurts:

- **"Load More" button, not infinite scroll.** Brief asks. On phone, page-by-page through months is tedious.
- **No "last time you did this" surface on Today** (already noted) — the data is right here, one query away.
- **No per-exercise trend chart.** Brief asks. Exercise filter narrows the day list but doesn't visualize weight × reps over time.
- **Detail rendering inconsistency.** History detail shows `{actual_load} {WEIGHT_UNIT}` raw (line 364, 482); Today's Completed section uses `formatWeightWithPlates` (`TodayPage.tsx:745`). Same data, two formats.

### PR detection

`PrsPage.tsx` derives PRs from `completed_sets` — no PR storage table. Epley + rep-best aggregation (`PrsPage.tsx:23-27, 72-110`).

Works:

- 90-day default with "Load All History" escape (line 158, 308-321).
- Tracked-exercises persistence (`pr_tracked_exercise_ids` JSON column, line 130-151).
- Per-exercise card with rep-records chips is scannable (line 290-301).

Hurts:

- **PR celebration is a single Alert toast on Today.** Same gap as the timer — no sound, no animation, no haptic, no notification. The PR moment is the one place a workout app can afford a flourish.
- **PR-detection edge case** (the `r===reps && l===load continue` bug above).
- **First-record toast is noisy** — fires for every first-ever set including warm-ups.
- **`epley1RM` exported from `PrsPage.tsx`** and re-imported by TodayPage (`TodayPage.tsx:14`). Architecture smell — belongs in `shared/`.

### Edit weekly split

`SplitPage.tsx`, 7-day expanders, JSONB `template_sets`.

Works:

- Auto-collapse rest days (line 82-89).
- Rest presets 30/60/90/120 (line 13, 414-428, 595-609).
- Mobile-card / desktop-table split is clean.
- Inline %1RM toggle (line 373-394, 571-593).

Hurts:

- **No drag-drop reorder.** Brief asks. `grep` confirms zero hits for `drag|reorder|sortable`. To reorder you delete and re-add at the end. `template_sets` is a JSONB array — totally amenable.
- **Manual Save per day, no auto-save.** Settings auto-saves on blur (`SettingsPage.tsx:182-188`); Split requires the per-day Save button (`SplitPage.tsx:637-646`). Changes lost if you navigate away. Inconsistent.
- **Save shows no success flash.** Just flips `Saving…` → `Save`. No `SaveIndicator` like notes/summary.
- **Add Exercise picks alphabetical first** (`SplitPage.tsx:179-180`) — almost never what the user wants.
- **Propagation to Today is implicit and one-shot.** Per `coachbyte.md:36-39`: split edits apply to FUTURE bootstraps only. Editing Tuesday's split mid-Tuesday-workout has zero effect on the active plan. No UI hint of this — discoverable only via docs.

## Cross-cutting findings

- **Phone-first claim vs reality.** The most-tapped controls during a workout (timer pause/resume/reset, queue-row Remove, rest preset chips, completed Remove) are all `sm` (`min-h-[36px]`). The 44px standard is honored only on `lg` (used inconsistently — Complete Set is `lg`, but timer controls aren't).
- **No optimistic updates anywhere on the hot path** — `completeSetMutation`, `addPlannedSet`, `deletePlannedSet`, `deleteCompletedSet` all wait for round-trip. TanStack `onMutate` would fix every one.
- **Realtime correctness looks solid.** Per-table channels (no shared-channel "one bad publication kills all"), heartbeat probe, exponential reconnect, socket-close hook (`useRealtimeInvalidation.ts:265-294`). Two-tab/two-device sync should mirror within 1s for postgres_changes events; ~30-90s worst case for connection-drop detection via heartbeat.
- **Trust signals are weak on workout writes.** The `SaveIndicator` flashes on notes/summary (`TodayPage.tsx:779, 814`) but not on Complete Set, Reset Plan, or Split Save. The actually-important writes are the silent ones.
- **`Exercises` not in top nav.** Brief listed it. Library is buried 3 levels deep (Today → menu → Settings → scroll → Exercise Library card). For mid-workout "I want to add a custom exercise" this is too deep.
- **Day boundary** uses `dayStartHour` from profile (`shared/dates.ts:20-26`) and re-fetches Today on visibility change (`TodayPage.tsx:307-315`). Correct.
- **Two-click destructive confirmation pattern** is consistent across Reset Plan and Remove Completed.
- **Speed of "I just finished a rep" → "app reflects":** with prefill = 1 tap; with override = 2-3 taps. Then 200-1000ms server round-trip with no optimistic flip. With `onMutate` it would be tap → instant → server reconciles.

## Top 5 highest-impact UX changes

1. **Add timer-expiry signaling: sound + vibration + system notification + screen wake-lock during rest.** Persona is on-phone-mid-workout; right now the only signal is visual on a screen that may be off. `Audio` (with user-gesture unlock), `navigator.vibrate([200,100,200])`, `Notification.requestPermission` on first timer use, `navigator.wakeLock.request('screen')` on timer start / release on reset/expire. Single biggest impact.

2. **Surface "last time you did this" on the Today next-in-queue card.** One query against `completed_sets WHERE exercise_id = X ORDER BY completed_at DESC LIMIT 3`. Display under the prefilled targets: "Last time: 8r @ 185 (Mon)". The single most useful number to show a lifter mid-workout.

3. **Optimistic update + undo toast on Complete Set.** Add `onMutate` to `completeSetMutation` (`TodayPage.tsx:318-370`) that immediately marks the set complete in cache and advances `nextSet`. On success, show a 5s "Set logged — Undo" toast that calls `delete completed_sets WHERE completed_set_id = X` if tapped. Eliminates the uncertainty beat AND solves the buried-undo problem.

4. **Promote tap-target sizes for in-workout controls + add timer-extend buttons.** Switch Pause/Resume/Reset and rest-preset chips in `SetQueue.tsx:170-204` to `size="lg"` (44px). Add "+15s" / "+30s" / "Skip" affordances distinct from "Reset" so users have non-destructive "I'm ready" or "I need more" paths.

5. **Make split-to-today a one-tap action, not a destructive Reset dance.** Add: (a) "Use today's split" (current Reset behavior, renamed), (b) "Use [other day]'s plan today" picker that copies that weekday's split into today's planned_sets, (c) drag-drop reorder on the Split page proper, (d) "Apply split changes to today" affordance on Split for the active weekday. Removes the delete-then-rebootstrap mental dance.

## Things working well

- **Timer state machine in DB** (`migrations/20260425040000_timer_state_machine_rpcs.sql`). Server-side guards mean UI bugs can't desync state. Service-role overloads (`20260425090000_*`) keep the door open for cron expirations.
- **Realtime invalidation infrastructure** (`useRealtimeInvalidation.ts`). Per-table channels, heartbeat probes, reconnect-on-close, exponential backoff, health store — far better than the typical shared-channel pattern.
- **Sequential set completion via `complete_next_set`**. Server picks lowest-order incomplete set; can't double-log; next set's `rest_seconds` returned in the same response.
- **Plan bootstrap idempotence + previous-day cleanup** (`coachbyte_functions.sql:48-82`). Single transaction, ON CONFLICT DO NOTHING, no orphan empty days cluttering History.
- **Plate calculator integration on Today + Coming Up** (`SetQueue.tsx:81-91`, `TodayPage.tsx:745`). Knowing "185 = 45+25 per side" is exactly the question at the bar.
- **Tracked-exercises persistence with reasonable UX** (`PrsPage.tsx:204-226, 324-403`).
- **Spec docs in `docs/apps/coachbyte.md` are detailed and match the code** — a rare thing.
