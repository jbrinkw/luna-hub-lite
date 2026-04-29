# Luna Hub Lite — Systemic Audit Strategy

Audit playbook to surface logical bugs, sync gaps, asymmetries, and idempotency holes that the existing ~1600 tests routinely miss. Anchored in the recent ~15+ findings (live_scale auto-register missing, `pairings_sync_poller` absent, cloud_outbox FIFO blocked at row 97, weight unit drift Pi=160.4g vs cloud=1.6 ctn, watermark advances on skip, timezone flakes, etc.). The audit is designed to be re-run on every architectural change and is the source-of-truth for the Coverage Matrix in §6.

---

## Section 1 — Audit Dimensions (the Lenses)

Each pass walks the codebase through one lens. Lenses are orthogonal so findings rarely overlap.

| #   | Lens                                                    | What it catches                                                                                                                                                               | How the pass executes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Symmetry matrix**                                     | Feature implemented for entity A but missing for B (e.g. catch_all has single-frame classifier, live_shelf/live_scale don't). Live_scale auto-register, weight sync to Pi-UI. | Read-only. Build a (entity × feature) grid by scanning `hardware/live-shelf/server/handlers/`, `intake/`, `cloud/`, the `device_kind` enum, and `chefbyte.shelf_event_kind`. Any missing cell → finding unless explicitly waived in §7.                                                                                                                                                                                                           |
| L2  | **Cross-system parity**                                 | Pi state and cloud state diverge silently (chicken weight 160.4g Pi vs 1.6 ctn cloud; pairings empty on Pi vs populated cloud-side).                                          | Dynamic. Seed a workflow on Pi via `scripts/harness/orchestrator.py`, run polling cycle, then read BOTH `hardware/live-shelf/server/storage/schema.sql` SQLite tables AND `chefbyte.*` Postgres tables and assert agreement on shared fields (qty, weight_g, status, lot_id, expires_on).                                                                                                                                                         |
| L3  | **Idempotency**                                         | Replay of `event_id` 500s, double-apply of cloud_outbox row, double-mint of lot. `apply_shelf_event` 500 on duplicate event_id; cloud_outbox row 97 blocking FIFO.            | Static + dynamic. Static: every plpgsql `SECURITY DEFINER` function in `supabase/migrations/*.sql` must be flagged "idempotent" or "non-idempotent" by inspection of `INSERT … ON CONFLICT` / explicit duplicate check. Dynamic: harness test that re-emits the same event 3× and asserts (a) no error, (b) state stable after first apply.                                                                                                       |
| L4  | **Resilience under failure**                            | One bad row blocks worker. No DLQ in `cloud_outbox`. `backfill_missing_outbox_events` blindly replays 168h.                                                                   | Static: grep for retry loops without max-attempt + dead-letter (`hardware/live-shelf/server/cloud/outbox.py`, `worker.py`). Dynamic: inject a poison row, run drain, assert non-poison rows still drain (FIFO must not block).                                                                                                                                                                                                                    |
| L5  | **Watermark correctness**                               | Poller advances watermark when apply was skipped/failed → permanent loss. `event_overrides_poller`, `lot_snapshot_poller`, `product_sync_poller`.                             | Static: every file matching `hardware/live-shelf/server/cloud/*_poller.py` must (a) only update watermark inside the same DB transaction as the row apply, or (b) explicitly handle skip→don't-advance. Dynamic: harness test "force apply to skip; assert watermark unchanged; rerun with apply working; assert row applied."                                                                                                                    |
| L6  | **Delete propagation**                                  | Cloud DELETE doesn't reach Pi `lots.status` (tombstone bug). Pi-side delete doesn't reach cloud.                                                                              | Symmetric dynamic. For each pair (`products`, `stock_lots`, `live_shelf_devices`, `scale_pairings`, `recipes`, `meal_plan_entries`): seed both sides, delete one side, run pollers + outbox drain, assert the other side reflects deletion.                                                                                                                                                                                                       |
| L7  | **Time boundaries**                                     | UTC vs local-calendar mismatch. 2 tests failed only between UTC-midnight and local-midnight (8pm–midnight EDT).                                                               | Static: grep for raw `now()`, `CURRENT_DATE`, `datetime.utcnow()`, `Date.now()` and verify each goes through `private.get_logical_date()` or its TS/Python equivalent. Dynamic: clock-skew harness — freeze wall clock at `2026-04-28 03:30 UTC` (i.e. 23:30 EDT prior day), run every test that touches dates, then again at `2026-04-28 06:30 UTC`, assert results match. Add DST transition (`2026-03-08 06:30Z`) and leap-day (`2024-02-29`). |
| L8  | **Negative-space markers**                              | TODOs, "future X" comments, commented-out branches encoding intent never implemented. `app.py` "future single_item" comment was the literal smoking gun.                      | Static. Grep `(?i)todo                                                                                                                                                                                                                                                                                                                                                                                                                            | fixme | xxx | future | hack | stub | not.?yet | deferred`across`apps/`, `hardware/`, `supabase/`, `packages/`. Each hit must be (a) tracked to a deferred-backlog issue with a date, or (b) waived in §7, or (c) implemented. |
| L9  | **Reality-shape fixtures**                              | Tests pre-seed rows that production never has, so empty-table code path is never exercised. Pi `scale_pairings` empty in prod but tests had 3 rows.                           | Static + dynamic. Static: scan `hardware/live-shelf/server/cloud/tests/conftest.py` (and any `conftest.py`) for blanket seeding. Dynamic: every pytest test with a fixture that inserts >0 rows must have a sibling `_empty` variant that runs the same assertion path against zero rows.                                                                                                                                                         |
| L10 | **Schema asymmetry**                                    | Same logical field, different types/units/uniqueness across hops. `weight_g` (g) vs `qty` (containers); `scale_pairings` naming collision Pi vs cloud.                        | Extend the existing `scripts/audit_schema_drift.py` to cover (a) unit annotations on numeric columns (g, kg, ctn, srv) and (b) uniqueness scope (per-user vs global vs per-device).                                                                                                                                                                                                                                                               |
| L11 | **Invariants in code, not heads**                       | Design rules ("single-track scale must NEVER mint a lot") only exist in user's mental model. Revert of `74a0240`/`2a14d4e` because no pgTAP pinned the contract.              | Static. Audit every plan/decision doc in `docs/` and `ignore.md` for "must / never / always" sentences. Each must trace to a pgTAP test in `supabase/tests/invariants/` (e.g. `live_scale_never_mints.test.sql` is the model). Any rule without a test → finding.                                                                                                                                                                                 |
| L12 | **Authority boundaries (RLS / SECURITY DEFINER scope)** | A function runs as `SECURITY DEFINER` but takes user-provided IDs without verifying ownership.                                                                                | Static. For each `SECURITY DEFINER` function in `supabase/migrations/*.sql`, verify either (a) `WHERE … = (select auth.uid())` filter, or (b) explicit ownership precondition. Already partially covered by `supabase/tests/hub/*_rls.test.sql`.                                                                                                                                                                                                  |

