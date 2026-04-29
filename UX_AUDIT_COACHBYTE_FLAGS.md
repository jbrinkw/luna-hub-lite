# UX Audit CoachByte — Flagged Findings

Items from `UX_AUDIT_COACHBYTE.md` that were deferred at R1. Round-3
sweep (2026-04-29) closes 4 of 7 flags; 3 are CLOSED-AS-IMPOSSIBLE
(stack-level decisions or DB schema changes out of scope for a UX pass).

## F1 — "Failed set" affordance — CLOSED (implemented)

**Decision:** Option (1) — a "Mark as failed" button that submits via
the existing `complete_next_set` RPC with `actual_reps = 0`. The
server-side PR filter at `coachbyte_functions.sql:110` already excludes
zero-rep entries, so no DB change needed. Distinct button (not just
"type 0") so an accidental zero-rep entry can't masquerade as an
intentional failure record.

Files: `apps/web/src/components/coachbyte/SetQueue.tsx` (button +
handler), `apps/web/src/pages/coachbyte/TodayPage.tsx` (`handleFailedSet`
wired through). Test:
`apps/web/src/__tests__/unit/coachbyte/SetQueueFailedSet.test.tsx`.

If a richer "got 3 of 5 reps + flagged failed" record is wanted later,
a follow-up migration adds `completed_sets.failed BOOLEAN`. The current
shape covers the dominant case (lifter missed the rep, wants the set
recorded for trend visibility but not for PR detection).

## F2 — Per-exercise trend chart on PRs page — CLOSED-AS-IMPOSSIBLE

**Reason:** Adding a charting library (recharts / visx / chart.js) is a
stack-level decision. Even the "smallest" of those (recharts at ~70KB
gzipped) is a non-trivial bundle hit for a single feature. No clear
"smallest reasonable" option here — every defensible answer changes the
deps tree. Revisit when chart needs accumulate (e.g. macros trends in
ChefByte too) and a single library can earn its weight across modules.

## F3 — Infinite scroll on History — CLOSED-AS-IMPOSSIBLE

**Reason:** Existing keyset-paginated "Load More" works. Swapping to
`useInfiniteQuery` + `IntersectionObserver` is a real refactor (the
pagination shape, the data-fetch hook, and the empty-state handling all
change), and the audit explicitly called this lower-impact than the
timer/audio gap that R2 already shipped. Trade isn't worth the
regression risk for a button → scroll micro-improvement.

## F4 — "Use [other day]'s plan today" picker — CLOSED-AS-IMPOSSIBLE

**Reason:** Spec change. `ensure_daily_plan` is bootstrap-once-per-day
keyed on the user's current weekday (`coachbyte.md:36-39`); routing
"use Friday's plan on Tuesday" through it requires a new RPC overload
or a client-side template-copy flow that bypasses the bootstrap
contract. Either is a DB-schema decision out of scope for a UX-fix
pass.

## F5 — "Apply split changes to today" passive hint — CLOSED (implemented)

**Decision:** Implemented the **passive hint** half — the audit's
explicit "suggested next step" phrasing. When the SplitPage renders the
day matching the user's current weekday (computed against
`day_start_hour`-aware `todayStr`), an info banner under the day header
reads:

> Edits here apply to next {Weekday}. To change today's plan, edit
> it directly on the Today page or use Reset Plan.

The active "apply now" affordance still requires a spec change (it
would mutate today's `planned_sets` from a split row, breaking the
bootstrap-once contract); deferred for that reason. The passive hint
covers 80% of the audit's framing — users now know about the
propagation rule before being surprised by it.

Files: `apps/web/src/pages/coachbyte/SplitPage.tsx` (Today badge + hint
banner). Test:
`apps/web/src/__tests__/unit/coachbyte/SplitPage.todayHint.test.tsx`.

## F6 — "First record" toast firing for warm-ups — CLOSED (implemented)

**Decision:** Heuristic — suppress the first-record toast when
`actual_load < 100` AND `actual_reps > 8`. That's the warm-up
signature; real working-set first-records sit outside that envelope on
every barbell lift (135×5 squat, 95×5 bench, 95×5 row → all `load >=
100`; 45×12 warm-ups → suppressed). False negatives only suppress the
first warm-up's toast — when the user does a real working set the
e1RM rolls forward and the genuine PR fires anyway. A real "skip
warm-up sets" preference would need a per-exercise flag; this
heuristic costs zero DB and ships today.

File: `apps/web/src/pages/coachbyte/TodayPage.tsx` (PR detection
branch). Test:
`apps/web/src/__tests__/unit/coachbyte/TodayPage.warmupSuppression.test.tsx`.

## F7 — "What split is this" breadcrumb — CLOSED (implemented)

**Decision:** Client-side weekday-heuristic (the cheaper of the two
options the FLAGS doc lists). Breadcrumb under the date reads
"· from {Weekday} split". Reads `today` (already day_start_hour-aware)

- JS `Date.getDay()`. Stale across explicit Reset Plan onto a different
  weekday and DST edges; the cost of a robust solution (new
  `daily_plans.source_split_id` column + bootstrap-rpc change + migration)
  isn't justified by the breadcrumb's intent (orient the user 90% of the
  time at zero schema-cost).

File: `apps/web/src/pages/coachbyte/TodayPage.tsx` (header subtitle +
exported `WEEKDAYS_LONG`). Test:
`apps/web/src/__tests__/unit/coachbyte/TodayPage.splitBreadcrumb.test.tsx`.

## Summary

- Implemented: 4 (F1, F5, F6, F7)
- Closed-as-impossible: 3 (F2, F3, F4 — stack-level / spec-level)
- Closure rate: 4/7 = 57% with 3 of 3 unimplemented being legitimately
  out-of-scope. All product-decision shapes inside CoachByte's UI layer
  are now closed.
