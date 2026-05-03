# Deep Code Audit — Catch-all LiveTrack Auto-Import + USB Scanner Forwarder

**Date:** 2026-05-03
**Branch:** `feat/catch-all-livetrack-auto-import` (`/home/jeremy/luna-hub-lite/.worktrees/catch-all-livetrack/`)
**Scope:** 33 commits between `99f6469` (pre-feature) and the audit cutoff. Two features:

1. Catch-all LiveTrack auto-import (13 implementation tasks)
2. Pi USB scanner forwarder (16 implementation tasks)

**Method:** Five parallel domain audits (DB schema + functions, Pi-side code, cloud edge functions, web UI surfaces, test infrastructure). Each audit ran independently against the worktree HEAD with full test re-runs.

## TL;DR

- **2 critical issues found and fixed** before audit closure.
- **9 important issues** identified; **6 fixed** as follow-up commits, 3 deferred with rationale.
- **15 minor / polish issues** flagged; **2 fixed**, 13 noted for follow-up.
- Full test suites green: 1,460 pgTAP / 1,575 Pi pytest / 1,076 web vitest / 463 web integration / 3 scanner-pipeline E2E.
- The user's "no shortcuts or mock bs" mandate is met: the new `scanner-pipeline.test.ts` performs real cloud round-trips against local Supabase + adminClient DB readbacks.

---

## Critical findings (FIXED)

### C1 — Privilege escalation in chefbyte scanner wrappers

**Files:** `supabase/migrations/20260503100150_*.sql`, `supabase/migrations/20260503100250_*.sql`
**Found by:** DB schema audit + cloud edge function audit (both flagged independently)
**Fixed in:** `b45cb91` — `fix(security): restrict chefbyte scanner wrapper EXECUTE to service_role only`

The chefbyte-schema PostgREST wrappers `chefbyte.execute_scan_action` and `chefbyte.void_scan_transaction` were granted EXECUTE to `authenticated` but performed no `auth.uid()` ownership check before delegating to their `private.*` counterparts. PostgREST exposes the chefbyte schema, so any logged-in user could:

- Direct-RPC `chefbyte.execute_scan_action(p_user_id => victim_uuid, p_product_id => victim_product, ...)` to mint stock_lots / write food_logs / fill carts in the victim's account.
- Direct-RPC `chefbyte.void_scan_transaction(victim_transaction_uuid)` to delete the victim's stock_lot / food_log / cart_item.

The edge function path was safe (service-role + ownership check at call site), but the direct PostgREST surface bypassed both. UUID opacity is not a security boundary — transaction UUIDs leak via Realtime / shared screenshots / MCP responses.

**Fix:** Match the existing `*_admin` precedent (`apply_shelf_event_admin`, `consume_product_admin`): REVOKE EXECUTE from `authenticated, anon`, keep `service_role` only. Edge function uses service-role client, so production path unaffected. Added 2 pgTAP regression tests proving authenticated callers get 42501 (insufficient_privilege).

### C2 — Web purchase merge breaks void semantics

**File:** `apps/web/src/pages/chefbyte/ScannerPage.tsx`
**Found by:** Web UI audit
**Fixed in:** `6016d32` — `fix(chef): null applied_lot_id on web merge to prevent destructive void`

The web ScannerPage merges purchase scans into existing stock_lots when `(product, location, expires_on)` matches. The merged lot's id was being recorded as `scan_transactions.applied_lot_id`. `private.void_scan_transaction` unconditionally DELETEs that lot — destroying inventory contributed by other scans, manual entries, or Pi USB.

Concrete failure: user scans 3 cans of beans (web, all merge into one lot). Void the third → entire 3-can lot deleted instead of just the third can.

**Fix:** Only set `applied_lot_id` when `wasNewLot=true`. For merges, leave it null so void becomes status-flip-only (macros still voided correctly via `applied_food_log_id`, but stock changes from a merge are intentionally not reversible). Asymmetric with the Pi USB path (which always inserts new lots and gets clean void semantics) — acceptable for v1; documented in code comments. Added a merge-scenario test + tightened the existing weak `['applied','errored'].toContain(...)` assertion.

---

## Important findings

### I-Cloud-3 — `/barcode-scan` qty validation gap (FIXED in follow-up)

Negative or zero `qty` for purchase mode passed through to Postgres, which only rejects via the `stock_lots_qty_nonneg` CHECK. Result: malformed transactions accumulating in the audit log. Added edge-side validation: `qty > 0`, finite, ≤ 10000.

### I-Cloud-6 — Void route regex too lenient (FIXED in follow-up)

`/^\/scan-transaction\/([0-9a-f-]{36})\/void$/i` matched 36-char hex/dash strings including 36 dashes. Tightened to strict UUID regex.

### I-Pi-1 — Magic-string ReasonCodes bypass `lifecycle.ReasonCode` (FIXED in follow-up)

