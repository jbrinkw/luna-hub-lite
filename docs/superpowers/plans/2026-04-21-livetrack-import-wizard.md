# 2026-04-21-livetrack-import-wizard.md

## 0. Review notes (2026-04-21 revision)

This plan was reviewed against the actual codebase before implementation. The items below supersede / clarify the original sections that follow. **Implementers: read this section FIRST.**

1. **Edge-function JWT config.** Every existing edge fn in `supabase/config.toml` uses `verify_jwt = false` and verifies the JWT manually via `supabase.auth.getUser()` (this is a CLI 2.75 ES256 workaround — see the comment in config.toml L376). The new `livetrack-session` function must follow the same pattern: `verify_jwt = false`, one function, three routes dispatched by URL path:
    - `POST /livetrack-session/create` — manual JWT verify (like `analyze-product`)
    - `POST /livetrack-session/pi-update` — manual `x-api-key` check + SHA-256 lookup (like `shelf-ingest`)
    - `GET /livetrack-session/active` — manual `x-api-key` check (same pattern)

2. **Don't extend `shelf-ingest`.** The plan originally suggested extending shelf-ingest with the Pi GET route. Don't — keep the new session flow in its own function so its failures/logs stay isolated.

3. **`ai_tare.estimate()` takes image PATHS, not frames.** Signature is `estimate(*, ref_image_paths: list[str], product_form: AiTareProductForm, measured_gross_g: Optional[float] = None, is_partial: Optional[bool] = None, ...)`. The Pi subscriber must:
    - Grab a current camera frame from the daemon's ring buffer
    - Write it to `/home/jeremy/live-shelf/data/tmp/livetrack-<session_id>.jpg` (or similar)
    - Call `estimate(ref_image_paths=[path], product_form=AiTareProductForm(...), measured_gross_g=float|None, is_partial=True)`
    - Clean up the temp file

4. **`AiTareProductForm` fields** (from `intake/models.py:177`): `name`, `brand`, `variant`, `net_weight_g`, `serving_weight_g`, `servings_per_container`, `unit_type` (UnitType enum), `container_type`. The session row's `ai_tare_product_form` JSONB must be shaped to match these keys.

5. **Architecture diagram (§3) is stale.** Pi uses polling for the cloud→Pi direction, POST for Pi→cloud. Only the browser uses Realtime. Treat §5's recommendation as authoritative; the diagram is documentary intent, not the protocol.

6. **Direction variable hoisting.** The snippet in §8 uses `direction` — ensure `direction = self._direction(delta_g)` is computed ABOVE the import-arm branch (same fix as `CATCH_ALL_TARE_CAPTURE_PLAN.md` drift note). Non-catch-all events short-circuit before the branch anyway; this is just defensive.

7. **Multi-device per user.** Plan assumes one device per user; the schema allows many. On `livetrack-session/create`, pick the `live_shelf_devices` row with the most recent `last_heartbeat_ts` that's within 60s. Reject with 409 if none fresh.

8. **Pi-offline manual-tare path.** `WizardState` needs an `offline` branch with a manual `tare_g` input. When the device is stale OR the user explicitly chooses it, skip the scale-waiting step and let them type a tare directly. Save path is unchanged.

9. **`GET /livetrack-session/active` empty response.** Return `200 {session: null}` when no active session is found for the device. 204 would mean "no content" to some clients — stay with 200 + null body for ergonomic parsing on the Pi.

10. **500ms race between scan and arming.** Pi polls every 500ms; if the user places the container within 500ms of scanning, the Pi may still see `waiting_barcode` state and fall through to normal delta detection. Accepted for v1 — UI shows "Place container on catch-all scale" only after the state has flipped to `waiting_scale` (confirmed via Realtime). The user should follow the visible prompt.

11. **Tare save column.** The final save in §2 step 7 must include `tare_weight_g` in the `products` UPDATE. `ScannerPage.executeAction` does NOT currently write this column, so the wizard's save path is net-new code (don't just "reuse executeAction").

