import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScannerDetection } from '@/hooks/useScannerDetection';

/**
 * Helper: fires a keydown event on `document` with the given key.
 * Uses capture-phase-compatible dispatch (the hook listens with `true`).
 */
function fireKey(key: string, options?: { target?: HTMLElement }) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  // If a custom target is provided, override the target by dispatching on that element
  if (options?.target) {
    options.target.dispatchEvent(event);
  } else {
    document.dispatchEvent(event);
  }
  return event;
}

/**
 * Helper: simulates a rapid barcode scan by typing digits with 10ms gaps,
 * then pressing Enter.
 */
function simulateRapidScan(barcode: string, nowSpy: ReturnType<typeof vi.spyOn>, startTime: number) {
  let time = startTime;
  for (const char of barcode) {
    nowSpy.mockReturnValue(time);
    fireKey(char);
    time += 10; // 10ms between keystrokes = rapid
  }
  nowSpy.mockReturnValue(time);
  return time;
}

describe('useScannerDetection', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    nowSpy.mockRestore();
  });

  it('calls onBarcodeScanned for a rapid 6-digit scan + Enter', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const time = simulateRapidScan('123456', nowSpy, 1000);
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).toHaveBeenCalledOnce();
    expect(onBarcodeScanned).toHaveBeenCalledWith('123456');
  });

  it('calls onBarcodeScanned for a rapid 24-digit scan + Enter (max length)', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const barcode = '012345678901234567890123'; // 24 digits
    expect(barcode).toHaveLength(24);

    const time = simulateRapidScan(barcode, nowSpy, 1000);
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).toHaveBeenCalledOnce();
    expect(onBarcodeScanned).toHaveBeenCalledWith(barcode);
  });

  it('does NOT call onBarcodeScanned for 5-digit scan (too short)', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const time = simulateRapidScan('12345', nowSpy, 1000);
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).not.toHaveBeenCalled();
  });

  it('does NOT call onBarcodeScanned for 25-digit scan (too long)', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const barcode = '0123456789012345678901234'; // 25 digits
    expect(barcode).toHaveLength(25);

    const time = simulateRapidScan(barcode, nowSpy, 1000);
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).not.toHaveBeenCalled();
  });

  it('resets buffer on slow typing (> 50ms between keystrokes)', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    // Type 6 digits slowly (500ms apart) -- each one resets the buffer to just that digit
    let time = 1000;
    for (const char of '123456') {
      nowSpy.mockReturnValue(time);
      fireKey(char);
      time += 500; // 500ms = slow, well above 50ms threshold
    }

    // Buffer should only contain '6' (last digit typed slowly)
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    // Buffer has only 1 char, which is below minBarcodeLength, so no fire
    expect(onBarcodeScanned).not.toHaveBeenCalled();
  });

  it('non-digit key clears buffer; subsequent rapid digits form a new barcode', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    // Type 6 rapid digits
    let time = simulateRapidScan('123456', nowSpy, 1000);

    // Press 'a' to clear buffer
    nowSpy.mockReturnValue(time);
    fireKey('a');
    time += 10;

    // Type 6 more rapid digits
    time = simulateRapidScan('789012', nowSpy, time);

    // Press Enter
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    // Should fire with only the second batch
    expect(onBarcodeScanned).toHaveBeenCalledOnce();
    expect(onBarcodeScanned).toHaveBeenCalledWith('789012');
  });

  it('modifier keys (Shift, Control, Alt, Meta) do NOT clear the buffer', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    let time = 1000;

    // Type 3 rapid digits
    for (const char of '123') {
      nowSpy.mockReturnValue(time);
      fireKey(char);
      time += 5;
    }

    // Press all modifier keys -- these don't update lastKeyTimeRef,
    // so total elapsed time between last digit '3' and next digit '4'
    // must stay under scanSpeedThreshold (50ms). Use 2ms per modifier.
    for (const mod of ['Shift', 'Control', 'Alt', 'Meta']) {
      nowSpy.mockReturnValue(time);
      fireKey(mod);
      time += 2;
    }

    // Type 3 more rapid digits (delta from last digit '3' is ~13ms, well < 50ms)
    for (const char of '456') {
      nowSpy.mockReturnValue(time);
      fireKey(char);
      time += 5;
    }

    // Press Enter
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).toHaveBeenCalledOnce();
    expect(onBarcodeScanned).toHaveBeenCalledWith('123456');
  });

  it('clears buffer when target is a protected input by ID', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() =>
      useScannerDetection({
        onBarcodeScanned,
        protectedInputIds: ['search-field'],
      }),
    );

    // Create a protected input element
    const input = document.createElement('input');
    input.id = 'search-field';
    document.body.appendChild(input);

    try {
      // Type rapid digits targeting the protected input
      let time = 1000;
      for (const char of '123456') {
        nowSpy.mockReturnValue(time);
        fireKey(char, { target: input });
        time += 10;
      }

      // Enter targeting the protected input
      nowSpy.mockReturnValue(time);
      fireKey('Enter', { target: input });

      expect(onBarcodeScanned).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(input);
    }
  });

  it('clears buffer when target is a textarea (protected by default)', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    try {
      let time = 1000;
      for (const char of '123456') {
        nowSpy.mockReturnValue(time);
        fireKey(char, { target: textarea });
        time += 10;
      }

      nowSpy.mockReturnValue(time);
      fireKey('Enter', { target: textarea });

      expect(onBarcodeScanned).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(textarea);
    }
  });

  it('does NOT protect an input with data-testid="barcode-input"', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    const barcodeInput = document.createElement('input');
    barcodeInput.setAttribute('data-testid', 'barcode-input');
    document.body.appendChild(barcodeInput);

    try {
      let time = 1000;
      for (const char of '123456') {
        nowSpy.mockReturnValue(time);
        fireKey(char, { target: barcodeInput });
        time += 10;
      }

      nowSpy.mockReturnValue(time);
      fireKey('Enter', { target: barcodeInput });

      expect(onBarcodeScanned).toHaveBeenCalledOnce();
      expect(onBarcodeScanned).toHaveBeenCalledWith('123456');
    } finally {
      document.body.removeChild(barcodeInput);
    }
  });

  it('buffer resets after 200ms of inactivity', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    // Type 3 rapid digits
    let time = 1000;
    for (const char of '123') {
      nowSpy.mockReturnValue(time);
      fireKey(char);
      time += 10;
    }

    // Advance fake timers by 200ms to trigger the buffer reset timeout
    vi.advanceTimersByTime(200);

    // Type 3 more rapid digits (buffer was cleared, so only these 3 are in buffer)
    for (const char of '456') {
      nowSpy.mockReturnValue(time);
      fireKey(char);
      time += 10;
    }

    // Press Enter -- only 3 chars in buffer, below minBarcodeLength
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).not.toHaveBeenCalled();
  });

  it('Enter event calls preventDefault() and stopPropagation() when buffer is valid', () => {
    const onBarcodeScanned = vi.fn();
    renderHook(() => useScannerDetection({ onBarcodeScanned }));

    // Type 6 rapid digits
    const time = simulateRapidScan('123456', nowSpy, 1000);

    // Create an Enter event and spy on its methods
    nowSpy.mockReturnValue(time);
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(enterEvent, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(enterEvent, 'stopPropagation');

    document.dispatchEvent(enterEvent);

    expect(preventDefaultSpy).toHaveBeenCalledOnce();
    expect(stopPropagationSpy).toHaveBeenCalledOnce();
    expect(onBarcodeScanned).toHaveBeenCalledWith('123456');
  });

  it('cleanup removes event listener on unmount', () => {
    const onBarcodeScanned = vi.fn();
    const { unmount } = renderHook(() => useScannerDetection({ onBarcodeScanned }));

    // Unmount the hook
    unmount();

    // Now simulate a scan -- should NOT fire
    const time = simulateRapidScan('123456', nowSpy, 1000);
    nowSpy.mockReturnValue(time);
    fireKey('Enter');

    expect(onBarcodeScanned).not.toHaveBeenCalled();
  });
});
