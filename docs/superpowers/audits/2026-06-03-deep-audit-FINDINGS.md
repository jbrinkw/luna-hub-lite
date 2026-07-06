# Deep System Audit — Ranked Findings (2026-06-03)

Synthesis of a multi-domain adversarial audit of `/home/jeremy/luna-hub-lite`. Every finding below survived a refutation attempt and (where feasible) a live DB / Node repro. This document de-dupes across the domain finders (A1-A6, B1a/B1b, B2-B5, C1-C5) and the seam finders (SEAM, TZ, QTY, RT-SEAM), ranks by severity with `file:line` + repro + a one-line fix direction, and calls out cross-cutting themes and coverage gaps.

**Counts after de-dupe:** 3 Critical, 23 High, 38 Medium/Low.

---

## De-duplication map

Several findings from independent finders are the **same defect** observed at different call sites or layers. Merged clusters:

| Cluster                                                          | Merged IDs                                | Canonical              |
| ---------------------------------------------------------------- | ----------------------------------------- | ---------------------- |
| Tombstone-merge ghost stock (import RPC)                         | A3-01, B1b-03                             | **GHOST-IMPORT**       |
| Tombstone-merge ghost stock (add_stock tool)                     | A3-02, B3-01                              | **GHOST-ADDSTOCK**     |
| Tombstone-merge ghost stock (execute_scan_action purchase)       | MISSED-A3 #3rd-writer                     | **GHOST-SCAN**         |
| Merge-key not partial on `deleted_at` (root cause)               | A3-04, MISSED-A3 systemic, B1b root-cause | **MERGEKEY-ROOT**      |
| `complete_next_set` returns no `completed_set_id` → PR/undo dead | A2-01, A2-02, A2-03                       | **PR-DEAD**            |
| `complete_next_set` double-complete (no lock/unique)             | A2-07, B1b-04                             | **SET-DOUBLE**         |
| Epley reps=1 divergence (web vs server vs app-tools)             | A2-06, B3-03, SEAM-MCP-04                 | **EPLEY-1RM**          |
| `['profile', userId]` shared cache key, incompatible shapes      | A1-HUB-03, B5-01                          | **PROFILE-CACHE**      |
| `unmark_meal_done` deletes wrong [MEAL] product (time-suffix)    | A4-01, B1b-01(chef)                       | **UNMARK-WRONG**       |
| MCP RPC under service-role hits `auth.uid()=NULL` (import)       | B3-02, SEAM-MCP-02                        | **MCP-AUTHUID-IMPORT** |
| `todayStr()` ignores profile tz                                  | B5-03, TZ-01, TZ-02, TZ-03                | **TZ-CLIENT**          |
| tz/DST boundary test is a false-pass (private re-impl)           | B5-02, TZ-04                              | **TZ-TESTFALSE**       |
| Realtime drift script broken + orphaned                          | B5-05(partial), MISSED-B5, RT-SEAM-02     | **DRIFT-SCRIPT**       |
| Realtime pgTAP omits 6 subscribed tables                         | B5-05, RT-SEAM-03                         | **RT-PGTAP-GAP**       |
| `mcpToolLogs` mislabeled read-only in registry                   | B5-04, MISSED-B5 identifier               | **REGISTRY-MISLABEL**  |

> **Important naming clash:** two different finders both used `B1b-01`…`B1b-07`. One series is the **chef-functions** finder (meal/stock plpgsql); the other is the **platform-functions/RLS** finder (agent keys, api_keys, etc.). They are disambiguated below as `B1b(chef)-NN` and `B1b(rls)-NN`.

---

## CRITICAL

### C-1 — Cross-tenant Anthropic API key theft via `hub.get_agent_anthropic_key_admin`

- **ID:** B1b(rls)-01
- **Where:** `supabase/migrations/20260409010000_agent_settings.sql:77-101` (body 88-100 has **no** `auth.uid()` guard); `20260409020000_fix_agent_encryption_fallback.sql:33-58` re-CREATEs without REVOKE; guard migration `20260429100000` skips it.
- **Why critical:** `SECURITY DEFINER` + `GRANT … TO service_role` but **PUBLIC retains the default EXECUTE** (never `REVOKE`d). Verified live: `proacl[1] = '=X/postgres'`, `has_function_privilege('authenticated', …) = t`, `anon = t`. The body decrypts `anthropic_key_encrypted WHERE user_id = p_user_id` with no check that `p_user_id = auth.uid()`. SECURITY DEFINER bypasses RLS.
- **Repro (live, confirmed):** `SET ROLE authenticated` + `request.jwt.claims sub=<attacker>`; `SELECT hub.get_agent_anthropic_key_admin('<victim-uuid>')` returned the victim's decrypted `sk-ant-…` key.
- **Fix direction:** Add `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` in a new migration **and** an in-body guard `IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN RAISE insufficient_privilege` (mirror `20260429100000`).

### C-2 — Ghost-stock data loss: importing shopping list merges onto a tombstoned lot

- **ID:** GHOST-IMPORT (A3-01 + B1b(chef)-03)
- **Where:** `supabase/migrations/20260425010000_shopping_imported_at.sql:104-116` — merge `SELECT … WHERE expires_on IS NULL` has **no** `deleted_at` filter; `UPDATE … SET qty_containers = v_existing_qty + …` (lines 114-116) **never resets `deleted_at`**.
- **Why critical:** `consume_product` (`20260515010000:233-238`) soft-deletes a fully-drained lot (`qty=0, deleted_at=now()`). Because `stock_lots_merge_key` is **not** partial on `deleted_at`, the tombstone occupies the exact merge slot. The import then bumps qty onto the tombstone, leaving `deleted_at` set. Every UI read filters `deleted_at IS NULL` (`InventoryPage:521`, `HomePage:344`, `ShoppingPage`), so the imported containers are **invisible** while the shopping row is stamped `imported_at` (gone from the cart). Pure silent data loss.
- **Reach is wide (finder undersold it):** the RPC is the shared backend behind `HomePage.tsx:562` (dashboard import button), `ShoppingPage.tsx:395` (Import to Inventory), **and** the MCP tool — not MCP-only.
- **Repro (live, confirmed):** drain a 2-container NULL-expiry lot via `consume_product`, then `import_shopping_to_inventory(NULL)` of 3 containers → row ends `qty_containers=3.000, deleted_at` set, `SUM(qty) WHERE deleted_at IS NULL = 0`.
- **Fix direction:** in the merge `UPDATE`, also set `deleted_at = NULL`; or make `stock_lots_merge_key` partial (`WHERE deleted_at IS NULL`) so the merge `SELECT` misses tombstones and a fresh `INSERT` happens. (See MERGEKEY-ROOT / theme T1.)

### C-3 — `CHEFBYTE_add_stock` (MCP) merges onto a tombstoned lot → invisible stock; diverges from the fixed UI path

- **ID:** GHOST-ADDSTOCK (A3-02 + B3-01)
- **Where:** `packages/app-tools/src/chefbyte/add-stock.ts:37-62` — existing-lot `SELECT('lot_id, qty_containers')` (no `deleted_at` projection, no `.is('deleted_at', null)` filter); merge `UPDATE` (line 59) sets only `qty_containers`.
- **Why critical:** identical class to C-2 on the MCP write path. `merge_key` guarantees ≤1 row per slot, so `.single()` returns the tombstone cleanly (no error/INSERT fallback). The UI reference impl (`InventoryPage.tsx:990-993`) detects `isTombstone` and sets `deleted_at = null`; the MCP tool omits `deleted_at` from both projection and update. **No** chefbyte MCP tool clears `deleted_at` on merge. Worse, MCP **reads** filter only `.gt('qty_containers', 0)` (not `deleted_at`), so the qty>0 tombstone **leaks into MCP reads** while staying hidden in the UI → a hard web-vs-MCP inventory mismatch.
- **Repro (live-faithful emulation, confirmed):** tombstone precondition via `consume_product`, then the two handler statements → `(qty 5.000, deleted_at set)`, `ui_visible = 0`. `chefbyte-tools.test.ts:196-275` never seeds tombstone-then-merge (untested false-pass).
- **Fix direction:** select `deleted_at`, and on merge `UPDATE` set `deleted_at: null` and reset qty if revived — copy the `InventoryPage` revive pattern. Apply to **all** chefbyte merge writers (see GHOST-SCAN below + T1).

