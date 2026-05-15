# Luna Hub Lite — Complete Feature List

## 1. Hub (`/hub/*`)

Account management, MCP control plane, extension settings.

### Account

- Email/password registration + login (Supabase Auth)
- Profile: display name, IANA timezone (searchable combobox), `day_start_hour` (drives every "today" calculation app-wide)
- Forgot-password flow → `/hub/reset-password` (public page, `updateUser` token)
- Session-expiration detection → amber toast on silent expiry
- App activation / deactivation toggles (CoachByte, ChefByte); deactivate = full RPC-driven data delete with confirm
- Offline indicator + "last synced" timestamp in header

### MCP Server Configuration

- Endpoint card: `https://mcp.lunahub.dev/mcp` (Streamable HTTP, legacy `/sse` still aliased for back-compat)
- API key management — show-once plaintext, SHA-256 stored, multiple keys, per-key revoke
- OAuth 2.1 consent page at `/oauth/consent`

### Tools

- All 65+ tools in collapsible groups (CoachByte, ChefByte, Obsidian, Todoist, Home Assistant)
- Search/filter, descriptions, per-user enable/disable toggles

### Extensions

- List + enable toggle + per-extension settings form
- Credentials stored in Supabase Vault (pgsodium); UI only sees a `vault_secret_id` pointer + boolean "configured" badge
- Save → `hub.save_extension_credentials` (vault.create_secret/update_secret); disable → `hub.clear_extension_credentials` deletes the vault row
- "Last 5 MCP calls" tail per extension card (reads `hub.mcp_tool_logs`, live via Realtime, click row to expand error/full tool name)

### AI Agent (`/hub/agent`)

- OpenAI-compatible `/v1/chat/completions` proxy (base URL `https://mcp.lunahub.dev/v1`)
- Stores Anthropic API key (pgcrypto-encrypted)
- Custom system prompt editor
- Voice Assist: filler phrase + delay (0–5000 ms) for HA Voice Preview streaming gaps

### Shared shell

- `AuthGuard`, `AppProvider` (TanStack-Query backed activations + profile + online/lastSynced/dayStartHour), `ModuleSwitcher` (filtered by activations), `OfflineIndicator`, per-module `ErrorBoundary`, `SkeletonScreen` primitives, 404 catch-all

---

## 2. CoachByte (`/coach/*`)

Strength-training copilot.

### Today

- Sequential set queue (enforced server-side via `complete_next_set`)
- Plate-breakdown rendering (`185 (45,25)`, `bar` when ≤ bar weight)
- Relative loads resolved against Epley 1RM PRs, both % and resolved lb stored
- Override reps/load on complete; inline validation
- Auto rest timer seeded from next set's rest duration
- PR toast notifications (Epley e1RM beat) — first-record + new-PR variants
- Inline-editable queued sets (reps/load/rest) saving on blur, Realtime suppressed during edit
- "+ Add Set" / per-set delete; two-click "Remove" confirm for completed sets
- Reset Plan (two-click confirm → cascade delete → re-bootstrap from split)
- Workout notes textarea + session summary (debounced save-on-blur)
- Ad-hoc set logging
- Offline = write buttons disabled

### Day Lifecycle

- `ensure_daily_plan` on first open: `private.get_logical_date()`, UNIQUE-constrained idempotent bootstrap, weekday split-template copy, PR-resolved weights (rounded to 5 lb / 2.5 kg)
- Empty-yesterday cleanup side-effect on bootstrap
- Split-edits apply forward only; intra-day PR changes don't retro-update existing plans

### Rest Timer

- DB state machine (`running/paused/expired`, `end_time`, `paused_at`, `duration_seconds`, `elapsed_before_pause`)
- Atomic-guarded transitions, exactly-once expiration via WHERE clauses
- Realtime row events only (no ticking), tab-focus recalc, MCP-readable/settable
- Manual start-custom / pause / resume / reset

### Weekly Split Planner

- 7-day collapsible grid (rest days collapsed by default)
- Per-day editable table: # / Exercise / Reps / Load / %1RM toggle / Rest (with 30/60/90/120 s presets) / delete
- Per-day split notes textarea, Add Exercise + Save per day

### PR Tracker

- All PRs derived from `completed_sets` (no separate PR table)
- Epley `load × (1 + reps/30)`, 1-rep uses raw weight, failed (0 reps) excluded
- 90-day filter default + "Load All History" toggle
- Tracked-exercise list persisted to `coachbyte.user_settings.pr_tracked_exercise_ids`
- Card per tracked exercise with e1RM + rep-range chips (`5 rep: 225 lb`)

### History

- Keyset paginated (`plan_date < cursor ORDER BY plan_date DESC LIMIT 20`)
- Empty-day filter, exercise-name filter dropdown
- Expandable day row → set list with `Intl` formatted dates/times
- Desktop table / mobile card responsive layouts, "Load More"

