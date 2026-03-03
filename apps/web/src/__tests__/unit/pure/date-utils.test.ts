import { describe, it, expect } from 'vitest';
import { getMonday } from '@/pages/chefbyte/MealPlanPage';
import { formatTime } from '@/components/coachbyte/RestTimer';

/* ================================================================== */
/*  getMonday                                                          */
/* ================================================================== */

describe('getMonday', () => {
  it('returns the same day for a Monday', () => {
    const monday = new Date('2026-03-02T12:00:00'); // Monday
    const result = getMonday(monday);
    expect(result.getDay()).toBe(1); // Monday = 1
    expect(result.getDate()).toBe(2);
    expect(result.getMonth()).toBe(2); // March = 2
  });

  it('returns previous Monday for a Wednesday', () => {
    const wed = new Date('2026-03-04T12:00:00'); // Wednesday
    const result = getMonday(wed);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(2); // Monday March 2
  });

  it('returns previous Monday for a Sunday', () => {
    const sun = new Date('2026-03-08T12:00:00'); // Sunday
    const result = getMonday(sun);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(2); // Monday March 2
  });

  it('returns previous Monday for a Saturday', () => {
    const sat = new Date('2026-03-07T12:00:00'); // Saturday
    const result = getMonday(sat);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(2); // Monday March 2
  });

  it('returns previous Monday for a Friday', () => {
    const fri = new Date('2026-03-06T12:00:00'); // Friday
    const result = getMonday(fri);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(2);
  });

  it('sets time to midnight (00:00:00.000)', () => {
    const wed = new Date('2026-03-04T15:30:45.123');
    const result = getMonday(wed);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  it('does not mutate the original date', () => {
    const original = new Date('2026-03-05T10:00:00');
    const originalTime = original.getTime();
    getMonday(original);
    expect(original.getTime()).toBe(originalTime);
  });

  it('handles month boundary correctly (Sunday March 1, 2026)', () => {
    const sun = new Date('2026-03-01T12:00:00'); // Sunday March 1
    const result = getMonday(sun);
    expect(result.getDay()).toBe(1);
    // Monday before March 1 Sunday is February 23
    expect(result.getDate()).toBe(23);
    expect(result.getMonth()).toBe(1); // February = 1
  });

  it('handles year boundary (Sunday Jan 1, 2023)', () => {
    const sun = new Date('2023-01-01T12:00:00'); // Sunday Jan 1
    const result = getMonday(sun);
    expect(result.getDay()).toBe(1);
    // Previous Monday: Dec 26, 2022
    expect(result.getDate()).toBe(26);
    expect(result.getMonth()).toBe(11); // December = 11
    expect(result.getFullYear()).toBe(2022);
  });
});

/* ================================================================== */
/*  formatTime (mm:ss from total seconds)                              */
/* ================================================================== */

describe('formatTime', () => {
  it('formats 0 seconds as 0:00', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('formats 90 seconds as 1:30', () => {
    expect(formatTime(90)).toBe('1:30');
  });

  it('formats 60 seconds as 1:00', () => {
    expect(formatTime(60)).toBe('1:00');
  });

  it('formats 5 seconds as 0:05 (pads seconds)', () => {
    expect(formatTime(5)).toBe('0:05');
  });

  it('formats 59 seconds as 0:59', () => {
    expect(formatTime(59)).toBe('0:59');
  });

  it('formats 120 seconds as 2:00', () => {
    expect(formatTime(120)).toBe('2:00');
  });

  it('formats 301 seconds as 5:01', () => {
    expect(formatTime(301)).toBe('5:01');
  });

  it('formats large values (3600 = 60:00)', () => {
    expect(formatTime(3600)).toBe('60:00');
  });

  /* ---- Edge cases ---- */

  it('treats negative seconds as 0:00', () => {
    expect(formatTime(-10)).toBe('0:00');
  });

  it('treats large negative seconds as 0:00', () => {
    expect(formatTime(-999)).toBe('0:00');
  });
});
