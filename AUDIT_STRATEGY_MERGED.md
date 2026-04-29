# Luna Hub Lite — Systemic Audit Strategy (Merged)

This document reconciles two parallel planning passes (`AUDIT_STRATEGY.md` —
12 named lenses; `AUDIT_STRATEGY_codex.md` — 9 lens rows + 7-section coverage
matrix) into one playbook. It defines _how_ to audit for the systemic class of
bugs we have been hitting (asymmetry gaps, cross-system drift, idempotency
holes, watermark advancement on skip, timezone flakes, etc.) and is the
source-of-truth for the Coverage Matrix in §6.

---

## Section 1 — Audit Dimensions (the Lenses)

Lenses are orthogonal so findings rarely overlap. Numbering follows Claude's
L1–L12; the Codex 9-row matrix maps onto L1–L10 directly, with L11 / L12
promoted from sub-bullets to their own lenses (see Appendix B).

| #   | Lens                                | What it catches                                                                                                                            | How the pass executes                                                                                                                                                  |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Symmetry matrix                     | Feature implemented for entity A but absent for B (catch_all single-frame classifier orphaned; live_scale auto-register missing on Pi).    | Build an `(entity × feature)` grid by walking Pi `handlers/`, `intake/`, `cloud/` and edge `shelf-ingest/`. Any missing cell → finding unless waived in §7.            |
| L2  | Cross-system parity                 | Pi state and cloud state diverge silently (160.4 g Pi vs 1.6 ctn cloud; Pi `scale_pairings` empty while cloud populated).                  | Dynamic. Drive a Pi workflow via `scripts/harness/orchestrator.py`, then dual-read Pi SQLite + cloud Postgres for shared fields.                                       |
| L3  | Idempotency                         | Replay of `event_id` 500s; double-apply of `cloud_outbox` row; double-mint of a lot.                                                       | Static: every `SECURITY DEFINER` flagged idempotent or not by inspection of `ON CONFLICT`/explicit dup guard. Dynamic: re-emit each event 3×, assert stable.           |
| L4  | Resilience under failure            | One bad row blocks the worker; no DLQ in `cloud_outbox`; `backfill_missing_outbox_events` blindly replays 168 h.                           | Static: grep `outbox.py`/`worker.py` for retry loops without `max_attempts` + DLQ. Dynamic: poison row, drain, assert FIFO does not block.                             |
| L5  | Watermark correctness               | Poller advances watermark when apply was skipped → permanent loss.                                                                         | Static: every `cloud/*_poller.py` must update watermark only when row was applied. Dynamic: force a skip; assert watermark frozen.                                     |
| L6  | Delete propagation                  | Cloud `DELETE` does not reach Pi `lots.status`; Pi-side delete does not reach cloud.                                                       | Symmetric dynamic per table pair: seed both, delete one, drain pollers/outbox, assert both reflect deletion.                                                           |
| L7  | Time boundaries                     | UTC vs local-calendar mismatch (DST, leap-day, day_start_hour wraparound).                                                                 | Static: grep raw `now()`, `Date.now()` and verify each routes through `private.get_logical_date()`. Dynamic: clock-freeze at boundary timestamps incl. DST + leap-day. |
| L8  | Negative-space markers              | TODOs, "future X" comments, commented-out branches encoding never-implemented intent.                                                      | Static. Grep for TODO/FIXME/XXX/HACK/STUB/`future …`/`not yet implemented`/`deferred`. Each hit must be tracked, waived, or implemented.                               |
| L9  | Reality-shape fixtures              | Tests pre-seed rows that production never has — empty-table path never exercised.                                                          | Static: scan `conftest.py` for blanket seeding. Dynamic: every pytest with a `>0`-row fixture must have a sibling `_empty` variant.                                    |
| L10 | Schema asymmetry                    | Same logical field, different types/units/uniqueness across hops (`weight_g` vs `qty_containers`; `live_scale` cloud vs `single_item` Pi). | Extend `scripts/audit_schema_drift.py` to cover unit annotations on numeric columns (g, kg, ctn, srv) and uniqueness scope.                                            |
| L11 | Invariants in code, not heads       | Design rules ("single_track must NEVER mint a lot") only exist in the user's head — anchored by the `74a0240`/`2a14d4e` revert.            | Audit every doc + `ignore.md` + migration comment for "must/never/always" sentences. Each must trace to a pgTAP in `supabase/tests/invariants/`. Unpinned → finding.   |
| L12 | Authority boundaries (RLS / SECDEF) | A `SECURITY DEFINER` function takes user-provided IDs without verifying ownership.                                                         | Verify each is either (a) filtered by `auth.uid()`, (b) restricted to `service_role`, or (c) has explicit caller-trust precondition.                                   |

