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
import { computeReviewState, pickLatestAutomatedSource, shouldShowLotSourcePill } from '@/pages/chefbyte/InventoryPage';

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
    // The product must be passed as paired so the live_scale row isn't
    // suppressed by the post-2026-04-27 stale-tag gate.
    // catch_all row carries in-flight context so it can compete (the
    // post-2026-05-15 gate strips historical catch_all rows).
    const res = pickLatestAutomatedSource(
      [
        { last_update_source: 'live_shelf', last_update_ts: '2026-01-01T00:00:00Z' },
        { last_update_source: 'live_scale', last_update_ts: '2026-04-01T00:00:00Z' },
        {
          last_update_source: 'catch_all',
          last_update_ts: '2026-02-15T00:00:00Z',
          in_flight_kind: 'catch_all',
          in_flight_since: '2026-02-15T00:00:00Z',
        },
      ],
      'p1',
      new Set(['p1']),
    );
    expect(res.latestSource).toBe('live_scale');
    expect(res.latestSourceTs).toBe('2026-04-01T00:00:00Z');
  });

  it('prefers any ts-carrying lot over a ts-less fallback, regardless of iteration order', () => {
    // The ts-less fallback only "sticks" when no ts-bearing lot has ever
    // been seen. If a mutation swapped the precedence, a stale legacy
    // row with null ts would overwrite a fresh live_shelf tag.
    // Catch_all row is currently in-flight on the catch-all so it's
    // eligible to compete (without that gate it'd be stripped first).
    const res = pickLatestAutomatedSource([
      { last_update_source: 'live_shelf', last_update_ts: '2026-04-01T00:00:00Z' },
      {
        last_update_source: 'catch_all',
        last_update_ts: null,
        in_flight_kind: 'catch_all',
        in_flight_since: '2026-04-02T00:00:00Z',
      },
    ]);
    expect(res.latestSource).toBe('live_shelf');
  });

  it('falls back to a ts-less automated source when NO ts-carrying source exists', () => {
    // Catch_all surfacing requires CURRENT in-flight on the catch-all.
    const res = pickLatestAutomatedSource([
      {
        last_update_source: 'catch_all',
        last_update_ts: null,
        in_flight_kind: 'catch_all',
        in_flight_since: '2026-04-01T00:00:01Z',
      },
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

  // -----------------------------------------------------------------------
  // live_scale gating against scale_pairings — root cause C / B from the
  // 2026-04-27 fix(chefbyte/inventory) bug. A lot's last_update_source can
  // remain 'live_scale' indefinitely after the device pairing is removed.
  // Without the paired-set gate the badge fires forever; with it, the badge
  // disappears as soon as the pairing row goes away (or never existed).
  // -----------------------------------------------------------------------

  it('suppresses live_scale tag when product is NOT in the live-scale paired set', () => {
    // Mutation that dropped the gate (`return source !== 'manual'`) would
    // resurrect the stale-tag bug — chicken with last_update_source=live_scale
    // from 5 days ago, but no current scale_pairings row, would still light
    // up the badge.
    const res = pickLatestAutomatedSource(
      [{ last_update_source: 'live_scale', last_update_ts: '2026-04-22T14:39:00Z' }],
      'product-chicken',
      new Set(), // no pairings — the badge MUST go away
    );
    expect(res.latestSource).toBeNull();
    expect(res.latestSourceTs).toBeNull();
  });

  it('keeps live_scale tag when product IS in the live-scale paired set', () => {
    // The legitimate path: chocolate milk has a fresh scale_pairings row and
    // a live_scale lot tag — badge SHOULD fire.
    const res = pickLatestAutomatedSource(
      [{ last_update_source: 'live_scale', last_update_ts: '2026-04-27T19:59:05Z' }],
      'product-choco-milk',
      new Set(['product-choco-milk']),
    );
    expect(res.latestSource).toBe('live_scale');
    expect(res.latestSourceTs).toBe('2026-04-27T19:59:05Z');
  });

  it('falls through to a still-valid live_shelf tag when live_scale is suppressed', () => {
    // A product can have BOTH a stale live_scale lot tag AND a current
    // live_shelf tag (it sits on the multi-item shelf now). The stale
    // live_scale must be skipped and the live_shelf badge must surface,
    // not "no badge."
    const res = pickLatestAutomatedSource(
      [
        { last_update_source: 'live_scale', last_update_ts: '2026-04-22T00:00:00Z' }, // stale, suppressed
        { last_update_source: 'live_shelf', last_update_ts: '2026-04-26T00:00:00Z' }, // newer, kept
      ],
      'product-id',
      new Set(), // not paired to any live scale right now
    );
    expect(res.latestSource).toBe('live_shelf');
    expect(res.latestSourceTs).toBe('2026-04-26T00:00:00Z');
  });

  it('does NOT suppress live_shelf when the product is unpaired', () => {
    // Defence against a mutation that broadens the live_scale paired-set
    // gate to live_shelf. live_shelf is a device-level source so the
    // paired-set check must never apply to it.
    const res = pickLatestAutomatedSource(
      [{ last_update_source: 'live_shelf', last_update_ts: '2026-04-27T00:00:00Z' }],
      'product-id',
      new Set(), // empty paired set — must NOT suppress live_shelf
    );
    expect(res.latestSource).toBe('live_shelf');
  });

  // -----------------------------------------------------------------------
  // catch_all gating against current in-flight state (2026-05-15 rule).
  // `last_update_source='catch_all'` is HISTORICAL — the column records
  // "this lot was last touched by a catch-all event at some point in the
  // past" and that signal persists forever. The pill must only surface
  // when the SAME lot is currently in flight on the catch-all
  // (`in_flight_kind='catch_all'` AND `in_flight_since IS NOT NULL`).
  // The pill must vanish the moment the pickup resolves
  // (returned / consumed / discarded → cloud nulls both fields).
  // -----------------------------------------------------------------------

  it('surfaces catch_all when the lot is CURRENTLY in flight on the catch-all', () => {
    // The positive case: lot is right now off the catch-all and not yet
    // reconciled. Pill should fire.
    const res = pickLatestAutomatedSource([
      {
        last_update_source: 'catch_all',
        last_update_ts: '2026-05-15T12:00:00Z',
        in_flight_kind: 'catch_all',
        in_flight_since: '2026-05-15T12:00:00Z',
      },
    ]);
    expect(res.latestSource).toBe('catch_all');
    expect(res.latestSourceTs).toBe('2026-05-15T12:00:00Z');
  });

  it('SUPPRESSES catch_all when last_update_source=catch_all but in_flight_since IS NULL (historical row)', () => {
    // The load-bearing bug fix: a lot was once catch-all-touched (e.g.
    // tare-captured weeks ago) and now sits quietly on the shelf. The
    // pill must NOT fire — `last_update_source='catch_all'` alone is a
    // historical audit marker. Mutation: dropping the in_flight_since
    // check would resurrect the bug (pill stays lit forever).
    const res = pickLatestAutomatedSource([
      {
        last_update_source: 'catch_all',
        last_update_ts: '2026-04-01T00:00:00Z',
        in_flight_kind: null,
        in_flight_since: null,
      },
    ]);
    expect(res.latestSource).toBeNull();
    expect(res.latestSourceTs).toBeNull();
  });

  it('SUPPRESSES catch_all when the lot is in flight on a DIFFERENT kind (e.g. live_shelf)', () => {
    // Edge case: a lot can be in_flight from a live_shelf pickup AND its
    // last_update_source can still be 'catch_all' (e.g. tare was captured
    // on the catch-all, then the bottle was placed on the live shelf and
    // is now picked up off it). The catch-all pill must NOT fire — the
    // CURRENT pickup didn't come from the catch-all. Mutation: ignoring
    // in_flight_kind would surface catch_all whenever the lot is in flight
    // for ANY reason.
    const res = pickLatestAutomatedSource([
      {
        last_update_source: 'catch_all',
        last_update_ts: '2026-05-15T12:00:00Z',
        in_flight_kind: 'live_shelf',
        in_flight_since: '2026-05-15T12:00:00Z',
      },
    ]);
    expect(res.latestSource).toBeNull();
  });

  it('falls back to a still-valid live_shelf tag when historical catch_all is suppressed', () => {
    // Parallels the live_scale fall-through test: when the catch_all gate
    // rejects a historical row, sibling lots with other automated tags
    // must still surface.
    const res = pickLatestAutomatedSource([
      {
        last_update_source: 'catch_all', // historical (no current in-flight)
        last_update_ts: '2026-04-01T00:00:00Z',
        in_flight_kind: null,
        in_flight_since: null,
      },
      { last_update_source: 'live_shelf', last_update_ts: '2026-04-26T00:00:00Z' },
    ]);
    expect(res.latestSource).toBe('live_shelf');
    expect(res.latestSourceTs).toBe('2026-04-26T00:00:00Z');
  });

  it('default args (no in_flight context) treat every catch_all tag as historical → suppressed', () => {
    // Backwards-compat sanity check on default-arg behavior. Callers that
    // don't pass per-lot in_flight_kind/in_flight_since get strict gating
    // (catch_all hidden) — safe-by-default, mirroring the live_scale gate.
    const res = pickLatestAutomatedSource([
      { last_update_source: 'catch_all', last_update_ts: '2026-05-15T00:00:00Z' },
    ]);
    expect(res.latestSource).toBeNull();
  });

  it('default args: empty paired set treats every live_scale tag as stale', () => {
    // Backwards-compat sanity check on the default-arg behavior. Callers
    // that haven't been updated to pass the paired-set get strict gating
    // (no badge), which is the safe-by-default direction.
    const res = pickLatestAutomatedSource([
      { last_update_source: 'live_scale', last_update_ts: '2026-04-27T00:00:00Z' },
    ]);
    expect(res.latestSource).toBeNull();
  });
});

/* ================================================================== */
/*  shouldShowLotSourcePill                                             */
/* ================================================================== */

describe('shouldShowLotSourcePill', () => {
  it('hides null sources', () => {
    expect(shouldShowLotSourcePill(null, 'p', new Set())).toBe(false);
  });

  it('hides manual sources', () => {
    expect(shouldShowLotSourcePill('manual', 'p', new Set())).toBe(false);
  });

  it('shows live_shelf unconditionally (device-level source, not per-product)', () => {
    expect(shouldShowLotSourcePill('live_shelf', 'p', new Set())).toBe(true);
  });

  it('hides live_scale when product is NOT in the paired set', () => {
    // The lots-view counterpart of the grouped-view live_scale gate. A
    // mutation that dropped this guard would resurrect the per-row stale-tag
    // pill seen in the 2026-04-27 bug.
    expect(shouldShowLotSourcePill('live_scale', 'product-chicken', new Set())).toBe(false);
  });

  it('shows live_scale when product IS in the paired set', () => {
    expect(shouldShowLotSourcePill('live_scale', 'product-choco-milk', new Set(['product-choco-milk']))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // catch_all per-lot gating (2026-05-15 rule). Mirrors the
  // pickLatestAutomatedSource gate — see the docstring there for the full
  // rationale. The pill must surface ONLY when the SAME lot is CURRENTLY
  // in flight on the catch-all (in_flight_kind='catch_all' AND
  // in_flight_since IS NOT NULL).
  // -----------------------------------------------------------------------

  it('shows catch_all when the lot is currently in flight on the catch-all', () => {
    // Positive case: in_flight_kind + in_flight_since both prove the lot
    // is RIGHT NOW off the catch-all. Pill MUST fire.
    expect(
      shouldShowLotSourcePill('catch_all', 'p', new Set(), {
        kind: 'catch_all',
        since: '2026-05-15T12:00:00Z',
      }),
    ).toBe(true);
  });

  it('HIDES catch_all when last_update_source=catch_all but in_flight_since IS NULL (historical row)', () => {
    // Load-bearing bug fix: the lot was once touched by a catch-all event
    // (e.g. tare capture weeks ago) but is no longer in flight. Pill MUST
    // NOT fire. Mutation: dropping the in_flight_since check would
    // resurrect the "pill stays lit forever" bug.
    expect(
      shouldShowLotSourcePill('catch_all', 'p', new Set(), {
        kind: null,
        since: null,
      }),
    ).toBe(false);
  });

  it('HIDES catch_all when the lot is in flight on a DIFFERENT kind (e.g. live_shelf)', () => {
    // Edge case: lot is in_flight from a live_shelf pickup, but
    // last_update_source is still 'catch_all' (e.g. tare was captured on
    // the catch-all, bottle now lives on the shelf, just picked up off
    // shelf). Catch-all pill MUST NOT fire — the CURRENT pickup didn't
    // come from the catch-all. Mutation: ignoring in_flight_kind would
    // surface catch_all whenever the lot is in flight for ANY reason.
    expect(
      shouldShowLotSourcePill('catch_all', 'p', new Set(), {
        kind: 'live_shelf',
        since: '2026-05-15T12:00:00Z',
      }),
    ).toBe(false);
  });

  it('default in-flight arg (omitted) treats every catch_all as historical → hidden', () => {
    // Backwards-compat sanity: callers that don't pass the in_flight arg
    // get safe-by-default behaviour. Mirrors the live_scale default-arg
    // test above.
    expect(shouldShowLotSourcePill('catch_all', 'p', new Set())).toBe(false);
  });
});
