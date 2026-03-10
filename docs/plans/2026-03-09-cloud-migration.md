# Cloud Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy Luna Hub Lite to production — web app on Vercel, MCP server on Cloudflare Workers, database on Supabase (already provisioned).

**Architecture:** Supabase project `btlfsxammjzkyluophgr` is already provisioned with 2 pending migrations. Web app deploys to Vercel as SPA with rewrites. MCP worker deploys to Cloudflare Workers with Durable Objects at `mcp.lunahub.dev`. DNS managed via Cloudflare (zone already exists).

**Tech Stack:** Supabase CLI, Wrangler CLI, Vercel CLI, Cloudflare API, Git

---

### Task 1: Git Cleanup & Push to GitHub

**Files:**

- Modify: `.gitignore`

**Step 1: Add untracked noise to .gitignore**

Append to `.gitignore`:

```
# Temp files
*.png
.playwright-mcp/
qa-screenshots/
```

**Step 2: Push all commits to GitHub**

```bash
git add .gitignore
git commit -m "chore: update gitignore for deployment"
git push origin main
```

Expected: All commits pushed to `https://github.com/jbrinkw/luna-hub-lite`.

**Step 3: Verify**

```bash
git status
git log --oneline origin/main -3
```

---

### Task 2: Push Supabase Migrations to Production

**Context:** 2 pending migrations need to be pushed to the remote Supabase project (`btlfsxammjzkyluophgr`). The project is already linked.

**Step 1: Dry run to verify**

```bash
cd /home/jeremy/luna-hub-lite
supabase db push --dry-run
```

Expected: Shows 2 pending migrations:

- `20260306050000_schema_fixes.sql`
- `20260309010000_fix_demo_reset_full_week.sql`

**Step 2: Push migrations**

```bash
supabase db push
```

Expected: Both migrations applied successfully.

**Step 3: Verify**

```bash
supabase db push --dry-run
```

Expected: "No pending migrations."

---

### Task 3: Set Supabase Edge Function Secrets

**Context:** Edge functions need API keys set as secrets in the Supabase dashboard. The CLI can set these.

**Step 1: Set ANTHROPIC_API_KEY**

```bash
echo "$ANTHROPIC_API_KEY" | supabase secrets set ANTHROPIC_API_KEY
```

**Step 2: Set SERPAPI_KEY**

```bash
echo "$SERPAPI_KEY" | supabase secrets set SERPAPI_KEY
```

**Step 3: Verify secrets are set**

```bash
supabase secrets list
```

Expected: Both `ANTHROPIC_API_KEY` and `SERPAPI_KEY` appear in the list.

---

### Task 4: Deploy Supabase Edge Functions

**Context:** Three edge functions: `analyze-product`, `walmart-scrape`, `liquidtrack`.

**Step 1: Deploy all functions**

```bash
supabase functions deploy analyze-product --no-verify-jwt
supabase functions deploy walmart-scrape --no-verify-jwt
supabase functions deploy liquidtrack --no-verify-jwt
```

Note: `--no-verify-jwt` matches `config.toml` settings — these functions do internal JWT verification.

**Step 2: Verify each function is accessible**

```bash
curl -s -o /dev/null -w "%{http_code}" https://btlfsxammjzkyluophgr.supabase.co/functions/v1/analyze-product
curl -s -o /dev/null -w "%{http_code}" https://btlfsxammjzkyluophgr.supabase.co/functions/v1/walmart-scrape
curl -s -o /dev/null -w "%{http_code}" https://btlfsxammjzkyluophgr.supabase.co/functions/v1/liquidtrack
```

Expected: 401 for analyze-product and walmart-scrape (no auth header), 400 or 401 for liquidtrack (no API key).

---

### Task 5: Create vercel.json & Deploy Web App

**Files:**

- Create: `apps/web/vercel.json`

**Step 1: Create vercel.json**

```json
{
  "buildCommand": "cd ../.. && pnpm build",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

This tells Vercel: run the monorepo build from root, serve from `apps/web/dist`, rewrite all routes to `index.html` for SPA routing.

**Step 2: Deploy to Vercel with env vars**

```bash
cd /home/jeremy/luna-hub-lite/apps/web
npx vercel --yes \
  --env VITE_SUPABASE_URL=$SUPABASE_URL \
  --env VITE_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