---

## Section 2 — Per-Component Audit Checklist

### 2.1 Pi cloud sync layer (`hardware/live-shelf/server/cloud/`)

- Every poller file (`*_poller.py`) has a sibling test that exercises L3, L5, L6.
- `outbox.py` drain has DLQ-on-poison test (L4).
- `worker.py` shutdown mid-tick → next start replays exactly the un-acked rows (L3 + L4).
- `client.py` retries cap at N + surface error to outbox (L4).
- `pairings_sync_poller.py` (newly added per `d9f7210`) is reviewed for the same L1–L11 checklist now that it exists.
- Verify NO poller has empty-fixture tests only (L9).

### 2.2 Edge functions (`supabase/functions/`)

- `shelf-ingest`: idempotency on duplicate `event_id` (L3); rate limit + DLQ for poison payload (L4).
- `analyze-product`: per-user 100/day cap honors UTC vs logical-date boundary (L7); idempotency on retry (L3).
- `walmart-scrape`, `livetrack-session`, `invariant-monitor`: same checklist — L3, L4, L7.
- All functions: x-api-key hashing path tested with WRONG, EXPIRED, REVOKED keys (L12).

### 2.3 MCP worker (`apps/mcp-worker/src/`)

- `registry.ts` + tool definitions: every tool maps to a backing RPC; assert no orphan tools and no orphan RPCs (L1, symmetry of tool ↔ RPC).
- `tool-executor.ts`: error path returns structured JSON (no leaked stack traces).
- `auth.ts`: API key check uses constant-time compare.
- `tool-logger.ts`: writes are idempotent on retry (L3).
- Stryker config (`stryker.mcp-worker.conf.json`) mutation score ≥ threshold; record gaps.

