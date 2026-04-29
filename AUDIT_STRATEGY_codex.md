# Luna Hub Lite Audit Strategy (Codex)

Planning-only strategy for a comprehensive correctness audit of `/home/jeremy/luna-hub-lite/`. This document defines _how_ to audit; it does not run audits, write tests, or change production code.

## Section 1 — Audit dimensions

| Audit lens                          | Tonight pattern this lens addresses                                                            | How the pass executes                                                                                                                                                                                                                                                                                                                                                           | Primary anchors                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Symmetry matrix                     | Feature present in `catch_all` and `live_shelf` but missing in `live_scale`/single-track paths | Build explicit matrix: `(kind x event_kind x side_effect)` and `(kind x poller x UI surface)`. Statically enumerate accepted kinds from `supabase/functions/shelf-ingest/index.ts` (`VALID_KINDS`, `VALID_EVENT_KINDS`), Pi translations (`single_item`), and cloud handlers. Then validate each matrix cell has a concrete emit + handle + UI behavior (or documented waiver). | `supabase/functions/shelf-ingest/index.ts`, `hardware/live-shelf/server/handlers/scale_events.py`, `hardware/live-shelf/server/cloud/integration.py`, `hardware/live-shelf/server/app.py`, `apps/web/src/components/chefbyte/ScalesTab.tsx`, `supabase/tests/invariants/event_kind_emit_handle_matrix.test.sql`        |
| Cross-system parity                 | Pi SQLite and cloud Postgres drifting silently                                                 | Define parity probe queries that read both stores for the same business entity and compare normalized values. Required comparisons: Pi `lots/current_weight_g`, Pi `cloud_lots/qty_containers`, cloud `chefbyte.stock_lots/qty_containers`, and `chefbyte.shelf_event_log` vs Pi `cloud_outbox`. Flag any drift beyond tolerances (weight epsilon, timestamp skew window).      | Pi: `hardware/live-shelf/server/storage/schema.sql`, `hardware/live-shelf/server/storage/migrations.py` (`cloud_lots`), cloud: `chefbyte.stock_lots`, `chefbyte.shelf_event_log`, sync code: `hardware/live-shelf/server/cloud/lot_snapshot_poller.py`, `event_overrides_poller.py`                                    |
| Idempotency                         | Duplicate event replay, FIFO queue poisoning, permanent retry loops                            | Trace every ingest/drain path for idempotency keys and retry semantics. Confirm replay behavior at edge RPC boundary (`client_event_id`) and local queue boundary (`cloud_outbox.client_event_id`). Confirm poison-pill bypass and dead-letter behavior, including downstream rows unblocking.                                                                                  | `hardware/live-shelf/server/cloud/outbox.py`, `hardware/live-shelf/server/cloud/worker.py`, `supabase/functions/shelf-ingest/index.ts` (`apply_shelf_event_admin` calls), `supabase/tests/chefbyte/apply_shelf_event_signature_unique.test.sql`, `supabase/tests/chefbyte/in_flight_pickup_reemit_idempotent.test.sql` |
| Resilience                          | No graceful degradation, hidden backlog/failure modes                                          | Review whether failures degrade to safe, observable states: auth failure, heartbeat failure, cloud 5xx, malformed rows, DB lock contention. Require explicit behavior for “continue/skip/backoff/dead-letter” and operator-visible signal for each.                                                                                                                             | `hardware/live-shelf/server/cloud/worker.py`, `hardware/live-shelf/server/app.py` (poller startup best-effort), `hardware/live-shelf/server/cloud/client.py` (drift warning), `/healthz` wiring in `app.py`                                                                                                            |
| Watermark correctness               | Watermark advances on skipped/failed applies causing potential loss                            | For each poller with watermark, verify advancement conditions vs apply outcomes. Specifically test “row fetched but not applied” and “row malformed” paths. A watermark policy must be intentional per stream and documented as lossless or accepted-loss with rationale.                                                                                                       | `hardware/live-shelf/server/cloud/event_overrides_poller.py` (`max_updated_at` across all overrides), `hardware/live-shelf/server/cloud/lot_snapshot_poller.py` (`max_updated_at` incl tombstones), edge endpoints `/overrides` and `/lot-snapshot` in `supabase/functions/shelf-ingest/index.ts`                      |
| Delete propagation                  | Tombstones reaching mirror table but not all consumer state                                    | Trace delete/tombstone flow end-to-end and verify all intended downstream states update (not only mirror caches). Confirm whether cloud delete should affect Pi `cloud_lots` only, or also Pi `lots.status`/UI-derived state.                                                                                                                                                   | `supabase/functions/shelf-ingest/index.ts` (`/lot-snapshot` returns `deleted_at`), `hardware/live-shelf/server/cloud/lot_snapshot_poller.py` (`DELETE FROM cloud_lots`), Pi schema `lots` in `hardware/live-shelf/server/storage/schema.sql`                                                                           |
| Time boundaries                     | UTC/local-midnight flakes, occurred_at window mismatches                                       | Audit every date boundary derivation path (Pi local date utilities, cloud logical_date, event timestamp validation). Verify behavior for UTC midnight, local midnight, and configured `day_start_hour`.                                                                                                                                                                         | Cloud tests: `supabase/tests/chefbyte/logical_date_cloud_clock.test.sql`, `supabase/tests/coachbyte/day_start_hour_logical_date.test.sql`; web: `apps/web/src/shared/dates.ts`, `apps/web/src/__tests__/unit/pure/shared-dates.test.ts`; edge window validation in `supabase/functions/shelf-ingest/index.ts`          |
| Negative-space scan (TODO/future-X) | Missing implementations hidden behind comments and implied future work                         | Run structured static grep for `TODO`, `future`, `FIXME`, and domain-specific markers (`single_item`, `live_scale`) and classify each as implemented, intentionally deferred, or orphaned debt. Require matrix placement for each deferred item.                                                                                                                                | Example anchor: `hardware/live-shelf/server/app.py` comments referencing “future single_item”; repo-wide scan across `hardware/live-shelf/server/`, `supabase/functions/`, `apps/web/src/`                                                                                                                             |
| Reality-shape fixtures              | Tests passing with impossible pre-seeded state                                                 | Inventory fixture builders and seed helpers; compare fixture assumptions to production bootstrap path. Any fixture that seeds rows not producible by runtime must be marked synthetic and paired with a real-shape variant.                                                                                                                                                     | Pi tests in `hardware/live-shelf/server/.../tests/`, especially `test_web_repo_single_track.py`, `web/tests/test_routes.py`; web integration seeds in `apps/web/src/__tests__/integration/...`                                                                                                                         |
| Schema asymmetry                    | `single_item` (Pi) vs `live_scale` (cloud), signature drift, check-constraint drift            | Build schema-diff checklist between Pi SQLite literals/checks and cloud Postgres literals/checks/signatures. Audit translation boundaries and confirm every boundary has explicit mapping + test.                                                                                                                                                                               | Pi schema `hardware/live-shelf/server/storage/schema.sql`; translation in `handlers/scale_events.py` and `cloud/pairings_sync_poller.py`; cloud checks in `supabase/migrations/20260424040000_scale_pairings_check.sql`; signature guard `supabase/tests/chefbyte/apply_shelf_event_signature_unique.test.sql`         |

