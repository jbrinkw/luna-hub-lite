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

## Hub UX (Ionic)

- Desktop-optimized layout with side navigation
- Responsive for narrower viewports
- Pages: Account, Apps, Tools, Extensions, MCP Settings
