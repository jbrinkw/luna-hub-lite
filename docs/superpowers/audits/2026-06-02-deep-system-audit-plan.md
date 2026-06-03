# Deep System Audit — Plan & Orchestration Contract

**Date:** 2026-06-02
**Scope:** Full functional audit of Luna Hub Lite + a mutation-driven re-audit of the test suite to expose false-passes.
**Method:** Heavy subagent fan-out (finder → adversarial verifier → synthesis), structured to defeat subagent laziness by construction.
**Status:** Plan. Awaiting go-ahead to launch.

This document is the single source of truth for the audit. **Every subagent is pointed at this file** and must obey the Anti-Laziness Contract (§2) and emit the Coverage Ledger (§3) for its scope.

---

## 0. Why this plan exists / what "done" means

The system is ~110K LOC across web (33.6K), migrations (27.4K), Pi/live-shelf (41K), edge functions (5K), app-tools (3.2K), extensions (2.6K), with 9 test layers (~770 test files). Two goals:

1. **Functional coverage** — find real defects across every feature surface, not a sample.
2. **Test integrity** — find tests that pass even when the feature they claim to cover is broken ("false-pass BS"). The repo's own test count is meaningless if the tests don't fail when the code breaks.

"Done" is defined mechanically (§6): every Coverage-Ledger row has a verdict, every confirmed finding has a reproduction, every test-layer has a mutation result, and a completeness critic finds no unaddressed rows.

---

## 1. Reflection: how subagents are lazy (and the design that counters each)

A subagent does **not** optimize for "maximize true coverage of the search space." It optimizes for "produce a plausible-looking deliverable that lets me stop." Every laziness pattern is a manifestation of _finding the cheapest path to something that looks done_. You cannot fix this by saying "don't be lazy" — you fix it by **making the lazy path produce a visibly incomplete artifact**. Taxonomy + structural counter:

| #   | Laziness pattern              | What it looks like                                                                                        | Structural counter (not a scold)                                                                                                                                                                                     |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Sample → generalize**       | "Read 3 of 12 pollers, the rest follow the pattern"                                                       | **Coverage Ledger**: one row per item with line count + verdict. Skipping = a missing row = mechanically visible.                                                                                                    |
| L2  | **Surface read**              | Reads signatures + happy path; skips `except`, the back half of long files, `else`, teardown, concurrency | **Read receipts**: must cite a line number from the _last third_ of every file >150 lines, and quote one error-path branch per function.                                                                             |
| L3  | **Name-trust**                | `test_denies_anon` is _assumed_ to deny anon; `validate_x` is _assumed_ to validate                       | **Quote the assertion, not the name.** A finding/verdict that cites a test name without quoting its actual assertion is rejected.                                                                                    |
| L4  | **Agreeableness**             | "Looks good", softens findings to "you might consider"                                                    | **Adversarial framing**: "Assume bugs exist. A clean verdict requires _evidence per item_, not absence of suspicion." Finder and verifier are different agents with opposed incentives.                              |
| L5  | **Satisfice on first hit**    | One bug found, written up nicely, done                                                                    | **Quota**: surface ≥ K candidates before filtering; loop-until-dry (2 empty rounds) for discovery domains.                                                                                                           |
| L6  | **Reason instead of execute** | _Argues_ a test is strong instead of _breaking the code and watching_                                     | **Mutation is mandatory** for the test audit: inject a bug, run the suite, require RED. Speculation is not a verdict.                                                                                                |
| L7  | **Vagueness hedge**           | "There may be a potential race condition"                                                                 | **Falsifiability rule**: every finding needs file:line + concrete trigger + observable symptom + repro. No repro ⇒ it's a feeling, not a finding (goes in a separate "unverified leads" bucket, never in confirmed). |
| L8  | **Seam blindness**            | Each agent owns one module; nobody owns the interface between two                                         | **Dedicated seam-auditors** (§4 track C). The bug we shipped last (`single_item`↔`live_scale`) lived in a seam no module-owner would check.                                                                          |
| L9  | **State assumption**          | Trusts memory/docs/comments about what code does                                                          | **Verify-at-audit-time**: every claim checked against the live file; docs/memory are leads, not evidence.                                                                                                            |
| L10 | **Empty = done**              | Treats "no findings" as success                                                                           | An empty result is the _most_ suspicious outcome. Clean domains require a positive cleanliness proof per ledger row, signed with evidence.                                                                           |

**Three load-bearing design moves** that fall out of the table:

