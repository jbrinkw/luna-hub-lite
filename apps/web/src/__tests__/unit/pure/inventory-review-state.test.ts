/**
 * Mutation-hardening tests for InventoryPage's pure helpers:
 *
 *   - computeReviewState: the Review (N) deep-link builder. XSS-adjacent
 *     because the stored `lan_ip` is interpolated into an `<a href>`.
 *   - pickLatestAutomatedSource: the source-pill selection algorithm.
 *
 * Before the extraction these lived inline inside `useMemo` callbacks with
 * no coverage. Every branch below corresponds to a concrete mutation that
 * would ship silently otherwise.
 */
import { describe, it, expect } from 'vitest';
import { computeReviewState, pickLatestAutomatedSource } from '@/pages/chefbyte/InventoryPage';

/* ================================================================== */
/*  computeReviewState                                                  */
/* ================================================================== */

describe('computeReviewState — pending count totalling', () => {
  it('returns 0 and disables the button when there are no devices', () => {
    const res = computeReviewState([]);
    expect(res.pendingReviewTotal).toBe(0);
    expect(res.reviewUrl).toBeNull();
    expect(res.reviewDisabledReason).toBe('Set LAN IP in Settings → Scales');
  });

  it('sums pending counts across multiple devices', () => {
    // A mutation that dropped the reduce (e.g. `.length` instead of summing)
    // would collapse 5+7+3 = 15 to 3. A mutation that ignored the ??0 would
    // yield NaN for the null device and poison the total.
    const res = computeReviewState([
      { lan_ip: null, pending_review_count: 5, last_heartbeat_ts: null },
      { lan_ip: null, pending_review_count: 7, last_heartbeat_ts: null },
      { lan_ip: null, pending_review_count: null, last_heartbeat_ts: null },
      { lan_ip: null, pending_review_count: 3, last_heartbeat_ts: null },
    ]);
    expect(res.pendingReviewTotal).toBe(15);
  });

  it('treats null pending_review_count as 0 (??0 must be present)', () => {
    const res = computeReviewState([{ lan_ip: null, pending_review_count: null, last_heartbeat_ts: null }]);
    expect(res.pendingReviewTotal).toBe(0);
    expect(Number.isNaN(res.pendingReviewTotal)).toBe(false);
  });
});

describe('computeReviewState — URL construction & guard', () => {
  it('picks the most-recently-heartbeated device (descending by ts)', () => {
    // A mutation flipping the sort direction (tb-ta → ta-tb) would pick
    // 10.0.0.1 instead of 10.0.0.9 here.
    const res = computeReviewState([
      { lan_ip: '10.0.0.1', pending_review_count: 0, last_heartbeat_ts: '2026-01-01T00:00:00Z' },
      { lan_ip: '10.0.0.9', pending_review_count: 0, last_heartbeat_ts: '2026-04-01T00:00:00Z' },
      { lan_ip: '10.0.0.5', pending_review_count: 0, last_heartbeat_ts: '2026-02-15T00:00:00Z' },
    ]);
    expect(res.reviewUrl).toBe('http://10.0.0.9:8000/inventory#review');
    expect(res.reviewDisabledReason).toBeNull();
  });

  it('excludes devices with null or empty lan_ip before picking', () => {
    // A mutation dropping the `.filter(d => d.lan_ip && d.lan_ip.trim() !== '')`
    // would pick the null-IP device (most recent) and produce the literal
    // string "http://null:8000/..." — a clickable broken link.
    const res = computeReviewState([
      { lan_ip: null, pending_review_count: 0, last_heartbeat_ts: '2026-04-10T00:00:00Z' },
      { lan_ip: '', pending_review_count: 0, last_heartbeat_ts: '2026-04-05T00:00:00Z' },
      { lan_ip: '192.168.0.50', pending_review_count: 0, last_heartbeat_ts: '2026-03-01T00:00:00Z' },
    ]);
    expect(res.reviewUrl).toBe('http://192.168.0.50:8000/inventory#review');
  });

  it('refuses to build a URL when the stored IP fails isValidLanIp (XSS fence)', () => {
    // Load-bearing: the stored value is interpolated into an href. A mutation
    // that removed the `isValidLanIp` re-validation would produce
    //   href="http://javascript://evil.com:8000/..."
    // which browsers still honor as a scheme-injection vector.
    const res = computeReviewState([
      {
        lan_ip: 'javascript://evil.com',
        pending_review_count: 0,
        last_heartbeat_ts: '2026-04-01T00:00:00Z',
      },
    ]);
    expect(res.reviewUrl).toBeNull();
    expect(res.reviewDisabledReason).toBe('Invalid LAN IP — update in Settings → Scales');
  });

  it('distinguishes "no device with IP" from "device with invalid IP" (copy must differ)', () => {
    // The two disabled-button reasons guide the user to different fixes.
    // If a mutation collapsed the branches (always return the same string),
    // users wouldn't know which device to go fix.
    const noDevice = computeReviewState([]);
    const badIp = computeReviewState([
      {
        lan_ip: 'http://evil.com',
        pending_review_count: 0,
        last_heartbeat_ts: null,
      },
    ]);
    expect(noDevice.reviewDisabledReason).toBe('Set LAN IP in Settings → Scales');
    expect(badIp.reviewDisabledReason).toBe('Invalid LAN IP — update in Settings → Scales');
    expect(noDevice.reviewDisabledReason).not.toBe(badIp.reviewDisabledReason);
  });

  it('builds the exact expected URL format (http scheme, :8000 port, #review fragment)', () => {
    // Catches mutations to any of: scheme (http → https), port (8000 → 80),
    // path (/inventory → /), fragment (#review → #new).
    const res = computeReviewState([{ lan_ip: '192.168.1.1', pending_review_count: 0, last_heartbeat_ts: null }]);
    expect(res.reviewUrl).toBe('http://192.168.1.1:8000/inventory#review');
  });

  it('treats missing last_heartbeat_ts as oldest (0ms), so IP-bearing devices with a ts win', () => {
    // A mutation that changed the missing-ts fallback from 0 to Date.now()
    // would promote ts-less devices to the top and pick the wrong IP.
    const res = computeReviewState([
      { lan_ip: '10.0.0.1', pending_review_count: 0, last_heartbeat_ts: null },
      { lan_ip: '10.0.0.2', pending_review_count: 0, last_heartbeat_ts: '2026-04-01T00:00:00Z' },
    ]);
    expect(res.reviewUrl).toBe('http://10.0.0.2:8000/inventory#review');
  });

  it('does not mutate the input array (defensive — caller may reuse)', () => {
    // The old inline code called `.sort()` directly on the filtered array.
    // The extracted helper takes a ReadonlyArray and copies before sort —
    // a mutation back to in-place sort would reorder React Query cached data.
    const devices = [
      { lan_ip: '10.0.0.1', pending_review_count: 0, last_heartbeat_ts: '2026-01-01T00:00:00Z' },
      { lan_ip: '10.0.0.2', pending_review_count: 0, last_heartbeat_ts: '2026-04-01T00:00:00Z' },
    ];
    const snapshot = devices.map((d) => d.lan_ip);
    computeReviewState(devices);
    expect(devices.map((d) => d.lan_ip)).toEqual(snapshot);
  });
});