### 2.4 Web app (`apps/web/src/`)

- Realtime subscriptions (`hooks/useRealtimeInvalidation`): every table in `realtime publication` has at least one component that subscribes; orphan subs caught by L1.
- Optimistic mutations: rollback path tested (`__tests__/`).
- Timezone: every component formatting a date uses the user's `day_start_hour` not `Date.now()` (L7).
- Live-scale + live-shelf inventory pages render parity-correct values from the same shared formatter (L2 — defense against repeating the 1.6 ctn vs 160.4 g bug).

### 2.5 pgTAP invariants (`supabase/tests/invariants/`)

Pin every "rule" from `docs/`, `ignore.md`, and inline comments as a pgTAP test. Existing models: `live_scale_never_mints.test.sql`, `event_kind_emit_handle_matrix.test.sql`. Add (proposed names — actual implementation later):

- `cloud_outbox_dlq_isolation.test.sql` (L4)
- `watermark_no_advance_on_skip.test.sql` (L5)
- `delete_tombstones_propagate.test.sql` (L6)
- `apply_shelf_event_idempotent.test.sql` (L3)
- `weight_unit_consistency.test.sql` (L2 + L10)

### 2.6 Harness (`scripts/harness/scenarios/`)

- Every scenario file must declare which lens(es) it covers in a top-of-file docstring tag (`# LENSES: L2, L6`). Coverage Matrix consumes these tags. Scenarios with no tag default to L0 (uncategorized) and are flagged.

---

## Section 3 — Standardized Finding Format

Every finding emitted by the audit MUST follow this shape:

```
### [Direction] [Severity] — [One-line title]
- **Direction**: Pi→Cloud | Cloud→Pi | Cloud↔Web | MCP↔Cloud | Internal-Pi | Internal-Cloud | Cross-cutting
- **Severity**: CRITICAL (data loss / corruption) | HIGH (silent divergence, recoverable) | MEDIUM (DX / observability) | LOW (cosmetic)
- **Lens**: L1–L12
- **What**: 1–3 sentences describing the gap.
- **Evidence**: `path/to/file.ext:LINE-RANGE` with snippet ≤ 5 lines.
- **Reproduction**: minimal steps or harness scenario name (if dynamic).
- **Suggested fix**: 1–3 bullets, including the migration / poller / test that should be added.
- **Waiver candidate?**: yes/no + reason (used to populate §7 if accepted).
```

CRITICAL findings block CI. HIGH require an issue + ETA. MEDIUM/LOW go to a follow-ups list.

---

## Section 4 — Execution Order

### Phase 1 — Static (read-only, fast, ~5–10 min)

Run lenses L1, L8, L10, L11, L12 first — they need no DB and no harness. Outputs are immediately actionable.

1. L8 grep sweep → list of TODO/future/stub markers.
2. L1 symmetry-matrix builder → grid of (entity × feature).
3. L10 schema-drift extension → reuse `scripts/audit_schema_drift.py`.
4. L11 invariant-text extractor → list of "must / never / always" claims, joined against `supabase/tests/invariants/` filenames.
5. L12 SECURITY DEFINER scope check.

