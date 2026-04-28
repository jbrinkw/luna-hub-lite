/**
 * LiveTrack wizard — heartbeat-age display helper.
 *
 * Pins the negative-age clamp + null/non-finite fallbacks for
 * ``computeHeartbeatAgeSeconds``. The function backs the wizard's device-
 * status banner ("Pi: kitchen-pi (online, last hb 3s ago)").
 *
 * Pre-fix bug (2026-04-28):
 *   When the Pi's clock ran slightly ahead of the browser, the helper
 *   returned a negative seconds value and the UI rendered the confusing
 *   string "offline — last hb -1s ago". Negative ages are functionally
 *   indistinguishable from "just now" for staleness purposes, so the fix
 *   clamps them to 0 (which the page renders as "just now").
 *
 * Mutation hardening: revert the ``Math.max(0, ...)`` clamp and a
 * negative-skew test will fail.
 */

import { describe, it, expect } from 'vitest';
import { computeHeartbeatAgeSeconds } from '@/pages/chefbyte/livetrackSession';

const NOW = new Date('2026-04-28T12:00:00.000Z').getTime();

describe('computeHeartbeatAgeSeconds — negative-skew clamp + fallbacks', () => {
  it('null heartbeat ts → null (caller renders "?")', () => {
    expect(computeHeartbeatAgeSeconds(null, NOW)).toBeNull();
  });

  it('undefined heartbeat ts → null', () => {
    expect(computeHeartbeatAgeSeconds(undefined, NOW)).toBeNull();
  });

  it('empty string heartbeat ts → null (falsy short-circuit)', () => {
    expect(computeHeartbeatAgeSeconds('', NOW)).toBeNull();
  });

  it('non-parseable timestamp → null (NaN guard)', () => {
    expect(computeHeartbeatAgeSeconds('garbage-not-a-date', NOW)).toBeNull();
  });

  it('heartbeat 3s ago → 3', () => {
    const ts = new Date(NOW - 3_000).toISOString();
    expect(computeHeartbeatAgeSeconds(ts, NOW)).toBe(3);
  });

  it('heartbeat 60s ago → 60 (boundary of fresh window)', () => {
    const ts = new Date(NOW - 60_000).toISOString();
    expect(computeHeartbeatAgeSeconds(ts, NOW)).toBe(60);
  });

  it('heartbeat 5 minutes ago → 300', () => {
    const ts = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(computeHeartbeatAgeSeconds(ts, NOW)).toBe(300);
  });

  it('heartbeat exactly now → 0 (not negative)', () => {
    const ts = new Date(NOW).toISOString();
    expect(computeHeartbeatAgeSeconds(ts, NOW)).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /*  The 2026-04-28 negative-skew bug — primary regression coverage     */
  /* ------------------------------------------------------------------ */

  it('Pi clock 1s ahead of browser → 0, not -1 (the headline bug)', () => {
    // Pi heartbeat ts is 1 second in the future from the browser's
    // wall clock. Pre-fix this rendered as "last hb -1s ago".
    const ts = new Date(NOW + 1_000).toISOString();
    expect(computeHeartbeatAgeSeconds(ts, NOW)).toBe(0);
  });

  it('Pi clock 30s ahead → 0 (still clamps, no leakage)', () => {
    const ts = new Date(NOW + 30_000).toISOString();
    const result = computeHeartbeatAgeSeconds(ts, NOW);
    expect(result).toBe(0);
    expect(result).not.toBeLessThan(0);
  });

  it('regression: pre-fix would have returned a negative value here', () => {
    // Sanity check that the function never returns < 0 for ANY future ts.
    // If a refactor accidentally drops the clamp, this test pins the
    // behavior that the rendered string ("0s ago" / "just now") never
    // shows the confusing negative.
    const futureTs = new Date(NOW + 5_000).toISOString();
    const result = computeHeartbeatAgeSeconds(futureTs, NOW);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThanOrEqual(0);
  });

  /* ------------------------------------------------------------------ */
  /*  Defaulting nowMs                                                   */
  /* ------------------------------------------------------------------ */

  it('default nowMs uses Date.now() (no second argument)', () => {
    // Use a freshly minted ts and assert the result is small + finite.
    // Don't pin an exact value because Date.now() races with the call.
    const ts = new Date().toISOString();
    const ageA = computeHeartbeatAgeSeconds(ts);
    expect(ageA).not.toBeNull();
    expect(ageA as number).toBeGreaterThanOrEqual(0);
    expect(ageA as number).toBeLessThan(2);
  });
});
