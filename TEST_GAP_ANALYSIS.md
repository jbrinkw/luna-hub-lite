# TEST_GAP_ANALYSIS

## Scope reviewed

- `hardware/live-shelf/server/cloud/tests/test_weight_sync_poller.py`
- Sibling cloud tests (`test_integration_hooks.py`, `test_review_sync.py`, `test_scenarios.py`, `test_worker.py`)
- Pi-side emitter call-site tests in `server/tests/` and `server/handlers/tests/`
- All emitter helpers in `server/cloud/integration.py`

## Root cause class

**Bug class:** tests assert that an emit happened, but not that the persisted payload carries the correct non-null values.

In the live-weight incident, the poller passed a weight, but the emitted outbox payload field was missing/NULL. Most tests mocked the emitter and asserted `emit_live_weight_sync(...)` call behavior, so they never verified the serialized outbox payload.

## Weight-sync suite audit

`test_weight_sync_poller.py` currently has 20 tests.

### A) SQL/filter/throttle tests (do not inspect outbox payload)

These would not fail if the outbox payload silently wrote `observed_weight_g=NULL` inside the emitter:

- `test_subthreshold_drift_does_not_re_emit_within_ttl`
- `test_ttl_re_emits_stable_lot`
- `test_catch_all_lots_are_skipped`
- `test_out_status_lots_are_skipped`
- `test_in_flight_lots_are_emitted`
- `test_null_current_weight_lots_are_skipped`
- `test_disabled_emitter_short_circuits`
- `test_emit_failure_does_not_update_memory`
- `test_negative_weight_is_skipped`
- `test_live_scale_pairing_no_runtime_provider_skips`
- `test_live_scale_pairing_no_heartbeat_for_device_skips`
- `test_live_scale_pairing_without_lot_id_skipped`
- `test_live_scale_pairing_significant_change_re_emits`
- `test_live_scale_provider_exception_does_not_kill_tick`

### B) Mock-call argument tests (assert emit args, not persisted payload)

These would catch poller->emitter arg corruption, but **not** emitter->outbox payload corruption:

- `test_first_observation_emits_for_live_shelf_lot`
- `test_first_observation_emits_for_live_scale_lot_using_pairing_device_id`
- `test_significant_change_triggers_re_emit`
- `test_live_scale_pairing_emits_using_runtime_weight`
- `test_live_scale_pairing_dedup_when_lots_row_present`

### C) End-to-end payload checks

- `test_live_weight_sync_outbox_payload_carries_observed_weight_from_lot` **does** fail on NULL `observed_weight_g`.
- There is still no Pi->outbox->cloud DB fidelity assertion for `live_weight_sync` in this file.

## Emitter-by-emitter vulnerability map (`integration.py`)

Total emit helpers: **10**.

Strong payload/outbox assertions exist:

- `emit_reconciler_resolution`
- `emit_single_item_event`
- `emit_in_flight_reap`
- `emit_manual_discard`
- `emit_review_queue_create`
- `emit_review_queue_resolve`

Weak/missing payload-contract coverage (bug-prone):

- `emit_in_flight_return_marker` (mostly matrix/call-path assertions)
- `emit_catch_all_first_measurement` (call assertions via mocks/wraps)
- `emit_catch_all_second_measurement` (call assertions via mocks/wraps)
- `emit_live_weight_sync` (historically weak; now one direct outbox regression test on this branch)

## Systemic Pi pytest pattern issues

1. **Fixture shape drift via MagicMock emitters**

- Common pattern: `cloud_emitter = MagicMock(); emit_* = MagicMock(return_value='...')`
- This validates orchestration and branches, but bypasses payload serialization/contract enforcement.

2. **Call-count centric assertions**

- Broad use of `assert_called_once`, `call_count`, `assert_not_called` emphasizes control flow, not data fidelity.

3. **Insufficient contract boundary checks at `_enqueue`**

- Without pre-enqueue payload schema validation, invalid/NULL payload fields can traverse unit tests undetected if tests stop at mocked call boundaries.

## Count summary (this audit)

- Weight-sync tests: 20 total
- Tests that would miss emitter-side NULL payload drift: 19/20
- Emitters lacking strong direct payload-contract tests: 4/10 historically (3/10 after current in-branch live-weight regression add)
