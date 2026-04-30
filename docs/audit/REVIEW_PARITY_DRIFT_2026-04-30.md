# Review Queue Parity Drift — Diagnosis 2026-04-30

**Observed:** `chefbyte.review_queue` (cloud) = 432 rows.
Pi `review_queue` table = 82 rows.
Drift ratio: **5.3x**.

---

## Most Likely Root Cause

**The cloud `review_queue` is a cumulative, append-and-upsert historical log; the Pi `review_queue` is a live operational queue that deletes or overwrites resolved rows.**

Confidence: **88%**

### Evidence

1. **Pi `review_queue` has no `deleted_at` / soft-delete column** (`hardware/live-shelf/server/storage/schema.sql` lines 224–240). Once a row is resolved or dismissed, it stays in the table but its `status` changes. However, Pi DB wipes (reflashes), session resets, and any operational `DELETE` from the Pi inventory UI would permanently remove rows from the Pi's SQLite. The cloud's UPSERT path (`private.upsert_review_queue_from_pi`, migration `20260429120000`) **never deletes cloud rows** — it only INSERTs or updates non-resolved rows.

2. **Dual emit paths, no single-winner dedup for review events.** Two independent code paths call `emit_review_queue_create`:
   - `server/adapters/reconciler_repo.py:584` — fires when the reconciler queues a review item.
   - `server/handlers/scale_events.py:760` — fires when the scale event handler queues a review item in the fast path.

   Unlike stock-mutation events, review_queue emissions have **no `CLOUD_PATTERN_PRECEDENCE` / `should_suppress_cloud_emit_for_remove_event` guard**. If both the fast-path handler and the reconciler both create a review item for the same underlying event (e.g., an `unknown_item_add` that fires immediately then gets revisited at session close), two `cloud_outbox` rows with different `client_event_id` values but the same `pi_review_id` are enqueued. The cloud upserts on `(user_id, pi_review_id)` so only one row lands — but each attempt consumes one cloud_outbox slot. The 432 cloud_outbox rows therefore include many **retries and duplicate emits** that resolved to the same 82 (or more) cloud `review_queue` rows.

3. **The outbox is a historical log, not a current-state mirror.** `cloud_outbox` rows are marked `sent_at IS NOT NULL` after delivery but are only pruned after 7 days via `prune_sent_older_than(days=7)` (`outbox.py:411–455`, called from `app.py:732`). The user asked "cloud shows 432 review events" — this is almost certainly a count of **all `cloud_outbox` rows with `event_kind IN ('review_queue_create','review_queue_resolve')`**, not a count of distinct live cloud `review_queue` rows. That reading conflates "total events ever sent" with "current review items."

4. **Pi `review_queue` shows only 82 because it reflects current pending/resolved state,** not historical volume. Resolved and dismissed items remain in the Pi table with `status != 'pending'`, but any Pi DB wipe or manual cleanup would drop them entirely. If the Pi has been reflashed or the SQLite file was replaced at any point, the historical creation count is irrecoverably lower than the cloud's cumulative count.

5. **Worker retry amplification.** The CloudWorker (`worker.py:326–329`) sends `review_queue_create` events via `POST /review-create`. The cloud endpoint returns 409 when `review-resolve` is called before `review-create` has landed (`shelf-ingest/index.ts:1158`). Each 409 is retryable (not in `NON_RETRYABLE_EVENT_STATUS_CODES = {400, 404, 409}` — wait, 409 IS in that set). However, transient 5xx and 422 responses ARE retried (up to 10 attempts before dead-lettering). A batch of review events hitting a cloud 5xx during an outage would each accumulate multiple `cloud_outbox` rows on the Pi (via `mark_failed` / reattempt), and each retry sends another event — but the cloud-side UPSERT dedupes on `pi_review_id`, so the cloud row count stays lower than the outbox row count.

---

## Alternative Causes (Lower Confidence)