## Section 2 — Per-component audit checklist

### Pi cloud sync layer (`hardware/live-shelf/server/cloud/`, startup wiring in `hardware/live-shelf/server/app.py`)

- Verify outbox drain ordering and unblock semantics: `outbox.list_pending()` ordering by `outbox_id`, `worker.py` dead-letter threshold path, and behavior after one row fails 10+ times.
- Verify startup replay behavior: `backfill_missing_outbox_events()` in `cloud/integration.py` runs before `CloudWorker.start()` and respects `known_pi_event_ids()` probe (`cloud/client.py`).
- Verify watermark semantics for `EventOverridesPoller.tick_once()` and `LotSnapshotPoller.tick_once()` when rows are malformed or fail local apply.
- Verify delete semantics: `LotSnapshotPoller._apply_one()` tombstone path (`DELETE FROM cloud_lots`) and whether any intended `lots`-table side effect is missing.
- Verify kind/literal translations are symmetric at boundaries: `live_scale` ↔ `single_item` in `handlers/scale_events.py`, `pairings_sync_poller.py`, and heartbeat payload assembly in `app.py`.
- Verify resilience/observability: auth failures, heartbeat failures, backlog warnings, and `/healthz` thread status for `CloudWorker`, `PairingsSyncPoller`, `LotSnapshotPoller`, `EventOverridesPoller`, `WeightSyncPoller`.

### Edge functions (`supabase/functions/`, focus `shelf-ingest/index.ts`)

