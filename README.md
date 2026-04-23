# Luna Hub Lite

A serverless personal AI assistant platform. Replaces a previous self-hosted Python/FastAPI/Docker stack with a fully serverless architecture: **Supabase + Vercel + Cloudflare Workers** — with a Raspberry Pi hardware demo for the fridge-shelf computer-vision pipeline.

Three modules live in a single React SPA deployed to Vercel. Each module has a dedicated MCP server surface so AI agents (Claude Desktop, custom agents) can read and write data alongside the browser UI.

---

## Modules

### ChefByte — Inventory, Meal Planning & Macro Tracking

Zero-friction pantry and fridge inventory powered by **weight + vision fusion**. A load-cell array under a fridge shelf captures weight deltas from every interaction; a camera identifies the item. Together they track what was used, how much is left, and when to reorder — without any manual scanning.

**Inventory**

- Lot-level stock keyed on `(product, location, expiration)` with nearest-expiration consumption order
- Grouped-by-product view with lot-detail toggle; color-coded stock levels; min-stock thresholds
- In-flight tracking: lots transition `on_shelf → in_flight → out` when items are picked up and returned. Amber badge + "(picked up)" label keeps the UI honest during the pickup window. TTL-expired pickups remove the whole lot — drift-tolerant by design.
- Live Shelf integration: Pi → `shelf-ingest` edge function → `apply_shelf_event` RPC → stock mutations. Cloud lot-snapshot poller keeps the Pi classifier cache in sync.

**Barcode Scanner** — 4 modes (Purchase / Consume+Macros / Consume-NoMacros / Add to Shopping). Unknown barcodes fall back to OpenFoodFacts + Claude Haiku 4.5 normalization with 4-4-9 calorie validation. 100 calls/user/day quota.

**Recipes** — Dynamic macro calc (ingredient sum × servings × servings_per_container). Stock status badges (CAN MAKE / PARTIAL / NO STOCK). Integrated filters: macro density, active time, cookable-now. Single create/edit page with inline ingredient editing.

**Meal Plan** — 7-day grid. Regular + meal-prep modes. `[MEAL]` lot creation on prep execution (named `[MEAL] Recipe MM-DD`, frozen nutrition, 7-day expiry). Undo reverses stock, deletes food logs, and removes the `[MEAL]` product.

**Macro Tracking** — Daily aggregates from `food_logs` + `temp_items`. Consumed + planned lists. 4-4-9 auto-calc on goal macros. Logical date boundary respects configurable `day_start_hour` — no more midnight-rollover edge cases.

**Shopping List** — Meal Plan → Cart sync (next 7 days, rounds up to whole containers). Below-min-stock auto-add. Toggle purchased. Import checked items directly to inventory.

**Walmart Price Manager** — SerpApi search (6 results/product). Walmart deep link generates a cart URL from the shopping list. One click → Walmart In-Home delivery into the fridge.

**LiveTrack Import Wizard** — Cloud-driven barcode → tare calibration wizard. Pi scans barcode, edge function normalizes the product, Pi reads tare weight, AI calculates net weight, saves `tare_weight_g`/`net_weight_g`/`certified` to the product catalog. State machine in `livetrack_import_sessions` synced between browser + Pi via Supabase Realtime.

---

### CoachByte — Workout Tracker

Sequential set completion with a DB-backed rest timer, PR tracking, and a weekly split template engine.

**Today** — Sets are completed in order. Plate breakdown auto-calculated from bar weight + available plates. Inline rep/load overrides. Ad-hoc set injection. Rest timer with pause/resume/reset (state machine in Postgres, synced via Realtime). PR toast on new Epley 1RM.

**History** — Keyset pagination newest-first. Exercise filter. Expandable day detail with timestamps and plate breakdown.

**Split** — 7-day (Sun–Sat) weekly template editor. Supports relative loads (% of 1RM) and absolute loads. Preset rest buttons (30/60/90/120 s). Per-day notes.

**PRs** — Epley 1RM cards per tracked exercise. Rep-range pills. 90-day default with "Load all history" toggle. Tracked-exercise search and management.

**Settings** — Default rest time. Plate calculator (bar weight + available plates config). Exercise library with global + user-custom exercises and search.

**MCP tools**: `get_today_plan`, `complete_next_set`, `log_set`, `update_plan`, `update_summary`, `get_history`, `get_split`, `update_split`, `set_timer`, `get_timer`, `pause_timer`, `resume_timer`, `reset_timer`, `get_prs`, `get_exercises`.

---

### Hub — Auth, Profile & Platform Management

- Email/password auth via Supabase Auth
- Profile: timezone, `day_start_hour` (logical day boundary for macro + workout date attribution)
- App activation/deactivation per module
- MCP API key management (SHA-256 hashed; scoped tool toggles per key)
- Extension settings: Obsidian vault, Todoist, Home Assistant

---

## Live Shelf (Hardware Demo)

`hardware/live-shelf/` — A Raspberry Pi 4 fridge-shelf scale that runs the ChefByte computer-vision pipeline locally.

```
ESP8266 + 4× HX711 load cells
        ↓  weight events (WiFi)
Raspberry Pi 4
  Flask server · OpenCV · SQLite
  Anthropic Sonnet vision classifier
        ↓  event decisions only (no video)
Supabase shelf-ingest edge function
        ↓
ChefByte inventory + macro logs
```

