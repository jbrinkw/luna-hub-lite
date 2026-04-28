import { useEffect, useRef, useCallback } from 'react';

/**
 * Reasons a keystroke was eaten by the scanner-detection layer instead of
 * reaching the page.
 *
 *   - `'protected-target'` — focus is on a non-scanner input/textarea (or
 *     a registered protected ID). The buffer is cleared and the keystroke
 *     is allowed to reach the field, but it never accumulates as part of a
 *     scan. A hardware scanner firing here drops the entire scan silently.
 *   - `'buffer-stale'` — the 200 ms inactivity timer fired and wiped
 *     accumulated digits. Surface this when partial scans get abandoned
 *     because of a dropped or interrupted USB read.
 *   - `'non-digit-clears-buffer'` — a non-modifier, non-digit, non-Enter
 *     key arrived mid-buffer and reset it. Most common cause: the user
 *     hit a stray key while a scan was in flight.
 */
export type ScannerDropReason = 'protected-target' | 'buffer-stale' | 'non-digit-clears-buffer';

export interface ScannerDropDetail {
  /** Element ID at the moment the keystroke was eaten, if any. */
  targetId?: string | null;
  /** Element tag name at the moment the keystroke was eaten, if any. */
  targetTagName?: string | null;
  /** The key that triggered the drop (digit / 'Enter' / 'a' / etc.). */
  key?: string;
  /** How many buffered digits were lost when this drop fired. */
  bufferLength?: number;
}

interface ScannerDetectionOptions {
  /** Called when a valid barcode scan is detected */
  onBarcodeScanned: (barcode: string) => void;
  /**
   * Called whenever a keystroke gets eaten by the detection layer instead of
   * reaching the page. Used by ScannerPage to surface a "scan ignored" toast
   * + indicator so a hardware scanner firing while focus is wrong doesn't
   * fail silently.
   */
  onScanDropped?: (reason: ScannerDropReason, detail: ScannerDropDetail) => void;
  /** Minimum barcode length to accept (default: 6) */
  minBarcodeLength?: number;
  /** Maximum barcode length to accept (default: 24) */
  maxBarcodeLength?: number;
  /** Maximum ms between keystrokes to count as scanner input (default: 50) */
  scanSpeedThreshold?: number;
  /** Input element IDs that should NOT trigger scanner detection (default: []) */
  protectedInputIds?: string[];
}

/**
 * Detects rapid keystroke sequences from USB/Bluetooth barcode scanners.
 *
 * Hardware barcode scanners emulate a keyboard: they type digits very fast
 * (< 50 ms between keystrokes) and press Enter at the end. This hook
 * accumulates rapidly-typed digits and fires `onBarcodeScanned` when Enter
 * is pressed and the accumulated string looks like a barcode (>= 6 chars).
 *
 * The buffer resets after 200 ms of inactivity to avoid capturing human typing.
 *
 * Ported from legacy/chefbyte-vercel/apps/web/src/hooks/useScannerDetection.ts
 */
