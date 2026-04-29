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

## Vault encryption for extension credentials

- **Source:** `apps/web/src/__tests__/integration/hub/extension-settings.test.ts:38` 2026-04-29
- **TODO text:** "Encryption via Supabase Vault is deferred to post-MVP."
- **Why deferred:** Spec decision — Phase 1 stores OAuth tokens / API keys
  as plaintext in `hub.extension_settings.credentials_encrypted` (TEXT,
  no trigger). Vault wiring is a post-MVP follow-up; column name is
  intentionally aspirational so the migration path is ready.
- **Effort estimate:** M (Vault binding + migration + key rotation
  story).

## E2E test: status card click navigation

- **Source:** `apps/web/e2e/chefbyte/home.spec.ts:157` 2026-04-29
- **TODO text:** "Status cards are currently static display-only divs.
  Once they become clickable links… enable this test."
- **Why deferred:** Status cards on `/chef/home` are non-interactive
  summary widgets by design. Test stays `test.skip` and serves as a
  pinned spec for the day someone wires up navigation.
- **Effort estimate:** S (one click handler + Link wrapping).

## E2E test: Clear Purchased button on shopping page

- **Source:** `apps/web/e2e/chefbyte/shopping.spec.ts:128` 2026-04-29
- **TODO text:** "No 'Clear Purchased' button exists on the shopping
  page. Only 'Import to Inventory' and 'Clear All' are available."
- **Why deferred:** The current UX uses "Import to Inventory" (which
  removes purchased items as a side-effect) instead of a separate
  "Clear Purchased" affordance. Test stays skipped pending a UX
  decision.
- **Effort estimate:** S.

## E2E test: disabling extension clears credentials

- **Source:** `apps/web/e2e/hub/extensions.spec.ts:90` 2026-04-29
  (also covers `apps/web/e2e/hub/extensions.spec.ts:92` 2026-04-29 — same skip block)
- **TODO text:** "The current toggle handler only sets `enabled` flag —
  it does not clear `credentials_encrypted` in the DB. This test is
  skipped because the 'disable clears creds' behavior is not yet
  implemented."
- **Why deferred:** Currently `enabled=false` only hides the extension
  in the UI; credentials persist so a re-enable doesn't force a
  re-auth. Whether disable should ALSO wipe creds is a UX call.
- **Effort estimate:** S (one DB update + decision on UX).

## MacroPage describe.skip — fake timers vs TanStack Query

- **Source:** `apps/web/src/__tests__/unit/chefbyte/MacroPageInvariants.test.tsx:155` 2026-04-29
- **TODO text:** "FIXME: 3 tests below skipped — vitest fake timers
  interact badly with TanStack Query's microtask-based flush, leaving
  `await waitFor(...)` stuck."
- **Why deferred:** Documented mitigation already exists — pgTAP test
  `consume_pipeline_invariants.test.sql` covers the logical_date
  boundary at the DB level, so the user-observable behavior is
  guarded. Migrating off fake timers (mock `todayStr` directly) is the
  preferred cleanup.
- **Effort estimate:** M (refactor 3 tests + add Date.now harness).

## UX-FLAG: debug timeline pages light-mode style

- **Source:** `hardware/live-shelf/server/web/debug_routes.py:312` 2026-04-29
- **TODO text:** "UX_AUDIT_PI_LIVESHELF_FLAGS.md Flag 5. Decision
  deferred: keep the loud visual break OR migrate to extend
  `_base.html` for nav continuity. Both are defensible per the audit."
- **Why deferred:** Tracked in `UX_AUDIT_PI_LIVESHELF_FLAGS.md` Flag 5;
  current behavior is intentional ("you've left the app" signal).
- **Effort estimate:** S (template-only change if/when decision lands).

## Pi-side invariant check from cloud edge function

- **Source:** `supabase/functions/invariant-monitor/index.ts:193` 2026-04-29
- **TODO text:** "Deferred: Pi-side data is not visible to the cloud
  edge function."
- **Why deferred:** The `pi_cloud_lot_id_match` invariant cannot run
  from the cloud — Pi mirror tables don't yet exist in the cloud
  schema. The edge function emits a static warning advertising the
  gap (so it persists in the admin UI) until a Pi mirror lands. Phase
  3 has a parameterized version that activates when a lot-tracking
  simulator is wired in.
- **Effort estimate:** L (Pi mirror schema + sync poller + reconcile
  contract).

## Live-shelf devices: ledger-ize is_active flag

- **Source:** `supabase/migrations/20260425060000_live_shelf_devices_safer_invariant.sql:41` 2026-04-29
- **TODO text:** "Doesn't ledger-ize the is_active flag (deferred:
  would need a separate live_shelf_device_activations table +
  join-view)."
- **Why deferred:** Documented NON-GOAL of that migration. Current
  INSERT-default-true + partial-unique-index pattern is sufficient;
  a full activation ledger is post-MVP audit-trail work.
- **Effort estimate:** M (schema + view + backfill + RLS).

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
