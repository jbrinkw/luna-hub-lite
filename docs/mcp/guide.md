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

## Tool Call Logging

Every MCP tool invocation (through `tools/call` or the OpenAI-compatible `/v1/chat/completions` agentic loop) is logged to `hub.mcp_tool_logs`. Each row captures `user_id`, `tool_name`, `tool_args` (with top-level secret-looking keys redacted), `status` (`ok` | `tool_error` | `exception`), `error_message`, and `duration_ms`.

- Writes use the service role and are fired-and-forgotten via `ctx.waitUntil` so latency on the hot path is unaffected.
- A structured JSON line is also emitted to `console.log` (visible in `wrangler tail`) on every call, excluding `tool_args`.
- RLS: users can read their own rows; only `service_role` can insert.
- A failure partial index (`WHERE status <> 'ok'`) makes "recent failures for this user" queries cheap.
- Logging never breaks the tool call — insert errors are swallowed and surfaced to `console.error` only.

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
    "OBSIDIAN_usage_guide",
    "OBSIDIAN_get_project_hierarchy",
    "OBSIDIAN_get_project_text",
    "OBSIDIAN_get_notes_by_date_range",
    "OBSIDIAN_update_project_note"
  ]
}
```

**Credentials opt-out:** An extension tool can set `requiresCredentials: false` on its definition to skip the credentials fetch (e.g., static-content tools like `OBSIDIAN_usage_guide`). The extension-enabled gate is still enforced; the handler receives `credentials: {}`.

### Extension Tool Execution

When the MCP server receives a tool call for an extension tool:

1. Worker identifies the tool's extension from the tool registry
2. Worker reads the user's credentials via `private.get_extension_credentials(p_user_id, p_extension_name)` SECURITY DEFINER function called through Supabase RPC
3. Worker calls the extension's handler function, passing credentials and tool arguments
4. Handler makes the API call (e.g., GitHub/Gitea Contents API, Todoist REST API, Home Assistant REST API)
5. Handler returns the result to the Worker, which sends it to the MCP client

If credentials are missing or invalid, the tool returns `isError: true` with "Configure [Extension] credentials in Hub settings at lunahub.dev/hub/extensions."

### Included Extensions

| Extension      | Tools                                                                                      | External API                          |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Obsidian       | Usage guide, get project hierarchy, get project text, get notes by date range, update note | GitHub/Gitea Git Trees + Contents API |
| Todoist        | Get tasks, get task, create task, update task, complete task, get projects, get sections   | Todoist REST API v1                   |
| Home Assistant | Get devices, get entity status, turn on, turn off, TV remote                               | Home Assistant REST API               |

Additional extensions can be added by creating a new folder in `extensions/` with the tool definitions and config manifest. The MCP server Worker must be updated to import the new tools.

### Obsidian Extension — Folder Convention

The Obsidian extension treats the vault's **folder structure** as the source of truth for the project hierarchy. No frontmatter is required or read.

**Primer tool:** `OBSIDIAN_usage_guide` is a zero-op, zero-credential tool. Its description (always loaded in `tools/list`) carries the core vault model primer — what a project is, that `Journal/` is a personal-diary bucket distinct from project work, and the names of the four companion tools. Calling it returns a detailed guide with format specs, tool args, and limits. Intended as always-current context for MCP clients.

**Project detection rule:** A folder is a project if and only if it contains a markdown file whose stem (filename without `.md`) matches the folder name, case-insensitive.

- `Eco AI/Eco AI.md` → project "Eco AI"
- `gamegenai/gamegenai.md` → project "gamegenai"
- `luna-personal-assistant/CoachByte/CoachByte.md` → sub-project "CoachByte" under "luna-personal-assistant"

**Parent-child:** A project's parent is the nearest ancestor folder that is itself a project. Non-project folders are transparent (a project nested inside an organizational folder still links to its nearest ancestor project).

**Notes file:** A file named `Notes.md` or `notes.md` (case-insensitive) in the project folder is that project's notes file. Only one per project; first in tree order wins.

**Canonical ID:** A project's canonical id is its full folder path from the vault root (e.g., `luna-personal-assistant/CoachByte`). Tools accept either the full path (always unambiguous) or a case-insensitive folder name match (if unique in the vault). Duplicate folder names at different paths return an ambiguous-candidates error.

**Dated entries inside `Notes.md`:** Entries use `MM/DD/YY` date headers (optionally with trailing `:`), with entry body on subsequent lines until the next date header or end of file. Example:

```markdown
---
note_project_id: Eco AI
---

