import { describe, it, expect } from 'vitest';

/**
 * Pure keypad logic extracted from ScannerPage handleKeypadClick.
 * Tests double-decimal prevention, decimal with overwriteNext, backspace to '0'.
 */

type KeypadState = { screenValue: string; overwriteNext: boolean };

function handleKeypadClick(state: KeypadState, key: string): KeypadState {
  if (key === '←') {
    return {
      screenValue: state.screenValue.slice(0, -1) || '0',
      overwriteNext: false,
    };
  } else if (key === '.') {
    if (state.overwriteNext) {
      return { screenValue: '0.', overwriteNext: false };
    } else if (!state.screenValue.includes('.')) {
      return { screenValue: state.screenValue + '.', overwriteNext: false };
    }
    // Double decimal — no-op
    return state;
  } else {
    if (state.overwriteNext) {
      return { screenValue: key, overwriteNext: false };
    } else {
      return {
        screenValue: state.screenValue === '0' ? key : state.screenValue + key,
        overwriteNext: false,
      };
    }
  }
}

/** Unit toggle conversion: serving ↔ container */
function toggleUnit(
  currentUnit: 'serving' | 'container',
  currentQty: number,
  spc: number,
): { unit: 'serving' | 'container'; qty: number } {
  if (currentUnit === 'serving') {
    return { unit: 'container', qty: parseFloat((currentQty / Math.max(spc, 0.001)).toFixed(3)) };
  } else {
    return { unit: 'serving', qty: parseFloat((currentQty * spc).toFixed(3)) };
  }
}

describe('Keypad logic', () => {
  it('digit replaces value when overwriteNext is true', () => {
    const result = handleKeypadClick({ screenValue: '1', overwriteNext: true }, '5');
    expect(result).toEqual({ screenValue: '5', overwriteNext: false });
  });

  it('digit appends when overwriteNext is false', () => {
    const result = handleKeypadClick({ screenValue: '5', overwriteNext: false }, '3');
    expect(result).toEqual({ screenValue: '53', overwriteNext: false });
  });

  it('digit replaces leading 0', () => {
    const result = handleKeypadClick({ screenValue: '0', overwriteNext: false }, '7');
    expect(result).toEqual({ screenValue: '7', overwriteNext: false });
  });

  it('decimal with overwriteNext starts "0."', () => {
    const result = handleKeypadClick({ screenValue: '1', overwriteNext: true }, '.');
    expect(result).toEqual({ screenValue: '0.', overwriteNext: false });
  });

  it('decimal appends to value', () => {
    const result = handleKeypadClick({ screenValue: '3', overwriteNext: false }, '.');
    expect(result).toEqual({ screenValue: '3.', overwriteNext: false });
  });

  it('double decimal is prevented (no-op)', () => {
    const state: KeypadState = { screenValue: '3.5', overwriteNext: false };
    const result = handleKeypadClick(state, '.');
    expect(result).toBe(state); // Same reference — no-op
  });

  it('backspace removes last character', () => {
    const result = handleKeypadClick({ screenValue: '53', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '5', overwriteNext: false });
  });

  it('backspace on single character returns "0"', () => {
    const result = handleKeypadClick({ screenValue: '5', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '0', overwriteNext: false });
  });

  it('backspace on "0" stays "0"', () => {
    const result = handleKeypadClick({ screenValue: '0', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '0', overwriteNext: false });
  });

  it('backspace clears overwriteNext', () => {
    const result = handleKeypadClick({ screenValue: '53', overwriteNext: true }, '←');
    expect(result.overwriteNext).toBe(false);
  });

  it('multi-digit entry after overwrite', () => {
    let state: KeypadState = { screenValue: '1', overwriteNext: true };
    state = handleKeypadClick(state, '2'); // overwrite → '2'
    state = handleKeypadClick(state, '5'); // append → '25'
    state = handleKeypadClick(state, '.'); // append → '25.'
    state = handleKeypadClick(state, '3'); // append → '25.3'
    expect(state.screenValue).toBe('25.3');
  });
});

describe('Unit toggle conversion', () => {
  it('serving → container divides by spc', () => {
    const result = toggleUnit('serving', 4, 2);
    expect(result).toEqual({ unit: 'container', qty: 2 });
  });

  it('container → serving multiplies by spc', () => {
    const result = toggleUnit('container', 2, 4);
    expect(result).toEqual({ unit: 'serving', qty: 8 });
  });

  it('round-trips correctly', () => {
    let r = toggleUnit('serving', 3, 4); // 3 servings → 0.75 containers
    expect(r).toEqual({ unit: 'container', qty: 0.75 });
    r = toggleUnit('container', r.qty, 4); // 0.75 containers → 3 servings
    expect(r).toEqual({ unit: 'serving', qty: 3 });
  });

  it('handles spc=1 (no conversion)', () => {
    const result = toggleUnit('serving', 5, 1);
    expect(result).toEqual({ unit: 'container', qty: 5 });
  });

  it('handles fractional spc', () => {
    const result = toggleUnit('serving', 3, 1.5);
    expect(result).toEqual({ unit: 'container', qty: 2 });
  });
});
