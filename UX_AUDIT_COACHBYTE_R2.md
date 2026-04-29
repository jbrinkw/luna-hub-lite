# UX Audit — CoachByte Web (Round 2)

Read-only follow-up to `UX_AUDIT_COACHBYTE.md`. The salvaged Round-1 fix-batch (`34dc1a5`) landed substantial work on Today, Split, History, PRs, SetQueue, plus `useTimerAudio` and `shared/epley`. This round verifies what landed, looks for regressions, and re-walks under a phone-first lens. Static analysis only.

## What changed (verified)

- **`useTimerAudio`** (`apps/web/src/hooks/useTimerAudio.ts:1-232`) — Web Audio triple-beep, `navigator.vibrate([200,100,200])`, `Notification`, `useScreenWakeLock`. All four cues real, not test stubs.
- **Wired into Today** (`TodayPage.tsx:24, 328-330, 381-382, 651-657`). Permission requested on mount; wake-lock acquired when `sessionActive`; cue fires on running→expired edge via `lastTimerStateRef`.
- **Optimistic Complete-Set + 5s Undo toast** (`TodayPage.tsx:418-525, 853-870`). Real `onMutate` snapshot/rollback.
- **PR detection bug fixed** (`TodayPage.tsx:481-499`) — excludes by `completed_set_id`, not value-equality. Test pins it (`TodayPage.prDetection.test.tsx:190-210`).
- **"Last time you did this"** (`TodayPage.tsx:158-181, 372-377`; `SetQueue.tsx:266-285`).
- **Tap-target uplift** on hot path. Pause/Resume/Reset/Skip/Extend/AdHoc `lg` (44px) (`SetQueue.tsx:199-330`); Complete `xl` (48px); presets `min-h-[40px] min-w-[44px]` (`244`).
- **+15/+30 extend** + **distinct Skip** (`TodayPage.tsx:631-646`, `SetQueue.tsx:210-235`). Skip currently calls `resetTimerRpc` — label only.
- **Drag-drop reorder on Split (desktop)** (`SplitPage.tsx:294-315, 400-403`). HTML5 native drag.
- **Auto-save on Split** + per-day "Saving…/Saved" indicator (`SplitPage.tsx:203-216, 756-765`).
- **`shared/epley` + re-export shim** (`epley.ts`, `PrsPage.tsx:14, 27`).
- **History detail uses plate breakdown** mobile + desktop (`HistoryPage.tsx:365, 483`).
- **`Button` `xl=48px`** (`Button.tsx:15`).

## Per-flow

### Today — set completion + rest timer

- **Wake-lock heuristic too aggressive.** `sessionActive = sets.some(s => !s.completed)` (`TodayPage.tsx:381`) keeps the screen awake the entire workout, not just rest periods. Battery drain on 90-min sessions, screen never dims while reading notes. Better: bind to `timer.state === 'running' || 'paused'`.
- **Timer-expiry signaling is fragile when tab isn't foreground.** `expired` flips only when client `setTimeout` (`667-669`) calls `expireTimerRpc`. Mobile browsers throttle/freeze JS timers when the tab is backgrounded or phone locked — the setTimeout sleeps until the tab returns. No `pg_cron` wires `coachbyte.expire_timer(p_user_id)` (the service-role overload at `migrations/20260425090000_timer_rpc_service_role_overloads.sql:96-106` exists but isn't scheduled). Net: the cue fires _when the user looks at the screen_ — exactly when they don't need it. R1's headline gap is half-fixed.
- **AudioContext not unlocked on a user gesture.** `requestNotificationPermission` runs on mount (`329`), but `getAudioContext` lazy-inits inside `playTimerExpiredCue` (`60-69`). Chrome/Safari leave the context `suspended` until a user gesture; the first expiry beep will silently no-op on a fresh page until a gesture has happened. Resume from the Complete-Set click would unlock for the session.
- **No haptic on Complete tap.** A 50ms `vibrate(50)` would close the loop the way audio closes rest.
- **Toasts have no `aria-live`.** `Alert` (`847, 853`) misses `role="status"` — screen readers don't announce PR or Undo.
- **Double-fire window on Complete.** `completing` only flips the label (`326`); the button isn't `disabled={completing}`. Double-tap during the 200-1000ms before `onMutate` cancels could `mutate` twice — second call sees the optimistic cache and writes the _next_ set.