---

## HIGH

### H-1 — Ghost-stock on barcode "purchase" scan via `execute_scan_action` (third merge writer, finder-missed)

- **ID:** GHOST-SCAN (MISSED-by-finder, A3 domain)
- **Where:** `supabase/migrations/20260503120000_execute_scan_action_merge_purchase.sql:97-111` — `INSERT … ON CONFLICT (user_id,product_id,location_id,COALESCE(expires_on,'9999-12-31')) DO UPDATE SET qty_containers = existing + EXCLUDED …` never clears `deleted_at`.
- **Why high:** this is the **most user-reachable** of the tombstone-merge trio — barcode "purchase" is a primary ChefByte flow, used by **both** the Pi USB forwarder and the web `ScannerPage` cloud write. A purchase scan of a product you previously consumed to zero adds invisible stock.
- **Repro (live, confirmed):** drain a NULL-expiry lot to a tombstone, then `execute_scan_action(…, 'purchase', 3, …)` → `{applied_lot_id}` success, row `qty=3.000`, `deleted_at` still set, `ui_visible = 0`.
- **Fix direction:** add `deleted_at = NULL` to the `DO UPDATE SET` clause (or partial merge_key).

### H-2 — `complete_next_set` RPC returns no `completed_set_id` → PR detection + undo toast are dead on the planned-completion path

- **ID:** PR-DEAD (A2-01 + A2-02; masked by false-pass A2-03)
- **Where:** `apps/web/src/pages/coachbyte/TodayPage.tsx:503,520-524,533,541,547,559,1010`; RPC `supabase/migrations/20260422030000_complete_next_set_completed_flag.sql:103`; contract `packages/db-types/src/database.ts:1674-1677` (`Returns { completed; rest_seconds }[]` — **no** `completed_set_id`).
- **Why high:** `TodayPage:503` reads `result?.[0]?.completed_set_id` which is **always undefined**. Consequences: (a) the exclude-by-id guard at :533 is a no-op, the PR-check `SELECT` (:520-524) includes the just-inserted row, so `firePrCelebrationCue` is suppressed; (b) `setUndoSetId` at :559 is gated on `if (completedSetId)` → the undo toast (`data-testid undo-toast`, :1010) **never mounts**. Two user-facing CoachByte features silently broken.
- **False-pass that hid it:** `TodayPage.prDetection.test.tsx:58-68,217-229` mocks a **fabricated** RPC shape including `completed_set_id` (and `planned_set_id`); remove that field and `getByTestId('undo-toast')` at :227 throws. The sibling `completeNextSet.test.tsx:79` mocks the **real** `{rest_seconds, completed}` shape, proving the divergence.
- **Fix direction:** add `completed_set_id UUID` to the RPC `RETURNS TABLE` and `RETURN QUERY` (regenerate db-types), then fix the false-pass test to the real shape.
- **Secondary (perf, finder-noted):** even fixed, the PR-check `SELECT` (:520-524) is **unbounded** — it loads the user's entire lifetime of completed sets for the exercise on every completion. Scope it by date/plan.

### H-3 — `complete_next_set` double-completes a planned set under concurrency

- **ID:** SET-DOUBLE (A2-07 + B1b(rls)-04)
- **Where:** `supabase/migrations/20260422030000_complete_next_set_completed_flag.sql:47-77` (find-via-LEFT-JOIN then INSERT, no `FOR UPDATE`/`ON CONFLICT`); table DDL `20260303030035_coachbyte_tables.sql:49-59` has **no** unique on `planned_set_id`.
- **Why high:** under READ COMMITTED, two overlapping txns (two tabs, or a tab + MCP `complete_next_set_admin`) both read the same slot as incomplete and both insert. Verified live with interleaved txns: one `planned_set_id` ended with **2 completed rows** `{5×100, 8×60}`. Pollutes HistoryPage counts and PR derivation. (The single-user "last-write-wins" tolerance softens it, but exactly-once is genuinely violated.)
- **Fix direction:** add `UNIQUE (planned_set_id)` (partial `WHERE planned_set_id IS NOT NULL`) **or** `SELECT … FOR UPDATE` on the planned-set row inside the function.

### H-4 — `coachbyte.complete_next_set_admin` callable by PUBLIC/authenticated → cross-user write of completed sets

- **ID:** B1b(rls)-03
- **Where:** `supabase/migrations/20260422030000_complete_next_set_completed_flag.sql:15` (DROP drops the prior REVOKE) + `111-123` (re-CREATE) + `126` (GRANT service_role only) — resurrects PUBLIC's default EXECUTE that `20260304010000:19` had revoked.
- **Why high:** the inner ownership check (`WHERE plan_id=p_plan_id AND user_id=p_user_id`) is not a barrier — the attacker passes the victim's own `user_id`+`plan_id`. Verified live: attacker `sub=<B>` called `complete_next_set_admin('<A>','<A-plan>',999,999)` → `completed=t`, victim's completed_sets `0→1` with `actual_reps=999`.
- **Fix direction:** re-`REVOKE … FROM PUBLIC` after the re-CREATE; add the `auth.uid()` self-guard.

### H-5 — `chefbyte.add_to_shopping_admin` callable by PUBLIC/authenticated → cross-user write to another user's shopping list

- **ID:** MISSED-by-finder (platform-functions sweep)
- **Where:** `supabase/migrations/20260423030000_fix_add_to_shopping_admin_ambiguous.sql` (re-CREATE that did **not** re-REVOKE PUBLIC); body inserts `VALUES (p_user_id, …)` trusting the caller.
- **Why high:** identical class to H-4. Verified live: `proacl[1]='=X/postgres'`, `authenticated=t`, `anon=t`, no `auth.uid()` guard; product check `p.user_id = p_user_id` is satisfied by the victim's own id. A comprehensive sweep found **exactly 6** unguarded+PUBLIC `p_user_id` SECURITY DEFINER functions: the 5 the RLS finder cited (B1b(rls)-01/02/03/07) **plus** `add_to_shopping_admin`.
- **Fix direction:** single follow-up migration `REVOKE EXECUTE … FROM PUBLIC` on all 6 wrappers (3 agent fns + `complete_next_set_admin` + `consume_product_admin` + `add_to_shopping_admin`), mirroring `20260304010000:18-25`.

### H-6 — `hub.get_agent_system_prompt_admin` / `hub.get_agent_voice_ack_admin` callable by PUBLIC → cross-user disclosure

- **ID:** B1b(rls)-02
- **Where:** `20260409010000_agent_settings.sql:106-117` + `20260416020000_agent_voice_ack.sql:63-78` (GRANT service_role, no REVOKE PUBLIC).
- **Why high:** both bodies `SELECT … WHERE user_id = p_user_id` with no guard; `proacl[1]='=X/postgres'`, `auth/anon = t`. Verified live: attacker read victim's `'VICTIM-PRIVATE-SYSTEM-PROMPT'` and `'VICTIM-VOICE-ACK'`.
- **Fix direction:** same REVOKE + guard pass as C-1.

### H-7 — analyze-product daily quota is a non-atomic read-modify-write → concurrent scans bypass the 100/day cap

- **ID:** B2-01
- **Where:** `supabase/functions/analyze-product/index.ts:114-154` — `checkQuota` does client `SELECT value` → `JSON.parse` count → `if (count>=DAILY_QUOTA) return false` → `upsert({count: count+1})` writing an **absolute** JS-computed value (line 143).
- **Why high:** two concurrent requests both read `count=99`, both pass, both upsert `100`. No `FOR UPDATE` / atomic SQL increment. Contrast the walmart path (`private.walmart_check_and_increment`) which does `INSERT…ON CONFLICT + FOR UPDATE + used=used+1`. Bypasses a platform-paid LLM spend cap.
- **Repro:** the integration test (`analyze-product.test.ts:134`) pre-seeds `count=100` and asserts only the single-request path; zero concurrency coverage.
- **Fix direction:** port the walmart atomic pattern — a `private.analyze_check_and_increment` RPC with `ON CONFLICT … SET count = count + 1` and an in-DB `>= DAILY_QUOTA` gate.

### H-8 — shelf-ingest barcode-scan: stock mutation commits before the audit-row insert → partial apply + no idempotency record → double-apply on Pi retry