12. **Open questions resolved (by owner, earlier in this session):**
    - (1) Polling cloud→Pi: ACCEPTED
    - (2) OFF `product_quantity` missing: fall through to AI-tare button; also keep manual-tare field always visible in partial-container and offline branches
    - (3) `after_weight_g` vs before/delta: use `after_weight_g` (same as tare-button), UX instructs "place container, don't lift"
    - (4) Multi-tab: expire prior session on create, show one-sentence warning in the new tab
    - (5) Post-save Pi SQLite sync: out of scope, wait for existing `sync_products_from_cloud`

## 1. Summary

A new "LiveTrack Import" wizard in the cloud scanner UI chains barcode scan → analyze-product → scale-reading from Pi → save product, in one continuous loop. The Pi ↔ cloud link rides a new `chefbyte.livetrack_import_sessions` row that the Pi subscribes to via Supabase Realtime and patches with scale readings; the same pattern carries AI-tare round-trips. No new Pi API exposure, no persistent cloud→Pi channel — both sides only read/write session rows through Postgres.

## 2. User flow

1. User navigates to `/chef/livetrack-import`. UI fetches the user's `live_shelf_devices` row and refuses to start if `last_heartbeat_ts` is older than 60s (offline branch → "Pi offline — cannot arm scale").
2. UI calls `livetrack-session-create` edge function (user JWT). Function inserts a `livetrack_import_sessions` row `{session_id, user_id, device_id, state='waiting_barcode', expires_at=now+10min}` and returns it.
3. Pi's `LiveTrackSubscriber` (new) sees the row via Realtime and flips its in-memory `import_arm` flag — next non-noise catch-all event routes to the session instead of delta detection.
4. User scans barcode (hardware wedge → `useScannerDetection`). UI calls `analyze-product`, pre-fills the form, auto-focuses `servingsPerContainer`. Session moves to `state='waiting_scale'` via UI patch.
5. User places FULL container on catch-all scale. Pi handler sees import-armed catch-all event; instead of `_lc_event`/reconciler, it writes `livetrack_import_sessions.scale_reading_g = after_weight_g, scale_reading_ts = now, state='scale_reading_received'`. Cloud UI receives Realtime UPDATE and auto-computes `tare_g = scale_reading_g - product.product_quantity_g`.
6. Partial-container branch: user clicks "AI tare". UI patches session `state='awaiting_ai_tare', ai_tare_product_form=<json>`. Pi subscriber runs `intake.ai_tare.estimate` against the current camera frame, writes `ai_tare_g`, `ai_tare_confidence`, `state='ai_tare_ready'`.
7. User reviews, clicks **Next**. UI writes `chefbyte.products` + optional `stock_lots` row directly via user JWT (same path as `ScannerPage.executeAction` purchase branch), then patches session `state='waiting_barcode', scale_reading_g=NULL, ai_tare_g=NULL` — re-arms the Pi for the next item.
8. User closes wizard → UI patches `state='closed'`. Pi subscriber clears `import_arm` flag.

Error branches: scan with no analyze-product result → manual entry screen (reuse ScannerPage placeholder path). Scale reading arrives before barcode → session row's `scale_reading_g` is buffered; UI applies it when barcode step completes. Pi reboots mid-session → on startup `LiveTrackSubscriber.resync()` queries any `state IN ('waiting_scale','awaiting_ai_tare')` rows for this device and re-arms. Session row past `expires_at` → Pi subscriber ignores; UI renders "session expired" toast and offers "new session".

## 3. Architecture (ASCII)

