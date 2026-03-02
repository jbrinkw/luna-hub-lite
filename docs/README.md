# Luna Hub Lite

**Version:** 6.0
**Date:** February 2026

## What This Is

Luna Hub Lite is the serverless, multi-tenant version of the Luna ecosystem. It is a separate product from Luna Hub (the original self-hosted, fully extensible platform which remains available for power users who want to self-host and build custom extensions).

Luna Hub Lite consists of three interconnected app modules and an extension system, served from a single origin:

- **Luna Hub** (`lunahub.dev/hub`) — Account management, MCP server gateway, extension/tool configuration
- **CoachByte** (`lunahub.dev/coach`) — Strength training copilot
- **ChefByte** (`lunahub.dev/chef`) — AI-powered nutrition lab
- **Extensions** — Modular integrations (Obsidian, Todoist, Home Assistant)

Luna Hub Lite does not contain a built-in AI agent. It exposes an **MCP server** hosted on Cloudflare Workers that external platforms (Claude Desktop, Cursor, any MCP-compatible client) connect to for unified tool access. The platform provides tools and data; external clients provide the reasoning.

## Single-Origin Architecture

All app modules are served from a single origin (`lunahub.dev`) with path-based routing. This eliminates cross-subdomain cookie issues, PWA navigation problems, refresh token race conditions, and service worker scope conflicts.

| Path | Module | Purpose |
|------|--------|---------|
| `lunahub.dev/hub` | Luna Hub | Account, MCP config, extensions |
| `lunahub.dev/coach` | CoachByte | Strength training |
| `lunahub.dev/chef` | ChefByte | Nutrition lab |
| `mcp.lunahub.dev` | MCP Server | Cloudflare Worker (separate origin by necessity) |

The MCP server remains on a subdomain because it runs on Cloudflare Workers, separate from the Vercel deployment. All web app modules share a single Vercel project, single service worker, single PWA manifest, and single auth session.

## Monorepo Structure

```
luna-hub-lite/
├── apps/
│   ├── web/                          # Ionic React app (all modules)
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── hub/
│   │       │   ├── coachbyte/
│   │       │   └── chefbyte/
│   │       └── shared/
│   └── mcp-worker/                   # Cloudflare Worker
├── packages/
│   ├── app-tools/                    # CoachByte + ChefByte MCP tool defs + handlers
│   │   └── src/
│   │       ├── coachbyte/
│   │       ├── chefbyte/
│   │       └── shared/
│   ├── db-types/                     # Generated Supabase TypeScript types
│   ├── ui-kit/                       # Shared Ionic components
│   └── config/                       # Shared config (Supabase URLs, etc.)
├── supabase/
│   ├── migrations/                   # All schema migrations
│   ├── functions/                    # Edge functions
│   └── seeds/
├── extensions/
│   ├── obsidian/
│   ├── todoist/
│   └── home-assistant/
├── scripts/
└── docs/
```

## Documentation Map

| Document | Contents |
|----------|----------|
| [Architecture Overview](architecture/overview.md) | Design principles, tech stack, monorepo conventions |
| [Database Design](architecture/database.md) | Schema layout, RLS, day boundary, units, indexes |
| [Infrastructure](architecture/infrastructure.md) | Authentication, security model, realtime |
| [Apps Overview](apps/overview.md) | App modules vs extensions, cross-app integration, mobile readiness |
| [Luna Hub](apps/hub.md) | Account management, MCP config, extension management |
| [CoachByte](apps/coachbyte.md) | Strength training: features, UX, MCP tools, technical notes |
| [ChefByte](apps/chefbyte.md) | Nutrition lab: features, UX, MCP tools, edge functions |
| [MCP Server & Extensions](mcp/guide.md) | MCP server architecture, extension system, tool catalog |
