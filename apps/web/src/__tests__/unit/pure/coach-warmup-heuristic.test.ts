/**
 * `isLikelyWarmupSet` — pure heuristic that suppresses the
 * "First record!" toast on probable warm-up sets (CoachByte FLAG F6).
 *
 * Returns true iff `load < 100 AND reps > 8`. Both halves must be
 * true: a heavy single (135×1, load≥100) is never warm-up; a 5×45 lb
 * specialty exercise (reps≤8 even at low load) is honored as a real
 * record.
 */
import { describe, it, expect } from 'vitest';
import { isLikelyWarmupSet } from '@/pages/coachbyte/TodayPage';

describe('isLikelyWarmupSet — warm-up envelope (FLAG F6)', () => {
  it('returns true for the canonical warm-up shape (12×45)', () => {
    expect(isLikelyWarmupSet(12, 45)).toBe(true);
  });

  it('returns true for 10×95 (high-rep low-load opener)', () => {
    expect(isLikelyWarmupSet(10, 95)).toBe(true);
  });

  it('returns false for a real working set (5×135 squat)', () => {
    expect(isLikelyWarmupSet(5, 135)).toBe(false);
  });

  it('returns false for a real working set (5×95 bench)', () => {
    // load=95 < 100 but reps=5 — the high-rep half of the envelope
    // fails. Real working set, real first-record.
    expect(isLikelyWarmupSet(5, 95)).toBe(false);
  });

  it('returns false for a heavy single (1×185)', () => {
    expect(isLikelyWarmupSet(1, 185)).toBe(false);
  });

  it('returns false for a high-rep working set (12×185 — bodybuilding rep range, real load)', () => {
    expect(isLikelyWarmupSet(12, 185)).toBe(false);
  });

  it('returns false for boundary values: exactly load=100, reps=9', () => {
    // load < 100 is strict; load=100 is the work-set floor.
    expect(isLikelyWarmupSet(9, 100)).toBe(false);
  });

  it('returns false for boundary values: load=99, reps=8', () => {
    // reps > 8 is strict; reps=8 is the rep-range floor for hypertrophy.
    expect(isLikelyWarmupSet(8, 99)).toBe(false);
  });
});