```
 Browser (Vite SPA)               Supabase (Postgres + Realtime + Edge Fn)             Raspberry Pi
 ─────────────────                ─────────────────────────────────────                 ─────────────
 LiveTrackImportPage              edge fn: livetrack-session-create (JWT)               LiveTrackSubscriber thread
   | POST create --------------->  INSERT livetrack_import_sessions ------ Realtime ---> (realtime_py or polling)
   |                                   row.state=waiting_barcode                              |
   | barcode scan                                                                             |
   | UPDATE state=waiting_scale ----->  livetrack_import_sessions -------- Realtime --------> |
   |                                                                                          v
   |                                                                              ScaleHandler.handle_scale_event
   |                                                                              branch if import_arm + catch_all
   |                                                                              writes scale_reading_g back via
   |                                                                              CloudClient.post('/livetrack-session-update')
   |                                                                                          |
   |  Realtime UPDATE <------------  UPDATE livetrack_import_sessions <------------------------|
   |  tare auto-computes              (state=scale_reading_received)
   |
   | (optional) UPDATE state=awaiting_ai_tare ─► Pi: runs ai_tare.estimate, patches row
   |
   | SAVE: insert products + stock_lots (JWT)
   | UPDATE state=waiting_barcode (re-arm)

 Latency budget (target < 2s):
   UI → UPDATE row: ~150ms (supabase-js direct)
   Postgres WAL → Realtime → Pi: ~150-400ms (empirical for this repo)
   Pi scale event → Pi handler → cloud UPDATE: ~100ms + ESP firmware stabilize
   Cloud UPDATE → Realtime → Browser: ~150-400ms
   Total: ~800ms–1.2s typical.
```

## 4. Files to read before coding

- `apps/web/src/pages/chefbyte/ScannerPage.tsx` — barcode → analyze-product → product+lot insert pipeline; the `executeAction('purchase')` branch is what `LiveTrackImportPage.onSave` reuses.
- `apps/web/src/hooks/useScannerDetection.ts` — keyboard-wedge contract (`protectedInputIds`).
- `apps/web/src/shared/useRealtimeInvalidation.ts` — channel-per-table rule + `stateChangeCallbacks.close` reconnect hook (both load-bearing for the new subscription).
- `apps/web/src/pages/chefbyte/InventoryPage.tsx` L255 — reference call-site pattern for Realtime + queryKeys invalidation.
- `supabase/functions/shelf-ingest/index.ts` — existing x-api-key auth + `chefbyte.apply_shelf_event_admin` RPC pattern; the new edge fn is user-JWT, not x-api-key.
- `hardware/live-shelf/server/handlers/scale_events.py` L1518 — `handle_scale_event` is where the import-arm short-circuit sits (compare §3 of `CATCH_ALL_TARE_CAPTURE_PLAN.md`).
- `hardware/live-shelf/server/intake/ai_tare.py` — `estimate()` signature; the subscriber calls this directly.
- `hardware/live-shelf/server/cloud/client.py` / `worker.py` — existing Pi→cloud HTTPS pattern; we extend `CloudClient` with a session-patch method.
- `hardware/live-shelf/docs/CATCH_ALL_TARE_CAPTURE_PLAN.md` — local-only tare-capture design; we share the short-circuit point but diverge on state store (Postgres session row vs SQLite `tare_arm` table).
- `packages/db-types/src/database.ts` L295-367 — confirms `tare_weight_g`, `net_weight_g`, `gross_weight_g`, `container_type`, `density_g_per_ml`, `serving_weight_g`, `servings_per_container` all exist on `chefbyte.products`. No migration needed for product columns.

## 5. Pi ↔ cloud wire protocol

### Recommended: session-row + Realtime (both directions)

One row in `chefbyte.livetrack_import_sessions` IS the protocol. Cloud writes commands by UPDATE; Pi writes results by UPDATE. Both sides subscribe via Supabase Realtime `postgres_changes` filtered on `device_id=eq.<device_id>` and `state=neq.closed`.