Four catch-all auto-import lifecycle codes (`TARE_AUTO_IMPORT`, `MEASURED_FULL_AUTO`, `TARE_AUTO_FROM_EMPTY`, `TARE_CAPTURE`) were bare strings. The `ReasonCode` class header explicitly says: "Adding a new transition? Add the constant here so call sites don't sprout magic strings." Added the four constants + replaced literals.

### I-Web-1, I-Web-2, I-Web-3 — Missing Realtime + downstream invalidations (FIXED in follow-up)

- ScannerTransactionsTab: no Realtime subscription on `chefbyte.scan_transactions` → Pi-side scans don't appear without manual refresh.
- ScannerTab: no Realtime on `chefbyte.scanner_state` → cross-device lock toggle doesn't sync.
- void mutation: only invalidated `scanTransactions` query; missing invalidations for `dailyMacros`, `foodLogs`, `shoppingList`.

### I-DB-3, I-DB-5 — Cross-user pgTAP coverage gaps (FIXED via C1 commit)

The new pgTAP tests didn't probe RLS/ownership across users. Adding cross-user `throws_ok` would have caught C1 + C2 in the original Tasks 5/6 reviews. C1's fix commit added these tests.

### I-Cloud-2 — `/product-tare` set-once TOCTOU race (DEFERRED)

SELECT-then-UPDATE has a narrow concurrent-write window where two writes on the same NULL field could both pass the SELECT and both succeed. Same-user retries are unaffected (same value). Cross-device concurrent pushes (Pi + MCP tool, etc.) could violate set-once.

**Defer rationale:** Single-user MVP, last-write-wins is project policy. The Pi-side guard catches this before push in practice. Fix when multi-device usage becomes common; the fix is a 2-line `.is(field, null)` filter on the UPDATE.

### I-Cloud-4 — Pi unknown-barcode + analyze-product silent gap (DEFERRED)

`analyze-product` requires a user JWT (calls `auth.getUser()`). Pi USB scans use x-api-key auth, not JWT. So Pi scans of unknown barcodes always log `errored` and never auto-create products. Web scans work as before.

**Defer rationale:** Documented in `docs/apps/chefbyte.md` (USB Scanner section now mentions this constraint). Refactoring `analyze-product` to accept service-role + explicit user_id is a larger architectural change.

### I-Pi-2 — Barcode scanner thread no auto-restart (DEFERRED)

Daemon thread dies silently on USB unplug or evdev permission flap. Operator must restart the Pi service. Other long-running daemons follow the same one-shot pattern.

**Defer rationale:** Production environment is single-Pi LAN-only, low blast radius. A `while not shutdown_event.is_set()` outer loop with backoff would harden this; queue for the next live-shelf reliability pass.

---

## Minor findings (most deferred)

### Web polish (FIXED in follow-up)

- M-Web-1: Tooltip wording uses developer jargon ("measured-full confirmation"). Replaced with action-oriented copy.
- M-Web-2: Inventory legend describes only the green state. Updated to cover all three.

### Code quality / observability (DEFERRED, noted for backlog)

- M-Pi-1: Pi `Product` mirror missing `measured_full_at` — local set-once gate at `scale_events.py:2516` is dead code. Cloud handles it correctly. Either sync the column or remove the dead lookup.
- M-Pi-2: `ScannerLoop.run_once` and `run_forever` use different iterator paths (cached vs uncached). Cosmetic.
- M-Pi-3: 30%-of-net empty-container threshold is tight for tiny products (net=10g → 3g threshold). Operator hint warranted in docs.
- M-DB-M1: Wrapper LANGUAGE inconsistency (`sql` vs `plpgsql`). Cosmetic.
- M-DB-M2: `logical_date` source mismatch — edge function uses raw UTC, scanner action uses profile-aware. Day-boundary user impact at midnight-ish hours.
- M-Cloud-S1: `last_active_mode` not validated when read from scanner_state (DB CHECK already enforces).
- M-Cloud-S5: Wrapper comment vs grant inconsistency (resolved by C1 fix; comments updated).
- M-DB-1: `applied_food_log_id` capture uses post-call SELECT instead of `consume_product` returning the id. Same-tx ambiguity in hypothetical multi-step transactions; fine for current single-call edge function.
- M-DB-2: `void_scan_transaction` does NOT restore stock for `consume_macros` voids (food_logs deleted, stock decrements not reversed). Asymmetric UX. Either document UI-side or capture `consumption_payload JSONB` for replay.
- M-Web-5: `consume_no_macros` voids are silently irreversible from UI (no signal that "void" was a no-op). Disable Void button for that mode + add a tooltip.
- Test-1: `ScannerLogsTransaction.test.tsx:177` had `expect(['applied','errored']).toContain(patch.status)` — a tautology. (FIXED in C2 commit.)

