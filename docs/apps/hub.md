# Luna Hub

## Purpose

Account management, MCP server configuration, and extension management. Minimal but essential.

## Features

### Account Management
- Registration (email/password) and login
- Profile management (display name, timezone as IANA name, day start hour)
- Password reset, session management
- App activation (CoachByte, ChefByte) — deactivation requires confirmation, performs full delete of user's data in that module's schema via single auditable RPC
- Offline indicator and "last synced" timestamp in header

### MCP Server Configuration
- View MCP server connection details (endpoint URL `https://mcp.lunahub.dev/sse`, SSE transport)
- Generate and manage API keys (show-once pattern: plaintext displayed once, SHA-256 hash stored, multiple keys allowed, revoke individually)
- OAuth 2.1 client registration for MCP clients that require OAuth flow

### Tool Management
- View all available tools with descriptions
- Per-user tool enable/disable toggles

### Extension Management
- List of available extensions with enable/disable toggles
- Per-extension settings forms (API credentials, configuration)
- Extensions can be enabled without credentials — first tool call without credentials returns `isError: true` with instructions to configure in Hub. Credential validation on save is a future feature.

## Shared Components

### AppProvider
Wraps all authenticated routes. Provides `useAppContext()` with:
- `activations: Record<string, boolean>` — loaded from `hub.app_activations` on mount, updated via Realtime
- `online: boolean` — tracks `navigator.onLine` + window events
- `lastSynced: Date | null` — updated on successful data loads and reconnection
- `refreshActivations()` — manual refresh

### ModuleSwitcher
Side navigation links filtered by `useAppContext().activations`. Hub always visible; CoachByte/ChefByte shown only when activated.

### OfflineIndicator
Banner in `AppLayout` shown when `online === false`. Displays "No connection" with last synced timestamp (or "Never synced" if null).

### ErrorBoundary
React class component wrapping each module route independently (`/hub/*`, `/coach/*`, `/chef/*`). Shows module name, error message, and retry button. One module crashing doesn't affect others.

### SkeletonScreen
Reusable Ionic-based loading skeletons: `ListSkeleton`, `CardSkeleton`, `MacroBarSkeleton`, `TableSkeleton`. Used in page loading states across all modules.

## Hub UX (Ionic)

- Desktop-optimized layout with side navigation
- Responsive for narrower viewports
- Pages: Account, Apps, Tools, Extensions, MCP Settings
