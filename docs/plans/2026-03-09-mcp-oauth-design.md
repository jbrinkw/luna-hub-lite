# MCP OAuth 2.1 via Supabase — Design

## Overview

Add OAuth 2.1 authentication to the MCP worker using Supabase as the authorization server. MCP clients (Claude Desktop, Cursor, etc.) connect via standard OAuth flow — user logs in with existing email/password, approves access on a consent page, and the client gets tokens. No manual OAuth app setup required.

## Architecture

```
MCP Client (Claude Desktop, Cursor, etc.)
  │
  │ 1. GET /.well-known/oauth-protected-resource
  ▼
CF Worker (mcp.lunahub.dev)
  │ Returns: { authorization_servers: ["https://btlfsxammjzkyluophgr.supabase.co/auth/v1"] }
  │
  │ 2. Client discovers Supabase auth endpoints via /.well-known/oauth-authorization-server
  │ 3. Client dynamically registers as public client (PKCE)
  │ 4. User logs in via Supabase Auth (email/password)
  │ 5. User approves on consent page (hosted in web app at /oauth/consent)
  │ 6. Client exchanges authorization code + PKCE verifier for tokens
  ▼
CF Worker validates Supabase JWT → creates DO session → SSE stream
```

## Components

### 1. Supabase Dashboard Config (manual)

- Enable OAuth 2.1 server in Authentication > OAuth Server
- Enable Dynamic Client Registration
- Set Authorization Path to `/oauth/consent`

### 2. Consent Page (apps/web)

New route: `/oauth/consent`

- Supabase redirects here with `authorization_id` query param
- Page calls `supabase.auth.getAuthorizationDetails(authorization_id)` to get client info + scopes
- Displays client name, redirect URI, requested scopes
- Approve button calls `supabase.auth.approveAuthorization(authorization_id)`
- Deny button calls `supabase.auth.denyAuthorization(authorization_id)`
- If user not logged in, redirect to login first then back to consent

### 3. CF Worker Changes (apps/mcp-worker)

**New endpoint:** `GET /.well-known/oauth-protected-resource`

```json
{
  "resource": "https://mcp.lunahub.dev",
  "authorization_servers": ["https://btlfsxammjzkyluophgr.supabase.co/auth/v1"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["openid", "email", "profile"]
}
```

**New auth path:** JWT validation

- Extract `Authorization: Bearer <token>` header
- Verify JWT signature against Supabase JWKS
- Extract `sub` claim as `userId`
- Feed into existing DO session flow

**Auth priority:**

1. Bearer token in Authorization header → JWT validation
2. sessionId query param → existing pre-auth DO lookup
3. apiKey in POST /auth body → existing API key hash lookup
4. apiKey query param → legacy (deprecated)

### 4. No DB Changes

OAuth tokens issued and managed by Supabase. Existing `hub.api_keys` table kept for backward compatibility.

## What stays the same

- Durable Object session management
- Tool registry, filtering, execution
- SSE protocol, JSON-RPC messages
- API key auth (fallback)
- Hub Settings MCP key management UI

## Scope exclusions

- No custom OAuth scopes (Supabase limitation — tool permissions via user_tool_config)
- No token refresh in worker (MCP clients refresh directly with Supabase)
- No changes to existing API key flow
