import { describe, it, expect } from 'vitest';
import { rawPctOf, formatDayWindow, formatStockShortfallMessage } from '@/pages/chefbyte/HomePage';

/**
 * Pure-helper tests for HomePage's exported helpers (audit-driven).
 *
 *   rawPctOf — uncapped pct used by the % label and the over-goal chip.
 *   formatDayWindow — derives the "(6:00 AM - 5:59 AM)" label dynamically
 *     so users with a non-6 day_start_hour see a correct window.
 *   formatStockShortfallMessage — wraps the raw RPC error into actionable
 *     copy that points the user at "add to shopping list" recovery.
 */

describe('rawPctOf', () => {
  it('returns capped-style values when under or at goal', () => {
    expect(rawPctOf(0, 100)).toBe(0);
    expect(rawPctOf(50, 100)).toBe(50);
    expect(rawPctOf(100, 100)).toBe(100);
  });

  it('returns the uncapped raw percentage when over goal', () => {
    expect(rawPctOf(150, 100)).toBe(150);
    expect(rawPctOf(2400, 2000)).toBe(120);
  });

  it('returns 0 when goal is non-positive', () => {
    expect(rawPctOf(100, 0)).toBe(0);
    expect(rawPctOf(100, -10)).toBe(0);
  });

  it('rounds to the nearest integer like pctOf', () => {
    // 100 / 333 = 30.03 → 30
    expect(rawPctOf(100, 333)).toBe(30);
  });
});

describe('formatDayWindow', () => {
  it('renders the default 6 AM start as "6:00 AM - 5:59 AM"', () => {
    expect(formatDayWindow(6)).toBe('6:00 AM - 5:59 AM');
  });

  it('renders 4 AM start as "4:00 AM - 3:59 AM"', () => {
    expect(formatDayWindow(4)).toBe('4:00 AM - 3:59 AM');
  });

  it('renders midnight start with 12-hour format ("12:00 AM - 11:59 PM")', () => {
    expect(formatDayWindow(0)).toBe('12:00 AM - 11:59 PM');
  });

  it('renders noon start as "12:00 PM - 11:59 AM"', () => {
    expect(formatDayWindow(12)).toBe('12:00 PM - 11:59 AM');
  });

  it('renders 8 AM start as "8:00 AM - 7:59 AM"', () => {
    expect(formatDayWindow(8)).toBe('8:00 AM - 7:59 AM');
  });

  it('handles wraparound for hours > 23 (modulo)', () => {
    expect(formatDayWindow(30)).toBe(formatDayWindow(6));
  });

  it('handles negative hours (treats as wraparound)', () => {
    expect(formatDayWindow(-1)).toBe(formatDayWindow(23));
  });
});

describe('formatStockShortfallMessage', () => {
  it('wraps "Insufficient stock for X" errors with actionable copy', () => {
    const raw = 'Insufficient stock for Chicken: need 2 containers, have 1';
    const out = formatStockShortfallMessage(raw);
    // Should still contain the specifics (which product, how short)
    expect(out).toContain('Chicken');
    expect(out).toContain('need 2 containers');
    expect(out).toContain('have 1');
    // And the actionable next step
    expect(out.toLowerCase()).toContain('shopping list');
  });

  it('passes unrelated error messages through unchanged', () => {
    const raw = 'Recipe not found or not owned by user';
    expect(formatStockShortfallMessage(raw)).toBe(raw);
  });

  it('returns the empty string for empty/falsy input', () => {
    expect(formatStockShortfallMessage('')).toBe('');
  });

  it('case-insensitive on the "insufficient stock" trigger', () => {
    const raw = 'INSUFFICIENT STOCK for Eggs: need 4, have 2';
    const out = formatStockShortfallMessage(raw);
    // It must wrap (not pass through) when the case differs from the canonical RPC raise.
    expect(out).not.toBe(raw);
    expect(out.toLowerCase()).toContain('shopping list');
  });
});
