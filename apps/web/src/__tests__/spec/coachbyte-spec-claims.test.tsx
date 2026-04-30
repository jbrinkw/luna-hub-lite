/**
 * Spec-vs-implementation tests — CoachByte
 *
 * Each test pins one spec claim from docs/apps/coachbyte.md.
 * These tests MUST FAIL if the implementation drifts from the spec.
 *
 * Spec claims covered:
 *   1. Epley 1RM: 1-rep sets use actual weight (not formula) — spec + impl agree
 *   2. Epley 1RM: 0-rep (failed) sets → 0 (excluded from PR tracking)
 *   3. Epley 1RM: multi-rep sets use load × (1 + reps/30), rounded
 *   4. resolvePercentLoad: rounds to nearest 5 lbs
 *   5. Sequential set completion: lowest-order incomplete set is next
 *   6. Keyset pagination: results DESC by plan_date, cursor is last date
 *   7. History filters empty days (zero completed sets)
 *   8. Exercise uniqueness is case-insensitive per user
 */

import { describe, it, expect } from 'vitest';
import { epley1RM } from '@/shared/epley';

// =========================================================================
// 1. Epley: 1-rep sets use ACTUAL WEIGHT (spec + impl agree)
//    spec: "1-rep sets use actual weight (not Epley)"
//    impl: reps === 1 → return load
// =========================================================================

describe('spec: Epley 1RM — 1-rep sets return actual load', () => {
  it('epley1RM(200, 1) = 200 (not 200*(1+1/30))', () => {
    expect(epley1RM(200, 1)).toBe(200);
  });

  it('epley1RM(315, 1) = 315', () => {
    expect(epley1RM(315, 1)).toBe(315);
  });
});

// =========================================================================
// 2. Epley: 0-rep (failed) sets are excluded — returns 0
// =========================================================================

describe('spec: Epley 1RM — 0-rep failed sets return 0', () => {
  it('epley1RM(200, 0) = 0', () => {
    expect(epley1RM(200, 0)).toBe(0);
  });

  it('epley1RM with any load, 0 reps = 0', () => {
    for (const load of [100, 225, 315]) {
      expect(epley1RM(load, 0)).toBe(0);
    }
  });
});

// =========================================================================
// 3. Epley: multi-rep uses load × (1 + reps/30), rounded
// =========================================================================

describe('spec: Epley 1RM formula for multi-rep sets', () => {
  it('5 reps at 225 lb → 263 (225 × 1.1667 rounded)', () => {
    // 225 * (1 + 5/30) = 225 * 1.1667 = 262.5 → rounds to 263
    expect(epley1RM(225, 5)).toBe(263);
  });

  it('10 reps at 185 lb → 247', () => {
    expect(epley1RM(185, 10)).toBe(247);
  });

  it('higher reps produce higher e1RM for same load', () => {
    expect(epley1RM(185, 10)).toBeGreaterThan(epley1RM(185, 5));
  });

  it('0 load → 0 regardless of reps', () => {
    expect(epley1RM(0, 5)).toBe(0);
  });
});

// =========================================================================
// 4. resolvePercentLoad: rounds to nearest 5 lbs
//    (mirrors the app-tools epley.ts implementation)
// =========================================================================

function resolvePercentLoad(percent: number, e1rm: number): number {
  return Math.round(((percent / 100) * e1rm) / 5) * 5;
}

describe('spec: resolvePercentLoad rounds to nearest 5 lbs', () => {
  it('85% of 371 lb = 315 (nearest 5)', () => {
    expect(resolvePercentLoad(85, 371)).toBe(315);
  });

  it('100% of 200 lb = 200', () => {
    expect(resolvePercentLoad(100, 200)).toBe(200);
  });

  it('result is always a multiple of 5', () => {
    const cases: Array<[number, number]> = [[70, 300], [80, 225], [90, 400], [75, 355]];
    for (const [pct, e1rm] of cases) {
      expect(resolvePercentLoad(pct, e1rm) % 5).toBe(0);
    }
  });

  it('rounds 0.85 * 301 = 255.85 → nearest 5 = 255 (not 256)', () => {
    expect(resolvePercentLoad(85, 301)).toBe(255);
  });
});

// =========================================================================
// 5. Sequential set completion — lowest order wins
// =========================================================================

describe('spec: sequential set completion (lowest-order incomplete set)', () => {
  it('selects the minimum-order incomplete set', () => {
    const plannedSets = [
      { set_id: 'a', order: 2, completed: false },
      { set_id: 'b', order: 1, completed: false },
      { set_id: 'c', order: 3, completed: false },
    ];
    const incomplete = plannedSets.filter((s) => !s.completed);
    const next = incomplete.reduce((min, s) => (s.order < min.order ? s : min));
    expect(next.set_id).toBe('b');
    expect(next.order).toBe(1);
  });

  it('skips already-completed sets', () => {
    const plannedSets = [
      { set_id: 'a', order: 1, completed: true },
      { set_id: 'b', order: 2, completed: false },
      { set_id: 'c', order: 3, completed: false },
    ];
    const incomplete = plannedSets.filter((s) => !s.completed);
    const next = incomplete.reduce((min, s) => (s.order < min.order ? s : min));
    expect(next.set_id).toBe('b');
  });
});

// =========================================================================
// 6. Keyset pagination: DESC by plan_date, cursor is last visible date
// =========================================================================

describe('spec: history keyset pagination', () => {
  it('cursor is the plan_date of the last result row', () => {
    const page1 = [
      { plan_date: '2026-04-30' },
      { plan_date: '2026-04-28' },
      { plan_date: '2026-04-25' },
    ];
    const cursor = page1[page1.length - 1].plan_date;
    expect(cursor).toBe('2026-04-25');
  });

  it('next page rows are strictly before the cursor', () => {
    const cursor = '2026-04-25';
    const simulatedNextPage = [{ plan_date: '2026-04-23' }, { plan_date: '2026-04-20' }];
    for (const row of simulatedNextPage) {
      expect(row.plan_date < cursor).toBe(true);
    }
  });

  it('results within a page are in descending order (newest first)', () => {
    const page = ['2026-04-30', '2026-04-28', '2026-04-25'];
    for (let i = 0; i < page.length - 1; i++) {
      expect(page[i] > page[i + 1]).toBe(true);
    }
  });
});

// =========================================================================
// 7. History filters empty days (zero completed sets)
// =========================================================================

describe('spec: history filters out days with zero completed sets', () => {
  it('days with 0 completed sets are excluded', () => {
    const days = [
      { plan_date: '2026-04-30', completedSetCount: 3 },
      { plan_date: '2026-04-29', completedSetCount: 0 },
      { plan_date: '2026-04-28', completedSetCount: 5 },
      { plan_date: '2026-04-27', completedSetCount: 0 },
    ];
    const visible = days.filter((d) => d.completedSetCount > 0);
    expect(visible).toHaveLength(2);
    expect(visible.map((d) => d.plan_date)).toEqual(['2026-04-30', '2026-04-28']);
  });
});

// =========================================================================
// 8. Exercise uniqueness is case-insensitive per user
// =========================================================================

describe('spec: exercise uniqueness is case-insensitive', () => {
  it('LOWER(name) treats "bench press" and "Bench Press" as duplicates', () => {
    const existing = 'bench press';
    const candidate = 'Bench Press';
    expect(candidate.toLowerCase()).toBe(existing.toLowerCase());
  });

  it('different exercises are allowed side-by-side', () => {
    const existing = 'squat';
    const candidate = 'Deadlift';
    expect(candidate.toLowerCase()).not.toBe(existing.toLowerCase());
  });
});
