# Luna Hub Lite

Serverless refactor of the original self-hosted Luna Hub ecosystem. Replaces heavy Python/FastAPI/Docker services with a free-tier serverless stack: Supabase + Vercel + Cloudflare Workers.

## Execution Mode — Continuous Build

**Build the project continuously until completion or until stopped.** Do NOT ask questions — you have everything you need. On session start, read `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/MEMORY.md` and `current-task.md` to determine current phase and next action. Then:

1. If mid-task: resume from the exact stopping point in `current-task.md`
2. If idle: start the next phase in the Development Order (see MEMORY.md)
3. After completing a phase: immediately start the next one — do not stop to ask permission
4. Use the full skills chain per phase: brainstorm → writing-plans → subagent-driven-development → test-quality-review → verification → code-review
5. Commit after each phase, update `current-task.md` and `MEMORY.md`, then continue
6. If blocked on tests after reasonable debugging: ask the user. Otherwise, make the call and keep going.

**Do not pause between phases.** Do not ask clarifying questions. Do not present designs for approval. The specs in `docs/` + legacy code in `legacy/` + ASCII layouts in `docs/ascii-layouts.md` contain all the information needed. When in doubt, check the legacy code first (especially `legacy/chefbyte-vercel/` for ChefByte UI). Make autonomous decisions, flag them in `decisions.md`, and keep building.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite, Ionic React (UI components), React Router (path-based: `/hub/*`, `/coach/*`, `/chef/*`)
- **Backend:** Supabase (Postgres, Auth, Edge Functions, Realtime, Storage), schema-per-module (`hub`, `coachbyte`, `chefbyte`, `private`)
- **MCP Server:** Cloudflare Workers + Durable Objects at `mcp.lunahub.dev`
- **Monorepo:** pnpm workspaces + Turborepo

## Repo Structure

```
apps/web/              # Single Ionic React app (all modules), deployed to Vercel
packages/app-tools/    # MCP tool definitions + handlers (CoachByte + ChefByte)
packages/db-types/     # Generated Supabase TypeScript types
packages/ui-kit/       # Shared Ionic components (auth, layout, theme)
packages/config/       # Shared config (Supabase URLs)
supabase/              # Migrations, edge functions, seeds
extensions/            # Obsidian, Todoist, Home Assistant
apps/mcp-worker/       # Cloudflare Worker MCP server
docs/                  # Up-to-date specs (source of truth over spec-beta.md)
legacy/                # Old repos for reference (see below)
```

## What We're Building

**Phase 1 (now):** Hub app + ChefByte app + CoachByte app as a single Ionic React SPA, plus the MCP Worker with bundled extension tool integrations.

- **Hub** (`/hub`): Auth (email/password via Supabase), profile (timezone, day_start_hour), app activation/deactivation, MCP key management, tool toggles, extension settings UI
- **CoachByte** (`/coach`): Workout plans, sequential set completion, rest timer (DB state machine), weekly split planner, PR tracker (Epley 1RM), history with keyset pagination, exercise library
- **ChefByte** (`/chef`): Barcode scanner (4 modes), lot-based inventory (grouped-by-product default with nearest expiration), recipes (dynamic macro calc, integrated filters, single create/edit page), meal plan (regular + meal prep with `[MEAL]` lots), macro tracking, shopping list, Walmart price manager, LiquidTrack IoT

## Key Architecture Decisions

- **All business logic placement:** Simple CRUD via Supabase client SDK. Multi-step transactions via plpgsql SECURITY DEFINER functions in `private` schema. External APIs via Edge Functions. MCP tools via Cloudflare Worker → Supabase RPC.
- **Day boundary:** `private.get_logical_date()` computes logical_date from configurable `day_start_hour`. Stored on every date-sensitive row at insert time.
- **Quantities:** NUMERIC(10,3) in Postgres. Stock is canonical in containers and tracked at lot level (`product_id + location_id + expires_on`). UI displays containers by default; writes can be in containers or servings with server-side conversion via `servings_per_container`. Stock floors at 0. Macros always logged for full consumed amount regardless of stock.
- **RLS everywhere:** `(select auth.uid()) = user_id TO authenticated` on all tables. Client-side queries duplicate the filter.
- **Realtime over polling:** Supabase Realtime for timer updates, plan changes, macro totals, profile changes.
- **Desktop-first:** Ionic grid + CSS media queries. Mobile-optimized layouts deferred to post-MVP.