### Rest timer (inline in SetQueue)

- **`RestTimer.tsx` is dead production code.** Only test files import it; Today uses inline markup in `SetQueue.tsx:175-264`. ~130 LOC of orphaned component + dedicated test file.
- **Skip ≡ Reset functionally** (`641-646`). Label only.
- Numeric `inputMode` correct (`SetQueue.tsx:299, 310`).

### Split

- **Drag-drop is desktop-only.** `draggable` rows live in the `hidden sm:table` (`SplitPage.tsx:368, 400`). Mobile card layout (`565-738`) has no drag handles, no chevrons, no reorder affordance. On 375px — the brief's primary persona — reorder is impossible. Looks done in review, fails the phone test.
- **No drag visual feedback.** No `dragOver` styling, no insertion-line preview. The grip icon `w-3.5 h-3.5` is too small to read as interactive.
- **Auto-save / manual-save race.** Manual `Save now` mid-debounce fires once, then the 600ms debounce fires again. Idempotent; double-write per edit.
- **Add Exercise still picks alphabetical first** (`236`). R1 unfixed.

### History

- Format consistency fixed.
- **No "last time" cross-link**, no per-exercise trend chart, still "Load More" not infinite scroll. R1 + flag-doc unfixed (F2, F3).

### PRs

- **First-record toast still noisy** for warm-ups (R1 / F6).
- **PR celebration is silent.** Audio/vibration only fires on rest expiry — never on the actual PR moment.

### Exercises

- **Still buried in Settings** (`SettingsPage.tsx:246-307`). `CoachLayout.tsx:14-20` still 5 tabs without an Exercises tab. R1 unfixed.

## Cross-cutting

- **Wake-lock + battery + persona mismatch.** Acquired aggressively, never released until workout ends. Phones drain or screens never dim while reading notes.
- **Background-tab reality.** With no server-side cron and `setTimeout`-based expiry, the cue fires only when the tab is foregrounded. The Notification API can be delivered to a locked screen via Service Worker + Push, but `new Notification()` from the page dies when the tab is suspended. R1's most important fix is half-built.
- **Optimistic update only on Complete-Set.** `addPlannedSet`, `deletePlannedSet`, `deleteCompletedSet`, `updatePlannedSet`, ad-hoc submit (`547-586, 689-704, 752-767`) all wait for round-trip. R1 said "no optimistic anywhere on the hot path" — 1 of 5 fixed.
- **Realtime correctness.** Subscriptions on `planned_sets`, `completed_sets`, `timers` (`392-396`) — completing a set on phone propagates to desktop tab via existing per-table channels. Optimistic update on phone advances local cache before server round-trip; the realtime event from the desktop's view will then `invalidateQueries`. Works.
- **Persistence across reload during active workout.** Today's plan + completed_sets + timer all DB-backed; `summary`/`notes` debounce-saved with `onBlur` flush. Reload mid-rest restores from `end_time` (`792`). Solid.
- **Toast a11y silence** noted above.

## Things working better

- **Optimistic Complete-Set + Undo** — single biggest UX upgrade. Uncertainty beat gone.
- **PR detection by id** — correctness win, well-tested.
- **"Last time you did this"** inline.
- **Inline timer controls** with proper tap targets, +15/+30, distinct Skip — gym-phone usability dramatically up where the tab is foregrounded.
- **Auto-save Split** matches Settings pattern.
- **Format consistency** Today ↔ History.
- **`epley1RM`** moved cleanly with re-export shim.
- **Drag-drop on Split desktop** — affordance exists.

## Highest-impact remaining gaps

1. **Background/locked-phone timer expiry.** Without server-side cron + Service Worker push, the audio/vibration/notification still won't fire when the phone is actually locked. Wire `coachbyte.expire_timer(p_user_id)` to `pg_cron` and add a Web Push subscription, or document the limitation.
2. **Wake-lock scope** — bind to `timer.state === 'running'`, not the whole workout.
3. **AudioContext unlock** on Complete-Set click.
4. **Mobile drag-drop on Split** — primary persona never sees it today.
5. **Exercises in top nav.**
6. **Optimistic updates** for the other 4 mutations (pattern is now established).
7. **`role="status" aria-live="polite"`** on PR + Undo toasts.
8. **Double-fire guard** on Complete (`disabled={completing}`).
9. **Delete or use `RestTimer.tsx`.**
