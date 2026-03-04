import { describe, it, expect } from 'vitest';
import { todayStr, toDateStr, formatDateDisplay } from '@/shared/dates';

describe('todayStr', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    const result = todayStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the current local date (not UTC)', () => {
    const result = todayStr();
    const expected = new Date().toLocaleDateString('sv-SE');
    expect(result).toBe(expected);
  });
});

describe('toDateStr', () => {
  it('converts a Date to YYYY-MM-DD in local timezone', () => {
    const d = new Date('2026-03-15T12:00:00');
    const result = toDateStr(d);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe('2026-03-15');
  });

  it('handles month boundaries', () => {
    const d = new Date('2026-01-01T12:00:00');
    expect(toDateStr(d)).toBe('2026-01-01');
  });

  it('handles year boundaries', () => {
    const d = new Date('2025-12-31T12:00:00');
    expect(toDateStr(d)).toBe('2025-12-31');
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