- Verify route matrix completeness: `/event`, `/heartbeat`, `/catalog`, `/overrides`, `/lot-snapshot`, `/events-by-pi-id`, `/settings` all align with Pi callers.
- Verify `VALID_KINDS` and `VALID_EVENT_KINDS` consistency with Pi emit paths in `cloud/integration.py` and invariant tests.
- Verify `handleEvent()` branching correctness: `live_weight_sync` dispatch to `apply_live_weight_sync_admin`, lot-targeted discard to `apply_discard_with_lot_id_admin`, default to `apply_shelf_event_admin`.
- Verify timestamp window handling (`occurred_at` bounds) and retry implications (`422` contract for drift).
- Verify heartbeat scale validation and partial-write prevention in `handleHeartbeat()`.

### MCP worker (`apps/mcp-worker/src/`)

- Verify `/mcp` and `/sse` parity (same auth and JSON-RPC behavior) in `index.ts`.
- Verify stateless method coverage and unknown-method handling in `stateless.ts`.
- Verify tool execution gating and extension credential checks in `tool-executor.ts` (enabled flag, decrypt RPC, parse failures).
- Verify logging path never breaks tool execution (`tool-logger.ts`, fire-and-forget insert behavior).
- Verify auth asymmetry between chat endpoint and MCP endpoints (`authenticateApiKey` vs `authenticateJwt` order).

### Web app (`apps/web/`)

- Verify scale visibility behavior in `ScalesTab.tsx`: default collapsed single-track section, `Show Scales (N)` counter correctness, empty-state when no pairings.
- Verify live-scale truth-source rules in `InventoryPage.tsx`: suppress stale `live_scale` tags unless current `scale_pairings` says paired.
- Verify realtime subscriptions include `scale_pairings` and produce UI invalidation without reload (`useRealtimeInvalidation`, e2e realtime specs).
- Verify local-date utilities vs cloud logical-date assumptions (`shared/dates.ts`) at midnight/day-start boundaries.

### pgTAP invariants (`supabase/tests/`)

- Verify design-intent invariants exist for “must never” rules, not only happy-path behavior.
- Confirm invariant coverage for event-kind matrix (`tests/invariants/event_kind_emit_handle_matrix.test.sql`) and single-track no-mint rule (`tests/invariants/live_scale_never_mints.test.sql`).
- Confirm signature/overload guard remains in place (`tests/chefbyte/apply_shelf_event_signature_unique.test.sql`).
- Identify missing invariants for watermark safety and delete propagation to Pi state (currently outside SQL-only test surface).

## Section 3 — Standardized finding output format

Use one finding per row, no prose blobs.

| Field         | Required content                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Direction     | `Pi->cloud`, `cloud->Pi`, `within-component`, or `cross-component`                                                                  |
| Severity      | `S0` data loss, `S1` wrong state/user-visible corruption, `S2` recoverable correctness gap, `S3` observability/maintainability risk |
| What          | One-sentence defect statement in invariant form (“X happens when Y; should be Z”)                                                   |
| Evidence      | Absolute path + line (single line), plus table/function name if DB-side                                                             |
| Suggested fix | Minimal change plan: code location, guard/invariant to add, and rollback safety                                                     |

Template:

```md
- Direction: Pi->cloud
- Severity: S1
- What: Duplicate replay of `event_id` can stall downstream outbox rows because row-level failure increments attempts without bypass before threshold.
- Evidence: /home/jeremy/luna-hub-lite/hardware/live-shelf/server/cloud/worker.py:308 (`outbox.list_pending` FIFO drain)
- Suggested fix: Add immediate dead-letter on deterministic duplicate signature OR skip-with-ack branch keyed by cloud reason `duplicate`.
```

## Section 4 — Execution order

| Phase                                    | Goal                                             | Activities                                                                                                                                                                                  | Exit artifact                                                 |
| ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. Static-only                           | Build full risk map before running anything      | Build kind/feature matrix; trace call graphs for sync paths; inspect schema translations and constraints; classify TODO/future comments; generate first coverage matrix (Section 6 format). | `coverage_matrix_v1.md` + prioritized suspected gaps          |
| 2. Dynamic (integration + parity probes) | Validate suspected gaps against runtime behavior | Run controlled local integration flows with dual-read parity probes (Pi SQLite + cloud Postgres) for event apply, replay, override, snapshot, delete, and midnight boundaries.              | `parity_probe_report.md` with reproduced/cleared gaps         |
| 3. Adversarial                           | Break assumptions intentionally                  | Re-emit same event payloads; kill worker mid-tick; hold cloud 5xx/auth failures; simulate Pi reboot with backlog; force malformed poller rows; cross midnight in UTC and local zone.        | `adversarial_failures.md` with severity-ranked confirmed bugs |

## Section 5 — Required tooling (must exist before audit run)