### Exercise Library

- Global seed on activation + per-user custom
- Case-insensitive uniqueness per user (`UNIQUE(user_id, LOWER(name))`)

### Settings

- Default rest duration, plate calculator (bar + plate sizes), exercise library CRUD (delete only on custom)

### MCP Tools (15)

`COACHBYTE_get_today_plan`, `complete_next_set`, `log_set`, `update_plan`, `update_summary`, `get_history`, `get_split`, `update_split`, `get_exercises`, `set_timer`, `get_timer`, `pause_timer`, `resume_timer`, `reset_timer`, `get_prs`

---

## 3. ChefByte (`/chef/*`)

AI nutrition, inventory, scanning, IoT scale integration.

### Dashboard / Home

- Macro day summary (Calories / Protein / Carbs / Fats progress bars vs goal)
- Today's Meals list, today's meal-prep items
- Status badges: Missing Walmart Links, Missing Prices, Placeholder Items, Below Min Stock, Cart Value, **Expired** counter (links to `/chef/inventory#expired`)
- Quick actions: Import Shopping List, Meal Plan → Cart, Taste Profile, Target Macros (modal w/ 4-4-9 auto-calc)

### Barcode Scanner (`/chef/scanner`)

- Physical USB/Bluetooth HID scanner via `useScannerDetection` (rapid-keystroke detection, auto-focus)
- 4 modes: **Purchase / Consume+Macros / Consume−NoMacros / Add to Shopping**
- Pipeline: local → OpenFoodFacts → Claude Haiku 4.5 normalization → placeholder fallback
- Per-user 100/day `analyze-product` quota; charged only on successful OFF (OFF 5xx returns `ai_degraded` w/o charge)
- Nutrition editor with 4-4-9 auto-scale, container/serving keypad toggle w/ server-side conversion
- Per-scan undo (rolls back stock/log/shopping side-effects)
- Red-border for new/unacknowledged scans
- Inline-editable product name (save on blur)
- Two-pass classification + auto-LiveTrack-certify wired through `chefbyte.scan_transactions`

### Pi USB Scanner Forwarder

- Pi forwards barcode + active mode to cloud; mode from `chefbyte.scanner_state` (or locked single-mode in Settings → Scanner)
- All scans (web + Pi) logged in `chefbyte.scan_transactions`; void in Settings → Scanner Transactions reverses the side-effect

### Inventory (`/chef/inventory`)

- Search w/ ilike pattern escape
- Grouped-by-product default: total containers, servings equivalent, nearest-expiration, lot count, min stock; color-coded stock (red/orange/green)
- Lot-view toggle
- Storage locations (Fridge/Pantry/Freezer); default location for adds, no selector in modal
- Lot merge: `(user_id, product_id, location_id, COALESCE(expires_on,'9999-12-31'))` ON CONFLICT (fix-merge migration `20260503120000`)
- Optional expiry date input on add; consume routes through `consume_product` w/ `p_log_macros: true`
- **Expired — discard section**: red-bordered top section, per-row "Log as discarded" / "Consumed anyway"
- Visual unit display (`2 eggs Cage-Free Eggs` instead of `2 svg ...`) — `visual_unit_label` + `visual_units_per_serving`, both-or-neither check, math untouched
- Placeholder products (`is_placeholder = true`) for planning
- Realtime on `stock_lots` + `products`

### Recipes

- FK-linked ingredients, qty + unit (serving/container)
- Macros computed dynamically per-query (no recompute job)
- Filters: Can Be Made, carbs/protein density thresholds, active/total time sliders, search — all on main page
- Stock status badges per card: CAN MAKE / PARTIAL / NO STOCK
- Create/edit single page with inline ingredient edit, live per-serving + total macros preview, zero-ingredient validation

### Meal Plan

- Day grid using `logical_date`; meal_type labels (breakfast/lunch/dinner/snack)
- Per-entry macros + day-total macros row
- **Regular mode**: Mark Done consumes ingredients + logs macros to entry's logical_date
- **Meal Prep mode**: Execute creates a `[MEAL] Recipe Name MM-DD` lot with frozen nutrition; macros log only when the `[MEAL]` lot is later consumed
- Toggle prep on existing entries
- `meal_plan.servings` acts as batch multiplier
- Product-based entries (recipe_id NULL, product_id set) supported in both modes
- **Unmark Done** (`private.unmark_meal_done`): reverses food_logs by meal_id, restores stock, deletes `[MEAL]` lot for prep entries

### Macro Tracking

- `private.get_daily_macros` single source of truth (food_logs + temp_items)
- Consumed-items table with TOTAL row, per-row delete
- Temp items (coffee, restaurant food)
- Target macros (4-4-9 auto-calorie), taste profile freeform textarea
- Realtime on `food_logs` + `temp_items`