Where the two source plans disagreed on framing, the merged choice picks the
more falsifiable formulation so a finding either fires or doesn't, with no
judgement call. Disagreements are logged in Appendix B.

---

## Section 2 — Per-Component Audit Checklist

Compressed union of Claude §2.1–2.6 and Codex §2.

**2.1 Pi cloud sync (`hardware/live-shelf/server/cloud/`)** — every
`*_poller.py` has a sibling test exercising L3, L5, L6. `outbox.py` drain has
DLQ-on-poison test (L4); `worker.py` mid-tick shutdown replays exactly un-acked
rows; `client.py` retries cap at N + surface to outbox; `backfill_missing_outbox_events()`
runs before `CloudWorker.start()` and respects `known_pi_event_ids()`.
`pairings_sync_poller.py` (added in `d9f7210`) is reviewed against L1–L11. The
`live_scale` ↔ `single_item` translation is symmetric at every boundary.
`/healthz` exposes thread status for all five threads. No poller may have
empty-fixture-only tests (L9).

**2.2 Edge functions (`supabase/functions/`)** — `shelf-ingest` route matrix
aligns with Pi callers; `VALID_KINDS` / `VALID_EVENT_KINDS` consistent with Pi
emit paths; idempotency on duplicate `client_event_id` (L3); rate-limit + DLQ
for poison payload (L4); `occurred_at` window enforces 422 retry contract.
`analyze-product` per-user 100/day quota honors logical-date boundary (L7).
`walmart-scrape`, `livetrack-session`, `invariant-monitor`: L3 + L4 + L7. All
functions: `x-api-key` tested with WRONG / EXPIRED / REVOKED keys (L12).
`handleEvent()` branching: `live_weight_sync` → `apply_live_weight_sync_admin`;
lot-targeted discard → `apply_discard_with_lot_id_admin`; default →
`apply_shelf_event_admin`.

**2.3 MCP worker (`apps/mcp-worker/src/`)** — `registry.ts` ↔ backing-RPC
parity (L1); `/mcp` and `/sse` use same auth + JSON-RPC behavior;
`tool-executor.ts` enabled-flag + decrypt-RPC + parse-failure paths return
structured errors; `tool-logger.ts` writes idempotent on retry (L3);
`auth.ts` constant-time compare. Stryker mutation score ≥ threshold.

**2.4 Web app (`apps/web/src/`)** — `useRealtimeInvalidation`: every realtime
publication table has at least one subscriber; optimistic-mutation rollback
path tested; date formatters use `day_start_hour` not raw `Date.now()` (L7);
`ScalesTab.tsx` and `InventoryPage.tsx` enforce live_scale truth-source via
current `scale_pairings`; live-scale + live-shelf inventory pages render
through one shared formatter (L2 — defense against the 1.6 ctn vs 160.4 g bug).

**2.5 pgTAP invariants (`supabase/tests/invariants/`)** — pin every "rule"
from `docs/`, `ignore.md`, and inline migration comments. Existing
models: `live_scale_never_mints.test.sql`, `event_kind_emit_handle_matrix.test.sql`,
`scale_pairings_lot_id_consistency.test.sql`. Add (post-Phase-1):
`cloud_outbox_dlq_isolation` (L4), `watermark_no_advance_on_skip` (L5),
`delete_tombstones_propagate` (L6), `apply_shelf_event_idempotent` (L3),
`weight_unit_consistency` (L2 + L10), `food_logs_logical_date_immutable_on_update` (L11).

**2.6 Harness (`scripts/harness/scenarios/`)** — each scenario declares its
lenses in a top-of-file docstring tag (`# LENSES: L2, L6`). Untagged scenarios
default to L0 and are flagged.

---

## Section 3 — Standardized Finding Format

