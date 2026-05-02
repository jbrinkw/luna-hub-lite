import { describe, expect, it } from 'vitest';
import { aggregateLogsByProduct, type AggregableLog } from '@/shared/aggregateLogs';

const makeLog = (overrides: Partial<AggregableLog> & { log_id: string; created_at: string }): AggregableLog => ({
  log_id: overrides.log_id,
  // `??` would fold null → 'p1' which loses the null-orphan test case;
  // use an explicit "key present?" check.
  product_id: 'product_id' in overrides ? overrides.product_id : 'p1',
  qty_consumed: overrides.qty_consumed ?? 1,
  unit: overrides.unit ?? 'serving',
  calories: overrides.calories ?? 100,
  protein: overrides.protein ?? 10,
  carbs: overrides.carbs ?? 20,
  fat: overrides.fat ?? 3,
  created_at: overrides.created_at,
  products: overrides.products ?? { name: 'Whole Milk' },
});

describe('aggregateLogsByProduct', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateLogsByProduct([])).toEqual([]);
  });

  it('keeps a single log as a one-element group', () => {
    const log = makeLog({ log_id: 'a', created_at: '2026-05-02T10:00:00Z' });
    const groups = aggregateLogsByProduct([log]);
    expect(groups).toHaveLength(1);
    expect(groups[0].logs).toHaveLength(1);
    expect(groups[0].totalCalories).toBe(100);
  });

  it('merges 4 same-product logs all within 15 min', () => {
    const logs = [
      makeLog({ log_id: 'a', created_at: '2026-05-02T10:00:00Z' }),
      makeLog({ log_id: 'b', created_at: '2026-05-02T10:03:00Z' }),
      makeLog({ log_id: 'c', created_at: '2026-05-02T10:08:00Z' }),
      makeLog({ log_id: 'd', created_at: '2026-05-02T10:14:00Z' }),
    ];
    const groups = aggregateLogsByProduct(logs);
    expect(groups).toHaveLength(1);
    expect(groups[0].logs).toHaveLength(4);
    expect(groups[0].totalCalories).toBe(400);
    expect(groups[0].totalProtein).toBe(40);
    expect(groups[0].totalQty).toBe(4);
    expect(groups[0].anchor.log_id).toBe('a');
  });

  it('splits into separate groups when the gap exceeds 15 min from the anchor', () => {
    // 10:00 anchor, 10:14 still inside, 10:30 starts a new group (>15 min from 10:00)
    const logs = [
      makeLog({ log_id: 'a', created_at: '2026-05-02T10:00:00Z' }),
      makeLog({ log_id: 'b', created_at: '2026-05-02T10:14:00Z' }),
      makeLog({ log_id: 'c', created_at: '2026-05-02T10:30:00Z' }),
    ];
    const groups = aggregateLogsByProduct(logs);
    expect(groups).toHaveLength(2);
    expect(groups[0].logs.map((l) => l.log_id)).toEqual(['a', 'b']);
    expect(groups[1].logs.map((l) => l.log_id)).toEqual(['c']);
  });

  it('does NOT merge across different product_ids even within 15 min', () => {
    const logs = [
      makeLog({ log_id: 'a', product_id: 'milk', created_at: '2026-05-02T10:00:00Z' }),
      makeLog({ log_id: 'b', product_id: 'cheese', created_at: '2026-05-02T10:02:00Z' }),
      makeLog({ log_id: 'c', product_id: 'milk', created_at: '2026-05-02T10:04:00Z' }),
    ];
    const groups = aggregateLogsByProduct(logs);
    // milk-cheese-milk → 3 separate groups (the second milk doesn't merge with
    // the first because they're not consecutive after the cheese row).
    expect(groups).toHaveLength(3);
  });

  it('treats null product_id as un-mergeable (orphan logs always stand alone)', () => {
    const logs = [
      makeLog({ log_id: 'a', product_id: null, created_at: '2026-05-02T10:00:00Z' }),
      makeLog({ log_id: 'b', product_id: null, created_at: '2026-05-02T10:01:00Z' }),
    ];
    const groups = aggregateLogsByProduct(logs);
    expect(groups).toHaveLength(2);
  });

  it('sorts unsorted input before grouping (anchor is always the oldest)', () => {
    const logs = [
      makeLog({ log_id: 'late', created_at: '2026-05-02T10:14:00Z' }),
      makeLog({ log_id: 'early', created_at: '2026-05-02T10:00:00Z' }),
      makeLog({ log_id: 'mid', created_at: '2026-05-02T10:05:00Z' }),
    ];
    const groups = aggregateLogsByProduct(logs);
    expect(groups).toHaveLength(1);
    expect(groups[0].anchor.log_id).toBe('early');
    expect(groups[0].logs.map((l) => l.log_id)).toEqual(['early', 'mid', 'late']);
  });
});
