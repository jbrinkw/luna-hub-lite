# Phase 08: Remaining Edge Functions — walmart-scrape + liquidtrack

> Previous: phase-07c.md | Next: phase-09a.md

## Skills

test-driven-development, test-quality-review, context7 (Supabase Edge Functions, Deno)

## Build

- `supabase/functions/walmart-scrape/index.ts`:
  - POST handler: accepts Supabase JWT + product URL
  - Calls third-party scraper API with the URL
  - Per-user rate limiting (track requests in DB or in-memory with short TTL)
  - Returns product name + price on success
  - Returns error on invalid URL or rate limit exceeded
- `supabase/functions/liquidtrack/index.ts`:
  - `verify_jwt = false` in function config (IoT endpoint, no JWT)
  - POST handler: accepts device_id + weight data
  - Runtime auth: device ID lookup resolves owning user_id and linked product
  - Import key validation: first use activates device, reuse rejected
  - Calculates macros from weight delta using linked product nutrition
  - Inserts `liquidtrack_event` row (NOT food_log — macros aggregated via `get_daily_macros` from `liquidtrack_events` table)
  - Weight delta = 0 -> no event logged
  - Unknown device_id -> 401 Unauthorized
- Mock server setup in test env: `supabase/functions/.env.local` overrides scraper API base URL to point at local mock HTTP server

## Test (TDD)

### Integration: `apps/web/src/__tests__/integration/edge-functions/walmart-scrape.test.ts`

- POST with valid URL -> mock scraper returns data -> response contains product name + price
- POST with invalid/malformed URL -> error response with descriptive message
- Rate limiting: send rapid requests from same user -> later calls return 429 with throttle message
- Missing JWT -> 401 Unauthorized
- Expired JWT -> 401 Unauthorized

### Integration: `apps/web/src/__tests__/integration/edge-functions/liquidtrack.test.ts`

- POST with valid device_id + weight data (no JWT) -> event created in liquidtrack_events table
- Verify event row contains: device_id, weight_before, weight_after, calculated macros, logical_date
- Verify NO food_log row created (macros aggregated via get_daily_macros from liquidtrack_events)
- Unknown device_id -> 401 Unauthorized response
- Import key: first POST with import_key -> device activated (provisioned=true)
- Import key: second POST with same import_key -> rejected (one-time use)
- Weight delta = 0 (weight_before == weight_after) -> no event logged, success response with zero delta note
- Device with linked product -> macros calculated correctly from weight delta \* product nutrition per gram
- POST without device_id -> 400 Bad Request

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/luna-ext-chefbyte/lib/integrations/walmart.py` — Walmart scraping logic, URL parsing, response normalization
- `legacy/luna-ext-chefbyte/services/liquidtrack/server.py` — IoT ingestion endpoint, device ID auth, weight delta calculation
- `legacy/luna-ext-chefbyte/services/liquidtrack/init_schema.sql` — liquidtrack_events table schema reference

## Commit

`feat: walmart-scrape + liquidtrack edge functions`

## Acceptance

- [ ] walmart-scrape: POST with URL returns product name + price from mock scraper
- [ ] walmart-scrape: per-user rate limiting enforced
- [ ] liquidtrack: POST with device_id + weight creates liquidtrack_event (NOT food_log)
- [ ] liquidtrack: verify_jwt = false (no JWT required)
- [ ] liquidtrack: unknown device_id returns 401
- [ ] liquidtrack: import key one-time validation works (first use activates, reuse rejected)
- [ ] liquidtrack: weight delta = 0 does not create event
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/edge-functions/walmart-scrape src/__tests__/integration/edge-functions/liquidtrack`
- [ ] `pnpm typecheck` passes