- **A. Make incompleteness visible.** The Coverage Ledger (§3) forces a per-item shape; a lazy agent's gaps become missing rows. This single mechanism kills L1/L2/L10.
- **B. Demand artifacts, not opinions.** file:line, repro commands, failing-test output, mutation diffs. Artifacts are expensive to fabricate and cheap to check. Kills L3/L6/L7.
- **C. Split find from verify, with opposed incentives.** Finders over-report (recall); verifiers refute (precision). Balance is _not_ asked of any single agent. Kills L4.

---

## 2. The Anti-Laziness Contract (every subagent receives this verbatim)

> You are auditing a production system. Your output is consumed by an adversarial verifier whose job is to catch you cutting corners. Obey every rule; violations are detected and the work is rejected and re-run.
>
> **Scope discipline**
>
> 1. First, ENUMERATE your scope: list every file (with line count), function/endpoint/tool/test in your assignment. This list is your Coverage Ledger. You will produce one verdict per row. If you finish with rows that have no verdict, you have failed.
> 2. You MUST read every file in scope in full. For any file >150 lines, cite one specific line number and what's there from its **last third** — this proves you read past the easy part.
> 3. Do not sample and generalize. "The rest follow the same pattern" is a banned phrase. Check each one.
>
> **Evidence discipline** 4. Every claim is verified against the live file at audit time. Comments, docstrings, test names, memory, and this plan are LEADS, not evidence. Quote the code/assertion that proves your claim, with `path:line`. 5. Every finding has four parts or it does not count: (a) exact `file:line`, (b) a concrete trigger/input that exercises it, (c) the observable wrong behavior a user or system would see, (d) a reproduction — a command, a failing-test sketch, or a precise step list. A finding without (d) goes in "Unverified Leads," never in "Findings." 6. Banned outputs: "looks good", "you might consider", "there may be a potential", "should be fine", "probably". If you cannot make a falsifiable statement, say "UNRESOLVED — need: <what>".
>
> **Adversarial stance** 7. Assume bugs exist in your scope. Your prior is "this is broken until proven otherwise." A clean verdict on a ledger row requires a positive reason ("X is correct because the assertion at line N would fail if Y broke"), not the absence of an obvious bug. 8. Surface at least <K> candidate issues before you start filtering. Over-report; the verifier will cut the false ones. Under-reporting is the failure mode we are designing against.
>
> **Output shape** 9. Return the Coverage Ledger (every row, every verdict), then Findings (structured per rule 5), then Unverified Leads, then a Cleanliness Proof for every ledger row you marked clean. Word budget is generous; truncation or "for brevity" is a rule-7 violation.

`<K>` is set per domain (5 for small, 10+ for large/high-risk). The orchestrator injects the domain's file list and `<K>` into this template.

---

## 3. The Coverage Ledger (anti-sampling backbone)

Phase 0 produces, per domain, a machine-checkable ledger so every later phase can be held to "address every row." Shape:

```
| id | path | lines | kind | verdict | evidence |
|----|------|-------|------|---------|----------|
| HUB-01 | apps/web/src/pages/hub/AccountPage.tsx | 412 | page | <pending> | |
| HUB-02 | supabase/.../hub.save_extension_credentials | 88 | rpc | <pending> | |
```

`verdict ∈ {clean+proof, finding(s), unresolved}`. The synthesis phase rejects any domain whose ledger has `<pending>` rows.

---

## 4. Functional partition (domains → finder+verifier pairs)

Sized so a finder can actually cover its slice. Each domain gets ≥1 finder (Phase 1) and ≥1 independent verifier (Phase 2). Large domains (web Chef, Pi) get 2-3 finders split by sub-area.

### Track A — Application / product

- **A1 Hub** — auth, profile/tz/day_start_hour, MCP key mgmt (show-once, SHA-256), OAuth 2.1 consent, tool toggles, extension settings + Vault (save/clear/get, vault_secret_id pointer), AI agent proxy + Voice Assist.
- **A2 CoachByte** — sequential set state machine (`complete_next_set`), rest-timer DB state machine (atomic guards, exactly-once expiry), split planner, PR/Epley math, history keyset pagination, day lifecycle (`ensure_daily_plan`, bootstrap idempotency).
- **A3 ChefByte inventory/lots** — stock_lots, lot merge key, soft-delete (the new trigger), tombstone revive, locations, expiry/discard, visual unit, realtime.
- **A4 ChefByte recipes/meal/macros** — dynamic macro calc, meal-prep `[MEAL]` lots + frozen nutrition, mark/unmark done, `get_daily_macros`, temp items, targets/taste.
- **A5 ChefByte scanner/Walmart** — 4 scan modes, analyze-product pipeline + quota, undo, `scan_transactions`/void, `scanner_state` mode resolution, Pi USB forwarder, walmart-scrape.
- **A6 ChefByte LiveTrack (cloud)** — `scale_pairings`, shelf-ingest event/heartbeat, livetrack-session wizard, certify/tare set-once, calibration tags, backup/restore.