### Phase 2 — Dynamic (integration, ~30–45 min)

Requires harness + Pi sandbox SQLite + local Supabase running.

6. L2 cross-system parity: each scenario in `scripts/harness/scenarios/` augmented with a parity assertion at the end.
7. L3 idempotency replays: re-emit each event kind 3×.
8. L5 watermark probes: force a skip; assert watermark frozen.
9. L6 delete propagation: per-table delete + reconcile.
10. L7 time-boundary harness: clock-freeze runs at UTC-midnight, local-midnight, DST, leap-day.
11. L9 empty-fixture variants: rerun every Pi test with fixtures stripped.

### Phase 3 — Adversarial (chaos, ~30 min)

12. L4 poison row in `cloud_outbox`: assert downstream rows still drain.
13. L4 worker SIGKILL mid-tick: assert resume correctness.
14. L4 Pi reboot during sync: `backfill_missing_outbox_events` must reconcile against cloud HEAD, not blindly replay 168h.
15. Network partition (Pi can't reach Edge): outbox grows but doesn't corrupt; on reconnect, drains in FIFO without duplicates.

---

## Section 5 — Required Tooling / Harness

| Tool                                             | Status                                                                                       | Purpose            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------ |
| `scripts/audit_schema_drift.py`                  | EXISTS — extend for L10 unit annotations                                                     | L10                |
| `scripts/audit_test_quality.py`                  | EXISTS — extend for L9 empty-fixture detection                                               | L9                 |
| `scripts/harness/orchestrator.py` + `scenarios/` | EXISTS — needs lens tags + parity assertions added (L2)                                      | L2, L3, L4, L5, L6 |
| `scripts/audit_symmetry_matrix.py`               | **TO BUILD** — emit (entity × feature) grid as JSON                                          | L1                 |
| `scripts/audit_invariants_pinned.py`             | **TO BUILD** — extract "must/never/always" from docs, join vs `tests/invariants/` filenames  | L11                |
| `scripts/audit_negative_space.py`                | **TO BUILD** — TODO/future/stub grep with allow-list                                         | L8                 |
| `scripts/harness/clock_freeze.py`                | **TO BUILD** — wraps harness with `freezegun` + Postgres `set_config('app.frozen_now', ...)` | L7                 |
| `scripts/harness/poison_outbox.py`               | **TO BUILD** — injects malformed `cloud_outbox` row                                          | L4                 |
| `scripts/harness/parity_assert.py`               | **TO BUILD** — generic Pi-SQLite ↔ Postgres diff for shared fields                           | L2                 |
| Coverage Matrix generator                        | **TO BUILD** — consumes outputs of all of the above and renders §6 table                     | meta               |

All "TO BUILD" items are deferred to the audit _executor_ agent — this strategy doc only specifies their contracts.

---

## Section 6 — Coverage Matrix (template — first audit pass populates statuses)

Statuses: ✅ covered | ⚠️ gap | 🟡 partial | 🚫 waived

| Entity / Surface       | L1 sym | L2 parity | L3 idem | L4 resil | L5 wm | L6 del | L7 time | L8 neg | L9 fix | L10 schema | L11 inv | L12 auth |
| ---------------------- | ------ | --------- | ------- | -------- | ----- | ------ | ------- | ------ | ------ | ---------- | ------- | -------- |
| live_shelf             |        |           |         |          |       |        |         |        |        |            |         |          |
| live_scale             |        |           |         |          |       |        |         |        |        |            |         |          |
| catch_all              |        |           |         |          |       |        |         |        |        |            |         |          |
| products               |        |           |         |          |       |        |         |        |        |            |         |          |
| stock_lots             |        |           |         |          |       |        |         |        |        |            |         |          |
| livetrack_sessions     |        |           |         |          |       |        |         |        |        |            |         |          |
| scale_pairings (cloud) |        |           |         |          |       |        |         |        |        |            |         |          |
| scale_pairings (Pi)    |        |           |         |          |       |        |         |        |        |            |         |          |
| cloud_outbox           |        |           |         |          |       |        |         |        |        |            |         |          |
| event_overrides        |        |           |         |          |       |        |         |        |        |            |         |          |
| food_logs / macros     |        |           |         |          |       |        |         |        |        |            |         |          |
| recipes                |        |           |         |          |       |        |         |        |        |            |         |          |
| meal_plan_entries      |        |           |         |          |       |        |         |        |        |            |         |          |
| shopping_list          |        |           |         |          |       |        |         |        |        |            |         |          |
| coachbyte.timer        |        |           |         |          |       |        |         |        |        |            |         |          |
| coachbyte.planned_sets |        |           |         |          |       |        |         |        |        |            |         |          |
| api_keys               |        |           |         |          |       |        |         |        |        |            |         |          |
| extension_settings     |        |           |         |          |       |        |         |        |        |            |         |          |

The first pass's job is to fill this in. Each ⚠️ becomes a queued fix.

---

## Section 7 — What NOT to Audit

| Surface                                                                               | Reason                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP worker tool-DEFINITION shape                                                      | Auto-tested via `apps/mcp-worker/src/__tests__/` registry tests; registry-level symmetry already enforced by L1 §2.3 — no per-tool deep audit. |
| `legacy/` directory                                                                   | Reference-only; never deployed. Skip all lenses.                                                                                               |
| `supabase/tests/00_rls_pattern.test.sql` style canary tests                           | Already enforce structural RLS via pattern-grep. L12 builds on these — don't re-audit pattern itself.                                          |
| `scripts/audit_*.py` self-tests                                                       | Out of scope — we audit production, not the auditors (chicken-and-egg).                                                                        |
| Generated files (`packages/db-types/`, `playwright-report-e2e/`, `test-results-e2e/`) | Mechanically derived.                                                                                                                          |
| UI styling / Tailwind classes                                                         | Not a logical-bug surface; covered by visual review and `frontend-design` skill.                                                               |
| Fridge-cam + scale-board firmware (`hardware/fridge-cam/`, `hardware/scale-board/`)   | Embedded code, already covered by hardware-loop tests; the L1–L12 lenses target server/cloud sync, not microcontroller logic.                  |
| Stryker mutation runs                                                                 | Separate quality gate (`stryker.conf.json`), not a logical-bug audit.                                                                          |

---

## Appendix A — Anchoring Each Lens to a Real Bug Pattern

| Lens | Bug pattern it catches                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| L1   | live_scale auto-register missing; `pairings_sync_poller` absent; catch_all single-frame classifier orphaned. |
| L2   | weight=1.6 ctn cloud vs 160.4 g Pi.                                                                          |
| L3   | `apply_shelf_event` 500 on duplicate event_id.                                                               |
| L4   | cloud_outbox row 97 FIFO-blocking 98+99.                                                                     |
| L5   | `event_overrides_poller` advancing watermark on skip.                                                        |
| L6   | `lot_snapshot_poller` tombstone DELETE not propagating.                                                      |
| L7   | 2 pgTAP tests failing only 8pm–midnight EDT.                                                                 |
| L8   | "future single_item" comment in `app.py`.                                                                    |
| L9   | Pi `scale_pairings` empty in prod but tests pre-seeded.                                                      |
| L10  | g vs ctn unit drift; `scale_pairings` naming collision.                                                      |
| L11  | "single_track must never mint" not pinned → revert of `74a0240`/`2a14d4e`.                                   |
| L12  | Cousin family — preempts the next-tier bug.                                                                  |

End of strategy. Executor agent: read this, run Phase 1 first, then 2, then 3. Populate §6, queue ⚠️ cells as findings using §3 format.
