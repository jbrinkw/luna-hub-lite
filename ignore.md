<<<<<<< Updated upstream

# Negative-Space Ignore List

Tracked deferred work surfaced by `scripts/audit_negative_space.py` (lens
L8 of the Phase-2 audit). Each entry justifies why a TODO/FIXME/etc
marker stays in the codebase. The script accepts an entry as a waiver
when the line contains:

- A `path:line` reference, AND
- A `YYYY-MM-DD` date token nearby (discourages stale entries).

For inline waiver markers the detector also recognizes:

- GitHub issue refs (`# TODO #123`, `// FIXME(#1234)`)
- Pointers back to this file (`# TODO: see ignore.md "Title"`)
- The explicit `__deferred__` sentinel

See `AUDIT_STRATEGY_MERGED.md §5` for the broader Phase-2 audit context
and `AUDIT_FINDINGS_PHASE2.md` for the original L8 baseline (874 markers
on 2026-04-29 before this triage).

---

---

## Historical migration TODOs (do not edit — already discharged)

These are intentionally retained per migration-history archeology
policy. The detector waives them via the `historical-migration` rule
in `WAIVERS`.

- `supabase/migrations/20260424090000_invariant_batch.sql:26` —
  `mark_meal_done` wiring TODO discharged by
  `20260425020000_mark_meal_done_uses_name_helper.sql`. Date:
  2026-04-25.
- `supabase/migrations/20260424090000_invariant_batch.sql:211` —
  `TODO(agent 1 follow-up)` discharged by the same migration. Date:
  2026-04-25.
  =======

# Planned Work

Approved but not yet scheduled. Non-urgent — none are user-facing bugs or production risks.

---

## 1. Un-skip the 3 MacroPageInvariants dayStartHour tests

**File:** `apps/web/src/__tests__/unit/chefbyte/MacroPageInvariants.test.tsx`

The bug they cover: MacroPage was using `toDateStr(new Date())` — the raw calendar date — instead of `todayStr(dayStartHour)` — the _logical_ date shifted by the user's day-start hour. With `day_start_hour=6`, at 05:30 local the logical date is yesterday. Pre-fix, the page queried today's empty macro bucket while the consume flows had stamped everything to yesterday. So you'd see "0 calories logged" while having actually eaten a meal an hour ago.

The skipped tests are UI-level guards that the loader sends the correct `p_logical_date` to the `get_daily_macros` RPC, with three time/dsh combinations:

- 05:30 + dsh=6 → expect logical date = yesterday
- 14:00 + dsh=6 → expect logical date = today
- 05:30 + dsh=0 → expect calendar today (no shift)

**Why they're skipped:** to test "at 05:30 local," you have to freeze the clock. The natural tool is `vi.useFakeTimers()`. But TanStack Query schedules its query refetches through `setTimeout` / microtask-based promise chains — fake timers intercept those, and `await waitFor(...)` deadlocks. The test sits there forever because the query never flushes.

**Authoritative coverage exists** at the DB level (`consume_pipeline_invariants.test.sql` pgTAP tests pin the logical*date math via `private.get_logical_date(user_id)`), so the actual \_behavior* is guarded. What's missing is the UI-level guard that MacroPage _uses_ the right helper.

**Fix:** stop mocking `Date.now()` and instead mock the `todayStr` helper directly — then no fake timers, no TanStack Query interaction, no deadlock.

**Effort:** ~30 min.

---

## 2. Delete the dead `McpSession` Durable Object class

**Files:**

- `apps/mcp-worker/src/session.ts` (~200 LoC class)
- `apps/mcp-worker/src/index.ts:8,11` (export + type binding)
- `apps/mcp-worker/wrangler.toml:14` (DO binding)
- Test file under `apps/mcp-worker/src/__tests__/` (~50 LoC)

**Background:** the MCP Worker on Cloudflare uses Durable Objects to hold per-session state. Originally there were two transports — legacy `McpSession` DO (handles `/streamable` + `/message` routes via inlined RPC dispatch) and a newer SSE-based path. During the f35f419 MCP tool-handler audit, the agent found that `McpSession.processRpcMessage` was inlining tool dispatch and bypassing the `executeToolWithLogging` wrapper — meaning any traffic through the legacy DO transport produced zero rows in `hub.mcp_tool_logs`.

**Who would use it now:** nobody. Verified by grep: `env.MCP_SESSION.idFromName(...)` / `env.MCP_SESSION.get(...)` has zero call sites. The DO is exported but never instantiated. The `/sse` POST route used to forward into the DO; it now routes to the stateless handler (`handleStatelessMcp`), same as `/mcp`. The comment at `index.ts:293-294` spells out why: "The old SSE transport created Durable Objects on every reconnect, causing excessive DO duration billing. Claude.ai reconnects every ~2 min 24/7."

**Old consumers (all migrated):**

- Claude Desktop on the old MCP 2024-11-05 transport → now uses Streamable HTTP via `/mcp`
- Claude.ai web → same
- Older custom MCP clients that haven't updated past 2024-11-05 → also routed through `/sse` POST → stateless handler

**Caveats before deleting:**

1. **Cloudflare DO migration required.** Can't just `rm` the class — `wrangler.toml` declares the binding. Need a `[[migrations]]` entry with `deleted_classes = ["McpSession"]` and ship as a separate deploy, or Cloudflare will reject the deploy.
2. **Live DO instances in storage.** If sessions were created before the route redirect, Cloudflare may have orphan DO state. The migration handles this — instances get garbage-collected — but confirm via the Cloudflare dashboard before cutover.
3. **The f35f419 wrapper becomes redundant** once the class is gone — saves another ~30 LoC of defense-in-depth.

**Effort:** ~1h including the staged DO migration.

---

## 3. Extract shared SSRF block list

**Files (current duplication):**

- `extensions/obsidian/tools/git-api.ts` → `validateGitApiUrl()`
- `extensions/home-assistant/tools/...` → analogous validator on the HA base URL

Both block lists cover the same surface:

- IPv4 loopback (`127.0.0.0/8`)
- Link-local (`169.254.0.0/16` — includes cloud metadata)
- RFC1918 private (`10/8`, `172.16-31/12`, `192.168/16`)
- IPv6 loopback (`::1`)
- IPv6 link-local (`fe80::/10`) and ULA (`fc00::/7`)
- IPv4-mapped IPv6 (`::ffff:0:0/96`)
- `*.internal` hostname patterns
- Cloud metadata hostnames (`169.254.169.254`, etc.)

**Risk:** if a new SSRF technique emerges (or someone adds a new metadata endpoint to the AWS list), one extension gets patched, the other drifts. They should share one source of truth.

**Origin:** the Obsidian guard was added in f35f419 to fix a high-severity bug where the Obsidian MCP `github_api_url` parameter accepted free-form input and was passed directly to `fetch()`. An attacker could aim the Cloudflare Worker at `169.254.169.254` (cloud metadata), `localhost`, RFC1918 ranges, etc. The HA validator predates it and was the template.

**Fix:**

1. Extract to `extensions/_lib/ssrf.ts` (or `packages/security/` if you want a shared workspace package)
2. Export a single `validateExternalUrl(url, opts?)` function
3. Have both extensions import from it
4. Migrate the existing tests so the obsidian + HA SSRF specs both pass against the shared module
5. Add one shared test suite that captures every block-list rule

**Effort:** 1-2h.

---

## Status

All three approved 2026-04-23 (today). Not currently scheduled — pick up when there's a slow afternoon or after physical hardware verification of the in-flight tracker fixes is done.

> > > > > > > Stashed changes
