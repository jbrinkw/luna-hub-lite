import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ListSkeleton, CardSkeleton, MacroBarSkeleton, TableSkeleton } from '../../../components/SkeletonScreen';

describe('SkeletonScreen', () => {
  it('ListSkeleton renders specified number of rows', () => {
    const { container } = render(<ListSkeleton rows={3} />);
    // Each row is a flex container with skeleton children
    const rows = container.querySelectorAll('.flex.items-center.gap-3');
    expect(rows).toHaveLength(3);
  });

  it('ListSkeleton defaults to 5 rows', () => {
    const { container } = render(<ListSkeleton />);
    const rows = container.querySelectorAll('.flex.items-center.gap-3');
    expect(rows).toHaveLength(5);
  });

  it('ListSkeleton renders different count when rows prop changes', () => {
    const { container: c1 } = render(<ListSkeleton rows={2} />);
    const { container: c2 } = render(<ListSkeleton rows={7} />);
    expect(c1.querySelectorAll('.flex.items-center.gap-3')).toHaveLength(2);
    expect(c2.querySelectorAll('.flex.items-center.gap-3')).toHaveLength(7);
  });

  it('CardSkeleton renders skeleton elements in a bordered container', () => {
    const { container } = render(<CardSkeleton />);
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThanOrEqual(3);
    // Card should have a bordered wrapper
    const card = container.querySelector('.border');
    expect(card).toBeTruthy();
  });

  it('MacroBarSkeleton renders 4 groups with skeleton elements', () => {
    const { container } = render(<MacroBarSkeleton />);
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThanOrEqual(8);
  });

  it('TableSkeleton renders rows and columns of skeleton items', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    const pulses = container.querySelectorAll('.animate-pulse');
    // Header (4) + 3 body rows * 4 cols = 16
    expect(pulses).toHaveLength(16);
  });

  it('TableSkeleton defaults to 5 rows x 4 cols', () => {
    const { container } = render(<TableSkeleton />);
    const pulses = container.querySelectorAll('.animate-pulse');
    // Header (4) + 5 body rows * 4 cols = 24
    expect(pulses).toHaveLength(24);
  });

  it('TableSkeleton with different dimensions produces correct count', () => {
    const { container } = render(<TableSkeleton rows={2} cols={6} />);
    const pulses = container.querySelectorAll('.animate-pulse');
    // Header (6) + 2 body rows * 6 cols = 18
    expect(pulses).toHaveLength(18);
  });
});
