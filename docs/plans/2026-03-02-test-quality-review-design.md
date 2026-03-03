# Test Quality Review — Process Design

**Goal:** Add a structured test review gate to the development workflow that catches false positives, weak assertions, missing coverage, and tests that don't verify what they claim.

**Trigger:** Per-batch, after all implementation tasks in a test layer complete their spec + code quality reviews.

**Method:** Mental trace verification — reviewer reads each test and asks "if I broke the feature, would this test fail?"

## Workflow Integration

Current subagent-driven-development flow:
```
Implement → Spec Review → Code Quality Review → Done
```

New flow:
```
Implement → Spec Review → Code Quality Review → [batch completes] → Test Quality Review → Done
```

The test quality review subagent runs once per layer batch (e.g., after all pgTAP tasks finish). It reviews every new/modified test file in the batch as a group, catching cross-test gaps.

## Checklist — All Layers

1. **Falsifiability** — "If I broke the feature, would this test fail?" Mental trace per assertion.
2. **No tautologies** — Assertions always true (empty table counts, `!= null` on required fields)
3. **Exact assertions** — `is(count, 3)` not `ok(count > 0)`, `toHaveLength(2)` not `toBeTruthy()`
4. **Negative paths tested** — Error inputs, unauthorized access, cancel flows
5. **No duplicates** — Two tests asserting the same thing under different names

## Layer-Specific Checks

### pgTAP
6. Every `lives_ok` followed by a data assertion
7. Cross-user isolation (user B can't see/modify user A)
8. Anon denial test exists for every table
9. All tables in the schema have RLS tests

### Unit (Vitest + RTL)
10. Callback props verified with correct arguments, not just "was called"
11. Loading/disabled/error states covered
12. Mocks are minimal — only external dependencies

### Integration (Vitest + Supabase SDK)
13. All readbacks use user's client, NOT `adminClient`
14. Cross-user RLS isolation for every table touched
15. Each test creates its own user (no shared state)

### E2E (Playwright)
16. No URL-only assertions — every navigation has a content check
17. Selectors are page-specific (scoped locators, not `getByText` matching globally)
18. Persistence tests (state survives reload) for stateful features
19. Cleanup in `finally` blocks

## Output Format

```markdown
## Test Quality Review: [layer]

### Files reviewed
- path/to/test1.ts (N tests)

### PASS (N tests)
[Tests that passed all checks]

### FAIL (N issues)
1. [file:line] Test "name" — FALSE POSITIVE: [reason]
2. [file:line] Test "name" — WEAK: [reason]
3. [file:line] MISSING: [what's missing]

### Coverage gaps
- Table X has 0 tests
- Component Y missing error state test
```

If any FAIL items: implementer fixes → re-review.
