# MCP Server & Extension System

## Architecture

The MCP server is a single Cloudflare Worker deployed at `mcp.lunahub.dev`. It uses Durable Objects for OAuth session context per connected client. Tool calls are stateless request-response — the Durable Object provides session continuity for OAuth clients, not tool execution state. All critical session state is persisted to Durable Object SQLite storage on every write (no shutdown hook exists — Cloudflare does not provide one).

Transport is Server-Sent Events (SSE) at `https://mcp.lunahub.dev/sse`.

Remote MCP server proxying is **not included at launch**. It is a future feature. The MCP server exposes local tools only (CoachByte, ChefByte, extensions).

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

## Subrequest Budget

A typical app tool call uses 1-3 Supabase RPC subrequests. Extension tool calls use 2-4 (auth check + Vault credentials RPC + external API + optional write). The Workers free tier limit of 50 subrequests per invocation is sufficient.

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
  "description": "Read and write notes in your Obsidian vault",
  "required_secrets": ["obsidian_api_key"],
  "tools": ["OBSIDIAN_search_notes", "OBSIDIAN_create_note", "OBSIDIAN_get_note"]
}
```

### Extension Tool Execution

When the MCP server receives a tool call for an extension tool:

1. Worker identifies the tool's extension from the tool registry
2. Worker reads the user's credentials via `private.get_extension_credentials(p_user_id, p_extension_name)` SECURITY DEFINER function called through Supabase RPC
3. Worker calls the extension's handler function, passing credentials and tool arguments
4. Handler makes the API call (e.g., Obsidian REST API, Todoist Sync API)
5. Handler returns the result to the Worker, which sends it to the MCP client

If credentials are missing or invalid, the tool returns `isError: true` with "Configure [Extension] credentials in Hub settings at lunahub.dev/hub/extensions."

### Included Extensions

| Extension | Tools | External API |
|-----------|-------|-------------|
| Obsidian | Search notes, create note, get note, update note | Obsidian Local REST API |
| Todoist | Get tasks, create task, complete task, get projects | Todoist Sync/REST API |
| Home Assistant | Get entity state, call service, get entities list | Home Assistant REST API |

Additional extensions can be added by creating a new folder in `extensions/` with the tool definitions and config manifest. The MCP server Worker must be updated to import the new tools.
