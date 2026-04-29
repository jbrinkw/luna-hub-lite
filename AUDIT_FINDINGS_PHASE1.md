# Luna Hub Lite — Phase 1 Audit Findings (Static Lenses)

Phase 1 of `AUDIT_STRATEGY_MERGED.md` — read-only static analysis only.
Lenses run: **L1 (symmetry), L8 (negative-space), L10 (schema asymmetry),
L11 (invariants), L12 (authority boundaries)**.

Phase 2 (parity, idempotency, watermark, delete, time, fixtures) and Phase 3
(adversarial) are **deferred** — the strategy lists six "TO BUILD" harness
scripts that are prerequisites; see §"Phase 2/3 Readiness" at the end.

Format follows §3 of the merged strategy. Severities: **CRITICAL** (data loss /
privilege escalation), **HIGH** (silent divergence, recoverable), **MEDIUM**
(DX / observability), **LOW** (cosmetic).

---

## L12 — Authority Boundaries

### [Cloud↔Web] CRITICAL — `hub.revoke_all_api_keys_admin(UUID)` lets any authenticated user revoke any other user's API keys

- **Direction**: Cloud↔Web
- **Severity**: CRITICAL
- **Lens**: L12
- **What**: The `SECURITY DEFINER` wrapper accepts an arbitrary `p_user_id`, forwards to `private.revoke_all_api_keys`, and is granted to `authenticated`. Nothing checks `p_user_id = auth.uid()`. Any authenticated user can revoke another user's API keys (account lockout / DoS). Should require `p_user_id = (select auth.uid())` or drop the parameter and read `auth.uid()` inside the wrapper.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260424010000_api_key_lifecycle.sql:67-96` (`private.revoke_all_api_keys` filters by `WHERE user_id = p_user_id`; `hub.revoke_all_api_keys_admin(UUID)` is `GRANT EXECUTE … TO authenticated, service_role` with no auth-uid check).
- **Suggested fix**: Either (a) drop the `UUID` parameter and use `(SELECT auth.uid())` inside the wrapper, or (b) add `IF p_user_id <> (SELECT auth.uid()) AND NOT (SELECT is_admin FROM hub.profiles WHERE user_id = (SELECT auth.uid())) THEN RAISE EXCEPTION USING ERRCODE = '42501' END IF;` at the top of `private.revoke_all_api_keys`.
- **Waiver candidate?**: No.

### [Cloud↔Web] CRITICAL — `chefbyte.walmart_check_and_increment(UUID, INT)` lets any authenticated user burn another user's Walmart quota

