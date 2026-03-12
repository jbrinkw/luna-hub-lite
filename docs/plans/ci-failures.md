# CI Failures — Recorded 2026-03-12

Last two CI runs on `main` have the same 3 failures. Deploy workflow is healthy (Vercel, Supabase, CF Workers all succeed).

## 1. Unit Tests — FAILED (missing env vars)

**Root cause:** CI `unit-tests` job doesn't set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Tests that import components using `src/shared/supabase.ts` crash at module load with `Error: supabaseKey is required.` because `createClient()` is called at import time with undefined env vars.

Cascades across 8+ test files that transitively import `AuthProvider.tsx` → `supabase.ts`.

## 2. Integration Tests — FAILED (MCP Worker SSE timeout)

**Root cause:** `pnpm --filter @luna-hub/mcp-worker test:integration` fails. The MCP test client at `src/__tests__/helpers/mcp-client.ts:52` times out waiting for the SSE endpoint event. Miniflare/wrangler dev server for the CF worker may not be starting properly in CI, or the SSE transport has an issue.

This cascades into "Not connected — call connect() first" errors for all subsequent MCP tool tests. Also prevents `supabase test db` (pgTAP) from running since the step fails first.

## 3. Lint & Format — FAILED (Prettier drift)

**Root cause:** `pnpm format:check` fails (exit code 1). Code committed without running `pnpm format`.

**Linter warnings (non-blocking):**

- "Fast refresh only works when a file only exports components" in: `AppProvider.tsx`, `PrsPage.tsx`, `ScannerPage.tsx`, `RecipesPage.tsx`, `MealPlanPage.tsx`, `MacroPage.tsx`, `HomePage.tsx`, `RestTimer.tsx`
- "React Hook useCallback has a missing dependency: 'executeAction'" in `ScannerPage.tsx:356`

## 4. E2E Tests — status unknown (was still running)

## Non-blocking Warnings

- **Node.js 20 deprecation:** All GitHub Actions (checkout, setup-node, pnpm/action-setup) will be forced to Node.js 24 after June 2, 2026. Update action versions before then.
- **supabase npm bin:** `pnpm approve-builds` not run; supabase/esbuild/sharp/workerd build scripts skipped. Doesn't affect deploys (uses `supabase/setup-cli@v1` instead).