| Cause                                                                                                                                                      | Confidence                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pi DB wipe(s) dropped historical rows; cloud retained them                                                                                                 | 70% (likely a contributing factor, not the sole cause)                       |
| Different time windows being compared (cloud = all-time, Pi = current session or recent)                                                                   | 55%                                                                          |
| `review_queue_resolve` events are counted alongside `review_queue_create` at the cloud but not on the Pi side (the Pi's count is `WHERE status='pending'`) | 45%                                                                          |
| Dual-emit from both reconciler_repo + scale_events handler for the same physical event                                                                     | 30% (upsert dedupes at cloud; inflates cloud_outbox but not cloud row count) |

---

## What "82 vs 432" Most Likely Means

- **82:** Pi's SQLite `review_queue` rows currently present (any status), reflecting the post-wipe or current-install population.
- **432:** Total `cloud_outbox` rows ever enqueued with `event_kind = 'review_queue_create'` OR `'review_queue_resolve'` (cumulative, including retries, re-emits, and worker replay attempts — not the count of distinct `chefbyte.review_queue` rows in the cloud DB, which could be much lower, e.g., closer to 82–200).

If the 432 is instead a count of **distinct rows in `chefbyte.review_queue`**, then the Pi was wiped at least once (removing ~350 historical review rows from SQLite while the cloud retained them via the upsert path), and/or the reconciler and fast-path handler both enqueued reviews for a large fraction of events without the cloud dedup reducing them below 432 distinct `pi_review_id` values.

---

## Recommended Fix Actions

1. **Confirm what "432" means.** Before fixing anything, run these two queries:

   ```sql
   -- Cloud distinct review rows:
   SELECT COUNT(*) FROM chefbyte.review_queue WHERE user_id = '<user_id>';

   -- Cloud outbox rows by event_kind:
   SELECT json_extract(payload_json, '$.event_kind') AS ek, COUNT(*)
     FROM cloud_outbox GROUP BY 1;
   ```

   And on the Pi:

   ```sql
   SELECT COUNT(*), status FROM review_queue GROUP BY status;
   ```

   This determines whether 432 is the cloud DB row count or the outbox event count. The two cases have different fixes.

2. **If 432 = cloud DB rows, 82 = Pi rows:** The gap is historical (Pi DB was wiped or rows were deleted). No fix needed for data integrity — the cloud has the authoritative history. Add a `deleted_at` column to the Pi's `review_queue` so future wipes can be detected and the cloud can tombstone accordingly (or accept that the cloud is the system of record for review history).

3. **If 432 = cloud outbox rows (cumulative):** The count is misleading. Add an operator query to the `/admin` UI that distinguishes `cloud_outbox` cumulative counts from live `chefbyte.review_queue` row counts. Consider reducing `prune_sent_older_than` from 7 days to 3 days for review events to keep the outbox audit trail smaller.

4. **Audit dual-emit risk.** Confirm whether both `reconciler_repo.py` and `scale_events.py` can fire `emit_review_queue_create` for the same underlying `pi_review_id` on the same physical event. If yes, add a dedup guard analogous to `should_suppress_cloud_emit_for_remove_event` — or verify the cloud UPSERT idempotency is sufficient (it is, for DB rows, but inflates the outbox for no reason).

---

## Files Reviewed

- `hardware/live-shelf/server/cloud/integration.py` — emitter, dual-emit paths, CLOUD_PATTERN_PRECEDENCE (no review guard)
- `hardware/live-shelf/server/cloud/outbox.py` — enqueue, mark_sent, prune_sent_older_than
- `hardware/live-shelf/server/cloud/worker.py` — drain loop, review_queue routing, retry/dead-letter logic
- `hardware/live-shelf/server/cloud/review_sync_poller.py` — cloud→Pi resolution mirror
- `hardware/live-shelf/server/adapters/reconciler_repo.py:584` — reconciler emit site
- `hardware/live-shelf/server/handlers/scale_events.py:760` — fast-path emit site
- `hardware/live-shelf/server/storage/schema.sql:224` — Pi SQLite review_queue (no deleted_at)
- `supabase/migrations/20260429120000_review_queue_mirror.sql` — cloud table + UPSERT on (user_id, pi_review_id)
- `supabase/migrations/20260429310000_review_queue_image_urls.sql` — image URL columns
- `supabase/migrations/20260429320000_review_queue_upsert_image_urls.sql` — extended upsert
- `supabase/functions/shelf-ingest/index.ts` — /review-create handler (upsert, idempotent), /review-resolve (409 if row missing)