The Pi runs a local event pipeline: weight delta detection → brightness-gated session capture → frame selection → Sonnet classifier → cloud emit. Only product IDs and weight deltas reach the cloud — no frames, no video. A cloud-to-Pi lot-snapshot poller keeps the Pi classifier cache in sync after drift or offline periods.

**Scale variants:**
| Device | Hardware | Use case |
|--------|----------|----------|
| `live_shelf` | Pi + ESP8266 + 4× HX711 + camera | Multi-item fridge shelf tracking |
| `catch_all` | Wemos D1 Mini + 1× HX711 + camera | Countertop catch-all scale |
| `single_item` | ESP8266 + 1× HX711 | Per-product paired scale (scale-03) |

---

## MCP Server

Cloudflare Worker + Durable Objects at `mcp.lunahub.dev`. 41 tools across 5 namespaces:

| Namespace         | Tools                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `CHEFBYTE_*`      | 22 tools — inventory, products, recipes, meal plan, shopping, macros |
| `COACHBYTE_*`     | 15 tools — workouts, timer, split, PRs, history                      |
| `OBSIDIAN_*`      | 8 tools — Obsidian vault read/write                                  |
| `TODOIST_*`       | 8 tools — task CRUD                                                  |
| `HOMEASSISTANT_*` | 5 tools — device control, entity status                              |

Auth: API key (SHA-256) or OAuth 2.1. Every tool call is logged to `hub.mcp_tool_logs` for observability.

---

## Tech Stack

| Layer      | Technology                                                                        |
| ---------- | --------------------------------------------------------------------------------- |
| Frontend   | React 18 + TypeScript + Vite, TanStack Query v5, Tailwind CSS v4, React Router v6 |
| Backend    | Supabase (Postgres, Auth, Realtime, Edge Functions, Storage)                      |
| MCP Server | Cloudflare Workers + Durable Objects                                              |
| Hardware   | Raspberry Pi 4, ESP8266, Python 3.13, Flask, OpenCV, Anthropic SDK                |
| Deployment | Vercel (frontend), Cloudflare Workers (MCP), Supabase (DB + functions)            |
| Monorepo   | pnpm workspaces + Turborepo                                                       |

**Key architectural decisions:**

- All business logic is either simple CRUD via the Supabase client SDK or multi-step transactions via plpgsql `SECURITY DEFINER` functions in the `private` schema (never exposed via PostgREST).
- Day boundary: `private.get_logical_date()` computes logical date from `day_start_hour`. Stored on every date-sensitive row at insert time.
- RLS everywhere: `(select auth.uid()) = user_id TO authenticated` on all user-scoped tables.
- Realtime over polling: Supabase Realtime invalidates TanStack Query keys via `useRealtimeInvalidation` instead of refetching.
- Optimistic updates on all write-heavy flows (shopping list, set completion, timer).

---

## Repo Structure

```
apps/
  web/                  # React SPA — all modules, deployed to Vercel
  mcp-worker/           # Cloudflare Worker MCP server
packages/
  app-tools/            # MCP tool definitions + handlers
  db-types/             # Generated Supabase TypeScript types
  ui-kit/               # Shared layout components
supabase/
  migrations/           # All schema migrations
  functions/            # Edge functions (analyze-product, walmart-scrape, shelf-ingest, livetrack-session)
  tests/                # pgTAP test suites
hardware/
  live-shelf/           # Pi server, ESP8266 firmware, harness
extensions/
  obsidian/             # Obsidian vault tools
  todoist/              # Todoist integration
  home-assistant/       # Home Assistant integration
```

---

## Edge Functions

| Function            | Purpose                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze-product`   | OpenFoodFacts lookup + Claude Haiku 4.5 normalization + 4-4-9 calorie validation. 100/user/day.                                                           |
| `walmart-scrape`    | SerpApi Walmart search. Returns 6 results (price, URL, image) per product.                                                                                |
| `shelf-ingest`      | Pi → Supabase event ingestion. Routes: `/event`, `/catalog`, `/overrides`, `/lot-snapshot`, `/intake`, `/heartbeat`. Auth via `x-api-key` SHA-256 lookup. |
| `livetrack-session` | LiveTrack wizard state machine. Routes: `/create` (browser JWT), `/pi-update` (Pi key), `/active` (Pi).                                                   |

---

## Testing & Verification

**~1,600+ tests across 5 layers:**

| Layer      | Count | Tooling                      |
| ---------- | ----- | ---------------------------- |
| pgTAP (DB) | 774   | Supabase test runner         |
| Web unit   | ~270  | Vitest + Testing Library     |
| MCP worker | 82    | Vitest                       |
| App tools  | 131   | Vitest                       |
| Extensions | 100   | Vitest (72 mocked + 28 live) |
| Pi unit    | 253   | pytest                       |

**5 automated verification gates** (`.verify/<gate>.json`):

1. **Harness** — Pi↔cloud loopback runner. 14 scenarios covering all 6 event kinds, TTL reap, lot-snapshot reunite, wizard suppression.
2. **Impact** — `vitest --related` + `pytest-testmon` + scoped pgTAP for touched files only.
3. **Mutation** — Stryker (TypeScript, 3 configs) + mutmut (Python). 40% threshold.
4. **Drift** — Nightly schema AST diff vs linked Supabase. Opens a GitHub issue on material drift.
5. **Reviewer** — Mechanical script: parses JUnit XML vs commit message claims, flags mismatches.

CI runs lint + typecheck on every push. Integration tests run locally (`pnpm test`, `supabase test db`, `pnpm harness`).