- **ID:** B2-02
- **Where:** `supabase/functions/shelf-ingest/index.ts:1374-1445`.
- **Why high:** `body.unit` is **never** validated against `{container, serving}` (only `typeof === 'string'`), and `execute_scan_action` succeeds & commits for any unit (purchase branch ignores `p_unit`; consume coerces). The RPC (`:1386`) and the `scan_transactions` insert (`:1419`) are **two separate** PostgREST transactions. If the insert fails (e.g. `unit='kg'` → 23514 CHECK violation), `:1442` returns 500 **without** writing an errored idempotency row. The idempotency `SELECT` at `:1237` then finds nothing on Pi retry → the RPC re-runs → second lot mint / second consume. Broader than stated: affects **all** modes.
- **Fix direction:** validate `unit` up front (reject non-`{container,serving}`); fold stock mutation + audit insert into **one** RPC/transaction, or always write an errored-tx idempotency row before returning 500.

### H-9 — shelf-ingest heartbeat: `pending_review_count` forwarded unvalidated → CHECK violation 500s the whole heartbeat, blackholing liveness

- **ID:** B2-03
- **Where:** `supabase/functions/shelf-ingest/index.ts:1927,1992-2003`.
- **Why high:** `:1927` accepts any `typeof 'number'` (incl. `-1`, `3.5`, `Infinity`, `NaN`) — while the **immediately following** outbox counters (`:1934-1937`) are guarded with `Number.isFinite && >= 0 ? Math.trunc : 0`. The device `UPDATE` sets `last_heartbeat_ts` **and** `pending_review_count` in the same statement; a CHECK violation (`>= 0`, migration `20260419060000:420`) throws → top-level catch → 500, so `last_heartbeat_ts` never persists. A Pi counter-underflow bug silently makes the device look offline.
- **Fix direction:** apply the same `Number.isFinite && >= 0 ? Math.trunc(...) : 0` guard to `pendingReviewCount`.

### H-10 — `unmark_meal_done` deletes the WRONG `[MEAL]` product when two same-recipe meal-prep meals share a logical_date

- **ID:** UNMARK-WRONG (A4-01 + B1b(chef)-01)
- **Where:** `supabase/migrations/20260515010000_stock_lots_no_hard_delete.sql:389,402,413` (rebuilds bare prefix `'[MEAL] '||name||' '||to_char(d,'MM-DD')` and matches `name = v_expected_prefix` exactly) vs `generate_meal_product_name` time-suffix (`20260424090000_invariant_batch.sql:248-265` / `20260429100000:127-153`).
- **Why high:** the 2nd `mark_meal_done` of the same recipe/date produces a `'[MEAL] … MM-DD HH:MM'`-suffixed product (since `generate_meal_product_name` gates on a `NOT EXISTS` row check, not a constraint). But `unmark` only ever reconstructs the **bare** prefix. Verified live (rolled back): `unmark(m2)` **destroyed m1's** bare-named product+lots, left m2's suffixed product orphaned, and crossed the completed_at flags. **No recovery:** m1.completed_at stays set, a later Undo on m1 is a no-op (product already gone) → m1's prepped food permanently unrecoverable; the suffixed orphan is reachable by no cleanup path → permanent ghost inventory + phantom lot. Single-meal variant also holds (any pre-existing bare-name product forces a suffix on mark, so unmark fails to match its own product).
- **Structural enabler (finder-missed):** **no** UNIQUE on `chefbyte.products.name` (only `products_pkey` + partial unique on `user_id+barcode`); collision avoidance is purely advisory.
- **Fix direction:** store the chosen `product_id` on `meal_plan_entries` (or in `event_overrides`) at mark time and delete **by id** on unmark, instead of reconstructing the name.

### H-11 — Voiding a Pi-USB purchase that MERGED into a pre-existing lot destroys all stock in that lot

- **ID:** A5-01
- **Where:** `supabase/migrations/20260503120000_execute_scan_action_merge_purchase.sql:97-113` (merge `RETURNING lot_id` → stored as `applied_lot_id`) + `20260503100200_void_scan_transaction_fn.sql:72-75` (unconditional `DELETE … WHERE lot_id = v_applied_lot_id`) + `20260515010000:106-122` (hard-delete guard zeroes the **whole** lot).
- **Why high:** the Void button renders for any `status='applied'` (`ScannerTransactionsTab.tsx:132`) with no `pi_usb` exclusion; void does a per-lot delete with no per-portion reversal. Two same-day Pi purchases merge and **both** record the same `lot_id`; voiding one nukes the combined lot. The void test (`void_scan_transaction.test.sql:64-101`) only seeds a `qty=1` lot matching a `qty=1` purchase — never a pre-existing/extra-qty lot, so it green-lights whole-lot zeroing.
- **Fix direction:** store the per-scan delta and reverse by **subtracting** `purchaseQty` (like the in-session undo at `ScannerPage:1546`), not deleting the lot. Pairs with A5-09 (web merged purchase under-reverses) — unify the two void surfaces.

### H-12 — `resolve_add_to_shelf_lot` step-4 revive resurrects a soft-deleted tombstone without clearing `deleted_at` (live_shelf zombie stock)

- **ID:** B1b(chef)-02
- **Where:** `supabase/migrations/20260429210000_partial_place_no_qty_bump.sql:349-388` (step 4 `SELECT qty_containers<=0` with no `deleted_at` filter; `UPDATE qty=1.0` at 370-379 without resetting `deleted_at`). Tombstones from `consume_product` (`20260515010000:233-238`).
- **Why high:** `apply_shelf_event` added/refilled branch (`20260427130000:881-919`) unconditionally calls `resolve_add_to_shelf_lot`. Steps 1-3 all require `qty>0` so they skip a tombstone; step 4 reaches it, sets qty=1.0 but omits `deleted_at`. UI reads + `consume_product` FEFO both filter `deleted_at IS NULL` → revived lot is invisible **and** unspendable. The web manual-add path proves the author knows revive must clear it (`ScannerPage.tsx:1305-1312`, `InventoryPage.tsx:967-973`). Uncovered by tests.
- **Fix direction:** step-4 `UPDATE` must also `SET deleted_at = NULL`. (Theme T1.)

### H-13 — `queryKeys.profile` cache-key collision: metric users silently get imperial units

- **ID:** PROFILE-CACHE (B5-01 + A1-HUB-03)
- **Where:** `apps/web/src/shared/queryKeys.ts:4` (`['profile', userId]`) shared by `AppProvider.tsx:66-80` (returns a bare **number** `day_start_hour`, 10-min staleTime), `useUnitSystem.ts:21-37` (returns `{unit_system}`, 5-min), `AccountPage.tsx:92-105` (returns `{display_name, timezone, day_start_hour, unit_system}`, 2-min), `ClassifierTab.tsx:40` (`{chefbyte_classifier_fallback_enabled}`). **None** has a `select:` transform.
- **Why high:** TanStack v5 dedupes strictly by key and shares **one** `data` entry. `AppProvider` wraps all protected routes (`App.tsx:55`) and mounts first, caching a bare number under the key with a 10-min staleTime. Navigating to `/chef/inventory` within that window → `useUnitSystem` reads the number, `(number).unit_system === undefined` → returns `'imperial'`. A **metric** user then sees ounces (`formatIngredientDisplay.ts:88-96`, used at `InventoryPage.tsx:1517/1812/2009/2159`). The reverse cold-load ordering corrupts `day_start_hour → 0` (shifts the day boundary). Empirically reproduced with query-core; persists up to the staleTime (not "momentary"). No test references `useUnitSystem`.
- **Fix direction:** give each consumer a **distinct** key (e.g. `['profile', userId, 'unitSystem']`) or one canonical full-row profile query that all consumers `select:` from.

### H-14 — `mark_meal_done` over-tags unrelated food_logs via `WHERE created_at = now()`

- **ID:** A4-02
- **Where:** `supabase/migrations/20260430020000_meal_execute_unification.sql:345-349` (deployed 314-317).
- **Why high (latent):** the meal's food_log tagging matches `created_at = now()` (txn-start). Verified live (rolled back): an unrelated food_log inserted in the **same txn** before `mark_meal_done` gets `meal_id` overwritten and appears in `food_log_ids`. Caller audit confirms **no current** path shares a txn with an untagged insert (each `.rpc()` is its own PostgREST txn), so it's latent — but a future trigger/batched insert would corrupt macro attribution.
- **Fix direction:** tag by the specific `food_log_id`s returned from the meal's own `consume_product` calls, not by `created_at`.

