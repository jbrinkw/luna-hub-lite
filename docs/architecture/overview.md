# Architecture Overview

## Design Principles

1. **Zero always-on compute.** No supervisors, no Express servers, no background threads. Serverless everywhere.
2. **Single identity.** One Luna Hub account works across all app modules. Email/password authentication via Supabase Auth.
3. **Per-user isolation.** Every table has `user_id`. Row Level Security enforces access at the database level.
4. **Connectivity required.** All writes go to the server. No offline queue or conflict resolution. The UI communicates connectivity state clearly — offline indicators, disabled write buttons, "last synced" timestamps. Service workers cache app shell assets only for fast loads.
5. **Desktop-first, mobile-ready.** Built as a responsive web app with Ionic React. MVP targets desktop browsers. The architecture and component choices (Ionic + Capacitor abstraction points) ensure mobile and native app support can be added later without rewriting app code, but mobile-optimized layouts and native features (background notifications, camera scanning, etc.) are deferred to a post-MVP phase.
6. **Modular by convention.** App modules and extensions follow a consistent folder structure. Full app modules live in `apps/`, lightweight tool integrations live in `extensions/`. All tools aggregate into a single MCP server.
7. **AI client as integration layer.** Cross-app data access is available through MCP tools. An AI agent connected via MCP can query both CoachByte and ChefByte tools in the same conversation. No cross-app schema or UI integration exists at launch.
8. **One MCP endpoint for everything.** The Hub MCP server is a single gateway — it exposes CoachByte tools, ChefByte tools, and extension tools. External clients connect once and get access to everything the user has enabled.
9. **Shared day boundary.** All app modules use the same configurable `day_start_hour` (default 6 AM) from the user's hub profile. Day boundaries are computed by a single PostgreSQL function and stored as `logical_date` on every date-sensitive row at insert time.
10. **Last-write-wins concurrency.** The phone UI and MCP agent may modify data simultaneously. No locking is implemented. Each database operation is designed to be reasonable under concurrent writes, but no conflict detection or resolution exists. This is acceptable for single-user MVP.

## Frontend (Single App Shell)

| Concern       | Choice                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | React + TypeScript + Vite                                                                                                                                                                    |
| UI Library    | Ionic React (platform-adaptive components, Capacitor-ready for future native)                                                                                                                |
| Styling       | Ionic theming + CSS variables for per-module branding                                                                                                                                        |
| Routing       | React Router with path-based module routing (`/hub/*`, `/coach/*`, `/chef/*`)                                                                                                                |
| State         | React hooks + Supabase client SDK subscriptions                                                                                                                                              |
| Real-Time     | Supabase Realtime (Postgres change subscriptions filtered by `user_id`, additional filtering client-side)                                                                                    |
| PWA           | Single service worker (app shell caching only — no data caching or offline data access) + single web manifest                                                                                |
| Layout        | Desktop-first responsive design using Ionic grid + CSS media queries. Multi-column layouts on wide screens, single-column stacking on narrow. Mobile-optimized layouts deferred to post-MVP. |
| Future Native | Capacitor wrapping deferred to post-MVP (adds native plugins, no app code changes)                                                                                                           |

## Backend (Shared)

| Concern               | Choice                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database              | Supabase PostgreSQL (single project, schema-per-module: `hub`, `coachbyte`, `chefbyte`, `private`)                                                      |
| Auth                  | Supabase Auth (email/password, single origin — no cross-subdomain cookie issues)                                                                        |
| Serverless Functions  | Supabase Edge Functions (Deno/TypeScript) for anything needing secrets or external APIs                                                                 |
| Database Functions    | plpgsql for multi-step business logic that is purely data operations. All SECURITY DEFINER functions in a `private` schema with `SET search_path = ''`. |
| File Storage          | Supabase Storage (recipe photos, profile images — future)                                                                                               |
| Real-Time Engine      | Supabase Realtime (Postgres changes broadcast to subscribed clients)                                                                                    |
| Secrets Management    | Supabase Vault (pgsodium) for extension credentials                                                                                                     |
| Observability         | Platform-native dashboards (Cloudflare Workers analytics, Supabase logs, Vercel logs)                                                                   |
| Connection Management | All serverless connections route through Supavisor (port 6543, transaction mode)                                                                        |

## MCP Server

| Concern                 | Choice                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting                 | Cloudflare Workers with Durable Objects (serverless)                                                                                                                                                                                         |
| Transport               | Server-Sent Events (SSE)                                                                                                                                                                                                                     |
| Auth (primary)          | API key per user — stored as SHA-256 hash, validated with constant-time comparison                                                                                                                                                           |
| Auth (secondary)        | OAuth 2.1 flow with PKCE required for all clients, 24-hour token expiry, no server-side refresh — for MCP clients that require OAuth                                                                                                         |
| Auth (to database)      | Service role key via Supavisor — MCP auth verifies user identity first, then tool calls execute via SECURITY DEFINER functions with explicit user_id parameter. Each function asserts the passed user_id matches the authenticated identity. |
| Tool sources            | App tools (CoachByte, ChefByte) and extension tools                                                                                                                                                                                          |
| Tool scope              | Per-user — each user enables/disables tools in their Hub settings                                                                                                                                                                            |
| Durable Objects purpose | Maintaining OAuth session context per connected MCP client. Tool calls are stateless request-response.                                                                                                                                       |
| Remote MCP proxying     | **Deferred.** Not included at launch. Future feature.                                                                                                                                                                                        |

## Monorepo

| Concern           | Choice                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Workspace Manager | pnpm workspaces + Turborepo                                                                                         |
| Shared Packages   | Supabase client config, TypeScript types (auto-generated from DB schema), shared Ionic theme/layout/auth components |

### Convention: App Modules vs Extensions

**App modules** have their own database schema, UI pages (within the single app shell), and optionally edge functions. CoachByte and ChefByte are app modules. They contribute MCP tools via their `tools/` folder. Tool definitions and handlers live in separate workspace packages so the MCP Worker can import them at build time without pulling in UI code.

**Extensions** are lightweight tool-only integrations with no UI pages. Obsidian, Todoist, and Home Assistant are extensions. An extension's `config.json` declares its metadata and required secrets.

Both app modules and extensions contribute tools to the single MCP server. The Worker imports tool definitions explicitly at build time — no runtime autodiscovery.
