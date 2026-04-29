# UX Audit CoachByte — Flagged Findings

Items from `UX_AUDIT_COACHBYTE.md` that I deferred instead of implementing.
Each flag is keyed by the audit section and explains the reason.

## F1 — "Failed set" affordance (audit §Complete a set)

**Audit text:** "No 'I failed this set' affordance. You'd type 0 reps and Complete; PR check excludes `actual_reps > 0` (`coachbyte_functions.sql:110`) but the UI just records what you typed. A 'Failed' button that records partial reps, skips PR, and ends rest fast is missing."

**Why flagged:** This crosses into product-design territory. Two reasonable interpretations:

1. A button that submits with `actual_reps = 0` (matches the existing PR-skip filter at `coachbyte_functions.sql:110`).
2. A modal that lets the user record "I got 3 of 5" (partial reps) AND mark the set as failed for later filtering.

The SQL filter only excludes 0-rep entries, so option (1) is trivial; option (2) needs a `status` or `failed BOOL` column on `completed_sets` that doesn't currently exist. Wanted user input on which behavior to ship before pulling on a DB migration.

**Suggested next step:** Pick one of the two behaviors. If (2), add a migration adding `completed_sets.failed BOOLEAN DEFAULT FALSE` and update `complete_next_set` to accept `p_failed`.

## F2 — Per-exercise trend chart on PRs page (audit §History browse)

**Audit text:** "No per-exercise trend chart. Brief asks. Exercise filter narrows the day list but doesn't visualize weight × reps over time."

**Why flagged:** Charts mean a new dependency (recharts / visx / chart.js / etc). Adding a charting library is a stack-level decision worth flagging instead of picking unilaterally.

**Suggested next step:** Confirm preferred lib, then drop a small `<TrendChart exerciseId>` into `PrsPage` and `HistoryPage`.

## F3 — Infinite scroll on History (audit §History browse)

**Audit text:** "'Load More' button, not infinite scroll. Brief asks. On phone, page-by-page through months is tedious."

**Why flagged:** Lower-impact than the timer/audio gap; needs an `IntersectionObserver` setup and pagination-state refactor that's substantial enough to ship as its own change. Existing keyset-pagination + Load More is functional today.

**Suggested next step:** Wire `useInfiniteQuery` (TanStack supports this natively) with an IntersectionObserver sentinel.

## F4 — "Use [other day]'s plan today" picker (audit §Open + find today's plan)

**Audit text:** "No 'improvise today' path beyond Reset. 'Reset Plan' deletes + re-bootstraps from the SAME split."

**Why flagged:** Spec change — the bootstrap path is currently weekday-locked (see `coachbyte.md:36-39`). Adding "use Friday's plan on Tuesday" requires either:

- A new `ensure_daily_plan(p_day, p_source_weekday)` RPC overload, or
- A client-side "copy template_sets from another weekday" flow that bypasses bootstrap.

Both mean a DB-or-spec decision out of scope for a UI fix.

## F5 — "Apply split changes to today" (audit §Edit weekly split)

**Audit text:** "Propagation to Today is implicit and one-shot. Editing Tuesday's split mid-Tuesday-workout has zero effect on the active plan. No UI hint of this."

**Why flagged:** Same family as F4 — touches the bootstrap semantics. We could add a passive UI hint ("Today's plan was bootstrapped from this split — edits apply to NEXT Tuesday") cheaply, but the active "Apply to today" affordance is a real spec change.

**Suggested next step:** As a partial fix, add the passive hint banner to SplitPage when the day being edited matches today's weekday.

## F6 — "First record" toast firing for warm-ups (audit §PR detection)

**Audit text:** "First-record toast is noisy — fires for every first-ever set including warm-ups."

**Why flagged:** Defining "warm-up" is subjective. Options:

- Suppress when `actual_load < bar_weight × 1.5`
- Suppress when `actual_reps > 8` AND `actual_load < some_threshold`
- Add a "skip this exercise from first-record toasts" UI checkbox

Punted to keep the existing behavior intact; needs product call.

## F7 — "What split is this" breadcrumb (audit §Open + find today's plan)

**Audit text:** "Plan was bootstrapped from Tuesday's split but Today never says so. No breadcrumb to the source template."

**Why flagged:** Non-trivial because `daily_plans` doesn't currently store the `split_id` it was bootstrapped from — the bootstrap path in `ensure_daily_plan` uses `splits[weekday]` lookup but doesn't persist the link. Adding "bootstrapped from Tuesday split" requires either:

- A new `daily_plans.source_split_id UUID NULL` column, or
- A weekday-based heuristic computed client-side (which is fragile around DST / day_start_hour edges).

**Suggested next step:** Add the column in a follow-up migration; UI hint is a one-liner once persisted.