**Pi subscribe.** Add `hardware/live-shelf/server/cloud/realtime.py`: a thread using the `realtime` Python package (supabase-py ships with it) that connects to `wss://<project>.supabase.co/realtime/v1/websocket` with the device's service-role-less channel. Authentication: the Pi already has `CLOUD_IMPORT_KEY` (x-api-key). Realtime, however, requires a JWT or anon key. **Blocker**: Supabase Realtime doesn't natively accept x-api-key style auth. Two options:

  (a) Ship the Supabase **anon key** to the Pi via env var + rely on RLS for isolation. The new session RLS policies let the Pi's anon-key client read/write sessions filtered by `device_id` matching its active device row (joining on `live_shelf_devices.import_key_hash = sha256($PI_IMPORT_KEY)`). Requires a SECURITY DEFINER helper RPC `livetrack_session_for_device(p_import_key text)` that the Pi calls to authenticate and get its own session slice.

  (b) Pi **polls** `GET /functions/v1/shelf-ingest/livetrack-sessions` every 500ms when waiting, every 2s idle. Existing `x-api-key` auth works unchanged. Simpler; 500ms poll adds ~250ms average to the arm→event latency but fits the 2s budget.

  **Recommendation: (b) polling** for the session-command direction (cloud → Pi) because the Pi never needs sub-500ms command latency (user is physically placing a container). For the result direction (Pi → cloud) the Pi POSTs to a new edge function `livetrack-session-update` using existing x-api-key auth. Cloud UI gets the UPDATE via Realtime, which it already has working. This avoids shipping the anon key to the Pi and keeps auth consistent with existing Pi→cloud code.

### Rejected alternatives