```

**Step 3: Set production env vars for future deploys**

```bash
cd /home/jeremy/luna-hub-lite/apps/web
echo "$SUPABASE_URL" | npx vercel env add VITE_SUPABASE_URL production
echo "$SUPABASE_ANON_KEY" | npx vercel env add VITE_SUPABASE_ANON_KEY production
```

**Step 4: Deploy to production**

```bash
npx vercel --prod
```

**Step 5: Verify**

Visit the Vercel deployment URL. Login page should render. Commit:

```bash
cd /home/jeremy/luna-hub-lite
git add apps/web/vercel.json
git commit -m "chore: add vercel.json for SPA deployment"
git push origin main
```

---

### Task 6: Deploy MCP Worker to Cloudflare

**Context:** Worker needs Supabase secrets + Durable Objects. The `CLOUDFLARE_API_TOKEN` env var must be set.

**Step 1: Set worker secrets**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
echo "$SUPABASE_URL" | CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler secret put SUPABASE_URL
echo "$SUPABASE_SERVICE_ROLE_KEY" | CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

**Step 2: Deploy the worker**

```bash
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler deploy
```

Expected: Worker deployed to `luna-hub-mcp.<account>.workers.dev`.

**Step 3: Verify health endpoint**

```bash
curl https://luna-hub-mcp.<account-subdomain>.workers.dev/health
```

Expected: `ok`

---

### Task 7: Configure DNS — mcp.lunahub.dev

**Context:** Point `mcp.lunahub.dev` to the Cloudflare Worker. Since the zone is already on Cloudflare, we add a custom domain to the worker.

**Step 1: Add custom domain to worker**

Use the Cloudflare API (wrangler doesn't support custom domains directly):

```bash
# Get the zone ID for lunahub.dev
ZONE_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=lunahub.dev" | jq -r '.result[0].id')

# Add worker route for mcp.lunahub.dev/*
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"pattern": "mcp.lunahub.dev/*", "script": "luna-hub-mcp"}'

# Add DNS record for mcp subdomain (proxied AAAA record — standard for workers)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type": "AAAA", "name": "mcp", "content": "100::", "proxied": true}'
```

**Step 2: Verify**

```bash
curl https://mcp.lunahub.dev/health
```

Expected: `ok`

---

### Task 8: Configure DNS — lunahub.dev → Vercel

**Context:** Point the apex domain to Vercel. Need the Vercel project's CNAME target.

**Step 1: Add domain to Vercel project**

```bash
cd /home/jeremy/luna-hub-lite/apps/web
npx vercel domains add lunahub.dev
```

**Step 2: Add DNS records via Cloudflare API**

```bash
ZONE_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=lunahub.dev" | jq -r '.result[0].id')

# CNAME for apex → Vercel (Cloudflare supports CNAME flattening at apex)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type": "CNAME", "name": "@", "content": "cname.vercel-dns.com", "proxied": false}'

# CNAME for www → Vercel
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type": "CNAME", "name": "www", "content": "cname.vercel-dns.com", "proxied": false}'
```

Note: Vercel CNAMEs must NOT be proxied (orange cloud off) — Vercel needs to terminate TLS.

**Step 3: Verify**

```bash
curl -s -o /dev/null -w "%{http_code}" https://lunahub.dev
```

Expected: 200 (login page).

---

### Task 9: Update Supabase Auth Redirect URLs

**Context:** Supabase Auth needs to know the production site URL for OAuth redirects, password reset emails, etc. This is set via the Supabase dashboard (not config.toml, which is local-only).

**Step 1: Update via Supabase CLI**

The Supabase dashboard API can be used, or manually update via dashboard:

- Site URL: `https://lunahub.dev`
- Additional redirect URLs: `https://lunahub.dev/**`, `http://localhost:5173/**`

This can also be set via the management API:

```bash
# This requires the Supabase management API token (from supabase login)
# If CLI is already authed, this should work:
supabase auth config update --site-url "https://lunahub.dev"
```

If the CLI command doesn't support this, do it in the dashboard:

1. Go to https://supabase.com/dashboard/project/btlfsxammjzkyluophgr/auth/url-configuration
2. Set Site URL to `https://lunahub.dev`
3. Add redirect URL: `https://lunahub.dev/**`
4. Keep `http://localhost:5173/**` for local dev

**Step 2: Verify by triggering a password reset**

