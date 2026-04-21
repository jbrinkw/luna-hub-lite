// Integration tests for this function live under the repo's vitest runner:
//   apps/web/src/__tests__/integration/edge-functions/shelf-ingest.test.ts
//
// They're placed there because vitest's integration config
// (apps/web/vitest.integration.config.ts) only discovers tests under
// `src/__tests__/integration/**` and relies on shared setup
// (adminClient, createTestUser, etc) colocated with the other edge-function
// tests (analyze-product.test.ts, walmart.test.ts).
//
// Run them from the repo root with:
//   pnpm --filter @luna-hub/web test:integration -- shelf-ingest
// or equivalently:
//   pnpm --filter @luna-hub/web exec vitest run --config vitest.integration.config.ts shelf-ingest

export {};