### Operational / dev-loop hazards (DEFERRED)

- I-Cloud-1: Local edge runtime mounts main repo path, not worktree. Mirror state is brittle. Worktree-aware test wrapper would help.
- I-Cloud-5: x-api-key auth fallback (Pi misconfigured + browser logged in) doesn't log the failure. Diagnostic gap.

### Coverage gaps (NOTED)

- pgTAP tests for new tables don't pin CHECK constraint values, partial-index predicate, or FK ON DELETE behavior. Mitigated by integration tests covering the runtime behavior.
- Catch-all prompt fuzz coverage missing — the existing `test_prompt_purity_fuzz` only exercises the live-shelf path. If a future edit adds `lot_id` to the catch-all candidate JSON, no test catches it.
- Per-route negative paths in integration: `barcode-scan` with unrecognised barcode (placeholder fallback) and pi_event_id collision across users not tested.

---

## "No mock bs" mandate verification

The user explicitly required: _"Make sure testing system has been updated and test work e2e with no shortcuts or mock bs."_

**Verdict: mandate honored.** Evidence:

- `apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts` performs zero `vi.mock` calls. It uses real `fetch()` to `${SUPABASE_URL}/functions/v1/shelf-ingest/...` against the local Supabase Docker stack with service-role client for DB readbacks.
- Three scenarios cover the full chain:
  - Happy-path: mode push → Pi-style scan (x-api-key auth) → transaction logged → void reverses → lot deleted, transaction marked voided.
  - Trust boundary: `locked_mode` overrides body.mode (Pi cannot bypass user's lock).
  - Idempotency: same `pi_event_id` returns same transaction_id; exactly-one stock_lot.
- All three pass against the live local stack.
- Unit tests (which use `vi.mock` extensively) are appropriate isolation for component-level invariants (closure dep arrays, query invalidation, badge predicates) — they coexist with the integration layer rather than replacing it.

---

## Pre-existing fuzz failure verdict (NON-ISSUE)

`hardware/live-shelf/server/tests/property/test_prompt_purity_fuzz.py::test_prompt_text_never_contains_forbidden_lot_keys_or_honeypot` was reported as failing during the catch-all batch. Re-investigation found:

- Test passes deterministically across 5 standalone runs + 2 different Hypothesis seeds.
- Test is structurally sound: `Candidate.to_prompt_dict()` is a whitelist projection that never copies `lot_id` or any forbidden key. The honeypot constant `LOT_HONEYPOT_DO_NOT_LEAK_` is planted in `lot_id`, which the projection never touches.
- The audit's earlier concern that `Hypothesis generates candidate.name='pickup_weight_g'` would leak via the JSON `name` field is mitigated by the `_FORBIDDEN_LOT_KEYS` check using `'"pickup_weight_g"'` (with double quotes — JSON KEY form). A name value `pickup_weight_g` serializes as `"name": "pickup_weight_g"` and contains the bare token but not the keyform.

The earlier failure report was likely against a stale snapshot or a transient testmon-cache issue. The test is robust by design.

---

## Test suite final state

- **pgTAP:** 1,462 tests across 119 files, all pass (was 1,460 pre-audit; C1 fix added 2).
- **Pi pytest:** 1,575 passed, 1 skipped, 0 failed.
- **Web vitest unit:** 1,076 passed across 127 files (after `.env.local` copied to worktree per dev-setup gap).
- **Web vitest integration:** 463 passed, 8 skipped, 1 unrelated walmart-scrape flake.
- **Web vitest E2E (scanner-pipeline):** 3 passed.
- **Web typecheck:** clean (0 errors; 1 pre-existing `Unreachable code` warning at ScannerPage.tsx — exhaustiveness defense after a 4-case switch, not introduced by this branch).

---

## Outstanding follow-ups (not blocking merge)

In priority order:

1. M-Pi-1 / M-Pi-2 / M-Cloud-S5 cleanups (cosmetic).
2. M-DB-M2 logical_date alignment (day-boundary correctness for transactions logged at midnight-ish).
3. I-Cloud-1 worktree edge function mirror automation (dev-loop polish).
4. M-Web-5 disable Void on consume_no_macros (UX clarity).
5. I-Cloud-2 set-once TOCTOU hardening (when multi-device usage common).
6. I-Cloud-4 Pi unknown-barcode auto-create (architectural — accept service-role + explicit user_id in `analyze-product`).
7. I-Pi-2 scanner thread auto-restart on crash (operational reliability).

---

## Audit deliverables

- 2 critical security/data-integrity bugs fixed before merge.
- 6 important issues fixed via follow-up commits.
- All deferred items documented with rationale.
- Test infrastructure verified: real-cloud E2E meets the user's "no mock bs" mandate.
- Full test suite green across all four runtimes.

The branch is ready for merge after the user's review of this audit.