### H-15 — SSRF origin-normalization strips the API base path, breaking every self-hosted Git host (Gitea/GHE)

- **ID:** B4-01
- **Where:** `extensions/_lib/ssrf.ts:97` (`return parsed.origin`) + `extensions/obsidian/tools/git-api.ts:44-58`.
- **Why high:** `new URL('https://git.corp/api/v1').origin` drops `/api/v1`; `repoUrl()` then builds `${apiUrl}/repos/...` → `https://git.corp/repos/...` → 404 for all Gitea/GHE calls (github.com only works because `api.github.com` needs no path). The Hub Settings UI **actively instructs** entering `.../api/v1` (`ExtensionCard.tsx:70`), and `config.json:4` advertises "GitHub, Gitea, etc." — so the real-world hit rate is "anyone following the in-app Gitea setup hint," not a hypothetical self-hoster. False-pass: `obsidian-ssrf.test.ts:100-103` documents the path-drop as intended.
- **Fix direction:** preserve `parsed.origin + parsed.pathname` (strip only credentials/query) in the SSRF normalizer, or have callers re-prepend the configured base path.

### H-16 — `invariant-monitor` calls `private.upsert_alert` via PostgREST → PGRST106 → all 11 invariant violations silently never written

- **ID:** SEAM-EDGE-DB-01
- **Where:** `supabase/functions/invariant-monitor/index.ts:570` (`.schema('private').rpc('upsert_alert', …)`) + `578-588` (swallows the error, reports `ok:true`); target only exists as `private.upsert_alert` (`20260427030000_hub_alerts.sql:207`); `config.toml:13` api.schemas excludes `private`.
- **Why high:** supabase-js sets `Content-Profile: private`; PostgREST rejects with `PGRST106 'Invalid schema: private'` **before** any grant check. The cron job (`20260427040000`) runs every 30 min; every detected violation (negative stock, 4-4-9 macro breach, orphaned in-flight lot, pi/cloud drift, NULL-user mcp log, zombie LiveTrack session, running timer with NULL end, >5% macro drift) hits this line and is dropped → `hub.alerts` stays empty, the production data-corruption backstop is **completely inert**. The repo already fixed this exact PGRST106 pattern **three times** (walmart, execute_scan_action, void wrappers) with `chefbyte.*` SECURITY DEFINER wrappers; `invariant-monitor` is the lone remaining `.schema('private').rpc()` caller. Never caught because `handler.test.ts:150` stubs the upsert and the pgTAP calls `private.upsert_alert` directly in SQL.
- **Fix direction:** add a `hub.upsert_alert(...)` (or `public.`) SECURITY DEFINER wrapper exposed to PostgREST and call **that**; alternatively have the edge fn call the RPC via the admin REST path that targets an exposed schema.

### H-17 — `CHEFBYTE_update_recipe` ingredient replacement ALWAYS fails via MCP (`auth.uid()=NULL` under service-role)

- **ID:** SEAM-MCP-01
- **Where:** `packages/app-tools/src/chefbyte/update-recipe.ts:92` → 2-arg public wrapper `chefbyte.save_recipe_ingredients` → `private.save_recipe_ingredients((SELECT auth.uid()), …)` (`20260430060000:60-72`, ownership check `:32-36`).
- **Why high:** the MCP worker uses `createServiceClient(SERVICE_ROLE_KEY)` with **no** JWT attached (`apps/mcp-worker/src/supabase.ts:3-5`); the JWT is used only to derive `userId`. So `auth.uid()` is NULL → `p_user_id=NULL` → ownership guard `NOT EXISTS(… user_id=NULL)` → `RAISE 'Recipe not found or not owned by user'`. There is **no** `save_recipe_ingredients_admin(p_user_id, …)` overload, unlike every other ChefByte mutation. The documented "fully replace ingredient list" path is 100% broken via MCP; metadata patches succeed → partial update.
- **Fix direction:** add a `save_recipe_ingredients_admin(p_user_id, p_recipe_id, p_ingredients)` overload (GRANT service_role) and call it from the handler with `ctx.userId`.

### H-18 — `CHEFBYTE_import_shopping_to_inventory` ALWAYS fails via MCP (`auth.uid()=NULL`, no admin overload)

- **ID:** MCP-AUTHUID-IMPORT (B3-02 + SEAM-MCP-02)
- **Where:** `packages/app-tools/src/chefbyte/import-shopping-to-inventory.ts:23-27` → 1-arg public wrapper (`20260425010000:143-156`, GRANT `TO authenticated` only) → `private.import_shopping_to_inventory((SELECT auth.uid()), p_location_id)` → location resolution keyed on `p_user_id` (`:69-88`).
- **Why high:** service-role → `auth.uid()=NULL` → `p_user_id=NULL` → `RAISE 'No storage locations found for user'` (or 'Location not found'). No `_admin` overload exists. The `iserror`-convention test passes only because its mock RPC always errors (masking). The integration test (`chefbyte-tools.test.ts:1528-1533`) is stale: it asserts a `lots` field the handler no longer returns, and is excluded from the default `vitest run`, so the breakage ships undetected.
- **Fix direction:** add `import_shopping_to_inventory_admin(p_user_id, p_location_id)` (GRANT service_role); call with `ctx.userId`. (Note: even when fixed, the underlying RPC still has the GHOST-IMPORT tombstone bug C-2.)

### H-19 — Web `todayStr()` ignores profile timezone → diverges from every server `get_logical_date()`; written verbatim as `p_logical_date`

