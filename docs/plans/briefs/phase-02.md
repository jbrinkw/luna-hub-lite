# Phase 02: Test Infrastructure Setup
> Previous: (Phase 1 done) | Next: phase-03a.md

## Skills
test-driven-development, context7 (vitest, playwright, pgTAP APIs)

## Build
- `apps/web/vitest.config.ts` — jsdom env, setup files, globals: true
- `apps/web/vitest.integration.config.ts` — node env, integration + flow tests
- `apps/web/src/__tests__/setup.ts` — mocked Supabase client, jest-dom matchers
- `apps/web/src/__tests__/setup.integration.ts` — real local Supabase client at localhost:54321 + admin client for user management
- `apps/web/src/__tests__/test-helpers.ts` — factories: createTestUser, cleanupUser, createProduct, createExercise, createRecipeWithIngredients, createSplitForDay
- `apps/web/src/__tests__/integration/edge-functions/` — directory scaffold
- `supabase/tests/` — directory with pgTAP bootstrap
- `supabase/tests/00_rls_pattern.test.sql` — standard RLS verified across 2 users on hub.profiles
- `apps/mcp-worker/vitest.config.ts` — using @cloudflare/vitest-pool-workers
- `apps/mcp-worker` — install @cloudflare/vitest-pool-workers
- `apps/web/playwright.config.ts` — Playwright config (webServer: pnpm dev, port 5173)
- `apps/web/e2e/` — directory structure: hub/, coachbyte/, chefbyte/, cross-module/
- Test scripts in root + workspace package.json files

## Test (TDD)

### pgTAP: `supabase/tests/00_rls_pattern.test.sql`
- Create 2 test users (User A, User B) — profiles auto-created by handle_new_user trigger
- User A can SELECT their own profile
- User B cannot SELECT User A's profile
- User A can UPDATE their own profile
- User B cannot UPDATE User A's profile
- Anon role cannot SELECT any rows
- Note: INSERT/DELETE isolation tested in Phase 3b on hub.api_keys (hub.profiles uses PK + trigger, not directly insertable)

### Unit: `apps/web/src/__tests__/unit/hub/dummy.test.ts`
- Dummy test passes (verifies vitest + jsdom env works)

### Integration: `apps/web/src/__tests__/integration/hub/dummy.test.ts`
- Dummy test connects to local Supabase at localhost:54321
- createTestUser returns signed-in client + userId
- cleanupUser deletes user via admin API (FK cascade)

## Legacy Reference
- `legacy/chefbyte-vercel/apps/web/src/lib/supabase.ts` — client init pattern for test setup
- `legacy/luna-hub/core/utils/auth_service.py` — auth patterns (architecture reference only)

## Commit
`feat: test infrastructure setup`

## Acceptance
- [ ] `supabase start` boots full local stack
- [ ] `supabase test db` passes 00_rls_pattern.test.sql (6 assertions)
- [ ] `pnpm test` passes with dummy unit test in jsdom env
- [ ] Integration setup connects to local Supabase at localhost:54321
- [ ] test-helpers.ts exports createTestUser/cleanupUser and works against local Supabase
- [ ] Playwright launches browser and loads dev server at localhost:5173
- [ ] MCP worker vitest config loads with @cloudflare/vitest-pool-workers
- [ ] e2e/ directory structure exists: hub/, coachbyte/, chefbyte/, cross-module/
- [ ] Full pipeline: `supabase test db && pnpm test && npx playwright test --list`