### Shopping List

- Meal Plan → Cart: 7-day scan, container conversion, inventory subtract, round-up; placeholder flag
- Add Below Min Stock auto-add (subtracts existing list qty)
- Additive upsert (`UNIQUE(user_id, product_id)` + qty += excluded.qty)
- Clear All; Realtime on `shopping_list`
- "To Buy" / "Purchased" sections; **Import**: atomic `import_shopping_to_inventory(p_location_id)` stamps `imported_at` instead of delete; "Show imported items (7 days)" toggle
- Per-product Walmart cart links

### Walmart Price Manager

- SerpApi-backed `walmart-scrape` edge function (per-user rate-limited)
- Missing-links workflow (pick best match / "Not on Walmart")
- Missing-prices manual entry
- Refresh All Prices button, per-product custom URL input

### LiveTrack IoT Scales

- Devices: `live_shelf` (Pi rig), `catch_all` (catch-all scale on a Pi), `live_scale` (single-item scale)
- `chefbyte.scale_pairings` binds scale → product
- `shelf-ingest` edge function: `x-api-key` (SHA-256) → `apply_shelf_event` → `food_logs`
- `livetrack-session` edge function: pairing wizard lifecycle (browser JWT on `/create`, Pi `x-api-key` on `/pi-update`)
- Settings → Scales tab: device management, pairings, pending review count, heartbeat metrics
- **Catch-all auto-import** (two-pass classifier): pass-1 against certified+in-flight pool, pass-2 against uncertified inventory; pass-2 match auto-certifies (after successful cloud emit; gated on `tare_weight_g IS NOT NULL`)
- Tare estimation from visual + product metadata when missing
- **Calibration tag** in inventory: red (tare null), blue (tare set, full not measured), emerald (fully calibrated)
- `measured_full_at` stamp paths: programmatic (within 5 % of `tare + net_weight_g`) or manual ("Item is full" on `/chef/events`)
- Set-once tare + measured_full_at, manual UI edit always allowed
- Auto-tare-on-empty heuristic (capture when reading < 30 % of `net_weight_g`)
- Empty-lot revive on scale-03 wakeup, `in_flight_pickup` cloud sync, 6 h `in_flight` TTL reaper

### Backup & Restore (Settings → Backup)

- Wipe-and-replace export/restore JSON envelope (`luna-hub-chefbyte-backup-YYYY-MM-DD.json`)
- Scope: locations, products, stock_lots, recipes, recipe_ingredients, meal_plan_entries, food_logs, temp_items, shopping_list, user_config (PK UUIDs preserved)
- Excluded: shelf_event_log, event_overrides, livetrack_import_sessions, live_shelf_devices, scale_pairings
- Schema-version stamp + version-mismatch reject
- RPCs `chefbyte.export_chefbyte_backup()` / `restore_chefbyte_backup(jsonb)`, EXECUTE granted to `authenticated` only
- UI: consent checkbox gate, preview row counts, success panel w/ wipe + restore counts

### Settings tabs

Products / Walmart / Scales / Locations / Backup (deep-linkable via `?tab=`)

### MCP Tools (~30)

`CHEFBYTE_get_inventory`, `get_product_lots`, `add_stock`, `consume`, `get_products`, `create_product`, `update_product`, `delete_product`, `get_shopping_list`, `add_to_shopping`, `toggle_purchased`, `delete_shopping_item`, `clear_shopping`, `import_shopping_to_inventory`, `below_min_stock`, `get_meal_plan`, `add_meal`, `delete_meal_entry`, `mark_done`, (unwired: `unmark_done`), `get_recipes`, `get_cookable`, `create_recipe`, `update_recipe`, `delete_recipe`, `get_macros`, `log_temp_item`, `delete_temp_item`, `delete_food_log`, `set_price`

### Edge Functions

| Function            | Auth                                             | Purpose                                                          |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `walmart-scrape`    | Internal JWT validate                            | SerpApi Walmart search (≤6 results, price/URL/image)             |
| `shelf-ingest`      | `x-api-key` SHA-256 → `live_shelf_devices`       | Scale weight-delta ingest + server-side macro calc               |
| `livetrack-session` | JWT (browser) / x-api-key (Pi)                   | Pairing wizard session lifecycle                                 |
| `analyze-product`   | JWT (UI) or service-role + body.user_id (server) | OFF → Claude Haiku 4.5 normalize + 4-4-9 validate, 100/day quota |

---

## 4. Extensions (bundled in MCP Worker)

### Obsidian (`OBSIDIAN_*`, 8 tools)

GitHub-compatible Git API; credentials `github_token`, `github_repo`, `github_api_url`.