- **Direction**: Cloud↔Web
- **Severity**: CRITICAL
- **Lens**: L12
- **What**: Granted to `authenticated`. Caller passes any UUID; the function increments that user's `chefbyte.walmart_quota.used`. With a 100/day cap, an attacker can exhaust a victim's quota in ~100 RPC calls and lock them out of barcode lookup until the next UTC day.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260429040000_walmart_scrape_quota.sql:43-112` and `/home/jeremy/luna-hub-lite/supabase/migrations/20260429070000_walmart_quota_chefbyte_wrapper.sql:13-26` (`chefbyte.walmart_check_and_increment(UUID, INT) TO authenticated` with no `auth.uid()` check on `p_user_id`).
- **Suggested fix**: Restrict the chefbyte wrapper grant to `service_role` only (the edge function calls it with the service-role key and can pass the verified auth uid), or add `IF p_user_id <> (SELECT auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501' END IF;` inside the private function.
- **Waiver candidate?**: No.

### [Cross-cutting] HIGH — `private.generate_meal_product_name(UUID, TEXT, DATE)` granted to `authenticated` reads other users' product names

- **Direction**: Cross-cutting
- **Severity**: HIGH
- **Lens**: L12
- **What**: `SECURITY DEFINER` function probes `chefbyte.products` filtered by `WHERE user_id = p_user_id`, but is granted directly to `authenticated`. Any authenticated user can pass another user's UUID and infer how many `[MEAL]` products that user has named on a given date by observing which collision suffix the function returns. Information disclosure (lower severity than the two CRITICAL above because it does not mutate state).
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260424090000_invariant_batch.sql:219-266` (function definition with `WHERE user_id = p_user_id`; `GRANT EXECUTE … TO authenticated, service_role`).
- **Suggested fix**: Revoke from `authenticated`; only `private.mark_meal_done` (already SECURITY DEFINER, called from the chefbyte wrapper that passes verified `auth.uid()`) needs to call this. Pure helper — no user-facing surface lost.
- **Waiver candidate?**: No.

### [Internal-Cloud] MEDIUM — `private.apply_event_override` is SECURITY DEFINER but trusts caller-provided `p_client_event_id` without ownership check on the target row

- **Direction**: Internal-Cloud
- **Severity**: MEDIUM
- **Lens**: L12
- **What**: The `chefbyte.apply_event_override` wrapper reads `v_user_id := (select auth.uid())` and forwards. But the underlying private function looks up the `shelf_event_log` row by `client_event_id` and only later checks `user_id = v_user_id`. If the `client_event_id` namespace is global (not per-user) — and it is `UNIQUE (user_id, client_event_id)` per migration `20260421040000_event_overrides.sql:35` — collisions produce a "row not found" rather than an explicit forbidden error. Acceptable but should raise `42501` on cross-user lookup attempts for forensics.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260422040000_classifier_review.sql:78-170`.
- **Suggested fix**: Convert the silent miss into an explicit `RAISE EXCEPTION 'forbidden'` when a row exists with matching `client_event_id` but `user_id <> v_user_id`. Documents the intent and surfaces probing in logs.
- **Waiver candidate?**: yes — accepted-loss observability gap; promote to HIGH only if cross-user telemetry shows probing.

---

## L11 — Invariants in Code, Not Heads

### [Cross-cutting] HIGH — "watermark must NOT advance on skipped/failed apply" rule is unpinned

- **Direction**: Cross-cutting
- **Severity**: HIGH
- **Lens**: L11
- **What**: The user's mental model and `event_overrides_poller.py:281-299` document the rule that watermarks may only advance over successfully-applied rows. No pgTAP / pytest test pins this for the cloud `/lot-snapshot` and `/overrides` watermark endpoints. The strategy doc proposes `watermark_no_advance_on_skip.test.sql`; it does not exist in `supabase/tests/invariants/`.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/cloud/event_overrides_poller.py:275-296` (correct implementation); `/home/jeremy/luna-hub-lite/supabase/tests/invariants/` (8 files, none for watermarks).
- **Suggested fix**: Add `supabase/tests/invariants/watermark_no_advance_on_skip.test.sql` and a pytest sibling for each poller that simulates an apply skip and asserts the persisted watermark.
- **Waiver candidate?**: No.

### [Cross-cutting] HIGH — "food_logs.logical_date must NOT recompute from now() on UPDATE" rule is unpinned

- **Direction**: Cross-cutting
- **Severity**: HIGH
- **Lens**: L11
- **What**: `docs/superpowers/plans/2026-04-21-pi-to-cloud-audit.md:150` codifies the rule "Edits must NOT recompute `logical_date` from `now()` on update". Grep of `supabase/tests/` shows tests covering INSERT-time `logical_date` (e.g. `consume_product.test.sql:399-404`) but no test asserts that an UPDATE on an existing row preserves the original `logical_date`. A regression that recomputes silently re-buckets historical macros into today's totals — exactly the class of bug the doc warns about.
- **Evidence**: `/home/jeremy/luna-hub-lite/docs/superpowers/plans/2026-04-21-pi-to-cloud-audit.md:150`; no matching pgTAP in `supabase/tests/chefbyte/` or `supabase/tests/invariants/`.
- **Suggested fix**: Add `supabase/tests/invariants/food_logs_logical_date_immutable_on_update.test.sql`: insert a row at logical_date X, set session time to a different logical date Y, UPDATE qty, assert `logical_date = X`.
- **Waiver candidate?**: No.

### [Pi→Cloud] HIGH — "stale heartbeat must NOT regress paired status" rule is unpinned

- **Direction**: Pi→Cloud
- **Severity**: HIGH
- **Lens**: L11
- **What**: `docs/superpowers/plans/2026-04-22-legacy-test-fidelity-audit.md:463` codifies the "stale heartbeat must NOT regress" rule for `chefbyte.live_shelf_devices`/`scale_pairings`. Existing test `live_shelf_devices_self_heal.test.sql` covers the self-heal path but not the regression-prevention assertion (older heartbeat ts losing to newer paired state).
- **Evidence**: `/home/jeremy/luna-hub-lite/docs/superpowers/plans/2026-04-22-legacy-test-fidelity-audit.md:463`; `/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_shelf_devices_self_heal.test.sql` (no two-call sequence).
- **Suggested fix**: Add a two-call sequence test: write fresh paired heartbeat at T+10s; then submit a stale T-30s payload; assert paired state still reflects the fresh write.
- **Waiver candidate?**: No.

### [Internal-Cloud] HIGH — "single_track must NEVER mint a lot" pgTAP exists but no test pins the rule for the `live_weight_sync` event_kind branch

- **Direction**: Internal-Cloud
- **Severity**: HIGH
- **Lens**: L11
- **What**: `supabase/tests/invariants/live_scale_never_mints.test.sql` exists for the original event_kinds. The newly-added `live_weight_sync` event (migration `20260429030000_live_weight_sync.sql`) routes through `private.apply_live_weight_sync_admin`, a different code path. No pgTAP asserts `live_weight_sync` with `kind='live_scale'` and a non-existing pairing does not mint a `stock_lots` row.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/tests/invariants/live_scale_never_mints.test.sql`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260429030000_live_weight_sync.sql:116-288`; `/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/live_weight_sync.test.sql` (no never-mint assertion).
- **Suggested fix**: Extend `live_scale_never_mints.test.sql` (or add a sibling `live_weight_sync_never_mints.test.sql`) with `kind='live_scale', event_kind='live_weight_sync'` and assert `stock_lots` row count unchanged when no pairing exists.
- **Waiver candidate?**: No.

### [Internal-Cloud] MEDIUM — "discarded must NOT write food_logs" only pinned for the legacy `apply_shelf_event` overload, not for the new `apply_discard_with_lot_id` path

- **Direction**: Internal-Cloud
- **Severity**: MEDIUM
- **Lens**: L11
- **What**: `discarded_no_food_logs.test.sql` covers the original discard route. Migration `20260428030000_discard_lot_by_id.sql` introduced `private.apply_discard_with_lot_id` for lot-targeted discards. The "no food_logs" invariant must hold there too. Grep does not find a test that exercises the new function with that assertion.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/tests/invariants/discarded_no_food_logs.test.sql`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260428030000_discard_lot_by_id.sql:54-209`.
- **Suggested fix**: Extend `discarded_no_food_logs.test.sql` with a parallel block that calls `private.apply_discard_with_lot_id` and asserts `food_logs` count unchanged.
- **Waiver candidate?**: No.

---

## L10 — Schema Asymmetry

### [Cross-cutting] HIGH — `live_scale` (cloud) ↔ `single_item` (Pi) literal collision relies on lossy translation table at every boundary

- **Direction**: Cross-cutting
- **Severity**: HIGH
- **Lens**: L10
- **What**: Cloud `chefbyte.scale_pairings.kind` ∈ `{live_shelf, catch_all, live_scale}`; Pi SQLite `lots.shelf_id` / `sessions.shelf_id` / `scale_pairings.kind` CHECK ∈ `{live_shelf, catch_all, single_item}`. Translation lives in three places (`pairings_sync_poller.py:104-107`, `weight_sync_poller.py:308-318`, Pi `app.py` heartbeat assembly) — any new place that reads `shelf_id` must remember to translate or drift silently.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/cloud/pairings_sync_poller.py:99-107`; `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/storage/schema.sql:70,94,123,207`; `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/storage/migrations.py:332,511,536,665,692,743`.
- **Suggested fix**: Centralize the translation behind a single helper (`hardware/live-shelf/server/cloud/_kind_translate.py`) and replace inline calls. Add `supabase/tests/invariants/kind_translation_table.test.sql` that pins the mapping. Long-term: schedule a migration to align Pi to the cloud literal.
- **Waiver candidate?**: yes — accepted as a known asymmetry until the Pi schema migration; promote translation to one helper now to bound the blast radius.

### [Pi↔Cloud] HIGH — Same logical "weight on the lot" stored as `REAL` (g) on Pi vs `NUMERIC(10,3)` (containers) in cloud, with `last_observed_weight_g` mirrored separately

- **Direction**: Pi↔Cloud
- **Severity**: HIGH
- **Lens**: L10
- **What**: Pi `lots.current_weight_g REAL` (grams, float) vs cloud `chefbyte.stock_lots.qty_containers NUMERIC(10,3)` (containers, fixed). The cloud separately tracks `last_observed_weight_g` (added by migration `20260429030000_live_weight_sync.sql`) — but the unit-and-precision drift between the two stores is the root cause of the 1.6 ctn vs 160.4 g bug. There is no schema-level constraint or test that asserts `last_observed_weight_g` equals `qty_containers * net_weight_g` within tolerance.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/storage/schema.sql:11-15,55-56`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260419010000_live_shelf.sql:20-22`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260426010000_stock_lots_snapshot_columns.sql`.
- **Suggested fix**: Add Phase-2 `weight_unit_consistency.test.sql` (proposed in merged §2.5) — pgTAP that walks every `stock_lots` row with both `last_observed_weight_g` and `qty_containers > 0` and asserts `abs(qty_containers * p.net_weight_g - last_observed_weight_g) < tolerance`. Until the harness exists, this stays a static finding.
- **Waiver candidate?**: No.

### [Internal-Cloud] MEDIUM — `private.apply_shelf_event` redefined 16 times across migrations; signature drift risk

- **Direction**: Internal-Cloud
- **Severity**: MEDIUM
- **Lens**: L10
- **What**: 16 `CREATE OR REPLACE FUNCTION private.apply_shelf_event(` redefinitions across the migrations folder, with the latest in `20260427130000_catch_all_delta_apply.sql:53` (10-arg signature). Migration `20260429020000_drop_orphan_apply_shelf_event_overload.sql` shows orphan overloads have been a problem before. `apply_shelf_event_signature_unique.test.sql` exists to pin uniqueness, but the in-tree `idempotency on duplicate event_id` invariant is not separately pinned for the latest signature.
- **Evidence**: `grep CREATE OR REPLACE FUNCTION private.apply_shelf_event supabase/migrations/*.sql | wc -l = 16`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260429020000_drop_orphan_apply_shelf_event_overload.sql`; `/home/jeremy/luna-hub-lite/supabase/tests/chefbyte/apply_shelf_event_signature_unique.test.sql`.
- **Suggested fix**: Add `supabase/tests/invariants/apply_shelf_event_idempotent.test.sql` (proposed in merged §2.5). Pin the latest signature's `(user_id, client_event_id) UNIQUE` round-trip explicitly — call once, expect 200; call again, expect cached response not error.
- **Waiver candidate?**: No.

### [Pi↔Cloud] MEDIUM — Pi `cloud_outbox.event_id` is a TEXT (Pi local UUID), `chefbyte.shelf_event_log.client_event_id` is a TEXT (same string) — but uniqueness scopes differ

- **Direction**: Pi↔Cloud
- **Severity**: MEDIUM
- **Lens**: L10
- **What**: Cloud unique key is `UNIQUE(user_id, client_event_id)` (per-user). Pi outbox dedup is on `(client_event_id)` alone (per-device, single-tenant Pi). If a future multi-tenant Pi configuration ever ships, the unique key on Pi becomes too narrow.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260421040000_event_overrides.sql:35` (`UNIQUE (user_id, client_event_id)`); Pi outbox uniqueness in `hardware/live-shelf/server/storage/schema.sql` (per the IN_FLIGHT_TRACKER_PLAN.md design intent).
- **Suggested fix**: Document the per-device-tenancy assumption in a comment on the Pi `cloud_outbox` schema. Defer schema change until multi-tenant Pi is on the roadmap.
- **Waiver candidate?**: yes — single-user Pi MVP; revisit if multi-tenant Pi ships.

---

## L8 — Negative-Space Markers

### [Pi→Cloud] HIGH — `intake/routes.py:434` TODO(v2) — no DLQ for cloud /intake 5xx

- **Direction**: Pi→Cloud
- **Severity**: HIGH
- **Lens**: L8
- **What**: On 5xx from cloud `/intake` the Pi rejects the user's barcode save with no local persistence. The TODO promises an `intake_pending` queue for background retry; until then, transient cloud outages block the entire intake flow. This is the exact resilience pattern L4 will exercise dynamically — flagging here as static evidence.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/intake/routes.py:425-446`.
- **Suggested fix**: Implement the planned `intake_pending` SQLite queue + a `BackfillIntakeWorker` that drains it. Mirror the `cloud_outbox` shape so the existing observability surface covers it.
- **Waiver candidate?**: No (graduate to Phase 3 adversarial test once implemented).

### [Internal-Pi] MEDIUM — `web/api_routes.py:174` TODO(persist) — config updates lost on restart

- **Direction**: Internal-Pi
- **Severity**: MEDIUM
- **Lens**: L8
- **What**: `update_config` is in-memory only; restarts revert. The current code logs a WARNING but the API returns `ok: true, persisted: false`. Operators using the staff UI will routinely lose changes after a deploy unless they remember to also edit `config.json`.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/web/api_routes.py:168-185`.
- **Suggested fix**: Wire up the disk-backed patcher OR change the API to return 501 if `persist=True` is requested without a backing patcher, so callers can't silently expect persistence.
- **Waiver candidate?**: No.

### [Internal-Cloud] MEDIUM — `reconciler/reconcile.py:703` TODO(H4) — same-session in-flight TTL reaper deferred

- **Direction**: Internal-Cloud
- **Severity**: MEDIUM
- **Lens**: L8
- **What**: TTL reaper for `status='in_flight'` rows that close + reconcile inside one sweeper tick is explicitly deferred. The 5-second `_reap_expired_in_flight` covers most cases, but a small race window exists. Documented; not yet addressed.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/reconciler/reconcile.py:695-713`.
- **Suggested fix**: Either (a) implement Pass 4 of the reconciler (extends `ReconcilerRepo` protocol — non-trivial), or (b) graduate to a planned-work item with a dated ETA so the TODO does not rot.
- **Waiver candidate?**: yes — race window is bounded by the 5s sweeper tick and the existing reaper covers > 99% of cases.

### [Internal-Pi] HIGH — `app.py:1270` & `app.py:2037` "future single_item" comments — Pi auto-register for live_scale ESPs still relies on static-registry fallback

- **Direction**: Internal-Pi
- **Severity**: HIGH
- **Lens**: L8 (also L1)
- **What**: Two production comments call out that the Pi has no auto-register handler for `live_scale` ESPs — instead the registry-derived fallback at `app.py:1132+` keeps the Pi UI populated. The "future single_item" path was anchored as the smoking gun for why live_scale auto-register was missing in the first place. The comment is a hint that the path is partially built but not actually wired to event ingestion.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/app.py:1262-1275`, `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/app.py:2030-2045`.
- **Suggested fix**: Either (a) implement an `emit_single_item_pairing_announce` handler so a live_scale ESP that comes online after Pi boot is auto-registered (mirror what the registry fallback does on boot), or (b) collapse the comment to a one-liner that just says "live_scale ESPs are registered only via the registry/heartbeat fallback."
- **Waiver candidate?**: No (explicitly anchored as the systemic-bug pattern in §Appendix A of the merged strategy).

### [Cross-cutting] LOW — `supabase/migrations/20260424090000_invariant_batch.sql:211` "TODO(agent 1 follow-up)"

- **Direction**: Cross-cutting
- **Severity**: LOW
- **Lens**: L8
- **What**: Migration carries a self-referential follow-up note. Discharged in `20260425020000_mark_meal_done_uses_name_helper.sql:19`, but the original TODO text remains in-tree.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260424090000_invariant_batch.sql:211`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260425020000_mark_meal_done_uses_name_helper.sql:19`.
- **Suggested fix**: Add a one-line comment at line 211 of the original migration noting "discharged by 20260425020000".
- **Waiver candidate?**: yes — cosmetic.

---

## L1 — Symmetry Matrix

### [Internal-Pi] HIGH — `CloudEventEmitter` has dedicated `emit_single_item_event` (live_scale) and `emit_catch_all_first/second_measurement` (catch_all) but no symmetric `emit_live_shelf_event` — live_shelf goes through generic `emit_event`

- **Direction**: Internal-Pi
- **Severity**: HIGH
- **Lens**: L1
- **What**: Cloud-event emission per-kind is asymmetric. live_scale and catch_all have explicit, type-specific emit methods with kind-specific validation and payload assembly; live_shelf piggybacks on `emit_event(kind="live_shelf")`. Any new validation rule (e.g. "live_shelf must include `pickup_weight_g` on `in_flight_pickup`") will be added to the catch_all/live_scale methods but easily missed for live_shelf.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/cloud/integration.py:500-545` (`emit_single_item_event`), `:702-784` (`emit_catch_all_first/second_measurement`); `:439-498` (generic `emit_event` covering live_shelf).
- **Suggested fix**: Either (a) add a thin `emit_live_shelf_event` wrapper around `emit_event` that enforces live-shelf-specific invariants (`pickup_weight_g` populated on `in_flight_pickup` per migration `20260428050000_pickup_weight_g_for_live_shelf.sql`), or (b) refactor catch_all/live_scale to also use `emit_event` and centralize validation.
- **Waiver candidate?**: No.

### [Cross-cutting] HIGH — `WeightSyncPoller` emits `live_weight_sync` for live_shelf + live_scale only; catch_all has no analogous Pi-side stream poll despite carrying a `last_observed_weight_g` cloud column

- **Direction**: Pi→Cloud
- **Severity**: HIGH
- **Lens**: L1
- **What**: `cloud/weight_sync_poller.py:244` filters `shelf_id IN ('live_shelf', 'single_item')` — catch_all is excluded "because catch_all already streams via the delta-capture pair." That assumption holds during the active session, but between sessions catch_all carries no continuous weight signal to `last_observed_weight_g`, while live_shelf/live_scale do. The cloud column is therefore populated for two of three kinds — silent asymmetry.
- **Evidence**: `/home/jeremy/luna-hub-lite/hardware/live-shelf/server/cloud/weight_sync_poller.py:5-15,225-244`; `/home/jeremy/luna-hub-lite/supabase/migrations/20260429030000_live_weight_sync.sql` (kind constraint allows live_shelf+live_scale only).
- **Suggested fix**: Document in the migration's `COMMENT ON COLUMN` that `last_observed_weight_g` is intentionally only updated for live_shelf/live_scale, OR extend the poller to emit a synthetic `live_weight_sync` for catch_all idle-state weights (low priority — but make the asymmetry intentional, not accidental).
- **Waiver candidate?**: yes — "catch_all already streams via delta-capture pair" rationalization in the poller docstring is plausible, but raise to HIGH if a regression makes the column ambiguous.

### [Pi→Cloud] MEDIUM — Edge `VALID_KINDS` includes `catch_all`; Pi `lots.shelf_id` CHECK includes `catch_all`; but `chefbyte.shelf_event_kind` enum (cloud) does not have a `catch_all_*` event for `consumed`/`added`/`refilled`/`depleted` — those kinds fall through to the generic events

- **Direction**: Pi→Cloud
- **Severity**: MEDIUM
- **Lens**: L1
- **What**: Catch_all has dedicated `catch_all_first_measurement` / `catch_all_second_measurement` event_kinds. live_shelf and live_scale share the generic `consumed/added/refilled/depleted` event_kinds. This is intentional (catch_all uses delta-capture; the others are direct), but the asymmetry should be pinned by the existing `event_kind_emit_handle_matrix.test.sql` invariant test — confirm row-by-row that the matrix is exhaustive for all three kinds × all event_kinds.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/functions/shelf-ingest/index.ts:37-67`; `/home/jeremy/luna-hub-lite/supabase/tests/invariants/event_kind_emit_handle_matrix.test.sql`.
- **Suggested fix**: Audit `event_kind_emit_handle_matrix.test.sql` for completeness vs the current `VALID_EVENT_KINDS` list — the file likely predates the `live_weight_sync` event added 2026-04-29.
- **Waiver candidate?**: No.

### [Cross-cutting] MEDIUM — `chefbyte.scale_pairings` cloud has 3 kinds; Pi `scale_pairings` table CHECK has 3 with one renamed; but `chefbyte.live_shelf_devices` (cloud) has no `kind` column at all — all device-level discriminators happen at the pairing layer

- **Direction**: Cross-cutting
- **Severity**: MEDIUM
- **Lens**: L1
- **What**: Asymmetry between device-level vs pairing-level discrimination: cloud uses `live_shelf_devices` as a single device row + `scale_pairings.kind` to discriminate; Pi mirrors `scale_pairings.kind` but has no equivalent of the cloud `live_shelf_devices` row (a Pi is implicitly itself). On a future multi-Pi tenant, the Pi would need a peer to `live_shelf_devices`.
- **Evidence**: `/home/jeremy/luna-hub-lite/supabase/migrations/20260419010000_live_shelf.sql` (cloud `live_shelf_devices`); Pi has no analogous table.
- **Suggested fix**: Document the asymmetry in `hardware/live-shelf/docs/PROD_MIGRATION_PLAN.md`. No code change needed for v1.
- **Waiver candidate?**: yes — single-Pi MVP.

---

## Summary

**Total findings: 19** (2 CRITICAL, 9 HIGH, 7 MEDIUM, 1 LOW.)

By lens:

- L12 Authority: 4 (2 CRITICAL, 1 HIGH, 1 MEDIUM)
- L11 Invariants: 5 (4 HIGH, 1 MEDIUM)
- L10 Schema: 4 (2 HIGH, 2 MEDIUM)
- L8 Negative-space: 4 (1 HIGH, 2 MEDIUM, 1 LOW; one bridged with L1)
- L1 Symmetry: 4 (2 HIGH, 2 MEDIUM)

### Top 5 Highest-Severity Findings

1. CRITICAL — `hub.revoke_all_api_keys_admin(UUID)` lets any authenticated user revoke any other user's API keys (L12).
2. CRITICAL — `chefbyte.walmart_check_and_increment(UUID, INT)` lets any authenticated user burn another user's Walmart quota (L12).
3. HIGH — `private.generate_meal_product_name(UUID, TEXT, DATE)` granted to authenticated reads other users' product names (L12).
4. HIGH — "watermark must NOT advance on skipped/failed apply" rule unpinned by any pgTAP/pytest (L11).
5. HIGH — `live_scale` (cloud) ↔ `single_item` (Pi) literal collision relies on three-place inline translation table (L10).

### Phase 2 / Phase 3 Readiness

Phase 2 and Phase 3 are blocked on the six "TO BUILD" harness scripts listed
in `AUDIT_STRATEGY_MERGED.md` §5:

1. `scripts/audit_symmetry_matrix.py` (L1 grid generator)
2. `scripts/audit_invariants_pinned.py` (L11 doc-vs-test joiner)
3. `scripts/audit_negative_space.py` (L8 with allow-list)
4. `scripts/harness/clock_freeze.py` (L7 dynamic)
5. `scripts/harness/poison_outbox.py` (L4 dynamic)
6. `scripts/harness/parity_assert.py` (L2 dynamic)

Plus extensions to `scripts/audit_schema_drift.py` (L10 unit annotations) and
`scripts/audit_test_quality.py` (L9 empty-fixture detection), and lens tags on
`scripts/harness/scenarios/`.

Phase 1 findings stand on their own and are immediately actionable; they do
not require any of the above to fix. The two CRITICAL L12 findings should be
treated as blocking issues (production multi-user risk).