- Dual-store parity probe harness: one command that queries Pi SQLite (`lots`, `cloud_lots`, `cloud_outbox`) and cloud Postgres (`chefbyte.stock_lots`, `chefbyte.shelf_event_log`, `chefbyte.scale_pairings`) for the same user/device and diffs normalized state.
- Deterministic replay harness: script that can POST identical `client_event_id` and `pi_event_id` sequences to `/event` and inspect queue behavior (`cloud_outbox.attempts`, `failed_permanently`).
- Fault injector for worker lifecycle: utilities to stop/restart `CloudWorker` and pollers at controlled points (before/after mark_sent, mid-batch, pre-watermark write).
- Clock/window harness: ability to run tests with explicit timezone and boundary timestamps around local midnight and UTC midnight.
- Fixture realism linter: static checker that flags test seeds that bypass production creation paths (e.g., direct `scale_pairings` inserts without heartbeat/import flow marker).
- Coverage matrix generator: lightweight script/template that emits Section 6 table from discovered entities/lenses and marks each cell `covered/gap/waived`.

## Section 6 — Coverage matrix (first audit output format)

Legend-free by design: every cell is exactly `covered`, `gap`, or `waived`.

| Entity                                                                                                                   | Symmetry matrix | Cross-system parity | Idempotency | Resilience | Watermark correctness | Delete propagation | Time boundaries | Negative-space | Reality-shape fixtures | Schema asymmetry |
| ------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------- | ----------- | ---------- | --------------------- | ------------------ | --------------- | -------------- | ---------------------- | ---------------- |
| Pi outbox + worker (`cloud/worker.py`, `cloud/outbox.py`, `cloud_outbox`)                                                | gap             | gap                 | covered     | covered    | waived                | waived             | covered         | gap            | gap                    | gap              |
| Pi startup/backfill/heartbeat (`app.py`, `cloud/integration.py`)                                                         | gap             | gap                 | covered     | covered    | waived                | gap                | covered         | gap            | gap                    | gap              |
| Event overrides sync (`cloud/event_overrides_poller.py`)                                                                 | gap             | gap                 | covered     | covered    | gap                   | waived             | gap             | gap            | gap                    | gap              |
| Lot snapshot sync (`cloud/lot_snapshot_poller.py`, Pi `cloud_lots`)                                                      | gap             | covered             | covered     | covered    | gap                   | gap                | gap             | gap            | gap                    | gap              |
| Pairings + weight sync (`cloud/pairings_sync_poller.py`, `cloud/weight_sync_poller.py`)                                  | covered         | gap                 | covered     | covered    | gap                   | covered            | gap             | gap            | gap                    | covered          |
| Pi ingest/classification (`handlers/scale_events.py`)                                                                    | gap             | gap                 | covered     | covered    | waived                | gap                | covered         | gap            | gap                    | covered          |
| Edge function (`supabase/functions/shelf-ingest/index.ts`)                                                               | covered         | gap                 | covered     | gap        | covered               | covered            | covered         | gap            | gap                    | covered          |
| Cloud DB handlers (`private.apply_shelf_event`, related migrations)                                                      | covered         | gap                 | covered     | gap        | waived                | covered            | covered         | gap            | gap                    | covered          |
| Web scales/inventory (`apps/web/src/components/chefbyte/ScalesTab.tsx`, `apps/web/src/pages/chefbyte/InventoryPage.tsx`) | gap             | gap                 | waived      | gap        | waived                | gap                | gap             | gap            | gap                    | covered          |
| MCP worker (`apps/mcp-worker/src/`)                                                                                      | waived          | waived              | gap         | covered    | waived                | waived             | waived          | gap            | gap                    | gap              |
| pgTAP invariants (`supabase/tests/invariants`, `supabase/tests/chefbyte`)                                                | covered         | gap                 | covered     | gap        | gap                   | gap                | covered         | covered        | gap                    | covered          |

## Section 7 — What NOT to audit

- Model quality tuning (classifier precision/recall) unless it causes deterministic state corruption. Reason: tonight’s failures were sync/invariant/systemic correctness, not model-selection quality.
- UI styling/layout polish and copy. Reason: non-correctness work dilutes audit throughput; include only behavior that affects state visibility or operator decisions.
- Broad CoachByte/Hub feature logic not on shared paths (`logical_date`, auth/RLS patterns, realtime infra) used by ChefByte sync. Reason: reduce blast radius and keep findings actionable for tonight’s failure class.
- Performance micro-optimizations without correctness impact (query tuning, render perf). Reason: this audit is bug- and invariant-driven, not latency-driven.
