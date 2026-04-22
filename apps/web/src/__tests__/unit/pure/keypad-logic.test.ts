import { describe, it, expect } from 'vitest';

/**
 * Pure keypad-logic unit tests.
 *
 * These exercise the SAME helpers the ScannerPage component uses (imported
 * from `@/pages/chefbyte/keypadLogic`) rather than a test-local copy, so a
 * regression in the production reducer is actually caught here.
 *
 * ScannerPage's `handleKeypadClick` is a thin adapter around
 * `handleKeypadStep` — it mirrors the returned `overwriteNext` into a ref
 * so same-batch keypresses each see the previous press's output. The step
 * function itself is pure and fully covered below.
 */
import { handleKeypadStep, toggleUnit, type KeypadState } from '@/pages/chefbyte/keypadLogic';

describe('Keypad logic', () => {
  it('digit replaces value when overwriteNext is true', () => {
    const result = handleKeypadStep({ screenValue: '1', overwriteNext: true }, '5');
    expect(result).toEqual({ screenValue: '5', overwriteNext: false });
  });

  it('digit appends when overwriteNext is false', () => {
    const result = handleKeypadStep({ screenValue: '5', overwriteNext: false }, '3');
    expect(result).toEqual({ screenValue: '53', overwriteNext: false });
  });

  it('digit replaces leading 0', () => {
    const result = handleKeypadStep({ screenValue: '0', overwriteNext: false }, '7');
    expect(result).toEqual({ screenValue: '7', overwriteNext: false });
  });

  it('decimal with overwriteNext starts "0."', () => {
    const result = handleKeypadStep({ screenValue: '1', overwriteNext: true }, '.');
    expect(result).toEqual({ screenValue: '0.', overwriteNext: false });
  });

  it('decimal appends to value', () => {
    const result = handleKeypadStep({ screenValue: '3', overwriteNext: false }, '.');
    expect(result).toEqual({ screenValue: '3.', overwriteNext: false });
  });

  it('double decimal is prevented (no-op)', () => {
    const state: KeypadState = { screenValue: '3.5', overwriteNext: false };
    const result = handleKeypadStep(state, '.');
    expect(result).toBe(state); // Same reference — no-op
  });

  it('backspace removes last character', () => {
    const result = handleKeypadStep({ screenValue: '53', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '5', overwriteNext: false });
  });

  it('backspace on single character returns "0"', () => {
    const result = handleKeypadStep({ screenValue: '5', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '0', overwriteNext: false });
  });

  it('backspace on "0" stays "0"', () => {
    const result = handleKeypadStep({ screenValue: '0', overwriteNext: false }, '←');
    expect(result).toEqual({ screenValue: '0', overwriteNext: false });
  });

  it('backspace clears overwriteNext', () => {
    const result = handleKeypadStep({ screenValue: '53', overwriteNext: true }, '←');
    expect(result.overwriteNext).toBe(false);
  });

  it('multi-digit entry after overwrite', () => {
    let state: KeypadState = { screenValue: '1', overwriteNext: true };
    state = handleKeypadStep(state, '2'); // overwrite → '2'
    state = handleKeypadStep(state, '5'); // append → '25'
    state = handleKeypadStep(state, '.'); // append → '25.'
    state = handleKeypadStep(state, '3'); // append → '25.3'
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
