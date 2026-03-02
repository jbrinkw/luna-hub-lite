# Phase 09a: MCP Worker — Core + Auth
> Previous: phase-08.md | Next: phase-09b.md

## Skills
test-driven-development, context7 (Cloudflare Workers, MCP SDK, Supabase, Durable Objects)

## Build
- `apps/mcp-worker/src/index.ts` — Worker entry point, SSE transport at `/sse` endpoint
- `apps/mcp-worker/src/auth/api-key.ts` — API key authentication middleware:
  - Accept key via Authorization header (Bearer scheme)
  - SHA-256 hash the provided key
  - Lookup hash in `hub.api_keys` via Supabase RPC (service_role)
  - Verify revoked_at IS NULL
  - Use `timingSafeEqual` for hash comparison
  - Return resolved user_id on success, 401 on failure
- `apps/mcp-worker/src/auth/oauth.ts` — OAuth 2.1 PKCE flow:
  - Authorization endpoint: generate auth code, store code_challenge
  - Token endpoint: validate code_verifier against stored code_challenge (S256)
  - Access token with 24h expiry
  - No server-side refresh tokens (client re-authorizes)
  - Auth code expires after 10 minutes
- `apps/mcp-worker/src/session/McpSession.ts` — Durable Object:
  - Per-connected-client session context for OAuth
  - SQLite persistence for session state (no shutdown hook available)
  - State written on every mutation
- `apps/mcp-worker/src/tools/registry.ts` — Tool registry:
  - Load per-user tool config from `hub.user_tool_config` via Supabase RPC
  - Filter tools by enabled state
  - Deactivated app module removes all its namespaced tools
  - Return filtered tool list to client on connection
- `apps/mcp-worker/src/tools/dispatch.ts` — Tool dispatch framework:
  - Route tool name to correct handler
  - Unknown tool -> `{isError: true, content: "Unknown tool: <name>"}`
  - Disabled tool -> `{isError: true, content: "Tool disabled: <name>"}`
  - Handler exception -> `{isError: true, content: error.message}`
- `apps/mcp-worker/src/supabase.ts` — Supabase RPC client (service_role key, Supavisor connection)
- `apps/mcp-worker/wrangler.toml` — Worker + Durable Object bindings
- `apps/mcp-worker/vitest.config.ts` — `@cloudflare/vitest-pool-workers` config

## Test (TDD)

### Unit: `apps/mcp-worker/src/__tests__/auth.test.ts`
- Valid API key -> accepted, returns resolved user_id
- Invalid API key (no matching hash) -> rejected with 401
- Revoked API key (revoked_at IS NOT NULL) -> rejected with 401
- timingSafeEqual used for comparison (verify via mock/spy)
- Missing Authorization header -> rejected with 401
- Malformed Bearer token -> rejected with 401

### Unit: `apps/mcp-worker/src/__tests__/tool-dispatch.test.ts`
- Known tool name -> correct handler function invoked with arguments
- Handler returns structured result -> result passed through to caller
- Unknown tool name -> returns `{isError: true, content: "Unknown tool: foo"}`
- Disabled tool name -> returns `{isError: true, content: "Tool disabled: bar"}`
- Handler throws exception -> returns `{isError: true, content: error.message}`
- Handler returns isError:true -> passed through unchanged

### Unit: `apps/mcp-worker/src/__tests__/tool-registry.test.ts`
- Loads user config from mock Supabase -> returns enabled tools only
- Disabled tool excluded from tool list
- Deactivated app (e.g., CoachByte) removes all COACHBYTE_* tools from list
- Both apps active -> all app tools present
- No user config -> returns default tool set (all enabled)

### Unit: `apps/mcp-worker/src/__tests__/oauth.test.ts`
- Authorization request with code_challenge -> returns auth code
- Code exchange with valid code_verifier (SHA256 matches challenge) -> returns access token with 24h expiry
- Code exchange with wrong code_verifier -> rejected with error
- Expired auth code (>10 minutes) -> rejected with error
- Expired access token (>24 hours) -> rejected with error
- Token contains user_id claim
- PKCE method must be S256 (plain rejected)

### Integration: `apps/mcp-worker/src/__tests__/sse-connection.test.ts`
- SSE connection with valid API key -> receives tool list in initial message
- SSE connection with invalid API key -> 401 response (no SSE stream)
- SSE connection with revoked API key -> 401 response
- Tool list matches user's enabled tools from config

## Legacy Reference
- `legacy/luna-hub/core/utils/mcp_server.py` — FastMCP server pattern, tool registration
- `legacy/luna-hub/core/utils/auth_service.py` — OAuth flow reference (different impl, concepts apply)
- `legacy/luna-hub/core/utils/agent_api.py` — API key generation and validation patterns

## Commit
`feat: MCP worker core + auth`

## Acceptance
- [ ] SSE transport at /sse endpoint accepts connections and streams tool list
- [ ] API key auth: SHA-256 hash lookup + timingSafeEqual + revocation check
- [ ] OAuth 2.1 PKCE: auth code -> token exchange with S256 verifier, 24h expiry
- [ ] Tool registry loads per-user config and filters disabled/deactivated tools
- [ ] Tool dispatch routes to handlers, returns structured errors for unknown/disabled/failed tools
- [ ] Durable Object persists session state to SQLite on every write
- [ ] All MCP worker tests pass: `pnpm --filter mcp-worker test`
- [ ] `pnpm typecheck` passes
