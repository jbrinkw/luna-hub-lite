# Phase 09b: MCP Worker — Tools + Extensions

> Previous: phase-09a.md | Next: phase-10.md

## Skills

test-driven-development, test-quality-review, context7 (Cloudflare Workers, Supabase)

## Build

- `apps/mcp-worker/src/tools/coachbyte/` — 11 CoachByte tool handlers:
  - COACHBYTE_get_today_plan, COACHBYTE_complete_next_set, COACHBYTE_log_set
  - COACHBYTE_update_plan, COACHBYTE_update_summary, COACHBYTE_get_history
  - COACHBYTE_get_split, COACHBYTE_update_split, COACHBYTE_set_timer
  - COACHBYTE_get_timer, COACHBYTE_get_prs
  - All reference entities by UUID, call Supabase RPC via service_role
- `apps/mcp-worker/src/tools/chefbyte/` — 19 ChefByte tool handlers:
  - CHEFBYTE_get_inventory, CHEFBYTE_get_product_lots, CHEFBYTE_add_stock
  - CHEFBYTE_consume, CHEFBYTE_get_products, CHEFBYTE_create_product
  - CHEFBYTE_get_shopping_list, CHEFBYTE_add_to_shopping, CHEFBYTE_clear_shopping
  - CHEFBYTE_below_min_stock, CHEFBYTE_get_meal_plan, CHEFBYTE_add_meal
  - CHEFBYTE_mark_done, CHEFBYTE_get_recipes, CHEFBYTE_get_cookable
  - CHEFBYTE_create_recipe, CHEFBYTE_get_macros, CHEFBYTE_log_temp_item
  - CHEFBYTE_set_price
- `extensions/obsidian/tools/` — 4 tools: OBSIDIAN_search_notes, OBSIDIAN_create_note, OBSIDIAN_get_note, OBSIDIAN_update_note
- `extensions/todoist/tools/` — 4 tools: TODOIST_get_tasks, TODOIST_create_task, TODOIST_complete_task, TODOIST_get_projects
- `extensions/homeassistant/tools/` — 3 tools: HOMEASSISTANT_get_entity_state, HOMEASSISTANT_call_service, HOMEASSISTANT_get_entities
- Extension handlers retrieve credentials via `private.get_extension_credentials(p_user_id, p_extension_name)` RPC
- Extension `config.json` manifests for each extension (name, display_name, required_secrets, tool list)

## Test (TDD)

### Integration: `apps/mcp-worker/src/__tests__/tools/coachbyte.test.ts`

- COACHBYTE_get_today_plan -> returns today's plan with sets and resolved loads
- COACHBYTE_complete_next_set -> completes lowest-order incomplete set, returns updated plan
- COACHBYTE_log_set -> creates ad-hoc completed_set row with provided exercise_id, reps, load
- COACHBYTE_get_history -> returns paginated day list with set summaries
- COACHBYTE_update_split -> updates template_sets for specified weekday
- COACHBYTE_set_timer -> creates/replaces timer row with state=running
- COACHBYTE_get_prs -> returns PR list with exercise name + e1rm values
- Remaining 4 tools (update_plan, update_summary, get_split, get_timer) follow identical dispatch pattern -> covered by tool-dispatch.test.ts

### Integration: `apps/mcp-worker/src/__tests__/tools/chefbyte.test.ts`

- CHEFBYTE_get_inventory -> returns grouped products with stock totals and nearest expiry
- CHEFBYTE_add_stock -> creates lot with correct qty, location, expiry
- CHEFBYTE_consume -> depletes nearest-expiry lot, optionally logs macros
- CHEFBYTE_create_product -> creates product with all fields, returns product_id
- CHEFBYTE_get_shopping_list -> returns current shopping list items
- CHEFBYTE_add_meal -> creates meal plan entry with recipe/product reference
- CHEFBYTE_mark_done -> executes regular (consume + log macros) or prep (consume + [MEAL] lot)
- CHEFBYTE_get_macros -> returns today's macro totals (food_logs + temp_items + liquidtrack_events)
- CHEFBYTE_log_temp_item -> creates temp_item with name + macros + logical_date
- Remaining 10 tools follow identical dispatch pattern -> covered by tool-dispatch.test.ts

### Integration: `apps/mcp-worker/src/__tests__/tools/extensions.test.ts`

- Extension credential retrieval via Vault RPC -> credentials passed to handler
- OBSIDIAN_search_notes with valid credentials -> mock API called -> results returned
- TODOIST_get_tasks with valid credentials -> mock API called -> tasks returned
- HOMEASSISTANT_get_entities with valid credentials -> mock API called -> entities returned
- Missing credentials -> returns `{isError: true, content: "Configure Obsidian credentials in Hub settings at lunahub.dev/hub/extensions."}`
- Invalid/expired credentials -> returns `{isError: true, content: "credential error message"}`

### Integration: `apps/mcp-worker/src/__tests__/tool-filtering.test.ts`

- Disable a tool in user config -> reconnect SSE -> tool absent from tool list
- Re-enable tool -> reconnect -> tool reappears in list
- Deactivate ChefByte app -> reconnect -> all CHEFBYTE*\* tools removed, COACHBYTE*\* still present
- Deactivate both apps -> reconnect -> only extension tools remain (if enabled)

### Flow: `apps/web/src/__tests__/flows/cross-module.flow.test.ts`

1. Sign up -> profile created with defaults
2. Update day_start_hour to 4 AM
3. Activate CoachByte -> global exercises accessible via query
4. Activate ChefByte -> target_macros defaults initialized
5. Create split + bootstrap plan -> verify logical_date computed with day_start_hour=4
6. Create product + consume -> verify food_log logical_date also uses day_start_hour=4
7. Deactivate CoachByte -> verify all CoachByte data deleted (splits, plans, completed_sets, PRs, timer)
8. Verify ChefByte data still intact (products, stock_lots, food_logs)
9. Verify Hub profile still intact (display_name, timezone, day_start_hour)
10. Reactivate CoachByte -> verify clean slate (no plans, no PRs), global exercises still accessible

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/luna-hub/core/utils/extension_discovery.py` — extension scanning and tool loading
- `legacy/luna-hub/core/utils/tool_discovery.py` — local + remote tool merge, registry patterns
- `legacy/luna_ext_coachbyte/tools/coachbyte_tools.py` — CoachByte tool definitions + handler logic
- `legacy/luna-ext-chefbyte/lib/api.py` — ChefByte tool-adjacent logic (product lookup, stock operations)

## Commit

`feat: MCP worker tools + extensions`

## Acceptance

- [ ] 11 CoachByte tools callable via MCP, all reference entities by UUID
- [ ] 19 ChefByte tools callable via MCP, all reference entities by UUID
- [ ] 11 extension tools (4 Obsidian + 4 Todoist + 3 Home Assistant) callable with credential retrieval
- [ ] Missing credentials return `{isError: true}` with "Configure in Hub" message
- [ ] Tool filtering: disabled tools excluded, deactivated app removes all its tools
- [ ] Cross-module flow test passes (10-step lifecycle: signup -> activate -> use -> deactivate -> verify)
- [ ] All MCP tool tests pass: `pnpm --filter mcp-worker test`
- [ ] Flow test passes: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/flows/cross-module`
- [ ] `pnpm typecheck` passes