export function useScannerDetection({
  onBarcodeScanned,
  onScanDropped,
  minBarcodeLength = 6,
  maxBarcodeLength = 24,
  scanSpeedThreshold = 50,
  protectedInputIds = [],
}: ScannerDetectionOptions) {
  const bufferRef = useRef('');
  const lastKeyTimeRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize callback and config references so the effect doesn't re-register
  const callbackRef = useRef(onBarcodeScanned);
  useEffect(() => {
    callbackRef.current = onBarcodeScanned;
  }, [onBarcodeScanned]);

  // Same ref-stabilization pattern as `onBarcodeScanned`: the global keydown
  // listener is attached once on mount and reads the latest callback via the
  // ref, so swapping `onScanDropped` between renders doesn't tear down the
  // listener (which would lose any in-flight buffer mid-scan).
  const droppedCallbackRef = useRef(onScanDropped);
  useEffect(() => {
    droppedCallbackRef.current = onScanDropped;
  }, [onScanDropped]);

  const protectedIdsRef = useRef(protectedInputIds);
  useEffect(() => {
    protectedIdsRef.current = protectedInputIds;
  }, [protectedInputIds]);

  const minLenRef = useRef(minBarcodeLength);
  const maxLenRef = useRef(maxBarcodeLength);
  const speedRef = useRef(scanSpeedThreshold);
  useEffect(() => {
    minLenRef.current = minBarcodeLength;
    maxLenRef.current = maxBarcodeLength;
    speedRef.current = scanSpeedThreshold;
  }, [minBarcodeLength, maxBarcodeLength, scanSpeedThreshold]);

  const stableCallback = useCallback((barcode: string) => {
    callbackRef.current(barcode);
  }, []);

  useEffect(() => {
    const isProtectedTarget = (target: EventTarget | null): boolean => {
      if (!target || !(target instanceof HTMLElement)) return false;
      // Check by ID
      if (target.id && protectedIdsRef.current.includes(target.id)) return true;
      // Protect all input/textarea elements except the barcode input
      const tag = target.tagName.toLowerCase();
      if ((tag === 'input' || tag === 'textarea') && target.getAttribute('data-testid') !== 'barcode-input') {
        return true;
      }
      return false;
    };

    /**
     * Surface a dropped keystroke to the consumer (ScannerPage) so it can
     * render a "Scan ignored" toast / flip the indicator yellow. Try/catch
     * so a buggy callback can't break the global keydown listener and brick
     * the scanner — observability must never make the underlying flow
     * worse than the silent-drop bug we're fixing.
     */
    const emitDropped = (reason: ScannerDropReason, detail: ScannerDropDetail) => {
      const cb = droppedCallbackRef.current;
      if (!cb) return;
      try {
        cb(reason, detail);
      } catch (err) {
        console.error('useScannerDetection: onScanDropped handler threw', err);
      }
    };

    const resetBuffer = () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        // Only emit a stale-buffer drop event if there were actually
        // accumulated digits to lose. Empty-buffer expirations are no-ops
        // and shouldn't pollute the toast stream.
        const lost = bufferRef.current.length;
        bufferRef.current = '';
        if (lost > 0) {
          emitDropped('buffer-stale', { bufferLength: lost });
        }
      }, 200);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Don't intercept when typing in protected fields. CRITICAL: surface the
      // drop BEFORE clearing the buffer so the callback receives the actual
      // length lost — useful both for the toast UX and for unit tests that
      // want to assert "the scan that was in flight got eaten."
      if (isProtectedTarget(target)) {
        const bufferLength = bufferRef.current.length;
        bufferRef.current = '';
        emitDropped('protected-target', {
          targetId: target?.id ?? null,
          targetTagName: target?.tagName ?? null,
          key: e.key,
          bufferLength,
        });
        return;
      }

      const now = Date.now();
      const delta = now - lastKeyTimeRef.current;

      // Accumulate digit keystrokes that arrive rapidly
      if (e.key >= '0' && e.key <= '9') {
        if (delta < speedRef.current || bufferRef.current.length === 0) {
          bufferRef.current += e.key;
        } else {
          // Slow typing -> human; reset scanner buffer
          bufferRef.current = e.key;
        }
        lastKeyTimeRef.current = now;
        resetBuffer();
        return;
      }

      // Enter: commit if buffer looks like a barcode
      if (
        e.key === 'Enter' &&
        bufferRef.current.length >= minLenRef.current &&
        bufferRef.current.length <= maxLenRef.current
      ) {
        e.preventDefault();
        e.stopPropagation();

        const barcode = bufferRef.current;
        bufferRef.current = '';

        stableCallback(barcode);
        return;
      }

      // Any other key (besides modifiers) clears the buffer. Surface this so
      // a stray keystroke during a scan doesn't silently lose the in-flight
      // digits.
      const isModifier = e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta';
      if (!isModifier) {
        const bufferLength = bufferRef.current.length;
        bufferRef.current = '';
        if (bufferLength > 0) {
          emitDropped('non-digit-clears-buffer', {
            targetId: target?.id ?? null,
            targetTagName: target?.tagName ?? null,
            key: e.key,
            bufferLength,
          });
        }
      }
    };

    // Use capture phase to intercept before normal event handlers.
    // Listener registered once; config changes are read via refs.
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