- `get_morning_brief` — pre-composed Morning Brief + goals + last 7 days of notes + accountability routine instructions
- `get_project_hierarchy` — simplified project tree
- `get_project_text` — root page + Notes.md for a project
- `get_notes_by_date_range` — dated entries in `[start, end]` MM/DD/YY, newest-first, optional project filter
- `update_project_note` — append content to dated note entry (defaults today, optional backdate, optional section)
- `patch_file` — sequential atomic find/replace patches on any vault file
- `create_project` — scaffold `<path>/<name>.md` + `<path>/Notes.md`, optional `parent_id` nesting
- `usage_guide` — primer (no-args), no credentials required

### Todoist (`TODOIST_*`, 8 tools)

REST API v2; credential `todoist_api_key`.

- `create_task`, `update_task`, `complete_task`, `get_task`, `get_tasks` (project_id / filter expression), `get_completed_tasks`, `get_projects`, `get_sections`

### Home Assistant (`HOMEASSISTANT_*`, 5 tools)

REST API; credentials `ha_api_key`, `ha_url`.

- `get_devices` — list controllable lights/switches/fans/media players
- `get_entity_status` — by entity_id or friendly name
- `turn_on` / `turn_off` — by entity_id or friendly name
- `tv_remote` — nav (up/down/left/right/ok/back/home), media (play/pause/stop/next/prev), volume (mute/up/down), app launch (youtube/netflix/spotify/disney)

---

## 5. MCP Worker (`mcp.lunahub.dev`)

- Cloudflare Worker, **stateless Streamable HTTP** (`POST /mcp`, legacy `POST /sse` aliased)
- Dual auth: API key (SHA-256) or OAuth 2.1
- Per-user tool toggles enforced at request time
- Observability via `hub.mcp_tool_logs` (action, duration, success/fail, error message), powers Hub extension cards
- Tool namespacing: `COACHBYTE_*` / `CHEFBYTE_*` / `OBSIDIAN_*` / `TODOIST_*` / `HOMEASSISTANT_*`
- CoachByte exercise tools accept case-insensitive name OR UUID (user-owned preferred over global)

---

## 6. Live Shelf (`hardware/live-shelf/`, separate stack)

Pi 4 + ESP8266 (4× HX711 load cells) + USB camera + Anthropic Sonnet classifier. **Not Supabase/Vercel** — Flask/SQLite local, LAN-only.

- Door sensor → session start; weight-delta events ingested per scale
- Multi-item pickup OK during open session; one-at-a-time return enforced by LED
- Reconciler pairs ADD/REMOVE events at close, updates stock, commits session
- Catch-all routing → `classify_catch_all_with_fallback` (two-pass: certified pool → uncertified pool, auto-certify path on pass-2 match, hallucination collapse to UNKNOWN, per-pass `classifier_prompt_prepared` lifecycle events)
- BT scanner watchdog: `select.poll()` + inode-rebind detection (`_POLL_TIMEOUT_MS = 2000`) recovers silent stale-fd after BT sleep/wake
- 7 cloud sync pollers: `product_sync`, `event_overrides`, `review_sync`, `lot_snapshot`, `pairings_sync`, `weight_sync`, `livetrack`
- In-flight pickup tracker w/ 6 h TTL reaper (`IN_FLIGHT_TTL_SECONDS=21600`)
- Tare-gated certify (`certified` push deferred when `tare_weight_g IS NULL`)
- Auto-tare-on-empty (reading < 30 % of `net_weight_g`)
- Per-session before/after photos + MP4 video, review queue UI
- Deploy via `~/.claude/skills/live-shelf-deploy/deploy.sh --restart <files>` / `--status` / `--logs`
- Phase 1 verification infrastructure (5 gates: harness, impact, review, mutation, drift) per `docs/VERIFY.md`

---

## Cross-cutting platform

- **DB schemas**: `hub`, `coachbyte`, `chefbyte`, `private` (all SECURITY DEFINER fns live here, `SET search_path = ''`)
- **Day boundary**: `private.get_logical_date()` stamped at insert on every date-sensitive row
- **Quantities**: NUMERIC(10,3) in DB, displayed to 1 decimal; stock canonical in containers; floor at 0; macros always logged for full consumed amount
- **RLS**: `(select auth.uid()) = user_id TO authenticated` everywhere; client mirrors filter
- **Realtime over polling**: timers, plans, macros, profile, shopping, stock_lots, products, food_logs (publication added 2026-04-27 after regression), temp_items
- **TanStack Query v5**: all server state; query keys in `src/shared/queryKeys.ts`; optimistic updates on shopping/inventory/meal-plan/products
- **Code splitting**: route modules + within-module pages lazy-loaded; vendor + Supabase chunks
- **Theme**: Material Dark across all modules (6 commits, 44 files)
- **Concurrency**: last-write-wins, no locks (single-user MVP)
