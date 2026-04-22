/**
 * Pure keypad-reducer helpers used by the Scanner page.
 *
 * Extracted so the unit tests (`__tests__/unit/pure/keypad-logic.test.ts`)
 * exercise the SAME function the production component runs, instead of a
 * copy-paste fork. A regression in the inline copy would silently slip past
 * a pure-function unit test — this file closes that gap.
 */

export type KeypadState = { screenValue: string; overwriteNext: boolean };

/**
 * Reducer-style keypad step. Given the current screen value + overwriteNext
 * flag and a pressed key ('0'..'9', '.', or '←' for backspace), returns
 * the next state. Used by ScannerPage's handleKeypadClick through a thin
 * adapter that mirrors `overwriteNext` into a ref (the ref is what gives
 * rapid-fire keypresses within the same React batch correct ordering).
 *
 * Rules:
 *   - Backspace: drop last char; if empty, return '0'; clears overwriteNext.
 *   - '.' with overwriteNext: start a fresh '0.'.
 *   - '.' without overwriteNext and no existing '.': append '.'.
 *   - '.' with existing '.': NO-OP (returns the same state by reference).
 *   - digit with overwriteNext: replace entire value.
 *   - digit without overwriteNext: append, unless current is '0' (replace).
 */
export function handleKeypadStep(state: KeypadState, key: string): KeypadState {
  if (key === '←') {
    return {
      screenValue: state.screenValue.slice(0, -1) || '0',
      overwriteNext: false,
    };
  }
  if (key === '.') {
    if (state.overwriteNext) {
      return { screenValue: '0.', overwriteNext: false };
    }
    if (!state.screenValue.includes('.')) {
      return { screenValue: state.screenValue + '.', overwriteNext: false };
    }
    return state; // double-decimal → no-op, same reference
  }
  if (state.overwriteNext) {
    return { screenValue: key, overwriteNext: false };
  }
  return {
    screenValue: state.screenValue === '0' ? key : state.screenValue + key,
    overwriteNext: false,
  };
}

/**
 * Unit toggle conversion between serving and container.
 * Used by the consume-mode unit toggle button.
 */
export function toggleUnit(
  currentUnit: 'serving' | 'container',
  currentQty: number,
  spc: number,
): { unit: 'serving' | 'container'; qty: number } {
  if (currentUnit === 'serving') {
    return { unit: 'container', qty: parseFloat((currentQty / Math.max(spc, 0.001)).toFixed(3)) };
  }
  return { unit: 'serving', qty: parseFloat((currentQty * spc).toFixed(3)) };
}
