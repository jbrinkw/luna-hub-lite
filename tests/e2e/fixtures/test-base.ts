/**
 * Shared Playwright test base for e2e scenarios — Phase 3.
 *
 * Wraps `@playwright/test`'s `test` so every scenario automatically:
 *   1. records its start time + the test user ids it seeds,
 *   2. on PASS, runs `assertSystemInvariants` against each user via
 *      `afterEach` so any contract drift the scenario didn't directly
 *      check fails the scenario.
 *
 * Why a shared base instead of per-scenario `test.afterEach`: see
 * `tests/e2e/README.md` "Runtime Invariants". The behavior is identical
 * across all 15 scenarios; duplicating boilerplate would hide the
 * scenario-specific assertions in a sea of identical hooks.
 *
 * Tracking strategy: Playwright runs scenarios serial-per-worker (we
 * pin `workers=1` in playwright.config.ts), so a module-level Map keyed
 * by `testInfo.testId` is safe. The seedUser helpers register their
 * userId with the active test via `recordSeededUser(userId)` — the
 * helpers themselves don't have access to `testInfo`, so we use a
 * simple "currently running test" registry maintained by beforeEach +
 * afterEach. The pattern relies on Node's single-thread model + the
 * non-overlapping nature of a worker's test schedule.
 *
 * Skipping mechanism: scenarios that explicitly want to bypass the
 * invariants for some reason can call `markScenarioSkipInvariants()` —
 * none do today. The bypass is intentionally available so a future
 * scenario that deliberately leaves the system in a violated state
 * (e.g. testing the production monitor itself) can opt out.
 */
import { test as base, type TestInfo } from '@playwright/test';
import { adminClient } from './env';
import { assertSystemInvariants, type PiSimulatorState } from '../invariants';

interface ScenarioContext {
  startTime: Date;
  userIds: Set<string>;
  piSimulator?: PiSimulatorState;
  skipInvariants: boolean;
}

const contexts = new Map<string, ScenarioContext>();
let currentTestId: string | null = null;

/**
 * Called by `seedUser` / `seedUserAndActivate` after the user is
 * created. Pushes the userId onto the active scenario's context so
 * the afterEach hook can scope invariant checks to it.
 *
 * No-op if called outside an active scenario (e.g. from a unit test
 * importing the seeding helpers directly — never expected, but safe).
 */
export function recordSeededUser(userId: string): void {
  if (!currentTestId) return;
  const ctx = contexts.get(currentTestId);
  if (ctx) ctx.userIds.add(userId);
}

/**
 * Attach a Pi simulator to the active scenario for invariant checks
 * #4 + #10. Most scenarios pass `undefined` (no simulator state to
 * cross-check); scenarios that maintain a Pi-side mirror can set this
 * and the corresponding predicates activate.
 */
export function recordPiSimulator(sim: PiSimulatorState): void {
  if (!currentTestId) return;
  const ctx = contexts.get(currentTestId);
  if (ctx) ctx.piSimulator = sim;
}

/**
 * Opt the current scenario out of the invariant afterEach. Reserved
 * for the rare case of testing a deliberately-violated state.
 */
export function markScenarioSkipInvariants(): void {
  if (!currentTestId) return;
  const ctx = contexts.get(currentTestId);
  if (ctx) ctx.skipInvariants = true;
}

/** Test-only: drop a scenario's context by id. Used by harness teardown paths. */
export function clearScenarioContext(testId: string): void {
  contexts.delete(testId);
  if (currentTestId === testId) currentTestId = null;
}

export const test = base.extend<{ scenarioRegistry: void }>({
  // Auto-fixture: registers context on entry, runs invariants on pass.
  scenarioRegistry: [
    async ({}, use, testInfo: TestInfo) => {
      const id = testInfo.testId;
      currentTestId = id;
      const ctx: ScenarioContext = {
        startTime: new Date(),
        userIds: new Set<string>(),
        skipInvariants: false,
      };
      contexts.set(id, ctx);
      try {
        await use();
      } finally {
        // PASS only: piling invariant assertions on top of an
        // already-failing scenario just confuses the failure report.
        // testInfo.status is set by the time the fixture's after-use
        // body runs.
        if (testInfo.status === 'passed' && !ctx.skipInvariants) {
          const supabase = adminClient();
          // Run invariants against each seeded user. With workers=1
          // and per-scenario user creation, this is typically 1 user
          // per scenario; multi-user scenarios (none today, but the
          // shape supports it) iterate.
          for (const userId of ctx.userIds) {
            await assertSystemInvariants({
              supabase,
              testUserId: userId,
              scenarioStartTime: ctx.startTime,
              scenarioName: testInfo.title,
              piSimulator: ctx.piSimulator,
            });
          }
        }
        contexts.delete(id);
        currentTestId = null;
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
