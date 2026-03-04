# Luna Hub

## Purpose

Account management, MCP server configuration, and extension management. Minimal but essential.

## Features

### Account Management

- Registration (email/password) and login
- Profile management (display name, timezone as IANA name, day start hour)
- Password reset flow: Login page has a "Forgot password?" toggle that reveals an inline form calling `supabase.auth.resetPasswordForEmail` with `redirectTo` pointing to `/hub/reset-password`. The `/hub/reset-password` route is a public (unauthenticated) page where users set a new password via `supabase.auth.updateUser`. Validates minimum password length and confirmation match before submitting.
- Session management with automatic session expiration detection: `AuthProvider` tracks whether the initial session load has completed; if a null session arrives after initial load (and the event is not `SIGNED_OUT`), it displays a "Your session has expired. Please sign in again." IonToast notification (warning color, top position, 5-second duration).
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

### AuthGuard

Wraps all protected routes. While the auth session is loading, displays a centered `IonSpinner` (full viewport height). Once loaded, redirects unauthenticated users to `/login`. Authenticated users see the child content.

### AppProvider

Wraps all authenticated routes. Provides `useAppContext()` with:

- `activations: Record<string, boolean>` — loaded from `hub.app_activations` on mount, updated via Realtime. When the user has no session (e.g. after sign-out), activations are cleared to an empty object `{}`.
- `activationsLoading: boolean` — true until the first activations load completes
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

### 404 Catch-All

A catch-all `*` route inside the authenticated layout renders a "Page not found" message with a link to `/hub`. This catches any unmatched paths after `/hub/*`, `/coach/*`, and `/chef/*` routes.

## Hub UX (Ionic)

- Desktop-optimized layout with side navigation
- Responsive for narrower viewports
- Pages: Account, Apps, Tools, Extensions, MCP Settings
