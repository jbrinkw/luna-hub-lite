# MCP Server & Extension System

## Architecture

The MCP server is a single Cloudflare Worker deployed at `mcp.lunahub.dev`.

**Primary transport: Streamable HTTP** at `POST /mcp`. Fully stateless — no Durable Objects. Each request authenticates via Bearer token, builds the user's tool list inline, processes the JSON-RPC message, and returns a JSON response. Session IDs (`Mcp-Session-Id` header) are protocol formalities with no server-side state.

**Legacy transport: SSE** at `GET /sse`. Uses Durable Objects for session state. Still functional but not recommended — each SSE reconnect creates a new Durable Object that burns DO duration billing. MCP clients that maintain persistent SSE connections (like Claude.ai) will accumulate significant DO costs on this transport.

Remote MCP server proxying is **not included at launch**. The MCP server exposes local tools only (CoachByte, ChefByte, extensions).

## Tool Sources

The Worker aggregates tools from two sources:

1. **App tools** — CoachByte and ChefByte tool definitions imported at build time. Handlers call Supabase database functions via RPC using the service role key through Supavisor.

2. **Extension tools** — Tool definitions imported from `extensions/{name}/tools/`. Handlers make direct API calls to external services using credentials retrieved from Supabase Vault via a `private.get_extension_credentials(p_user_id, p_extension_name)` SECURITY DEFINER function called through Supabase RPC.

## Tool Namespacing

All tools are namespaced by source:

- App tools: `COACHBYTE_`, `CHEFBYTE_`
- Extension tools: `OBSIDIAN_`, `TODOIST_`, `HOMEASSISTANT_`

All tools reference entities by UUID primary keys, never by name or barcode.

## Tool Error Contract

All tool handlers return structured responses. On failure, tools return `isError: true` with content describing the failure (e.g., "No remaining sets in today's plan", "Insufficient stock for this product"). The AI client reads structured errors and communicates them naturally to the user.

MVP note: mutating tools do **not** use idempotency keys yet. If a network timeout occurs and write status is unknown, the tool returns an error instructing the client to refresh state before retrying.

## Tool Schema Loading

MCP clients load tool schemas fresh on each connection. Tool schema changes take effect on the next client connection — no versioning or migration needed.

## Per-User Tool Configuration

Each user has a tool configuration stored in `hub.user_tool_config`. When an MCP client connects, the Worker loads that user's enabled tools and only exposes those in the tool listing. Users manage their tool toggles in the Hub UI. When a user deactivates an app module, that module's tools disappear from the tool listing on the next MCP client connection. In-flight tool calls complete normally.

**Extension enabled filtering:** Extension tools are only included in the `tools/list` response if the extension is enabled in `hub.extension_settings` (checked via the `enabled` boolean). Individual extension tools can also be disabled via `user_tool_config`. Both checks must pass for an extension tool to appear.

## Subrequest Budget

A typical app tool call uses 1-3 Supabase RPC subrequests. Extension tool calls use 2-4 (auth check + Vault credentials RPC + external API + optional write). The Workers free tier limit of 50 subrequests per invocation is sufficient.

## Additional MCP Protocol Methods

The Worker handles the following standard MCP protocol methods beyond `initialize` and `tools/list`:

| Method                      | Response                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| `ping`                      | Returns empty object `{}` — used for connection health checks                   |
| `resources/list`            | Returns `{ resources: [] }` — no resources exposed (placeholder for future use) |
| `prompts/list`              | Returns `{ prompts: [] }` — no prompts exposed (placeholder for future use)     |
| `notifications/initialized` | Returns HTTP 202 — acknowledges client initialization notification              |

---

## Extension System

### Extension Structure

Extensions are lightweight, tool-only integrations that live in `extensions/{name}/`:

```
extensions/{name}/
├── tools/
│   ├── index.ts
│   └── {tool_name}.ts
└── config.json
```

### Extension Manifest (`config.json`)

```json
{
  "name": "obsidian",
  "display_name": "Obsidian",
  "description": "Read and write notes in your Obsidian vault via Git API",
  "required_secrets": ["github_token", "github_repo", "github_api_url"],
  "tools": [
    "OBSIDIAN_get_project_hierarchy",
    "OBSIDIAN_get_project_text",
    "OBSIDIAN_get_notes_by_date_range",
    "OBSIDIAN_update_project_note"
  ]
}
```

### Extension Tool Execution

When the MCP server receives a tool call for an extension tool:

1. Worker identifies the tool's extension from the tool registry
2. Worker reads the user's credentials via `private.get_extension_credentials(p_user_id, p_extension_name)` SECURITY DEFINER function called through Supabase RPC
3. Worker calls the extension's handler function, passing credentials and tool arguments
4. Handler makes the API call (e.g., GitHub/Gitea Contents API, Todoist REST API, Home Assistant REST API)
5. Handler returns the result to the Worker, which sends it to the MCP client

If credentials are missing or invalid, the tool returns `isError: true` with "Configure [Extension] credentials in Hub settings at lunahub.dev/hub/extensions."

### Included Extensions

| Extension      | Tools                                                                                    | External API              |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| Obsidian       | Get project hierarchy, get project text, get notes by date range, update note            | GitHub/Gitea Contents API |
| Todoist        | Get tasks, get task, create task, update task, complete task, get projects, get sections | Todoist REST API v1       |
| Home Assistant | Get devices, get entity status, turn on, turn off, TV remote                             | Home Assistant REST API   |

Additional extensions can be added by creating a new folder in `extensions/` with the tool definitions and config manifest. The MCP server Worker must be updated to import the new tools.

---

## Authentication

### OAuth 2.1 (Recommended for MCP Clients)

MCP clients that support OAuth 2.1 (Claude Desktop, Cursor, etc.) authenticate via browser login — no manual key setup required.

**How it works:**

1. MCP client connects to `mcp.lunahub.dev/mcp` without credentials
2. Worker returns `401` with `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource`
3. Client discovers Supabase as the authorization server (RFC 9728)
4. Client dynamically registers as a public PKCE client with Supabase
5. User logs in with email/password and approves access on the consent page (`/oauth/consent`)
6. Client receives tokens, sends `POST /mcp` with `Authorization: Bearer <token>` on each request

**Supabase Dashboard Setup (one-time):**

1. Go to **Authentication > OAuth Server** in the Supabase project dashboard
2. Toggle **Enable OAuth 2.1 Server** on
3. Toggle **Enable Dynamic Client Registration** on
4. Set **Authorization Path** to `/oauth/consent`
5. Ensure **Site URL** (Authentication > URL Configuration) matches the web app URL (e.g., `https://lunahub.dev`)

### API Keys (Manual Setup)

Generate keys in Hub > Settings > MCP Keys. Connection flows:

1. **Preferred (Streamable HTTP):** `POST /mcp` with `Authorization: Bearer lh_...` — API key passed as Bearer token, each request is self-contained
2. **Legacy SSE:** `POST /auth` with `{ "apiKey": "lh_..." }` → returns `{ sessionId, sseUrl }` → `GET /sse?sessionId=xxx`
3. **Deprecated:** `GET /sse?apiKey=lh_...` (key in URL)
