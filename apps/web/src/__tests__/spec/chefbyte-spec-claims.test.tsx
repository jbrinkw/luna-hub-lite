/**
 * Spec-vs-implementation tests — ChefByte
 *
 * Each test drives a REAL imported production symbol so it can turn RED when
 * that symbol regresses. Earlier revisions of this file re-implemented the
 * helpers inline and asserted the COPY (or asserted JS-stdlib behaviour like
 * `Math.ceil`/`toFixed`), which could never fail for a production change. Those
 * tautological claims were removed; the falsifiable ones now import the
 * shipped functions.
 *
 * Spec claims with a real web hook (pinned here):
 *   • ilike search escapes %, _, \  → escapeIlike (src/shared/supabase.ts)
 *   • pickEarliestInFlight           → src/pages/chefbyte/InventoryPage.tsx
 *   • isLotOnScale / in-flight + qty  → src/pages/chefbyte/InventoryPage.tsx
 *
 * Spec claims with NO falsifiable web symbol (intentionally NOT faked — a
 * re-implemented copy or a `Math.ceil(1.1) === 2` stdlib assertion gives false
 * coverage; these are enforced/covered elsewhere):
 *   • Inventory default viewMode 'grouped' — inline `useState<ViewMode>('grouped')`
 *     render detail; covered by InventoryPage render/e2e tests.
 *   • Quantities displayed to 1 decimal — inline `Number(x).toFixed(1)` at call
 *     sites, no exported formatter; this is a JS-stdlib fact, not prod logic.
 *   • Stock floors at 0 — enforced by the `stock_lots_qty_nonneg` CHECK + the
 *     `consume_product` SQL floor; covered by pgTAP, not web arithmetic.
 *   • Shopping qty rounded up — inline `Math.ceil(...)` at call sites, no
 *     exported helper; the spec rule is a stdlib fact here.
 *   • Barcode nullable / lot merge key (product+location+expires) — DB schema
 *     facts; the merge happens in `add_stock`/`consume` SQL. Covered by pgTAP.
 */

import { describe, it, expect } from 'vitest';
import { escapeIlike } from '@/shared/supabase';
import { pickEarliestInFlight, isLotOnScale, ON_SCALE_QTY_EPSILON } from '@/pages/chefbyte/InventoryPage';

// =========================================================================
// ilike search escapes %, _, \ before passing to Supabase
//   real symbol: escapeIlike — prevents a user-typed `%` from matching all
//   rows (and a `\` from breaking the ILIKE escape sequence).
// =========================================================================

describe('spec: ilike search escapes special characters (escapeIlike)', () => {
  it('escapes % to prevent wildcard match-all', () => {
    expect(escapeIlike('%')).toBe('\\%');
  });

  it('escapes _ to prevent single-char wildcard', () => {
    expect(escapeIlike('a_b')).toBe('a\\_b');
  });

  it('escapes \\ (backslash — the ILIKE escape char)', () => {
    expect(escapeIlike('a\\b')).toBe('a\\\\b');
  });

  it('leaves normal text unchanged', () => {
    expect(escapeIlike('chicken soup')).toBe('chicken soup');
  });

  it('combined: all three special chars in one string', () => {
    expect(escapeIlike('%_\\')).toBe('\\%\\_\\\\');
  });
});

// =========================================================================
// pickEarliestInFlight — real exported helper from InventoryPage
//   Earliest in_flight_since wins so the in-flight badge reflects the
//   longest-outstanding pickup; null when nothing is in flight.
// =========================================================================

describe('spec: pickEarliestInFlight (real InventoryPage helper)', () => {
  it('returns null when no lots are in flight', () => {
    expect(pickEarliestInFlight([{ in_flight_since: null }, { in_flight_since: null }])).toBeNull();
  });

  it('returns the EARLIEST in_flight_since across lots (not the first encountered)', () => {
    const lots = [
      { in_flight_since: '2026-04-30T10:00:00Z' },
      { in_flight_since: '2026-04-30T08:00:00Z' }, // earlier — must win
      { in_flight_since: null },
    ];
    expect(pickEarliestInFlight(lots)).toBe('2026-04-30T08:00:00Z');
  });

  it('ignores null entries and returns the only in-flight timestamp', () => {
    const lots = [{ in_flight_since: null }, { in_flight_since: '2026-04-29T12:00:00Z' }];
    expect(pickEarliestInFlight(lots)).toBe('2026-04-29T12:00:00Z');
  });
});

// =========================================================================
// isLotOnScale — real exported helper from InventoryPage
//   "On Scale" iff paired AND not in-flight AND qty >= ON_SCALE_QTY_EPSILON.
//   An in-flight bottle is physically elsewhere → NOT on scale even if paired.
//   A paired lot at sub-epsilon residual qty is treated as not-on-scale
//   (phantom-empty guard; threshold MUST equal the cloud rotation threshold).
// =========================================================================

describe('spec: isLotOnScale (real InventoryPage helper)', () => {
  const pairedLotIds = new Set(['lot-paired']);

  it('exposes the residual-qty epsilon as 0.01 (must match cloud rotation threshold)', () => {
    expect(ON_SCALE_QTY_EPSILON).toBe(0.01);
  });

  it('paired + not in-flight + qty above epsilon → on scale', () => {
    expect(isLotOnScale({ lot_id: 'lot-paired', in_flight_since: null, qty_containers: 1 }, pairedLotIds)).toBe(true);
  });

  it('paired + in-flight → NOT on scale (bottle is physically elsewhere)', () => {
    expect(
      isLotOnScale({ lot_id: 'lot-paired', in_flight_since: '2026-04-30T10:00:00Z', qty_containers: 1 }, pairedLotIds),
    ).toBe(false);
  });

  it('not paired → never on scale', () => {
    expect(isLotOnScale({ lot_id: 'lot-unpaired', in_flight_since: null, qty_containers: 1 }, pairedLotIds)).toBe(
      false,
    );
  });

  it('paired but zero-qty (below epsilon) → not on scale (phantom-empty guard)', () => {
    expect(isLotOnScale({ lot_id: 'lot-paired', in_flight_since: null, qty_containers: 0 }, pairedLotIds)).toBe(false);
  });

  it('qty exactly AT the epsilon (0.01) is treated as on scale (boundary is strict <)', () => {
    // Production uses `q < ON_SCALE_QTY_EPSILON` → exactly-epsilon is on-scale.
    // Pins the boundary direction so a flip to `<=` would go RED.
    expect(
      isLotOnScale({ lot_id: 'lot-paired', in_flight_since: null, qty_containers: ON_SCALE_QTY_EPSILON }, pairedLotIds),
    ).toBe(true);
  });
});
