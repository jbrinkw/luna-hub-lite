# Infrastructure: Authentication, Security & Realtime

## Auth Flow

Users create an account at `lunahub.dev` using email/password via Supabase Auth. Since all app modules share a single origin, authentication is straightforward — one session, one cookie, no cross-subdomain configuration needed.

A database trigger on `auth.users` INSERT automatically creates a `hub.profiles` row with defaults (`day_start_hour = 6`, timezone from signup metadata or `America/New_York`).

## App Activation & Deactivation

Signing up creates a Luna Hub account and a hub profile. Each app module (CoachByte, ChefByte) requires explicit activation by the user. Activation runs a per-user bootstrap seed transaction (e.g., populating the global exercise library for CoachByte, default units for ChefByte).

Deactivation requires explicit confirmation in the UI. It performs a full delete of the user's data in that module's schema via a single RPC call. Reactivation starts fresh with a clean seed. Cross-app features gracefully degrade when the companion module isn't activated — MCP tools return empty/null, UI shows a call-to-action to activate.

## MCP Authentication

External MCP clients authenticate with the Hub's MCP server via two supported methods:

**API key (primary, recommended):** Users generate API keys in the Hub UI. The plaintext key is displayed once at creation time in a copy-able modal — after dismissal, only the SHA-256 hash is stored and the plaintext cannot be retrieved. If a user loses a key, they revoke it and generate a new one. Users can have multiple active API keys. MCP clients pass the key as a bearer token. The Worker validates against the hash using constant-time comparison and resolves the associated user_id. Revocation invalidates the hash — active MCP sessions using a revoked key fail on the next tool call. This is the recommended method for persistent MCP connections (Claude Desktop, Cursor, etc.) because keys do not expire unless revoked.

**OAuth 2.1 flow (secondary):** PKCE is required for all clients (no implicit flow). Exact redirect URI matching enforced. The MCP client initiates an OAuth authorization against Luna Hub's Supabase Auth. The Cloudflare Worker validates the resulting token and extracts the user identity. Access tokens expire after 24 hours (extended from default). If the token expires, the client must re-authenticate — the Worker does not perform server-side token refresh. This is supported for MCP clients that require OAuth.

Once user identity is verified via either method, tool calls execute using Supabase's service role key (via Supavisor transaction mode) with the authenticated `user_id` passed as an explicit parameter to `SECURITY DEFINER` functions in the `private` schema. The MCP auth layer is the security gate — no unauthenticated request reaches the database.

The frontend app uses the Supabase client SDK with standard RLS. The service role key pattern is only for the MCP server path. The frontend catches 401 responses globally and shows a non-blocking re-auth modal that preserves current UI state.

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Transport | HTTPS everywhere (Vercel, Supabase, Cloudflare all enforce) |
| Frontend Auth | Supabase Auth with PKCE flow, single origin (no cross-subdomain issues) |
| Frontend Data Access | RLS on every table, `(select auth.uid()) = user_id TO authenticated` |
| MCP Auth | API key (SHA-256, primary) or OAuth 2.1 with PKCE (24h expiry, secondary) — verified before any tool execution |
| MCP Data Access | Service role key via Supavisor + SECURITY DEFINER functions in `private` schema with `SET search_path = ''` and explicit `user_id` parameter assertion |
| MCP Tool Scoping | Tools only call validated RPC functions, never raw SQL — mitigates prompt injection data exfiltration |
| Device Auth | LiquidTrack provisioning validates a one-time device key (stored hashed). Runtime events are accepted by device ID lookup (MVP simplification), with JWT verification disabled on IoT endpoint |
| Extension Credentials | Supabase Vault (pgsodium) per user, accessed via `private` schema RPC |
| Secrets | Vercel env vars + Supabase dashboard + Cloudflare Worker secrets (never in client code) |
| XSS Prevention | Strict Content Security Policy headers (`script-src 'self'` minimum) on all pages |
| CSRF | SameSite=Lax cookies + CSRF tokens |
| Walmart Rate Limiting | Per-user request quota with queuing in edge function |
| LLM Rate Limiting | Per-user daily quota (100 scans/day) on analyze-product |

## Realtime Infrastructure

Supabase Realtime replaces all polling. Clients subscribe to Postgres changes filtered by `user_id`. Additional filtering (e.g., by date, log, or active timer) is applied client-side. This is the simplest approach and sufficient for MVP scale.

**Future optimization:** For high-frequency events (timer updates), switch to Broadcast channels to avoid per-subscriber RLS evaluation. For scoped subscriptions, subscribe to specific row IDs instead of broad table-level changes.

| Channel | Module | What Triggers | Purpose |
|---------|--------|--------------|---------|
| Timer updates | CoachByte | CoachByte `timer` row INSERT/UPDATE | Client receives new `end_time`, starts local countdown |
| Plan updates | CoachByte | CoachByte `planned_sets` or `completed_sets` changes | UI reflects sets completed by MCP agent or another device |
| Macro totals | ChefByte | ChefByte `meal_plan` done status changes, `temp_items` inserts | Dashboard updates when meals are logged |
| Profile changes | Hub | Hub `profiles` UPDATE | `day_start_hour` or timezone changes propagate to all modules without page refresh |

### Timer Precision Model

The database stores `end_time` (timestamptz) when a timer is set. The client receives this via Realtime subscription, calculates the remaining seconds, and renders its own local countdown. Realtime only fires when a **new timer is set** — not every tick. Timer accuracy depends on client clock accuracy — no server-side time sync is performed.

### Realtime Scaling Notes

Free tier: 200 concurrent connections, 100 messages/second. At MVP scale (1-10 users), well within limits. Scaling trigger: Supabase Pro ($25/month) at 50+ concurrent users.

The `supabase-js` client auto-reconnects on disconnect. Join refusals (`too_many_channels`, `too_many_connections`) are handled with manual retry and exponential backoff. When Realtime delivers truncated payloads (fields >64 bytes), the client re-fetches the full row via the API.

### Realtime + MCP Tool Call Race Condition

When the MCP server writes data (e.g., completing a set), the Realtime notification may arrive before or after the MCP response reaches the AI client. Both the Realtime handler and any response handlers are idempotent — the UI deduplicates updates using the row's primary key.
