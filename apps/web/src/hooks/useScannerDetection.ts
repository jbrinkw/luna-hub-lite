import { useEffect, useRef, useCallback } from 'react';

interface ScannerDetectionOptions {
  /** Called when a valid barcode scan is detected */
  onBarcodeScanned: (barcode: string) => void;
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
  minBarcodeLength = 6,
  maxBarcodeLength = 24,
  scanSpeedThreshold = 50,
  protectedInputIds = [],
}: ScannerDetectionOptions) {
  const bufferRef = useRef('');
  const lastKeyTimeRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize callback reference so effect doesn't re-register on every render
  const callbackRef = useRef(onBarcodeScanned);
  useEffect(() => {
    callbackRef.current = onBarcodeScanned;
  }, [onBarcodeScanned]);

  const stableCallback = useCallback((barcode: string) => {
    callbackRef.current(barcode);
  }, []);

  useEffect(() => {
    const isProtectedTarget = (target: EventTarget | null): boolean => {
      if (!target || !(target instanceof HTMLElement)) return false;
      // Check by ID
      if (target.id && protectedInputIds.includes(target.id)) return true;
      // Protect all input/textarea elements except the barcode input
      const tag = target.tagName.toLowerCase();
      if ((tag === 'input' || tag === 'textarea') && target.getAttribute('data-testid') !== 'barcode-input') {
        return true;
      }
      return false;
    };

    const resetBuffer = () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        bufferRef.current = '';
      }, 200);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Don't intercept when typing in protected fields
      if (isProtectedTarget(target)) {
        bufferRef.current = '';
        return;
      }

      const now = Date.now();
      const delta = now - lastKeyTimeRef.current;

      // Accumulate digit keystrokes that arrive rapidly
      if (e.key >= '0' && e.key <= '9') {
        if (delta < scanSpeedThreshold || bufferRef.current.length === 0) {
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
        bufferRef.current.length >= minBarcodeLength &&
        bufferRef.current.length <= maxBarcodeLength
      ) {
        e.preventDefault();
        e.stopPropagation();

        const barcode = bufferRef.current;
        bufferRef.current = '';

        stableCallback(barcode);
        return;
      }

      // Any other key (besides modifiers) clears the buffer
      const isModifier = e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta';
      if (!isModifier) {
        bufferRef.current = '';
      }
    };

    // Use capture phase to intercept before normal event handlers
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [minBarcodeLength, maxBarcodeLength, scanSpeedThreshold, protectedInputIds, stableCallback]);
}