### Track B — Platform / infra

- **B1 Database** — RLS coverage on every table (the `(select auth.uid())=user_id` pattern + client-filter parity), SECURITY DEFINER + `search_path=''` correctness, CHECK constraints, plpgsql function logic, migration ordering integrity.
- **B2 Edge functions** — analyze-product (OFF→Claude, 4-4-9, quota, degraded), shelf-ingest (auth, validation, the new per-scale skip), walmart-scrape (rate limit), livetrack-session (dual auth), invariant-monitor. Auth + every error path.
- **B3 MCP Worker + app-tools** — 35+ tools, namespacing, API-key/OAuth auth, per-user tool toggles enforced, observability (`mcp_tool_logs`), CoachByte name→UUID resolution.
- **B4 Extensions** — Obsidian/Todoist/HA handlers, credential gating (isError without creds), error contracts, the GitHub-API/REST integration shapes.

### Track C — Live Shelf (Pi) + SEAMS (the L8 counter)

- **C1 Pi event pipeline** — scale_events ingress, shelf routing, classifier, reconciler, session capture, in-flight tracker.
- **C2 Pi cloud-sync** — the 7 pollers (re-verify the G1-G10 fixes landed + look for NEW gaps), worker/outbox, dead-letter.
- **C3 Pi storage/lifecycle** — SQLite schema, repo, in-flight TTL reaper, dedup LRU, retention sweepers, shutdown discipline.
- **C4 SEAM AUDITORS (dedicated, cross-domain):**
  - Pi↔cloud vocab (kind/shelf_id `single_item`↔`live_scale` — verify EVERY boundary calls the translate table now), IDs (pi_lot_id↔cloud_lot_id), units (g↔containers↔servings).
  - web↔edge↔db (does the browser query mirror RLS? do edge fns validate what the DB assumes?).
  - MCP↔RPC (tool input → RPC contract; does every tool error map to `isError`?).
  - day-boundary/timezone (`get_logical_date`, day_start_hour) consistency across web, Pi, RPC.
  - quantities/conversions (NUMERIC(10,3), floor-at-0, round-up shopping, servings_per_container) — one wrong conversion = silent data corruption.
  - realtime publication completeness (every table the UI subscribes to is actually in the publication — the 2026-04-27 food_logs regression class).
  - RLS-vs-client-filter parity (every client query duplicates the RLS filter; a missing client filter leaks nothing but a missing RLS policy leaks everything).

### Track D — Testing integrity (mutation-driven false-pass hunt) — §5

---

## 5. Testing-integrity audit (the "no false-pass BS" track)

This is the part the user cares most about. **Inspection alone is insufficient** (L6) — a test that _looks_ strong can still be a false-pass. Two passes per layer:

### Pass 1 — Inspection (per test file, adversarial)

For every test, the auditor performs the trace: _"If I broke the feature this test claims to cover, would THIS assertion fail?"_ Hunt the known false-pass mechanisms:

- **Tautologies** — `count > 0` on a seeded table; asserting a constant equals itself; `expect(x).toBeDefined()` on something always defined.
- **Weak assertions** — `toBeTruthy()` instead of the exact value; `status === 200` without checking the body; `lives_ok` (pgTAP) with no follow-up SELECT.
- **RLS-bypass reads** — integration tests that read back via `adminClient`/service-role, so a broken RLS policy still passes.
- **Mock-the-thing-under-test** — unit tests that mock the function they claim to test, or stub the RPC and assert the stub was called.
- **Name≠assertion** — `test_cross_user_denied` that never actually creates user B.
- **URL-only e2e** — `toHaveURL` with no visible-content assertion.
- **Seeded-state leakage** — test passes because of a prior test's rows, not its own.

### Pass 2 — Mutation (ground truth, mandatory)

Inspection finds _suspicious_ tests; mutation _proves_ false-passes. Leverage existing infra:

- Repo already has `scripts/verify/...mutation_pair_gate`, `mutmut` (Pi/python), Stryker (web), and `MUTATION_BASELINE_2026-04-30.md`. Use them; don't reinvent.
- Procedure per high-risk target: pick the load-bearing functions (RPCs that move stock/macros, the timer state machine, lot merge, RLS policies, the conversion math, the classifier dispatch, the pollers' watermark/apply logic). For each, inject a deliberate, semantically-meaningful mutation (flip a `>` to `>=`, drop a `WHERE user_id`, return early, off-by-one a conversion, skip the floor-at-0). Run the _relevant_ tests.
  - **RED** ⇒ the test catches it (good; record which test).
  - **GREEN** ⇒ proven false-pass. This is a finding with the strongest possible artifact: the mutation diff + the green test output.
- Don't mutate everything (too slow). **Sample by risk**, and `log()` exactly what was and wasn't mutated (no silent truncation — that would itself be L1 laziness).
- Special case for RLS: the highest-value mutation is "drop the `USING ((select auth.uid()) = user_id)` predicate or widen it to `true`" and confirm a cross-user pgTAP test goes RED. If no test goes red, the table's tenant isolation is untested — critical.

Output per layer: a table of `target → mutation → test result (RED/GREEN) → verdict`. Every GREEN is a confirmed false-pass finding.

---

## 6. Orchestration topology

Run as a **Workflow** (deterministic fan-out; user opted into heavy multi-agent). Phases:

- **Phase 0 — Decompose (≈16 cheap agents, one per domain).** Each emits its Coverage Ledger (§3) + flags partition gaps/overlaps. Barrier: merge ledgers, confirm the union covers the repo (cross-check against `find` file lists — any source file in no ledger is an escaped gap).
- **Phase 1 — Functional finders (fan out, ≈22 agents).** Each gets the Anti-Laziness Contract + its ledger + `<K>`. Adversarial bug hunt. Pipeline, not barrier: a domain's findings flow straight to verification.
- **Phase 2 — Adversarial verifiers (fan out, per finding).** Independent agents try to REFUTE each finding; executable claims require a repro. ≥majority-refute ⇒ killed. Survivors ⇒ confirmed. (Perspective-diverse for ambiguous ones: correctness / security / does-it-repro lenses.)
- **Phase 3 — Testing integrity (parallel track, ≈6 inspection agents + a mutation runner per layer).** §5. Mutation runs are the long pole — budget for them.
- **Phase 4 — Seam auditors (≈7 agents, Track C4).** The interface bugs.
- **Phase 5 — Completeness critic + synthesis.** Critic asks: which ledger rows lack verdicts? which findings lack repros? which seams/tables/test-layers weren't mutated? Its output becomes a remediation round if anything is missing. Synthesizer merges into one ranked report: **Confirmed (with repro) / Refuted / Unresolved**, severity-ordered, plus a test-integrity scorecard (false-passes per layer).

Concurrency is capped by the runtime (~10-16 live); total agents land in the 50-70 range across phases. Findings verify as they land (pipeline), so wall-clock ≈ slowest chain, not sum.

Model tiers: finders/verifiers/seams default to the session model; Phase-0 ledger-builders and the mutation-runner mechanics can run on a cheaper tier; synthesis on the strong model.

---

## 7. Deliverables

1. `docs/superpowers/audits/2026-06-02-deep-system-audit-FINDINGS.md` — ranked confirmed findings, each with file:line + repro + severity, grouped by domain.
2. `…-TEST-INTEGRITY.md` — per-layer scorecard: inspected count, false-passes found (with mutation diff + green output), coverage gaps (untested tables/functions/branches).
3. `…-COVERAGE-LEDGER.md` — the merged ledger with every row's final verdict (the proof we didn't sample).
4. A short remediation backlog (what to fix, ordered) — NOT auto-fixed; the user decides what to action.

The audit **only reports**. No code changes during the audit (a finder that "fixes while auditing" pollutes the verifier's ground truth). Remediation is a separate, post-audit decision.

---

## 8. What this plan deliberately does NOT do

- Does not trust the existing green `verify:full` as evidence of correctness — that's the thing under audit (a suite of false-passes is green too).
- Does not auto-fix — separation of audit from remediation keeps the verifier's baseline clean.
- Does not mutate exhaustively — risk-sampled, with explicit logging of what was skipped (silent truncation is itself the laziness we're hunting).