(Claude's shape — the more falsifiable of the two — adopted verbatim.)

```
### [Direction] [Severity] — [One-line title]
- **Direction**: Pi→Cloud | Cloud→Pi | Cloud↔Web | MCP↔Cloud | Internal-Pi | Internal-Cloud | Cross-cutting
- **Severity**: CRITICAL (data loss / privilege escalation) | HIGH (silent divergence, recoverable) | MEDIUM (DX / observability) | LOW (cosmetic)
- **Lens**: L1–L12
- **What**: 1–3 sentences in invariant form ("X happens when Y; should be Z").
- **Evidence**: `path/to/file.ext:LINE-RANGE` (absolute paths).
- **Suggested fix**: 1–3 bullets.
- **Waiver candidate?**: yes/no + reason.
```

CRITICAL findings block CI. HIGH require an issue + ETA. MEDIUM/LOW go to a
follow-ups list.

---

## Section 4 — Execution Order

**Phase 1 — Static-only (~5–10 min, no DB, no harness).** Run L1, L8, L10, L11,
L12. _This is the deliverable in `AUDIT_FINDINGS_PHASE1.md`._ Order: L8 grep
sweep → L1 symmetry-matrix builder → L10 schema-drift extension → L11
invariant-text extractor → L12 SECURITY DEFINER scope check.

**Phase 2 — Dynamic / integration (~30–45 min).** Requires harness + Pi sandbox
SQLite + local Supabase. Covers L2 parity assertions, L3 replays, L5 watermark
probes, L6 delete propagation, L7 time-boundary harness (UTC + local-midnight

- DST + leap-day), L9 empty-fixture variants.

**Phase 3 — Adversarial (~30 min).** L4 poison-row in `cloud_outbox`; worker
SIGKILL mid-tick; Pi reboot during sync (`backfill_missing_outbox_events` must
reconcile against cloud HEAD, not blindly replay 168 h); network-partition →
outbox grows but doesn't corrupt; on reconnect drains FIFO without duplicates.

---

## Section 5 — Required Tooling / Harness

| Tool                                             | Status                                                                  | Lens               |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------ |
| `scripts/audit_schema_drift.py`                  | EXISTS — extend for L10 unit annotations                                | L10                |
| `scripts/audit_test_quality.py`                  | EXISTS — extend for L9 empty-fixture detection                          | L9                 |
| `scripts/harness/orchestrator.py` + `scenarios/` | EXISTS — add lens tags + parity assertions                              | L2, L3, L4, L5, L6 |
| `scripts/audit_symmetry_matrix.py`               | **TO BUILD** — emit `(entity × feature)` grid as JSON                   | L1                 |
| `scripts/audit_invariants_pinned.py`             | **TO BUILD** — extract "must/never/always" docs vs `tests/invariants/`  | L11                |
| `scripts/audit_negative_space.py`                | **TO BUILD** — TODO/future/stub grep with allow-list                    | L8                 |
| `scripts/harness/clock_freeze.py`                | **TO BUILD** — `freezegun` + Postgres `set_config('app.frozen_now', …)` | L7                 |
| `scripts/harness/poison_outbox.py`               | **TO BUILD** — injects malformed `cloud_outbox` row                     | L4                 |
| `scripts/harness/parity_assert.py`               | **TO BUILD** — generic Pi-SQLite ↔ Postgres diff                        | L2                 |
| Coverage Matrix generator                        | **TO BUILD** — renders §6 table                                         | meta               |

The six "TO BUILD" items are deferred to the audit _executor_ agent — this
strategy doc only specifies their contracts.

---

## Section 6 — Coverage Matrix (template — first audit pass populates statuses)

Statuses: ✅ covered | ⚠️ gap | 🟡 partial | 🚫 waived. Entity list is
Claude's; column structure is Codex's.

| Entity / Surface             | L1  | L2  | L3  | L4  | L5  | L6  | L7  | L8  | L9  | L10 | L11 | L12 |
| ---------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live_shelf                   |     |     |     |     |     |     |     |     |     |     |     |     |
| live_scale                   |     |     |     |     |     |     |     |     |     |     |     |     |
| catch_all                    |     |     |     |     |     |     |     |     |     |     |     |     |
| products                     |     |     |     |     |     |     |     |     |     |     |     |     |
| stock_lots                   |     |     |     |     |     |     |     |     |     |     |     |     |
| livetrack_sessions           |     |     |     |     |     |     |     |     |     |     |     |     |
| scale_pairings (cloud)       |     |     |     |     |     |     |     |     |     |     |     |     |
| scale_pairings (Pi)          |     |     |     |     |     |     |     |     |     |     |     |     |
| cloud_outbox                 |     |     |     |     |     |     |     |     |     |     |     |     |
| event_overrides              |     |     |     |     |     |     |     |     |     |     |     |     |
| food_logs / macros           |     |     |     |     |     |     |     |     |     |     |     |     |
| recipes                      |     |     |     |     |     |     |     |     |     |     |     |     |
| meal_plan_entries            |     |     |     |     |     |     |     |     |     |     |     |     |
| shopping_list                |     |     |     |     |     |     |     |     |     |     |     |     |
| coachbyte.timer              |     |     |     |     |     |     |     |     |     |     |     |     |
| coachbyte.planned_sets       |     |     |     |     |     |     |     |     |     |     |     |     |
| api_keys                     |     |     |     |     |     |     |     |     |     |     |     |     |
| extension_settings           |     |     |     |     |     |     |     |     |     |     |     |     |
| MCP worker (registry+logger) |     |     |     |     |     |     |     |     |     |     |     |     |
| pgTAP invariants             |     |     |     |     |     |     |     |     |     |     |     |     |

Phase 2 fills this in. Each ⚠️ becomes a queued fix.

---

## Section 7 — What NOT to Audit

- MCP per-tool DEFINITION shape (registry tests already cover it).
- `legacy/` directory (reference-only, never deployed).
- `supabase/tests/00_rls_pattern.test.sql`-style canary tests (L12 builds on these — don't re-audit the pattern).
- `scripts/audit_*.py` self-tests.
- Generated files (`packages/db-types/`, `playwright-report-e2e/`, build dirs).
- UI styling / Tailwind classes (covered by `frontend-design`).
- Fridge-cam + scale-board firmware (covered by hardware-loop tests; lenses target server/cloud sync).
- Stryker mutation runs (separate quality gate).
- Classifier model precision/recall (Codex constraint — not deterministic state corruption).
- Performance micro-optimizations (this audit is bug-driven, not latency-driven).
- Broad CoachByte/Hub feature logic outside shared infra (`logical_date`, auth/RLS, realtime, extension_settings, timer state machine).

### L1 symmetry-matrix waivers

`scripts/audit_symmetry_matrix.py` carries an in-source `WAIVERS` map for cells that genuinely don't apply to a given entity. The full justified list lives next to the cell in code; the user-visible summary:

- **`catch_all × weight_sync_to_cloud`** — catch-all has its own `catch_all_first_measurement` / `_second_measurement` event pair (migrations `20260427120000` / `20260427130000`). The `weight_sync_poller` scope clause filters it out so no duplicate cloud events are emitted.
- **`live_scale × classifier_prompt`** and **`single_item × classifier_prompt`** — the classifier is camera-driven (Anthropic vision before/after frame pair). Live-scale rigs are HX711 load-cell-only with no camera, so the prompt scaffolding genuinely doesn't apply to either the cloud (`live_scale`) or Pi (`single_item`) synonym.
- **`single_item × auto_register`** — auto-register lives in the cloud edge fn `supabase/functions/shelf-ingest/index.ts` which speaks the cloud vocabulary `{live_shelf, live_scale, catch_all}`. The Pi-only `single_item` literal is never in scope there.
- Cloud↔Pi vocabulary translator (`hardware/live-shelf/server/cloud/_kind_translate.py`) handles the `live_scale ↔ single_item` boundary, so each side is allowed to be absent in the OTHER side's storage / handler / outbox / UI section. This was the L10/HIGH fix from `AUDIT_FINDINGS_PHASE1.md`.

### L11 invariants-pinned waivers

`scripts/audit_invariants_pinned.py` greps for must/never/always sentences across `docs/`, `AUDIT_STRATEGY*.md`, `planned-work.md`, migrations, and `hardware/live-shelf/server/storage/schema.sql`, then asserts each rule is pinned by a filename in `supabase/tests/invariants/`. The bare grep is intentionally aggressive (it cannot distinguish "X must Y" rules from "X has never seen Y" narrative), so the script carries three explicit waiver mechanisms reviewed line-by-line during the Phase-2 triage:

1. **`WAIVED_FILE_PREFIXES`** — entire files whose purpose is to _describe_ rules rather than encode them. Audit-strategy markdowns (`AUDIT_STRATEGY*.md`), planning docs (`docs/superpowers/plans/`, `docs/superpowers/specs/`), the verification-gate spec (`docs/VERIFY.md`), the L11 lens spec itself (`docs/testing/design-intent-invariants.md`), test-system retros (`docs/test-system-fix-plan.md`, `docs/test-audit-*.md`), accountability-process docs (`docs/accountability/`), and the forward-looking `planned-work.md`. Their must/never/always sentences are how-to-audit instructions, not production invariants.
2. **`IN_CODE_ENFORCED_SUBSTRINGS`** — `RAISE EXCEPTION '... must ...'`, `GENERATED ALWAYS AS`, `USING HINT = '... must ...'`, `USING ERRCODE`. These ARE the enforcement code; happy-path + error-path coverage in `supabase/tests/<schema>/` already exercises them (otherwise the migration wouldn't compile). Re-asserting a CHECK constraint in `invariants/` would be tautological.
3. **`NARRATIVE_PATTERNS`** — regex patterns for descriptive phrasings ("never observed", "never trips", "NULL = never observed", "always reflects", etc.) that describe past behaviour or non-testable context.
4. **`WAIVED_LINES`** — explicit `(file, line)` overrides for cases the broader patterns shouldn't cover. Each entry records why the rule is pinned elsewhere (cross-reference to a non-`invariants/` test file like `supabase/tests/chefbyte/*` or `supabase/tests/hub/*`, an app-tools integration test, or a frontend-design layer).

The Phase-2 triage closed all 208 initial L11 findings: 91 already-pinned plus 3 new pgTAP files (`nonneg_check_constraints.test.sql`, `discard_lot_by_id_ownership.test.sql`, `close_in_flight_lot_ownership.test.sql`) covering the genuinely-new invariants, and the rest into the four waiver categories above. Section 7 should NOT widen beyond truly-advisory items — every entry above has a filename or pattern that a reviewer can audit.

---

## Appendix A — Anchoring Each Lens to a Real Bug Pattern

L1: live_scale auto-register missing; `pairings_sync_poller` absent until `d9f7210`; catch_all single-frame classifier orphaned. L2: 1.6 ctn cloud vs 160.4 g Pi. L3: `apply_shelf_event` 500 on duplicate event_id. L4: `cloud_outbox` row 97 FIFO-blocking 98+99. L5: `event_overrides_poller` advancing watermark on skip. L6: `lot_snapshot_poller` tombstone DELETE not propagating to Pi `lots.status`. L7: 2 pgTAP tests failing only 8 pm–midnight EDT. L8: "future single_item" comment in `app.py`. L9: Pi `scale_pairings` empty in prod but tests pre-seeded. L10: g vs ctn unit drift; live_scale (cloud) vs single_item (Pi) literal collision. L11: "single_track must never mint" not pinned → revert of `74a0240`/`2a14d4e`. L12: cousin family — preempts the next-tier privilege-escalation bug.

---

## Appendix B — Reconciliation Log

Disagreements between the two source plans, and the chosen path:

1. **Lens count.** Claude=12, Codex=9. _Picked Claude's 12._ Codex bundled "invariants in code" under "Schema asymmetry" and "authority boundaries" was implicit; promoting them keeps findings sortable and the fix-shape distinct.
2. **L7 scope.** Codex limited time-boundary auditing to existing midnight cases; Claude wanted DST + leap-day. _Picked Claude_ — adversarial coverage is cheap once the harness exists.
3. **Finding format.** Claude used a Markdown block, Codex a 5-field table. _Picked Claude's block_ — the "Reproduction" line carries scenario name for dynamic findings.
4. **Severity scale.** Claude: CRITICAL/HIGH/MEDIUM/LOW; Codex: S0/S1/S2/S3. _Picked Claude_ — text labels survive grep.
5. **Coverage matrix entity list.** Claude had 18 rows, Codex had 11 file-grouped surfaces. _Picked Claude's entities_ inside Codex's column structure.
6. **What NOT to audit.** Codex constrained CoachByte/Hub more aggressively. _Reconciled_ — kept timer + day_start_hour in scope (shared infra), excluded the rest.
7. **Required tooling.** Both lists matched on the six "TO BUILD" items. _Adopted both verbatim._
8. **L11 enforcement.** Codex argued happy-path-only tests suffice when invariants live in CHECK constraints; Claude argued every "must/never" sentence in docs needs a test. _Picked Claude_ — recent reverts came from unpinned design rules.

End of merged strategy. Phase 1 was executed against this contract; results
land in `AUDIT_FINDINGS_PHASE1.md`.
