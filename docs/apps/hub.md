# Luna Hub

## Purpose

Account management, MCP server configuration, and extension management. Minimal but essential.

## Features

### Account Management

- Registration (email/password) and login
- Profile management (display name, timezone as IANA name, day start hour). Timezone uses a searchable combobox with all IANA timezone names.
- Password reset flow: Login page has a "Forgot password?" toggle that reveals an inline form calling `supabase.auth.resetPasswordForEmail` with `redirectTo` pointing to `/hub/reset-password`. The `/hub/reset-password` route is a public (unauthenticated) page where users set a new password via `supabase.auth.updateUser`. Validates minimum password length and confirmation match before submitting.
- Session management with automatic session expiration detection: `AuthProvider` tracks whether the initial session load has completed; if a null session arrives after initial load (and the event is not `SIGNED_OUT`), it displays a "Your session has expired. Please sign in again." toast notification (amber/warning color, top position, 5-second auto-dismiss).
- App activation (CoachByte, ChefByte) — deactivation requires confirmation, performs full delete of user's data in that module's schema via single auditable RPC
- Offline indicator and "last synced" timestamp in header

### MCP Server Configuration

- View MCP server connection details (endpoint URL `https://mcp.lunahub.dev/mcp`, Streamable HTTP transport). The legacy `POST /sse` endpoint is preserved for backwards compatibility — the worker treats `POST /sse` and `POST /mcp` identically as stateless JSON-RPC (per `docs/mcp/guide.md`), so existing Claude.ai connectors keep working without spawning Durable Objects.
- Generate and manage API keys (show-once pattern: plaintext displayed once, SHA-256 hash stored, multiple keys allowed, revoke individually)
- OAuth 2.1 consent flow handled at `/oauth/consent` for MCP clients that initiate the OAuth redirect

### Tool Management

- View all available tools organized in collapsible groups (CoachByte, ChefByte, Obsidian, Todoist, Home Assistant) with search/filter and descriptions
- Per-user tool enable/disable toggles

### Extension Management

- List of available extensions with enable/disable toggles
- Per-extension settings forms (API credentials, configuration)
- Extensions can be enabled without credentials — first tool call without credentials returns `isError: true` with instructions to configure in Hub. Credential validation on save is a future feature.
- **Credentials at rest:** stored in Supabase Vault (pgsodium AEAD). The
  `hub.extension_settings` row carries only a `vault_secret_id` UUID
  pointer — never the secret payload. Save flow:
  `hub.save_extension_credentials(name, json)` calls `vault.create_secret`
  (or `vault.update_secret` on rotation). Read flow:
  `hub.get_extension_credentials(name)` for the SPA (auth.uid() check)
  and `hub.get_extension_credentials_admin(user_id, name)` for the MCP
  worker (service_role). The `hub.has_extension_credentials(name)`
  helper is the boolean the UI uses for the "Credentials configured"
  badge — the browser never sees the decrypted payload.
- Toggling an extension OFF calls `hub.clear_extension_credentials(name)`
  which both nulls the pointer AND deletes the underlying vault row.
  Re-enable forces re-entry (deliberate UX choice — stale tokens
  outliving a disable is worse than a one-time re-entry friction).
- "Last 5 MCP calls" tail per extension card (only when enabled + configured): reads from `hub.mcp_tool_logs` filtered by tool-name namespace (`OBSIDIAN_*`, `TODOIST_*`, `HOMEASSISTANT_*`). Each row shows the action (last segment of the tool name), duration, relative time, and a success/fail icon. Tap a row to expand the full tool name + error message. Updates live via Realtime subscription on `hub.mcp_tool_logs`. Empty state: "No calls yet — try asking Claude to use this extension."

### AI Agent

The `/hub/agent` page configures the OpenAI-compatible `/v1/chat/completions` endpoint used by Home Assistant Voice Preview and similar clients. It shows the base URL (`https://mcp.lunahub.dev/v1`), stores the user's Anthropic API key (encrypted via pgcrypto vault), and lets the user customize the system prompt used for every request.

#### Voice Assist

A card on the Agent page that controls optional filler phrases for voice streaming:

- **Enable** toggles filler emission during slow tool execution.
- **Filler phrase** (≤200 chars) is emitted verbatim when the delay expires without a real token having been streamed.
- **Delay** (0–5000 ms) is the silence threshold. Keep it long enough that fast responses skip the filler, short enough that voice users don't perceive a hang.

The filler is only ever spoken via `POST /v1/chat/completions` streaming responses. It has no effect on non-streaming requests or on the Luna chat UI.

## Shared Components

### AuthGuard

Wraps all protected routes. While the auth session is loading, displays a branded loading screen with "Luna Hub" heading and a centered spinner (full viewport height). Once loaded, redirects unauthenticated users to `/login`. Authenticated users see the child content.

### AppProvider

Wraps all authenticated routes. Uses TanStack Query internally (`useQuery` for activations and profile data, `useRealtimeInvalidation` for live updates). Provides `useAppContext()` with:

- `activations: Record<string, boolean>` — fetched via `useQuery` from `hub.app_activations`, invalidated via `useRealtimeInvalidation` on changes.
- `activationsLoading: boolean` — true until the first activations query completes
- `online: boolean` — tracks `navigator.onLine` + window events
- `lastSynced: Date | null` — updated on successful data loads and reconnection
- `dayStartHour: number` — from profile query
- `refreshActivations()` — invalidates the activations query cache

### ModuleSwitcher

Horizontal tab bar filtered by `useAppContext().activations`. Hub always visible; CoachByte/ChefByte shown only when activated.

### OfflineIndicator

Banner in `AppLayout` shown when `online === false`. Displays "No connection" with last synced timestamp (or "Never synced" if null).

### ErrorBoundary

React class component wrapping each module route independently (`/hub/*`, `/coach/*`, `/chef/*`). Shows module name, error message, and retry button. One module crashing doesn't affect others.

### SkeletonScreen

Reusable loading skeletons: `ListSkeleton`, `CardSkeleton`, `MacroBarSkeleton`, `TableSkeleton`. Used in page loading states across all modules.

### 404 Catch-All

A catch-all `*` route inside the authenticated layout renders a "Page not found" message with a link to `/hub`. This catches any unmatched paths after `/hub/*`, `/coach/*`, and `/chef/*` routes.

## Hub UX

- Desktop-optimized layout with side navigation
- Responsive for narrower viewports
- Pages: Account, Apps, Tools, Extensions, MCP Settings, AI Agent
