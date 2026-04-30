/**
 * Unit tests for useSaveIndicator.
 *
 * The hook exposes { showSaved, flash }:
 *   - showSaved starts false
 *   - flash() sets showSaved=true then auto-clears after durationMs
 *   - Multiple rapid flash() calls reset the timer (debounce semantics)
 *   - Cleanup on unmount does not throw
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSaveIndicator } from '@/hooks/useSaveIndicator';

describe('useSaveIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('showSaved starts as false', () => {
    const { result } = renderHook(() => useSaveIndicator());
    expect(result.current.showSaved).toBe(false);
  });

  it('flash() sets showSaved to true', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaveIndicator(2000));

    act(() => {
      result.current.flash();
    });

    expect(result.current.showSaved).toBe(true);
  });

  it('showSaved reverts to false after durationMs', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaveIndicator(500));

    act(() => {
      result.current.flash();
    });

    expect(result.current.showSaved).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.showSaved).toBe(false);
  });

  it('rapid flash() calls reset the timer (debounce: does not clear early)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaveIndicator(500));

    act(() => {
      result.current.flash();
    });

    // Advance partway — should still be showing
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.showSaved).toBe(true);

    // Second flash resets the 500ms window
    act(() => {
      result.current.flash();
    });

    // Another 300ms — only 300ms since the 2nd flash, still showing
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.showSaved).toBe(true);

    // Full 500ms from the 2nd flash
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.showSaved).toBe(false);
  });

  it('unmount does not throw (cleanup runs)', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSaveIndicator(2000));

    act(() => {
      result.current.flash();
    });

    expect(() => unmount()).not.toThrow();
  });

  it('custom durationMs is respected', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaveIndicator(100));

    act(() => {
      result.current.flash();
    });
    expect(result.current.showSaved).toBe(true);

    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current.showSaved).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.showSaved).toBe(false);
  });
});