The reset email link should point to `https://lunahub.dev/hub/reset-password`.

---

### Task 10: Seed Production Demo Account

**Context:** The demo account (`demo@lunahub.dev`) needs to exist in production for the "Try Demo Account" button.

**Step 1: Run seed SQL against production**

The seed.sql creates the demo user + sample data. Run it against the remote database:

```bash
supabase db execute --file supabase/seed.sql
```

If that fails (some seed SQL uses local-only syntax), extract the critical parts:

- Demo user creation in `auth.users`
- Demo profile in `hub.profiles`
- App activations
- Sample products, recipes, etc.

**Step 2: Verify**

Visit `https://lunahub.dev`, click "Try Demo Account". Should log in and show data.

---

### Task 11: Production Smoke Test

**Step 1: Test web app**

- Visit `https://lunahub.dev` — login page renders
- Sign up with a test email
- Activate CoachByte and ChefByte
- Verify pages load with data

**Step 2: Test MCP server**

```bash
# Health check
curl https://mcp.lunahub.dev/health

# Protected resource metadata
curl https://mcp.lunahub.dev/.well-known/oauth-protected-resource

# Unauthenticated SSE should return 401 with WWW-Authenticate
curl -s -o /dev/null -w "%{http_code}" https://mcp.lunahub.dev/sse
```

Expected: `ok`, JSON metadata, `401`

**Step 3: Test edge functions**

```bash
# walmart-scrape (should return 401 without auth)
curl -s -o /dev/null -w "%{http_code}" https://btlfsxammjzkyluophgr.supabase.co/functions/v1/walmart-scrape

# analyze-product (should return 401 without auth)
curl -s -o /dev/null -w "%{http_code}" https://btlfsxammjzkyluophgr.supabase.co/functions/v1/analyze-product
```

---

### Task 12: CI/CD Deploy Workflows

**Files:**

- Create: `.github/workflows/deploy.yml`

**Step 1: Create deploy workflow**

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
          working-directory: apps/web

  deploy-worker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: apps/mcp-worker

  deploy-functions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase link --project-ref btlfsxammjzkyluophgr
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: |
          supabase functions deploy analyze-product --no-verify-jwt
          supabase functions deploy walmart-scrape --no-verify-jwt
          supabase functions deploy liquidtrack --no-verify-jwt
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

**Step 2: Get Vercel project IDs for GitHub secrets**

```bash
cd /home/jeremy/luna-hub-lite/apps/web
cat .vercel/project.json
```

This gives `orgId` and `projectId` for the GitHub secrets.

**Step 3: Document required GitHub secrets**

These need to be added at https://github.com/jbrinkw/luna-hub-lite/settings/secrets/actions:

- `VERCEL_TOKEN` — from https://vercel.com/account/tokens
- `VERCEL_ORG_ID` — from .vercel/project.json
- `VERCEL_PROJECT_ID` — from .vercel/project.json
- `CLOUDFLARE_API_TOKEN` — the token already created
- `SUPABASE_ACCESS_TOKEN` — from `supabase login` or dashboard

**Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add deploy workflows for Vercel, Cloudflare, Supabase"
git push origin main
```

---

## Summary

| Task | What                                | Blocking?                             |
| ---- | ----------------------------------- | ------------------------------------- |
| 1    | Git cleanup + push to GitHub        | Yes — everything depends on this      |
| 2    | Push Supabase migrations            | Yes — DB must be ready for app        |
| 3    | Set edge function secrets           | Yes — functions need API keys         |
| 4    | Deploy edge functions               | Yes — app calls these                 |
| 5    | Create vercel.json + deploy web app | Yes — users need the site             |
| 6    | Deploy MCP worker                   | Yes — MCP clients need the endpoint   |
| 7    | DNS: mcp.lunahub.dev → CF Worker    | Yes — custom domain for MCP           |
| 8    | DNS: lunahub.dev → Vercel           | Yes — custom domain for web           |
| 9    | Update Supabase auth redirect URLs  | Yes — auth flows need production URLs |
| 10   | Seed demo account                   | No — nice to have                     |
| 11   | Production smoke test               | No — verification only                |
| 12   | CI/CD deploy workflows              | No — manual deploys work for now      |

**Execution order:** Tasks 1-11 are sequential. Task 12 can be done after everything is verified.
