# Polling Refactor Plan — Pi-side cloud-mirror pollers → Realtime

**Date:** 2026-05-04
**Trigger:** Supabase quota notice (~584K edge function invocations / billing period; limit 550K). Baseline ~58K/day from 7 background pollers running 24/7 in `hardware/live-shelf/server/cloud/*.py`.
**Status:** Plan only. Not started. See [WHAT TO PICK UP](#what-to-pick-up) at the bottom.

---

## Current state

Seven independent pollers in `hardware/live-shelf/server/cloud/`:

| Poller                   | Cadence               | Class                   | Calls/day    |
| ------------------------ | --------------------- | ----------------------- | ------------ |
| `product_sync_poller`    | 30s                   | A (catalog mirror)      | 2,880        |
| `event_overrides_poller` | 30s                   | A (catalog mirror)      | 2,880        |
| `review_sync_poller`     | 30s                   | A (catalog mirror)      | 2,880        |
| `lot_snapshot_poller`    | 60s                   | A (catalog mirror)      | 1,440        |
| `pairings_sync_poller`   | 60s                   | A (catalog mirror)      | 1,440        |
| `weight_sync_poller`     | ~30s                  | B (active session)      | ~2,880       |
| `livetrack_poller`       | 0.5s active / 2s idle | B active + C idle waste | up to 43,200 |

**Class A** — pure mirror sync. Pi calls Supabase asking "any deltas since last watermark?" The answer is "no" 99% of the time.
**Class B** — fires during real user sessions where every sample is a meaningful change.
**Class C** — Class B pollers that don't idle-gate properly (livetrack at 2s baseline even when no pairing is in progress).

## Target architecture

**Hybrid: Realtime primary + sparse safety-net + on-demand fetch.**

1. **Realtime WebSocket** as primary signal for Class A. One persistent connection from the Pi. Subscribes to `chefbyte.products`, `chefbyte.event_overrides`, `chefbyte.review_queue`, `chefbyte.scale_pairings`, `chefbyte.cloud_lots` (or `stock_lots`). Postgres CDC pushes row events as they happen. Zero edge function invocations.
2. **Sparse safety-net poll** (10 min cadence per table) to reconcile silently-dropped Realtime messages. Idempotent watermark-based apply.
3. **On-demand fetch** at scale-event time for `cloud_lots` if the picked lot's record is staler than ~5s. Catches "lot just landed cloud-side but Pi hasn't synced yet" race for catch-all classification. Adds maybe 1 invocation per catch-all event.

### Cost model

|                         | Today           | After Realtime                                               |
| ----------------------- | --------------- | ------------------------------------------------------------ |
| Edge fn invocations/day | ~58K            | ~750 (24 JWT refresh + 144 safety-net + ~5-50 actual events) |
| Worst-case staleness    | 30-60s          | <1s on Realtime, ~10min on safety-net                        |
| Connection count        | many short HTTP | 1 long-lived WebSocket                                       |
| Invocation reduction    | —               | ~99%                                                         |

## Phasing

### Phase 0 — bump idle cadences (5 min, no architecture change)

Edit constants in three files:

- `hardware/live-shelf/server/cloud/livetrack_poller.py:46` — `IDLE_POLL_S = 2.0` → `30.0`. Saves ~41K/day. **This alone gets you under the 550K limit immediately.**
- (Optional) `hardware/live-shelf/server/cloud/product_sync_poller.py:43` — `POLL_INTERVAL_S = 30.0` → `60.0`. Saves ~1.4K/day.
- (Optional) `event_overrides_poller`, `review_sync_poller` — same bump. Each saves ~1.4K/day.

Ship + deploy via `~/.claude/skills/live-shelf-deploy/deploy.sh`. No tests required — config constants.

### Phase 1 — JWT mint + RealtimeSubscriber skeleton (~1 day)

**New cloud edge function**: `supabase/functions/livetrack-token/index.ts`

- Accepts `x-api-key` header (existing device auth).
- Validates against `chefbyte.live_shelf_devices.import_key_hash`.
- Mints a 1hr JWT with custom claims `{sub: device.user_id, role: 'authenticated', aud: 'authenticated'}` signed with `SUPABASE_JWT_SECRET`.
- Returns `{access_token, expires_at}`.
- Hourly refresh from Pi = 24 invocations/day.

**New Pi module**: `hardware/live-shelf/server/cloud/realtime_subscriber.py`

- One `RealtimeSubscriber` class wrapping `supabase-py`'s Realtime client.
- Per-table channel; each channel calls back into an existing apply-handler function.
- Token refresh task runs hourly via the same shutdown_event pattern as existing pollers.
- Connection state machine: `connecting` → `connected` → `disconnected` → reconnect with jittered backoff.

**Proof of concept**: subscribe to ONE table (`event_overrides`) while keeping all pollers running. Watch logs / verify row events apply correctly through one wifi flap + one Supabase restart. Tests for the WebSocket reconnect path with mocked transport.

### Phase 2 — migrate remaining Class A tables (~2 days)

Per table:

1. Add Realtime subscription via the new subscriber.
2. Bump the corresponding poller's cadence from 30/60s → 600s (10min safety-net).
3. Verify no regression for a few hours.
4. Move to the next table.

Order to migrate: `event_overrides` → `review_queue` → `scale_pairings` → `products` → `cloud_lots`.

`cloud_lots` is last + most carefully because catch-all dispatch reads it synchronously. Add the on-demand fetch (item 3 in the target architecture) when this one lands.

### Phase 3 — cleanup (optional, weeks later)

After Realtime has been stable for ~2 weeks under real use, optionally:

- Remove the per-table safety-net pollers (controversial — see "Codex review" below).
- OR keep them permanently at 10min cadence as documented insurance.

## Invariants the `RealtimeSubscriber` must hold

Production-grade requirements derived from Codex review + Supabase Realtime docs:

A. **Idempotent handlers.** Realtime is at-least-once. Every row handler must safely apply the same row twice (upsert by PK + watermark check). Already the shape of the existing pollers' apply logic — reuse it.

B. **Cold-start ordering.** On Pi boot: fetch current state of each subscribed table FIRST, then subscribe. Otherwise events fired during the gap are lost.

C. **Reconnect catch-up.** WebSocket drops. On reconnect: fetch deltas-since-watermark per table BEFORE resuming listening. The watermark is `(updated_at, primary_key)` — NOT `updated_at` alone (per Codex: `updated_at` can regress on mixed-code-path writes; `(updated_at, pk)` cursor is monotonic).

D. **Watermark advance only on success.** Never advance the watermark until the row's apply transaction commits. Partial apply failures must leave the watermark unchanged so the next safety-net poll re-fetches.

E. **Jittered backoff per channel.** On Wi-Fi flap, all channels reconnect together. Add per-channel jitter so they don't thundering-herd the join.

F. **Health monitoring.** Track "last Realtime message age" per channel. Idle for >5min AND known activity should have produced events → one-shot reconcile poll. Surface in `/health` endpoint.

G. **Graceful degrade.** Realtime down → safety-net polling keeps Pi functional. Pi NEVER stops processing local scale events / barcode scans regardless of Realtime state.

H. **Delete semantics.** Postgres Changes delete events have caveats (RLS may suppress them; old-row payload may be partial). Handlers must treat deletes carefully — verify against safety-net poll on the next tick rather than trusting the event alone.

## Codex review highlights (2026-05-04 second-opinion)

Codex agreed with the overall architecture. Specific refinements:

- **`updated_at` alone is not monotonic.** Use `(updated_at, pk)` cursor; never advance on partial apply failure. (Updated invariant C/D above.)
- **Realtime billing is per-message-per-client, not per-connection.** At 1 Pi this is negligible; at 5-10 Pis this multiplies. Worth tracking peak-connection billing + plan caps before scaling.
- **Postgres Changes single-threaded.** Authorization is checked per subscriber on a single thread. For 5-10 Pis Supabase recommends migrating to Realtime Broadcast triggers (more setup, better fan-out). Out of scope for MVP; revisit at scale.
- **Replication slot pressure.** Realtime streams via logical replication slot; lagged consumers retain WAL. Alert on `ReplicationMaxWalSendersReached` and related error codes.
- **JWT mint approach is correct.** Don't put `service_role` on the Pi. Per-device long-lived API key is worse than short-lived JWT for physical hardware.
- **On-demand fetch at catch-all dispatch is correct.** Pair with bounded retry, never silent tolerance — silent tolerance shifts errors from "fetch latency spike" (recoverable) into "wrong dispatch decision" (data corruption).
- **Keep the 10min safety-net permanently.** Cheap insurance + deterministic self-heal SLO. Don't treat it as migration scaffolding.

## Open decisions

1. **Safety-net cadence**: 10 min vs 5 min vs 30 min. Tradeoff is reconcile latency vs invocation count. Default to 10 min.
2. **Realtime Postgres Changes vs Broadcast triggers**: Postgres Changes is simpler. Broadcast scales better. Stay on Postgres Changes for MVP; revisit at 5+ Pis.
3. **`cloud_lots` vs `stock_lots`**: Pi mirrors `cloud_lots` today. Confirm whether the Realtime publication has `cloud_lots` (it's a Pi-side mirror table — the cloud authoritative table is `chefbyte.stock_lots`). Pi should subscribe to `stock_lots` and mirror into local `cloud_lots`.
4. **Phase 3 cleanup**: leave pollers permanently as safety-net, or remove? Default per Codex: leave them.

## Test strategy

For each phase:

- Phase 0: smoke-test the Pi runs OK at new cadences for 24h.
- Phase 1: unit tests for the JWT-mint edge function (validate x-api-key, claim shape, expiry). Unit tests for `RealtimeSubscriber` with a mocked WebSocket transport. Integration test against local Supabase Realtime.
- Phase 2: end-to-end test per table — Pi subscribes → web admin INSERTs/UPDATEs/DELETEs via service-role → Pi applies the row within 1s. Verify safety-net poll cadence in the absence of events.
- Phase 3: chaos test — periodically kill the WebSocket and verify reconcile-on-reconnect produces no drift.

## File-level plan

```
NEW:
  supabase/functions/livetrack-token/index.ts        # JWT mint edge function
  hardware/live-shelf/server/cloud/realtime_subscriber.py  # main client
  hardware/live-shelf/server/cloud/tests/test_realtime_subscriber.py
  apps/web/src/__tests__/integration/edge-functions/livetrack-token.test.ts

EDIT (Phase 0 + 1 + 2):
  hardware/live-shelf/server/cloud/livetrack_poller.py        # IDLE_POLL_S 2 → 30
  hardware/live-shelf/server/cloud/product_sync_poller.py     # POLL_INTERVAL_S 30 → 600 in Phase 2
  hardware/live-shelf/server/cloud/event_overrides_poller.py  # same
  hardware/live-shelf/server/cloud/review_sync_poller.py      # same
  hardware/live-shelf/server/cloud/lot_snapshot_poller.py     # POLL_INTERVAL_S 60 → 600
  hardware/live-shelf/server/cloud/pairings_sync_poller.py    # same
  hardware/live-shelf/server/app.py                           # construct + start RealtimeSubscriber
  hardware/live-shelf/server/handlers/scale_events.py         # on-demand cloud_lots fetch (Phase 2)

NEW MIGRATION (if needed):
  supabase/migrations/YYYYMMDD_realtime_publication_check.sql  # verify all Class A tables in publication
```

## What to pick up

When you come back to this:

1. Start with Phase 0 (5 min change, immediate cost relief).
2. Decide on `cloud_lots` vs `stock_lots` for the lot mirror — read `hardware/live-shelf/server/cloud/lot_snapshot_poller.py` to confirm what it actually polls today.
3. Read Codex's two structural suggestions above (keep safety-net permanently; move to Broadcast at ~5 Pis).
4. Build the `livetrack-token` edge function first — that's the auth foundation for everything else.
5. Phase 1 (`event_overrides` proof of concept) is the riskiest single chunk. Take time on the reconnect/cold-start invariants before declaring it stable.

---

**Cross-references:**

- Audits that landed before this plan: commits `9b93fe8` → `eab1044` on `main` (catch-all two-pass classification + BT watchdog + 2-round audit hardening).
- Removed nightly CI workflows: `af059e7` (nightly-audits.yml) and `82a4a2f` (verify-full.yml).
- Supabase quota notice: 2026-05-04 email, OnTheBrinkAI org (`ocfinytcdavrelhumusj`).