/* ================================================================== */
/*  pickLatestAutomatedSource                                           */
/* ================================================================== */

describe('pickLatestAutomatedSource', () => {
  it('returns null when there are no lots', () => {
    expect(pickLatestAutomatedSource([])).toEqual({
      latestSource: null,
      latestSourceTs: null,
    });
  });

  it('returns null when every lot has a null source', () => {
    const res = pickLatestAutomatedSource([
      { last_update_source: null, last_update_ts: '2026-04-10T00:00:00Z' },
      { last_update_source: null, last_update_ts: null },
    ]);
    expect(res.latestSource).toBeNull();
  });

  it("excludes 'manual' sources — pill is reserved for automated tags", () => {
    // A mutation that accepted 'manual' would light up the pill for
    // user-edited lots and clobber the UI invariant that manual entries
    // have no badge.
    const res = pickLatestAutomatedSource([{ last_update_source: 'manual', last_update_ts: '2026-04-10T00:00:00Z' }]);
    expect(res.latestSource).toBeNull();
  });

  it('picks the max-ts automated source (not the first seen)', () => {
    // A mutation to the `l.last_update_ts > latestSourceTs` comparator
    // (e.g. flipped to <) would pick the oldest lot's source instead.
    const res = pickLatestAutomatedSource([
      { last_update_source: 'live_shelf', last_update_ts: '2026-01-01T00:00:00Z' },
      { last_update_source: 'live_scale', last_update_ts: '2026-04-01T00:00:00Z' },
      { last_update_source: 'catch_all', last_update_ts: '2026-02-15T00:00:00Z' },
    ]);
    expect(res.latestSource).toBe('live_scale');
    expect(res.latestSourceTs).toBe('2026-04-01T00:00:00Z');
  });

  it('prefers any ts-carrying lot over a ts-less fallback, regardless of iteration order', () => {
    // The ts-less fallback only "sticks" when no ts-bearing lot has ever
    // been seen. If a mutation swapped the precedence, a stale legacy
    // row with null ts would overwrite a fresh live_shelf tag.
    const res = pickLatestAutomatedSource([
      { last_update_source: 'live_shelf', last_update_ts: '2026-04-01T00:00:00Z' },
      { last_update_source: 'catch_all', last_update_ts: null }, // legacy row
    ]);
    expect(res.latestSource).toBe('live_shelf');
  });

  it('falls back to a ts-less automated source when NO ts-carrying source exists', () => {
    const res = pickLatestAutomatedSource([
      { last_update_source: 'catch_all', last_update_ts: null },
      { last_update_source: 'manual', last_update_ts: '2026-04-01T00:00:00Z' },
    ]);
    expect(res.latestSource).toBe('catch_all');
    expect(res.latestSourceTs).toBeNull();
  });

  it("handles mixed manual + automated — picks the automated tag's ts", () => {
    const res = pickLatestAutomatedSource([
      { last_update_source: 'manual', last_update_ts: '2026-04-10T00:00:00Z' },
      { last_update_source: 'live_shelf', last_update_ts: '2026-04-05T00:00:00Z' },
    ]);
    // Manual is newer but excluded → latestSource is live_shelf w/ its own ts.
    expect(res.latestSource).toBe('live_shelf');
    expect(res.latestSourceTs).toBe('2026-04-05T00:00:00Z');
  });
});
