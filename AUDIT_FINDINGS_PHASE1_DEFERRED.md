# Phase 1 Audit — Deferred Findings

This file lists findings from `AUDIT_FINDINGS_PHASE1.md` that this pass
intentionally did NOT close, with a one-paragraph rationale per item.
Everything else (16 findings from the original 19, plus the 3 already-fixed
in commit `85af87c`) was closed in the follow-up audit pass.

## Deferred

### L8/HIGH — `intake/routes.py:434` TODO(v2): no DLQ for cloud /intake 5xx

**Why deferred:** Implementing the planned `intake_pending` SQLite queue
plus a `BackfillIntakeWorker` is a non-trivial new subsystem. It needs:
new SQLite migration (analogous to `cloud_outbox`), retry policy +
backoff design, /healthz exposure, observability counters, and a
parallel test surface (drain idempotency, poison handling, unique-key
collision behaviour). Building all of that to the same fidelity as the
existing `cloud_outbox` is a focused feature, not a single-commit
hardening pass. Logged here so it stays visible until a dedicated brief
picks it up.

### L8/MEDIUM — `reconciler/reconcile.py:703` TODO(H4): same-session in-flight TTL reaper

**Why deferred:** The audit itself flags this finding as "yes — race
window is bounded by the 5s sweeper tick and the existing reaper covers

> 99% of cases" (see waiver candidate annotation in
> `AUDIT_FINDINGS_PHASE1.md`). Pass 4 of the reconciler extends the
> `ReconcilerRepo` protocol — non-trivial. Acceptable to ship without it
> given the bounded blast radius. Tracking here so the deferral has an
> explicit landing place rather than rotting as an in-source `TODO(H4)`.

### L11/HIGH — Pi-side pytest "watermark frozen on skip" for `lot_snapshot_poller` and `product_sync_poller`

**Why deferred (partial):** The audit recommended adding pytest siblings
for each of the three pollers. `event_overrides_poller` already has the
test (`test_skipped_override_freezes_watermark_and_retries`). The other
two pollers (`lot_snapshot_poller`, `product_sync_poller`) intentionally
DO advance the watermark over malformed/skipped rows — they treat the
update as "tombstones still bump updated_at, the row is observed-and-
ignored, advance so we don't re-fetch forever". Their test files
already pin this with `test_malformed_product_skipped_without_poisoning_batch`
(product_sync) — the analogous lot_snapshot test would just confirm
existing behaviour. The cloud-side contract (the `updated_at` triggers)
is now pinned by the new pgTAP `watermark_contract_updated_at.test.sql`,
which is the more-load-bearing half of the invariant. A proper Phase 2
harness will dynamically test the "freeze across a poll restart"
property; that's the right level for the missing pytest, not Phase 1.

## Closed in this pass

See `AUDIT_FINDINGS_PHASE1.md` plus the commit log for the four follow-up
commits referenced in the agent's report.