## Legacy Reference

The `legacy/` folder contains the old repos. Use these as reference — copy what fits but verify everything against the current spec.

- **`legacy/chefbyte-vercel/`** — Most important. Standalone React + Vite + Supabase ChefByte. **Match this UI as closely as possible** since the tech stack (React/Vite/Supabase) aligns. This is the most up-to-date ChefByte source.
- **`legacy/luna-ext-chefbyte/`** — Old Python ChefByte extension. **Only source for AI tools** (barcode analysis, OpenFoodFacts + LLM pipeline). Logic is reusable as reference but needs TypeScript rewrite.
- **`legacy/luna_ext_coachbyte/`** — Old Python CoachByte. DB schemas and logic are good reference. Try to match the look and functionality of the old ui with the new tech stack
- **`legacy/luna-hub/`** — Original Python Hub with FastAPI/LangChain. Architecture reference only — the Lite version is fundamentally different.


## Database Schemas

| Schema | Purpose |
|--------|---------|
| `hub` | User profiles (day_start_hour, timezone), app activation, MCP API keys (SHA-256 hashed), tool toggles, extension settings (Vault) |
| `coachbyte` | Exercises, daily logs, planned/completed sets, splits, PRs, timers |
| `chefbyte` | Products, stock, recipes, meal plans, shopping lists, macros, LiquidTrack device IDs/import keys |
| `private` | All SECURITY DEFINER functions, not exposed via PostgREST API |

## Edge Functions (Supabase, Deno/TypeScript)

- `analyze-product` — OpenFoodFacts lookup + Claude Haiku 4.5 normalization + 4-4-9 calorie validation. 100/user/day quota. Platform-paid LLM.
- `walmart-scrape` — Third-party scraper API for Walmart product data. Per-user rate limiting.
- `liquidtrack` — IoT scale ingestion. No JWT (`verify_jwt = false`), runtime lookup by device ID (one-time import key validated during provisioning).

## Documentation Rule

**Always update docs after making changes.** When you add, modify, or remove functionality — update the relevant file in `docs/` to reflect the change. This includes new pages, schema changes, new edge functions, changed behavior, or anything that makes the existing docs inaccurate. Docs must stay in sync with the code at all times.

## Test Quality Gate

After all implementation tasks in a test layer batch (pgTAP, unit, integration, or E2E) pass spec + code quality review, dispatch the `test-quality-review` skill (`~/.claude/skills/test-quality-review/`) before marking the batch complete. The reviewer mentally traces each test: "if I broke the feature, would this test fail?" Catches false positives, weak assertions, tautologies, and coverage gaps. See `reviewer-prompt.md` in the skill directory for the full per-layer checklist.

## Conventions

- Tool namespacing: `COACHBYTE_*`, `CHEFBYTE_*`, `OBSIDIAN_*`, `TODOIST_*`, `HOMEASSISTANT_*`
- All MCP tools reference entities by UUID, never by name
- Tool errors: `isError: true` with descriptive message
- DB functions: `private` schema, SECURITY DEFINER, `SET search_path = ''`
- Auth: Supabase Auth (email/password), MCP auth via API key (SHA-256) or OAuth 2.1
- No offline data caching. Service worker caches app shell only. Offline = disabled write buttons + indicator.
- Quantities displayed to 1 decimal in UI, stored to 3 decimals in DB
- Shopping quantities always rounded up to whole containers
- `last-write-wins` concurrency — no locking, acceptable for single-user MVP

## When Copying from Legacy

1. **ChefByte UI** — The `legacy/chefbyte-vercel/apps/web/` React components can be closely matched. Same React + Supabase stack. Check component patterns, hooks, and Supabase queries. Adapt to Ionic React components where appropriate.
2. **ChefByte AI pipeline** — `legacy/luna-ext-chefbyte/` has the barcode → OpenFoodFacts → LLM pipeline in Python. Rewrite to TypeScript for Supabase Edge Functions. Switch from GPT-4/OpenAI to Claude Haiku 4.5/Anthropic SDK.
3. **CoachByte DB logic** — `legacy/luna_ext_coachbyte/` has Postgres schemas and Python service logic. Port DB functions to plpgsql, build UI fresh from `docs/ascii-layouts.md`.
4. **Always verify** — Legacy code may have patterns that conflict with the current spec (different unit systems, different auth, different state management). The docs are the source of truth.
