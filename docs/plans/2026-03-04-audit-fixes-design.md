# Audit Fixes — Design Document

## Context

Feature audit found 146 issues (11 CRITICAL, 27 HIGH, 80 MEDIUM, 28 LOW). This plan addresses the critical and high-severity DATA BUGS first — small targeted fixes that unbreak existing functionality.

## Approach: Bugs Before Features

**Batch 1 — Critical Data Bugs (break existing features silently):**

- C1/D2: JSONB key mismatch in SplitPage + seed.sql
- C4/D1: Seed user_config goal keys don't match SQL functions
- C2: Relative load % hardcoded to 80 (should be editable input)
- ChefByte #12: importShopping inverted boolean (.eq('purchased', false) → true)
- M1: Extension credential key mismatch (all 3 extensions broken)

**Batch 2 — High Logic Bugs:**

- C3/M23: todayStr() ignores day_start_hour (use logical date from server)
- ChefByte #11: addStock lot proliferation (merge instead of create)
- ChefByte #10: Non-atomic recipe ingredient save (wrap in transaction)
- M2: ToolsPage hardcodes wrong tool names
- D4: Missing index on api_keys.api_key_hash

**Batch 3 — High Functional Gaps (CoachByte):**

- #1/#2: Inline editing + add/delete planned sets in Today queue
- #3: Delete completed sets
- #4: Plate breakdown display
- #5: Delete day/plan button
- #6: Tracked exercises auto-populate from completed sets
- #7: Timer expired state not written to DB

**Batch 4 — High Functional Gaps (ChefByte):**

- #2: Wire analyze-product edge function to Scanner
- #1: Hardware barcode scanner detection (useScannerDetection hook)
- #6: Delete temp items / food logs on Macros page
- #7: Location management page
- #8: Expiry date input on inventory
- #9: Realtime subscriptions on all ChefByte pages

**Deferred (MEDIUM/LOW) — tracked in feature-audit.md for future work.**

## Decision: Fix data bugs NOW, defer large features

The 5 critical data bugs (Batch 1) are 30-minute fixes each that unbreak the entire app. Batch 2 is similar. Batches 3-4 are real feature work requiring UI design.

## Architecture Decisions

1. **C1 fix:** Change SplitPage to save `target_reps`/`target_load`/`target_load_percentage`/`rest_seconds` keys. Update seed.sql to match. This aligns UI with SQL function expectations.

2. **C4 fix:** Change seed.sql to use `goal_calories`/`goal_protein`/`goal_carbs`/`goal_fat`. These match what `get_daily_macros` reads.

3. **C3 fix:** Replace client-side `todayStr()` with server RPC call `private.get_logical_date()` for date-sensitive operations. Cache result in context/hook for the session.

4. **Lot merge:** Change `addStock` to UPSERT on `(product_id, location_id, expires_on)` composite key, incrementing quantity instead of inserting new row.

5. **Extension credentials:** Match keys to what MCP handlers expect. Add credential schema validation on save.