- **ID:** TZ-CLIENT (B5-03 + TZ-01, with TZ-02/TZ-03 sub-cases)
- **Where:** `apps/web/src/shared/dates.ts:20-26` (uses `new Date()` + `toLocaleDateString('sv-SE')`, browser-local, accepts only `dayStartHour` — **no** tz param); consumed at `ScannerPage.tsx:1381,1387,1430` → `consume_product`; server `private.get_logical_date` (`20260424050000_consume_bounds.sql` / `20260302020835`) uses **profile tz**.
- **Why high:** `consume_product` inserts the client-supplied `p_logical_date` **verbatim** into `food_logs.logical_date` (no server recompute). When browser tz ≠ profile tz near the day boundary, the row lands on the wrong logical day vs the Pi/MCP, which use the profile tz. Verified numerically: at `2026-06-02T09:30:00Z`, dsh=6, browser=UTC → `todayStr='2026-06-02'` but `get_logical_date(…,'America/New_York',6)='2026-06-01'` → macros split across two days; a Pi-ingested log is invisible in the web "today" total. Two **distinct** divergence axes: (a) calendar-date formatting in host tz; (b) the `setHours(-dayStartHour)` subtraction done on host-local wall clock vs profile-tz wall clock. Sub-cases TZ-02/TZ-03: `scan_transactions.logical_date` is stamped in **raw UTC** (`ScannerPage.tsx:501`, `shelf-ingest:1418/1489`) while the food_log it produces uses the day-boundary date → the same single scan lands on two different days in the audit vs macro ledgers.
- **Fix direction:** pass profile `timezone` into `todayStr`/`toDateStr` and compute via `Intl.DateTimeFormat` with that tz (the test's own reference impl is correct — promote it); make `shelf-ingest` stamp `scan_transactions.logical_date` via the same `get_logical_date` it already uses for food_logs.

### H-20 — `recipe_ingredients` opted-out of the realtime completeness gate with a FALSE reason while 4 pages subscribe to it

- **ID:** RT-SEAM-01
- **Where:** `supabase/tests/realtime_publication_completeness/test_completeness.test.sql:64-65` (opt-out row, reason "RecipesPage subscribes to chefbyte.recipes, not this join table") vs live subscriptions at `RecipesPage.tsx:471`, `MacroPage.tsx:306`, `MealPlanPage.tsx:361`, `HomePage.tsx:465`.
- **Why high:** `recipe_ingredients` is the **only** one of 23 subscribed tables carrying an opt-out, **and** it's absent from the integrity probe (RT-SEAM-03), so it has **zero** gate coverage. A future `ALTER PUBLICATION … DROP TABLE chefbyte.recipe_ingredients` would silently break ingredient-edit realtime on 4 pages (the exact 2026-04-27 food_logs regression class) while **both** gates stay green. Verified live in a rolled-back txn: dropping it prints `GREEN-via-OPTOUT(uncaught)` vs `recipes` (no opt-out) which prints `RED-missing(caught)`.
- **Fix direction:** delete the opt-out row (the reason is factually wrong); add `recipe_ingredients` to the integrity probe.

### H-21 — Realtime drift-detector script is permanently broken AND unwired from CI

- **ID:** DRIFT-SCRIPT (RT-SEAM-02 + B5-05 partial + MISSED-B5)
- **Where:** `scripts/verify/realtime_publication_check.sh:30` (`set -euo pipefail`), `:62/64` (rg/grep over `apps/web/src` with **no** `--exclude-dir __tests__`), `:86-87` (Python `sorted()`), `:126-127` (`comm -23/-13`).
- **Why high:** Python `sorted()` uses codepoint order ('\_'=0x5F before letters) while shell `comm` uses locale collation; they disagree on tuples like `scan_transactions` vs `scanner_state`, so `comm` aborts with "file 1 is not in sorted order" and `set -e` kills the script **before** the drift-comparison logic runs. It can **never** print its DRIFT/WARN/ok output in any non-C locale — providing zero signal for the exact food_logs failure mode it was written to catch. Compounding: it's invoked **nowhere** (`run.sh`/`package.json:26`/CI all lack it). Plus it ingests a phantom fixture table `coachbyte.daily_logs` from `__tests__` (RT-SEAM-05) which would cause a false-positive once the comm bug is fixed.
- **Fix direction:** pipe both sides through `LC_ALL=C sort -u` before `comm`; add `--exclude-dir __tests__` to the extractor; wire it into `scripts/verify/run.sh` (`pnpm verify:full`). (Note: the project just deleted the nightly drift-check workflow in `cdcb857`, so this gate is the only intended safety net.)

### H-22 — `ScalesTab` synthetic "manual" close-in-flight device triggers a false "Your Pi key was deactivated" alarm banner

- **ID:** A6-01
- **Where:** `apps/web/src/components/chefbyte/ScalesTab.tsx:179-193` (devices query `.select('*')`, no `import_key_hash`/synthetic filter) + `251-255` (`silentRevokeDevice`) + `551-577` (banner); `supabase/migrations/20260427110000_close_in_flight_lot_rpc.sql:263-285` (synthetic device insert `is_active=false`).
- **Why high:** when a user deletes their last paired device while a lot is in-flight (`stock_lots.in_flight_since` survives the device delete — no FK), the only way to close it is `CloseInFlightModal` → `close_in_flight_lot`, which mints a synthetic `device_name='manual', import_key_hash='manual_close_in_flight_<uid>', is_active=false` device. `silentRevokeDevice` (which fires only when `devices.length === 1` and the sole device is inactive) then surfaces the alarming "Pi key was deactivated" banner with a Reactivate button — for a throwaway audit-only device that can never post events. **Finder-missed amplifier:** `deleteDeviceMutation` doesn't clear the orphaned lot's `in_flight_since` (so device deletion is the realistic trigger), and the banner's Reactivate is a complete **no-op** (the sentinel `import_key_hash` is not a SHA-256 the edge fn matches) → misleading UX.
- **Fix direction:** exclude synthetic devices (`import_key_hash LIKE 'manual_close_in_flight_%'`) from the devices query and from `silentRevokeDevice`; have `deleteDeviceMutation` also clear/close the orphaned in-flight lot.

### H-23 — `COACHBYTE_complete_next_set` performs zero reps/load validation → absurd values poison PR derivation

- **ID:** B3-04
- **Where:** `packages/app-tools/src/coachbyte/complete-next-set.ts:16-24` (forwards unbounded) → `complete_next_set_admin` (bare passthrough) → `private.complete_next_set` INSERT. Final CHECKs: `actual_reps >= 0` (`20260304040002:6`, replacing the `>0`) + `actual_load >= 0` (`20260304030000:232`) — **no upper bound**.
- **Why high (data-quality, finder-noted as MCP-only but actually broader):** `log_set` caps reps≤50/load≤2000 in the **TS handler only**; `complete_next_set` has no such cap on **any** caller (web or MCP), and `get_prs.ts:55` filters only `load<=0 || reps<=0`, so `reps=20/load=5000` passes and becomes the **max** e1RM (~8333), permanently poisoning the displayed PR. The durable fix belongs at the DB layer (which the finder didn't call out).
- **Fix direction:** add a DB CHECK `actual_reps BETWEEN 1 AND 50` (or sane ceiling) and `actual_load <= 2000` on `completed_sets` so all write paths are protected.

---

## MEDIUM / LOW (38)

Grouped; each retains `file:line` and a fix hint. Counted in `medium_low_count`.

**Ghost-stock / merge-key class (root + remaining writers):**

- **MERGEKEY-ROOT** (A3-04, med) — `stock_lots_merge_key` is not partial on `deleted_at` (`20260303040000:183-184`); tombstones occupy merge slots forcing every writer to revive (most don't). Fix: recreate the index `WHERE deleted_at IS NULL`, which structurally fixes C-2/C-3/H-1/H-12 at once.
- **live_scale Tier-4 tombstone-claim** (B1b(chef) lead, med) — `20260429010000_live_scale_never_mints_v2.sql:254-305` claims any lot (no `deleted_at` filter) and binds the scale pairing to a dead lot. Fix: add `deleted_at IS NULL` / clear on claim.
- **A5-03** (med) — consume-mode UNDO re-add uses a bare `.insert()` with no `expires_on` → collides with `merge_key` (`ScannerPage.tsx:1561-1576`); test diverges by using `expires_on:'2099-12-30'`. Fix: upsert with `onConflict` + revive.

**CoachByte:**

- **EPLEY-1RM** (A2-06/B3-03/SEAM-MCP-04, med) — `shared/epley.ts:10` special-cases `reps===1 → load` while server SQL (`20260303030435:104-105`) and `app-tools/epley.ts:9` use `load*(1+reps/30)` for all reps → displayed 1RM disagrees with percentage-load resolution by ~3.3%. The SQL comment "formula gives same result" is false. Fix: pick one definition repo-wide (drop the `reps===1` special case or add it everywhere).
- **A2-04** (med) — `ensure_daily_plan` deletes the prior day's plan (incl. notes/summary/planned_sets) when it has 0 completed sets (`20260303030435:68-82`); intended for history hygiene but the count considers only `completed_sets`. Fix: also preserve rows with non-null notes/summary or any planned_sets.
- **A2-05** (med) — HistoryPage can show "No workout history yet" with no Load More when the newest 20 daily_plans are all empty (`HistoryPage.tsx:278-282,318-327,533`). Fix: filter empties server-side, or keep Load More in the empty-state branch when `hasMore`.
- **A2-08** (med) — SplitPage autosave can double-INSERT a fresh split → 23505 on `UNIQUE(user_id,weekday)`, dropping the later edit (`SplitPage.tsx:144-168,214-224`). Fix: upsert on `(user_id, weekday)` or guard the in-flight window.
- **update-plan non-atomic delete+insert** (MISSED-B3, med — arguably high) — `update-plan.ts:96-110` does `.delete().eq('plan_id')` then a separate `.insert()`; an insert failure leaves the plan with **all** planned_sets gone, no rollback. Fix: wrap in a single RPC transaction (mirror the split path).
- **A2-09** (low) — entering `0` for Default Rest / Bar Weight is coerced to 90/45 (`SettingsPage.tsx:182,202`). Fix: allow explicit 0 or validate with a clear message.
- **A2-10** (low) — `deleteCompletedSet` optimistic reopen matches by `exercise_name` and flips the wrong set; self-heals on invalidate (`TodayPage.tsx:885-896`). Fix: carry `planned_set_id` on `CompletedSet`.

**ChefByte recipes / macros:**

- **A4-03** (med) — `computeRecipeMacros` divisor `Math.max(baseServings,1)` vs DB `GREATEST(base_servings,0.001)` → fractional `base_servings` (reachable via MCP `create-recipe.ts:46`, no min-1) shows half the consumed macros (`RecipesPage.tsx:157`). Fix: use the actual `base_servings` (with a tiny floor like the DB).
- **A4-04** (med) — meal-prep `[MEAL]` product freezes **understated** nutrition when an ingredient is out of stock, yet still mints a full 1-container lot with only a transient toast (`20260430020000:165-220`, `MealPlanPage.tsx:560-571`). Fix: block/flag the freeze on partial stock, or stamp a persistent badge.
- **A4-05** (low) — MacroPage delete-consumed-item optimistic update doesn't patch `macros.consumed`, so bars/remaining stay stale while TOTAL updates (`MacroPage.tsx:365-369` vs editQty `446-457`). Fix: patch `macros.consumed` in delete `onMutate` like editQty.

**ChefByte scanner / inventory / livetrack:**

- **A3-03** (high→listed med here per finder rating; med) — `CHEFBYTE_below_min_stock` auto*add upserts the deficit without resetting `imported_at` → deficit lands on a hidden imported row, never reaching the To-Buy cart (`below-min-stock.ts:67-94`). The web path sets `imported_at:null`; the tool doesn't. Fix: add `imported_at:null` + reactivate `purchased=false` on the upsert. *(Borderline high; kept here to match finder severity.)\_
- **HomePage.syncMealPlanToCart** (MISSED-A3, low-conf med) — `HomePage.tsx:660-668` upsert sets `purchased:false` but not `imported_at:null`; same hidden-row class as A3-03. Fix: add `imported_at:null`.
- **A5-04** (med) — Web Scanner does **not** enforce `locked_mode` server-side; bypassable client-side and ignored on `scanner_state` read failure (`ScannerPage.tsx:1989,310-318,1228-1453`, `scannerStateApi.ts:72-74` returns null on any error → buttons enabled). Fix: enforce the lock inside `execute_scan_action`/edge path, fail-closed on read error.
- **A5-07** (med) — `chefbyte.void_scan_transaction` / `execute_scan_action` wrappers have **zero** in-SQL ownership check; only the edge SELECT-by-(user,txn) gates it (`20260503100250:27-37`, `shelf-ingest:2099-2112`). REVOKE blocks authenticated today, but no defense-in-depth. Fix: add `AND user_id = …` inside the private functions.
- **A6-02** (med) — LiveTrack AI-tare sends stale `product.net_weight_g`, ignoring the operator's edited Net wt field (`LiveTrackImportPage.tsx:712-721`); the confirm path correctly reads `nutrition.netWeightG`. Fix: read `state.nutrition.netWeightG` in `requestAiTare`.
- **A6-03** (med) — `apply_event_override` prior-effect back-out uses the **new** effective product's `net_weight_g`, corrupting stock when successive overrides pick different-weight products (`20260422040000_classifier_review.sql:149-188,270-288`); `event_overrides` doesn't store the chosen `product_id`. Fix: persist the applied `product_id`+weight and back out with the prior product's weight.
- **A6-04** (med) — `measured_full_at` set-once is enforced only in app code; no DB constraint/trigger despite the "THREE layers" comment (`20260502130000`, `EventViewerPage.tsx:515-527`); `restore_chefbyte_backup` can clobber it. Fix: add a BEFORE UPDATE trigger that blocks non-null→new-value transitions.
- **B1b(chef)-05 / B1b(chef) save_extension_credentials** (B1b(rls)-05, med) — `private.save_extension_credentials` raises 23505 on `secrets_name_idx` when the settings pointer is NULL but the canonical vault secret still exists (the transient state `clear_extension_credentials` creates) (`20260429160000:158-163` vs `263-271`). Fix: in the ELSE branch, `vault.create_secret` should upsert-by-name or the clear should delete the vault row before nulling the pointer.
- **B1b(rls)-06 api_keys cap race** (med) — `api_keys_enforce_max_active` uses a non-locking COUNT in a BEFORE INSERT trigger → concurrent inserts exceed the 10-key cap (`20260425050000:51-60`); verified live (11 keys). Fix: advisory lock on `user_id` or a serializing partial index.
- **B1b(rls)-07 consume_product_admin** (med) — callable by PUBLIC/authenticated with no self-guard → cross-user stock decrement + macro logging (`20260303050000:36-51`; PUBLIC restored by a later DROP/CREATE). Verified live. Fix: part of the H-5 REVOKE pass.
- **B2 invariant-monitor food_logs_per_day** (MISSED-B2, med) — the real defect at `analyze-product` sibling `invariant-monitor` lines 107-114 is a **false-negative**: >1000 food_logs in the window truncates the tail (no `.limit()`/`.order()`), and which 1000 rows return is nondeterministic. Fix: chunked pagination + `.order()`.
- **B2 livetrack-session handlePiUpdate** (MISSED-B2 note, med-low) — writes `body[key]` for allowed fields with no value validation → bad `state`/`scale_reading_g` → 500 → permanent Pi retry loop (`index.ts:299-323`). Fix: validate against the CHECK enum / numeric before update.
- **A5-05** (low) — `scan_transactions.logical_date` (web) computed in UTC ignoring day*start_hour (`ScannerPage.tsx:501`). Cosmetic (void keys off `applied_food_log_id`). Fix: use `todayStr`/server recompute. *(Part of TZ-CLIENT cluster.)\_
- **A5-06** (low) — WalmartTab "Load Next 5" fires 5 scrape calls in parallel with no client-side quota pre-gate (`WalmartTab.tsx:213-251`); server rate-limit caps spend. Fix: sequential loop that breaks on first quota hit.
- **A5-09** (low) — Web merged-purchase records `applied_lot_id=null` so Void can't reverse the added stock (`ScannerPage.tsx:718-733`). Documented but a real gap (opposite of H-11). Fix: persist a reversible delta for web merges.
- **A5-02** (low) — Pi-USB purchase with `unit='serving'` stores serving count as containers (no conversion) (`shelf-ingest:1375-1391`, purchase SQL ignores `p_unit`). Latent (no shipping caller sends serving+purchase). Fix: honor `p_unit` in the purchase branch / reject serving for purchase.
- **B1b(chef)-05 partial-place macro /gross** (B1b(chef)-05 + QTY-03, low) — partial-place macro logging divides consumed grams by `gross_weight_g` instead of `net_weight_g` → systematic undercount by the packaging fraction (`20260429180000:167-179` vs net-based paths `20260427130000:547,842`). Gated on `gross_weight_g IS NOT NULL` (all 3 prod products are NULL today). Fix: divide by `net_weight_g` for dimensional consistency.

**Hub:**

- **A1-HUB-01** (high→med here; the finder rated high) — Extension "Test connection" always 401s because the session JWT is never sent (`ExtensionCard.tsx:280` calls `probe(... { useStored })` with no `bearer`; worker requires `Authorization: Bearer` at `test-extension-creds.ts:179-181`). Zero test coverage. Fix: destructure `session` from `useAuth()` and pass `bearer: session.access_token`. _(Listed here as a paired root with the HA defect below; treat as High for triage.)_
- **HA `ha_token` key-name mismatch** (MISSED-A1, med) — even with A1-HUB-01 fixed, the worker probe reads `creds.ha_token` (`test-extension-creds.ts:116`) while handlers + the settings UI use `ha_api_key` (`ha-api.ts:11`, `ExtensionsPage.tsx:33`) → HA "Test connection" always returns "Base URL + token are required." Fix: read `ha_api_key` in the probe.
- **A1-HUB-02** (med) — `revoke_keys_on_logout` mitigation is fully unimplemented: dead column + unwired RPC, no UI toggle (`AuthProvider.tsx:132`, migration `20260424010000`). The "stolen laptop" mitigation never fires. Fix: wire `revokeAllMutation` into `signOut` when the column is true, and add a toggle.
- **A1-HUB-04** (low) — Voice Assist "Reset to Defaults" doesn't persist (no `mutate`), inconsistent with System Prompt reset (`AgentPage.tsx:145-150` vs `177-181`). Fix: call `saveVoiceAckMutation.mutate(defaults)`.
- **A1-HUB-05** (low) — OAuthConsent renders an empty dead-end card when the authorize call returns null data + null error (`OAuthConsent.tsx:42-49,131`). Fix: add an explicit error/fallback for the null/null branch.

**Realtime gate gaps (beyond H-20/H-21):**

- **RT-PGTAP-GAP** (B5-05 + RT-SEAM-03, med) — `realtime_publication_integrity.test.sql:41` `plan(21)` asserts only 17 of 23 subscribed tables; missing `recipes, recipe_ingredients, review_queue, scan_transactions, scanner_state, mcp_tool_logs`. Fix: add `ok()` blocks for all 6.
- **REGISTRY-MISLABEL** (B5-04 + MISSED-B5, med) — `queryKeys-invalidation-registry.ts:47-54` marks `mcpToolLogs` read-only with a FALSE reason (cites non-existent `mcp_tool_calls`, claims not-in-publication) while it IS published (`20260429140000:24`) and IS invalidated-by-realtime via `ExtensionCard.tsx:219-225`; the completeness gate then skips its evidence check. Fix: reclassify as invalidated-by-realtime and correct the table name.
- **RT-SEAM-04** (med) — integration round-trip realtime test covers only 6 of 23 tables (`subscriptions.test.ts`), so timer/set tables (`coachbyte.timers/planned_sets/completed_sets`) have no cheap-layer probe. Fix: extend the integration test to the full subscription set.

**Edge / MCP seam reads:**

- **SEAM-MCP-03** (med) — `CHEFBYTE_get_shopping_list` returns already-imported rows (no `imported_at IS NULL` filter) while the UI hides them (`get-shopping-list.ts:14-15` vs `ShoppingPage.tsx:96-101`). Same class the `get_products` handler fixed. Fix: add `.is('imported_at', null)`.
- **SEAM-MCP-05** (med) — `CHEFBYTE_add_stock` can attach a lot to **another** user's `product_id` (raw service-role insert, FK only checks existence, no ownership SELECT) (`add-stock.ts:66-82`). Fix: verify `product_id` belongs to `ctx.userId` before insert.

**Quantity / conversion seam:**

- **QTY-01** (med) — shopping qty rounded up only at **display**; stored + imported **verbatim**, so fractional stock silently differs from what the UI showed (`ShoppingPage.tsx:604-607` vs `20260425010000:115,119`). Violates "shopping quantities always rounded up." Fix: `Math.ceil` on write/import, or reject fractional qty at input + MCP.
- **QTY-02** (med) — no CHECK on `servings_per_container` (0 storable via shelf-ingest/MCP); "Add Serving" computes `1/0=Infinity` → `JSON.stringify(Infinity)='null'` → NOT NULL violation, button permanently broken (`ProductActionModal.tsx:147`). Fix: add `CHECK (servings_per_container > 0)` + validate in edge/MCP.
- **QTY-04** (low) — gram-unit recipe ingredients logged to `food_logs` as `unit='container'` (qty=grams/net), so MacroPage shows "0.3 ctn" for a 300g ingredient when `display_by_weight` is off (`20260429230000:125-142`, `MacroPage.tsx:783-794`). Fix: preserve the original `gram` unit through to the food_log display.

**Pi reconciler / cloud-sync (hardware/live-shelf):**

- **C1-01** (med) — reconciler weight-sanity sums post-claim events but compares to the **full** physical delta → spurious `weight_mismatch` reviews after fast-path in-flight consumption (`reconcile.py:456,766`). The `events` name is reassigned (drops claimed in-flight) but `expected_delta` uses final-initial. Fix: compute `actual_delta` over the **original** unfiltered event list.
- **C2-01** (med) — `lot_snapshot_poller` advances the watermark over a row whose `_apply_one` raised a sqlite error → permanent mirror drift / data loss (`lot_snapshot_poller.py:335-349`). Watermark bumped **before** apply; cloud filter is strict `>`. Reproduced permanent drift. Fix: only advance the watermark past rows that applied successfully.
- **C2-03** (med) — `weight_sync` G5 guard misses >1-Pi-lots→single-cloud-lot → **double** `live_weight_sync` emit with conflicting weights **every tick** (permanent flap) (`weight_sync_poller.py:362-405`). Fix: dedup shelf rows sharing a `cloud_lot_id` (collapse/skip-ambiguous on the Pi-lot dimension too).
- **C2-04** (med) — `event_overrides` batch with non-empty overrides but empty `lots[]` freezes the watermark **forever** (all-TRANSIENT early return at `:513-520` before the PERMANENT handling) (`event_overrides_poller.py:507-520`). Reproduced frozen watermark. Fix: run the per-override PERMANENT classification even when `lots` is empty.
- **C2-05** (med) — `lot_snapshot` `_find_pi_lot_for_cloud_lot` product-fallback flips an **arbitrary** in-flight lot when >1 exist (no ambiguity guard, unlike event_overrides G3) (`lot_snapshot_poller.py:676-692`). Mainly a legacy-data hazard (modern catch-all sets `pickup_event_id`). Fix: add a COUNT guard that refuses/defers when >1 candidate.
- **C3-01** (med) — `_row_to_lot` silently rewrites `shelf_id='single_item' → 'live_shelf'` on every read (set-once / round-trip corruption) (`repo.py:133`). Reproduced. Downstream blast radius latent (single_item never reaches the lots table today). Fix: add `'single_item'` to the read whitelist.
- **C2-02** (low, downgraded from med) — `pairings_sync` treats an unknown-kind cloud pairing as "removed" → false un-pair + in-flight lots flipped to "lost" (`pairings_sync_poller.py:280-285,373-399`). **Not reachable** today (cloud `scale_pairings.kind` CHECK + heartbeat `VALID_KINDS` + RPC validation forbid a 4th kind). Latent forward-compat hazard. Fix: skip-unknown should not imply removal; update `_kind_translate.py` whenever a cloud kind is added.

**Pi storage / barcode / branded-id (low):**

- **C5-2** (low) — BT-rebind watchdog arms baseline to the current (possibly already-rebound) inode while `device.fd` is the stale fd → an already-happened rebind is never detected (`hid_listener.py:144-151`). Compound rare race. Fix: re-stat and compare against the fd's real inode, not the path's current inode.
- **C5-3** (low) — branded-id UUID regex uses `re.match` with `$` (not `\Z`), accepting a trailing-newline UUID through the format check; downstream lookup fails-closed but misattributes the error to the DB table (`types_branded.py:53-56,94-95`). Unreachable in prod (callers use the un-validating NewType). Fix: `re.fullmatch` / anchor with `\Z`.
- **SEAM-01** (low) — reconciler main-path cloud emit hardcodes `kind='live_shelf'` while only the TTL-reaper sibling translates per-lot (`reconciler_repo.py:412` vs `:753-758`). Latent (single_item never creates reconciler lots). Fix: derive `kind` from `lot.shelf_id` in both emit paths.

**False-pass tests (no runtime bug, but they hide real ones — already counted in their clusters):**

- **A2-03** — `TodayPage.prDetection.test.tsx` mocks a fabricated `completed_set_id` (hides H-2). Fix in H-2.
- **B2-05** — `invariant-monitor/handler.test.ts:76-120` asserts a **local re-implementation** of `isServiceRoleAuthorized`, never the production guard (`index.ts:535,622`); mutating the real auth to `return true` stays green. Fix: export + import the real function.
- **TZ-TESTFALSE** (B5-02 + TZ-04) — `tz-dst-boundary.test.ts:41-81` tests a private in-file `getLogicalDate`, never the shipped `todayStr` (`dates.ts:20-26`); the production function has no `getLogicalDate` at all. Hides H-19. Fix: import and test `todayStr` (and pass it a tz).
- **C2-06** (low) — `cloud/invariants.py assert_payload_invariants` (documented "LAST defense" mirror-FK check) is **dead code**, never wired into emit/enqueue; tests exercise it in isolation (`invariants.py:51-80` vs `integration.py:418-491`). Fix: call it in `_enqueue` (the cloud_outbox boundary).
- **C2-07** (low) — `weight_sync` `CloudLotId(raw_lot_id)` "verification" is a NewType identity cast that can never raise; surrounding try/except is dead (`weight_sync_poller.py:630-644`, `types_branded.py:38`). Fix: call `parse_cloud_lot_id` if real verification is intended, or drop the misleading try/except + docstring.
- **QTY-05** (low) — `chefbyte-spec-claims.test.tsx:144-157` asserts `Math.ceil(1.1)===2` in the abstract; never exercises app code (hides QTY-01). Fix: assert against `ShoppingPage.formatQty` + stored qty.
- **SEAM-02** (low) — heartbeat single_item→live_scale kind-translation has no test against the real `_heartbeat_provider` closure; the test replicates the SQL into a copy (`app.py:2552-2556` vs `test_heartbeat_lots_payload.py:40`). Fix: extract the translation to a module-scope importable helper and test it.

**Extensions (low):**

- **B4-02** (med) — HA `inferDomain` restriction makes correctly-named devices in another allowed domain unresolvable; `'tv'/'speaker'` force `['media_player']` only, no cross-domain fallback (`ha-api.ts:67-74,104-134`). Fix: after the domain-filtered passes miss, retry unfiltered by exact friendly-name.
- **B4-03** (med) — Todoist list endpoints return only the first page (no cursor following) → silent truncation at ~50 for the morning-brief ledger (`get-tasks.ts:35-37` et al.). Fix: follow `next_cursor` in a loop.
- **B4-04** (low) — HA `entity_id` interpolated raw into the REST URL path (no `encodeURIComponent`); `isEntityId` accepts slashes (`ha-api.ts:36,48,61-65`). Self-targeted, low. Fix: `encodeURIComponent(entityId)`.
- **B4-05** (low) — `tv_remote` sends a junk `'UNKNOWN'` command to HA and reports success (`tv-remote.ts:71-72,104-108`); the single-word fallback also forwards arbitrary tokens (MISSED-B4). Fix: return `toolError` for unrecognized commands instead of a sentinel.
- **B4-06** (low) — `create_project` does two non-atomic commits; failure after the root commit leaves a half-created project, retry blocked by the existence probe (`create-project.ts:86-92`). Repairable via `update_project_note`. Fix: rollback the root file on commit-2 failure.
- **B4-07** (low) — `update_project_note` parses existing date headers without calendar validation; an impossible header (`2/30/26`) rolls over (`3/2/26`) and hijacks appends (`update-project-note.ts:118`). Conditional on malformed pre-existing data. Fix: round-trip-validate body-header dates like `parseMMDDYY`.

---

## Cross-cutting themes

- **T1 — Soft-delete tombstones are systematically mishandled on merge/revive.** After the G1 soft-delete model (`20260515010000`), `qty=0` became **ambiguous** (tombstone vs live-empty), and `stock_lots_merge_key` was never made partial on `deleted_at`. Result: **3 of ~5** merge writers (`import_shopping_to_inventory`, `add-stock` tool, `execute_scan_action` purchase) and **2 revive paths** (`resolve_add_to_shelf_lot` step-4, `live_scale` Tier-4) bump qty onto tombstones without clearing `deleted_at` → invisible/unspendable ghost stock. Only `InventoryPage` and `unmark_meal_done`'s restore do it correctly. **One structural fix (partial merge_key) + a shared "revive" helper** would close C-2, C-3, H-1, H-12, A5-03, and the live_scale lead at once.

- **T2 — PUBLIC EXECUTE leaks on `_admin` SECURITY DEFINER wrappers.** A `DROP/CREATE` (or original CREATE) that GRANTs only `service_role` but never `REVOKE … FROM PUBLIC` leaves the function callable by `authenticated`/`anon`; the inner `WHERE user_id = p_user_id` is **not** a barrier because the attacker passes the victim's own id. Confirmed on **6** functions (agent key/prompt/voice-ack, `complete_next_set_admin`, `consume_product_admin`, `add_to_shopping_admin`). One `REVOKE FROM PUBLIC` migration + in-body `auth.uid()` guards closes C-1, H-4, H-5, H-6, and the consume/voice-ack mediums.

- **T3 — MCP RPC handlers call `auth.uid()`-based public wrappers under a service-role client → `auth.uid()` is NULL.** Tools backed by an `_admin(p_user_id,…)` overload work; tools calling the plain wrapper (`import_shopping_to_inventory`, `save_recipe_ingredients`) are **100% broken via MCP**, masked by `isError`-convention tests that always error. Pattern: **every chefbyte mutation needs a `_admin(p_user_id,…)` overload** the handler calls with `ctx.userId`.

- **T4 — `auth.uid()`/profile-tz divergence between client and server day-boundary logic.** `todayStr` uses the **browser** tz and is written verbatim into `food_logs`/`scan_transactions`, while the Pi/MCP/edge use `get_logical_date(profile.tz)`. Macros, audit ledgers, and expiry dates split across days whenever browser tz ≠ profile tz near midnight. The "tz/DST" test that should catch this tests a private re-implementation.

- **T5 — Realtime publication safety net is hollow.** The drift script is broken (locale-sort) **and** unwired; the integrity pgTAP omits 6 subscribed tables; the completeness gate has a false opt-out (`recipe_ingredients`) and a mislabeled read-only (`mcpToolLogs`); the integration round-trip covers 6/23 tables. The 2026-04-27 food_logs regression class is **not** defended for ~17 tables — and the nightly drift workflow was just removed (`cdcb857`).

- **T6 — Non-atomic read-modify-write / two-round-trip "transactions".** Recurs across layers: analyze-product quota (H-7), shelf-ingest stock+audit (H-8), api_keys cap (B1b-06), `complete_next_set` concurrency (H-3), SplitPage autosave (A2-08), `update-plan` delete+insert (MISSED-B3), several Pi pollers advancing watermarks before/around a failing apply (C2-01/04). The walmart path is the **correct reference** (`INSERT…ON CONFLICT + FOR UPDATE + col=col+1`).

- **T7 — "Mock/re-implement the thing under test" false-passes in the exact layers this audit validates.** A2-03, B2-05, TZ-TESTFALSE, QTY-05, C2-06, C2-07, SEAM-02 all assert against in-file copies or builtins, never the shipped code — so the bugs they nominally cover ship green. The codebase already knows the fix (module-scope extraction rationale at `app.py:482-487`); it just wasn't applied consistently.

- **T8 — `[MEAL]` product identity is name-based, not id-based.** No UNIQUE on `products.name`, time-suffix naming in `generate_meal_product_name` vs bare-prefix reconstruction in `unmark_meal_done` → wrong-product deletion (H-10) with no recovery path and permanent orphans. The durable fix is to persist the chosen `product_id` on the meal entry.

---

## Coverage concerns (finders to re-run)

- **None under-delivered on volume** — every finder returned substantive, repro-backed findings, and the `MISSED-BY-FINDER` notes show the verification pass actively extended each domain rather than finding empty output.
- **A3 (chef-inventory) should be re-swept for merge writers**: the finder enumerated `import` and `add_stock` but **missed the `execute_scan_action` purchase merge (H-1)** — the most user-reachable ghost-stock path — and the `HomePage.syncMealPlanToCart` `imported_at` gap. A targeted re-run "find every writer that `INSERT … ON CONFLICT … DO UPDATE` or merges into `stock_lots` and check `deleted_at`/`imported_at` reset" would confirm the writer inventory is complete.
- **Platform-functions/RLS finder should re-run the PUBLIC-EXECUTE sweep**: it fixed/cited 5 functions but **missed `add_to_shopping_admin` (H-5)**. Re-run: enumerate **all** `*_admin(p_user_id,…)` SECURITY DEFINER functions and assert each has both a `REVOKE FROM PUBLIC` and an `auth.uid()` guard (the sweep found exactly 6 vulnerable; confirm none beyond those).
- **B2 (edge-functions) mis-characterized the `invariant-monitor` food_logs_per_day defect** (claimed false-positive; it's a false-negative/silent-incompleteness). Worth a re-confirm of direction before fixing.
- **C2 (pi-cloud-sync) over-stated C2-02 reachability** (downgraded med→low after confirming the cloud kind CHECK forbids the trigger). Re-rate any other "forward-compat" pi findings against the live cloud schema before assigning severity.

---

## Appendix — severity ledger

- **Critical (3):** C-1 (B1b(rls)-01), C-2 (GHOST-IMPORT: A3-01/B1b(chef)-03), C-3 (GHOST-ADDSTOCK: A3-02/B3-01).
- **High (23):** H-1…H-23 above (GHOST-SCAN, PR-DEAD, SET-DOUBLE, complete_next_set_admin, add_to_shopping_admin, agent system-prompt/voice-ack, analyze quota, shelf-ingest commit-order, heartbeat 500, UNMARK-WRONG, void-merge, resolve_add revive, PROFILE-CACHE, mark_meal_done over-tag, SSRF path-strip, invariant-monitor PGRST106, update_recipe MCP, import MCP, TZ-CLIENT, recipe_ingredients opt-out, drift-script, ScalesTab false-banner, complete_next_set validation).
- **Medium/Low (38):** see the grouped section (`medium_low_count = 38`).
