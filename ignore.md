# Negative-Space Ignore List

Tracked deferred work surfaced by `scripts/audit_negative_space.py` (lens
L8 of the Phase-2 audit). Each entry justifies why a TODO/FIXME/etc
marker stays in the codebase. The script accepts an entry as a waiver
when the line contains:

- A `path:line` reference, AND
- A `YYYY-MM-DD` date token nearby (discourages stale entries).

For inline waiver markers the detector also recognizes:

- GitHub issue refs (`# TODO #123`, `// FIXME(#1234)`)
- Pointers back to this file (`# TODO: see ignore.md "Title"`)
- The explicit `__deferred__` sentinel

See `AUDIT_STRATEGY_MERGED.md §5` for the broader Phase-2 audit context
and `AUDIT_FINDINGS_PHASE2.md` for the original L8 baseline (874 markers
on 2026-04-29 before this triage).

---

---

## Historical migration TODOs (do not edit — already discharged)

These are intentionally retained per migration-history archeology
policy. The detector waives them via the `historical-migration` rule
in `WAIVERS`.

- `supabase/migrations/20260424090000_invariant_batch.sql:26` —
  `mark_meal_done` wiring TODO discharged by
  `20260425020000_mark_meal_done_uses_name_helper.sql`. Date:
  2026-04-25.
- `supabase/migrations/20260424090000_invariant_batch.sql:211` —
  `TODO(agent 1 follow-up)` discharged by the same migration. Date:
  2026-04-25.