- **Arm-based (no session row).** A single `live_shelf_devices.import_arm_product_id` column. Simpler but: (1) can't express "awaiting AI tare" vs "waiting scale"; (2) no place for the scale reading to land; (3) one row per device → no history / replay. Killed.
- **WebSocket from Pi directly to browser** via a shared peer-to-peer channel. Requires Pi reachability or a TURN/relay server. Kills the "not publicly routable" constraint. Killed.
- **Pi exposes a LAN HTTP endpoint**; browser calls it via `lan_ip` column. Breaks when user is off-LAN (the wizard's whole point is that the cloud is the single UX surface). Killed.
- **Supabase Queues / pg_cron.** Overkill for a sub-second bidirectional RPC pattern; pg_cron has minute granularity. Killed.

### Pi subscriber reconnect

Same rationale as `useRealtimeInvalidation`'s socket-close handler: on HTTP 4xx/5xx during poll the subscriber exponentially backs off (1s → 30s cap) and retries. On heartbeat tick (existing, 5s) if a session exists and the subscriber thread is dead, the heartbeat loop respawns it.

## 6. Schema migrations

Single new migration `supabase/migrations/20260421010000_livetrack_import_sessions.sql`:

```sql
CREATE TABLE chefbyte.livetrack_import_sessions (
  session_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id              UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  state                  TEXT NOT NULL CHECK (state IN (
                           'waiting_barcode','waiting_scale','scale_reading_received',
                           'awaiting_ai_tare','ai_tare_ready','closed','expired')),
  current_barcode        TEXT,
  current_product_id     UUID REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  scale_reading_g        NUMERIC(10,3),
  scale_reading_ts       TIMESTAMPTZ,
  ai_tare_product_form   JSONB,            -- what Pi needs for ai_tare.estimate
  ai_tare_g              NUMERIC(10,3),
  ai_tare_confidence     TEXT CHECK (ai_tare_confidence IN ('low','medium','high') OR ai_tare_confidence IS NULL),
  ai_tare_reasoning      TEXT,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX lti_active_idx
  ON chefbyte.livetrack_import_sessions (device_id, state)
  WHERE state NOT IN ('closed','expired');
CREATE INDEX lti_user_idx ON chefbyte.livetrack_import_sessions (user_id);

ALTER TABLE chefbyte.livetrack_import_sessions ENABLE ROW LEVEL SECURITY;

-- User reads/writes own sessions via JWT
DROP POLICY IF EXISTS lti_user_rls ON chefbyte.livetrack_import_sessions;
CREATE POLICY lti_user_rls ON chefbyte.livetrack_import_sessions
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.livetrack_import_sessions TO service_role;

-- Realtime publication so browser subscription fires
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='chefbyte'
      AND tablename='livetrack_import_sessions') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.livetrack_import_sessions';
  END IF;
END $$;
```

`chefbyte.products` column check: `tare_weight_g NUMERIC(10,3)` already exists (migration 20260419010000 L22). No product DDL needed.

## 7. Edge function spec

New Supabase edge function `supabase/functions/livetrack-session/index.ts` (`verify_jwt = true`). Two routes:

- `POST /livetrack-session/create` body: `{}`. Uses JWT-derived user_id; looks up the user's single `live_shelf_devices` row (rejects 409 if none or `is_active=false`); expires any prior `state NOT IN ('closed','expired')` rows for the device (UPDATE to `'expired'`); inserts a fresh row; returns the row.

- `POST /livetrack-session/pi-update` body: `{session_id, scale_reading_g?, ai_tare_g?, ai_tare_confidence?, ai_tare_reasoning?, state?, last_error?}`. Auth: `x-api-key` (same pattern as `shelf-ingest`). Validates the session's `device_id` matches the key's device. UPDATEs allowed fields and bumps `updated_at`. Returns the row.

The user-side UPDATEs (state transitions, Next/re-arm) happen client-side through supabase-js directly against `chefbyte.livetrack_import_sessions`, secured by the RLS policy above. No new edge route needed for those.

Request/response TS types live alongside in `apps/web/src/pages/chefbyte/livetrackSession.ts`.

## 8. Pi-side changes

- `hardware/live-shelf/server/cloud/client.py`: add `post_livetrack_session_update(session_id, **fields)` that wraps the POST.
- `hardware/live-shelf/server/cloud/livetrack_poller.py` (new): background thread (started from `app.py` alongside `CloudWorker`). 500ms poll `GET /functions/v1/shelf-ingest/livetrack-session/active` (extend `shelf-ingest` with one GET route that returns the Pi's active session via x-api-key lookup; cheaper than the full session edge fn). Sets a thread-safe `import_arm.state` dict. Handles `awaiting_ai_tare` by calling `intake.ai_tare.estimate()` against the latest `CameraDaemon` ring-buffer frame and posting the result.
- `hardware/live-shelf/server/handlers/scale_events.py` in `handle_scale_event` — insert a short-circuit BEFORE dedup, AFTER `shelf_id` resolution (mirrors §3 of CATCH_ALL_TARE_CAPTURE_PLAN.md, but the state source is the poller instead of the SQLite `tare_arm` table):

    ```python
    if shelf_id == "catch_all" and direction != "noise":
        arm = self._import_arm.get()  # thread-safe snapshot
        if arm is not None and arm.state == "waiting_scale":
            self._cloud_client.post_livetrack_session_update(
                arm.session_id,
                scale_reading_g=after_weight_g,
                scale_reading_ts=pi_received_ts,
                state="scale_reading_received",
            )
            return {"ok": True, "intercepted": "livetrack_import"}, 200
    ```

  This short-circuits BEFORE `record_scale_event` fires so the catch-all delta pipeline does NOT see the event. Noise events are ignored. `direction == 'remove'` is ignored for v1 (same constraint as CATCH_ALL_TARE_CAPTURE_PLAN.md open question #4).
- `app.py` startup: after `_apply_idempotent_migrations`, query the cloud for the Pi's active session and seed `_import_arm` so a reboot mid-wizard doesn't lose state. Symmetric to `clear_stale_tare_arm` in the local-only plan.

Shared with `CATCH_ALL_TARE_CAPTURE_PLAN.md`: the `shelf_id == "catch_all" and direction != "noise"` guard location. **Diverges**: state is held in cloud Postgres (not `tare_arm` SQLite table); response is an async UPDATE via Realtime (not a synchronous DB write to `products.tare_weight_g`). A future refactor could collapse both behind a `self._import_handlers` list.

## 9. Cloud UI changes

**Decision: new route `/chef/livetrack-import`.** Justification: the existing `ScannerPage` has four modes (purchase/consume_macros/consume_no_macros/shopping) with a dense state machine; adding a fifth mode that hijacks `useScannerDetection`, blocks on the Pi, and owns a session row would double the file's complexity. Extracting shared pieces into a hook is cheaper than inlining.

Files to create:
- `apps/web/src/pages/chefbyte/LiveTrackImportPage.tsx` — main page.
- `apps/web/src/pages/chefbyte/livetrackSession.ts` — session CRUD helpers (supabase-js direct + edge fn invoke).
- `apps/web/src/hooks/useLiveTrackSession.ts` — wraps the session row as TanStack Query + `useRealtimeInvalidation` + UPDATE mutations.

Files to modify:
- `apps/web/src/modules/chefbyte/routes.tsx` — add `<Route path="livetrack-import" element={<LiveTrackImportPage/>} />`.
- `apps/web/src/shared/queryKeys.ts` — add `livetrackSession: (userId, sessionId) => ['livetrack-session', userId, sessionId] as const` and `liveShelfDevice: (userId) => ['live-shelf-device', userId] as const`.

State shape (single reducer):
```ts
type WizardState =
  | { kind: 'idle' }
  | { kind: 'creating_session' }
  | { kind: 'waiting_barcode'; session: LiveTrackSession }
  | { kind: 'analyzing'; session: LiveTrackSession; barcode: string }
  | { kind: 'waiting_scale'; session: LiveTrackSession; product: Product; nutrition: NutritionData; tareSource: 'awaiting_scale' | 'ai_tare' }
  | { kind: 'review'; session: LiveTrackSession; product: Product; nutrition: NutritionData; tare_g: number; tareSource: 'scale' | 'ai' | 'manual' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };
```

Realtime wiring:
```ts
useRealtimeInvalidation('livetrack-session', [
  {
    schema: 'chefbyte',
    table: 'livetrack_import_sessions',
    filter: `session_id=eq.${sessionId}`,
    queryKeys: [queryKeys.livetrackSession(user.id, sessionId)],
  },
  {
    schema: 'chefbyte',
    table: 'live_shelf_devices',
    queryKeys: [queryKeys.liveShelfDevice(user.id)],
  },
]);
```

The `filter` override deviates from the default `user_id=eq.${user.id}` — important because `session_id` lets us scope to exactly one row even if two tabs start wizards concurrently. `useRealtimeInvalidation` already supports custom filter.

UX:
- Same keypad as ScannerPage (extract `KeypadPanel` into `apps/web/src/components/chefbyte/KeypadPanel.tsx` if not already).
- Auto-focus `servingsPerContainer` on analyze-product completion: `focusField('servingsPerContainer')` in the `analyzing → waiting_scale` reducer transition.
- Full-vs-partial branch: after analyze-product, show "Container full + sealed?" toggle. Full path: wait for scale, compute `tare_g = scale_reading_g - product.net_weight_g` (using OFF `net_weight_g`/`product_quantity_g`). Partial path: "Place container on scale THEN click AI tare" — UPDATE `state='awaiting_ai_tare'` + `ai_tare_product_form={name,brand,variant,net_weight_g,unit_type,container_type,measured_gross_g:scale_reading_g,is_partial:true}`.
- Pi-offline branch: banner "Pi offline since <relative time>. Place container reading disabled." Save still works without scale (manual tare entry enabled).
- aria-live region announces "scale reading received: 314 g" when the session row flips state.

## 10. Test plan

Spec locations mirror existing patterns (`apps/web/e2e/chefbyte/scanner.spec.ts` + `hardware/live-shelf/server/tests/test_catch_all_scale_routing.py` + `supabase/tests/chefbyte/`).

1. **E2E happy path** (`apps/web/e2e/chefbyte/livetrack-import.spec.ts`): seed a user + heartbeat-fresh device; open wizard; scan barcode; simulate Pi by POSTing to `livetrack-session/pi-update` with a scale reading; assert `tare_g` auto-computes; click Next; assert `products` row written with correct `tare_weight_g` and session row returns to `waiting_barcode`.
2. **No Pi paired**: seed user with zero `live_shelf_devices` rows; open wizard; expect "no Pi paired" screen, no session created.
3. **Pi offline mid-session**: seed device with `last_heartbeat_ts = now - 5min`; start session; scan barcode; assert UI banner "Pi offline" and scale step disabled; assert manual-tare fallback available.
4. **Partial container AI-tare branch** (Pi-side unit test, `test_livetrack_ai_tare.py`): inject a fake session row with `state='awaiting_ai_tare'`; stub `ai_tare.estimate` to return a fixed tare; run poller tick; assert `post_livetrack_session_update` called with `ai_tare_g` and `state='ai_tare_ready'`.
5. **Save-and-reset loop** (E2E): complete one item; assert session stays live with `state='waiting_barcode'`, `current_product_id=null`, `scale_reading_g=null`; scan a second barcode; assert it reuses the same session row.
6. **Re-arm on next item** (Pi-side unit): after short-circuit fires once, next catch-all event while `state='scale_reading_received'` is NOT intercepted; gets recorded normally. Only `state='waiting_scale'` intercepts.
7. **Session expiry**: freeze-time past `expires_at`; POST `/pi-update` returns 410; UI UPDATE fails (RLS still allows, but app-level guard rejects `expires_at < now`); session flips to `state='expired'`; wizard prompts "session timed out, start new".
8. **RLS**: `supabase/tests/chefbyte/livetrack_sessions.test.sql` — user A cannot SELECT/UPDATE user B's session row. Service role can. Anon cannot.

## 11. Open questions

1. **Pi auth for Realtime or polling?** Plan recommends polling (§5). Confirm we don't want the Pi to hold an anon key + JWT. Polling adds up to 500ms latency.
2. **OFF `product_quantity` reliability.** Tare auto-compute assumes `product.net_weight_g` is the declared label weight. OFF frequently has `product_quantity` (e.g., "500 g") but sometimes only `product_quantity_unit`. When missing, fall back to AI tare automatically, or show manual-tare field?
3. **Catch-all scale drift.** If the user has placed the container before arming the session (so `before_weight_g != 0`), should we use `delta_g` instead of `after_weight_g`? Same question as CATCH_ALL_TARE_CAPTURE_PLAN.md open Q#3.
4. **Multi-tab.** If user opens the wizard in two tabs, `livetrack-session/create` expires the prior session. Do we want a "session already active in another tab" warning instead?
5. **Voice / meal-plan cross-pollination.** Should successfully-tared products immediately trigger the existing AI-catalog sync back to LiveTrack's SQLite cache, or wait for the next `sync_products_from_cloud` tick?

## 12. Out of scope

- Mobile UI (wizard assumes desktop + keyboard-wedge scanner).
- Multi-user / shared-household sessions.
- Undo for saved items (uses existing InventoryPage undo).
- Voice assistance / audio prompts.
- ESP8266 firmware changes (`scale-catch-all.ino` already emits `after_weight_g`).
- Deprecating/replacing the Pi-local `/intake` wizard (still used for on-Pi operation).
- Reverse-path: capturing a tare on the Pi's `/inventory` page and pushing back to cloud (covered by CATCH_ALL_TARE_CAPTURE_PLAN.md #1 open question).
- Supporting `live_shelf` or `live_scale` kinds in the import session — catch-all only.
