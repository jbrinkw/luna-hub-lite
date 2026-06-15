import { describe, it, expect, afterEach, vi } from 'vitest';
import { todayStr, toDateStr, formatDateDisplay } from '@/shared/dates';

afterEach(() => {
  vi.useRealTimers();
});

describe('todayStr', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    const result = todayStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the profile-timezone calendar date for a fixed instant (dayStartHour=0)', () => {
    // 2026-03-15T18:00:00Z is the same calendar day (2pm) in New York.
    // Asserting a FIXED expected string — not `new Date().toLocaleDateString(...)`,
    // which would be a tautology mirroring the implementation (audit FP-1).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T18:00:00Z'));
    expect(todayStr(0, 'America/New_York')).toBe('2026-03-15');
  });

  it('shifts to the previous day before the day_start_hour boundary', () => {
    // 2026-03-15T08:00:00Z = 4:00am EDT. With dayStartHour=6, 4am < 6am → 2026-03-14.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:00:00Z'));
    expect(todayStr(6, 'America/New_York')).toBe('2026-03-14');
  });
});

describe('toDateStr', () => {
  it('converts a Date to YYYY-MM-DD in the supplied timezone', () => {
    const d = new Date('2026-03-15T18:00:00Z'); // 2pm EDT, same calendar day
    const result = toDateStr(d, 'America/New_York');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe('2026-03-15');
  });

  it('handles month boundaries', () => {
    const d = new Date('2026-01-01T18:00:00Z');
    expect(toDateStr(d, 'America/New_York')).toBe('2026-01-01');
  });

  it('handles year boundaries', () => {
    const d = new Date('2025-12-31T18:00:00Z');
    expect(toDateStr(d, 'America/New_York')).toBe('2025-12-31');
  });
});

describe('formatDateDisplay', () => {
  it('formats YYYY-MM-DD to readable format with weekday', () => {
    const result = formatDateDisplay('2026-03-02');
    // Monday March 2, 2026
    expect(result).toContain('Mon');
    expect(result).toContain('Mar');
    expect(result).toContain('2');
  });

  it('formats a different date correctly', () => {
    const result = formatDateDisplay('2026-03-08');
    // Sunday March 8, 2026
    expect(result).toContain('Sun');
    expect(result).toContain('Mar');
    expect(result).toContain('8');
  });

  it('handles January date', () => {
    const result = formatDateDisplay('2026-01-15');
    expect(result).toContain('Thu');
    expect(result).toContain('Jan');
    expect(result).toContain('15');
  });
});