4/15/26

## Refactor done

Today's notes...

4/14/26
Some older notes.
```

**Subrequest budget (Cloudflare Workers, 50/request limit):**

| Tool                      | Subrequests | Notes                                                                                                                                                                     |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_hierarchy`   | 1           | Single Git Trees call, builds full project map from paths + SHAs                                                                                                          |
| `get_project_text`        | 2–3         | Tree + 1 blob for root file + optional 1 blob for Notes.md                                                                                                                |
| `get_notes_by_date_range` | 1 + N       | Tree + N notes-file blobs (N capped at 40; response includes `truncated` flag if more exist). Accepts optional `project_id` to restrict scan to a single project subtree. |
| `update_project_note`     | 2–3         | Tree + Contents-API fetch for existing Notes.md sha + Contents-API write                                                                                                  |

**Vault setup requirements:**

1. Push your Obsidian vault to a GitHub (or Gitea) repo. [obsidian-git](https://github.com/denolehov/obsidian-git) handles this automatically.
2. Generate a fine-grained GitHub PAT with Contents: Read and write permission on the vault repo.
3. In Hub → Extensions → Obsidian, enter:
   - GitHub Repo (owner/repo format)
   - GitHub Personal Access Token
   - API URL (optional, defaults to `https://api.github.com`)

**What to rename (migration from frontmatter-based model):** Each project's root file must match its folder name. If you had `project_id: custom-id` in frontmatter pointing to a file whose name didn't match the folder, rename the file so the folder and filename match, or rename the folder. Any existing frontmatter is ignored (harmless).

**Limitations:**

- Hardcoded to `main` branch — repos on `master` or other default branches not supported.
- Notes files must be named exactly `Notes.md` or `notes.md` — not "Meeting Notes.md" or similar.
- Root-level `.md` files at the vault root are not projects (they have no folder to match). Move them into a folder to promote them to a project.

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

---

## AI Agent API (OpenAI-Compatible)

An OpenAI-compatible `POST /v1/chat/completions` endpoint that acts as an agentic voice assistant backbone. Designed for use with Home Assistant's `extended_openai_conversation` custom component.

### How It Works

1. Client sends standard OpenAI chat completions request with `Authorization: Bearer lh_...`
2. Worker authenticates via same API keys as MCP
3. Worker fetches user's Anthropic API key from encrypted vault storage
4. Worker builds user's enabled tools (same activation/toggle rules as MCP)
5. Worker calls Claude Haiku with an agentic tool loop — if Haiku wants to call tools, the worker executes them inline and feeds results back, repeating until Haiku produces a text response
6. Worker returns the response in OpenAI format

### Configuration (Hub UI)

Go to **Hub > AI Agent** to configure:

- **API Endpoint** — Copy the base URL (`https://mcp.lunahub.dev/v1`) for your HA integration
- **Anthropic API Key** — Your personal Anthropic key, stored encrypted via pgcrypto vault. Required for the agent to call Claude Haiku.
- **System Prompt** — Customize the assistant's personality and behavior. Default prompt identifies as "Luna" with awareness of all tool categories.

### Endpoints

| Method | Path                   | Description                                        |
| ------ | ---------------------- | -------------------------------------------------- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (auth required) |
| `GET`  | `/v1/models`           | List available models (no auth required)           |

### Request Format

```json
{
  "model": "claude-haiku-4-5-20251001",
  "messages": [{ "role": "user", "content": "Turn on the living room lights" }],
  "stream": false,
  "max_tokens": 4096
}
```

- `model` is ignored — always uses Claude Haiku
- `stream: true` supported (tool calls run server-side, final text streamed as SSE)
- `max_tokens` capped at 8192
- `tools` field ignored — tools are built server-side from user's enabled tools

### Home Assistant Setup

1. Install [extended_openai_conversation](https://github.com/jekalmin/extended_openai_conversation) via HACS
2. Add integration in HA: Settings > Devices & Services > Add Integration
3. Set **Base URL** to `https://mcp.lunahub.dev/v1`
4. Set **API Key** to your Luna Hub API key (`lh_...` from Hub > MCP Settings)
5. Assign as conversation agent in your voice pipeline
