import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ListSkeleton, CardSkeleton, MacroBarSkeleton, TableSkeleton } from '../../../components/SkeletonScreen';

describe('SkeletonScreen', () => {
  it('ListSkeleton renders specified number of rows', () => {
    const { container } = render(<ListSkeleton rows={3} />);
    const items = container.querySelectorAll('div[data-animated]');
    expect(items).toHaveLength(3);
  });

  it('ListSkeleton defaults to 5 rows', () => {
    const { container } = render(<ListSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(5);
  });

  it('ListSkeleton renders different count when rows prop changes', () => {
    const { container: c1 } = render(<ListSkeleton rows={2} />);
    const { container: c2 } = render(<ListSkeleton rows={7} />);
    expect(c1.querySelectorAll('div[data-animated]')).toHaveLength(2);
    expect(c2.querySelectorAll('div[data-animated]')).toHaveLength(7);
  });

  it('CardSkeleton renders 3 skeleton elements in a bordered container', () => {
    const { container } = render(<CardSkeleton />);
    const items = container.querySelectorAll('div[data-animated]');
    expect(items).toHaveLength(3);
    // Card should have a bordered wrapper
    const card = container.querySelector('[style*="border"]');
    expect(card).toBeTruthy();
  });

  it('MacroBarSkeleton renders 4 labeled groups with 2 skeletons each', () => {
    const { container } = render(<MacroBarSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(8);
    // Should use flex layout for the 4 groups
    const flexContainer = container.querySelector('[style*="flex"]');
    expect(flexContainer).toBeTruthy();
    // 4 groups = 4 direct children of the flex container
    expect(flexContainer!.children).toHaveLength(4);
  });

  it('TableSkeleton renders rows × cols skeleton items', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(12);
  });

  it('TableSkeleton defaults to 5 rows × 4 cols = 20 skeleton items', () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(20);
  });

  it('TableSkeleton with different dimensions produces correct count', () => {
    const { container } = render(<TableSkeleton rows={2} cols={6} />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(12);
    // Should have 2 rows
    const rows = container.querySelectorAll('[style*="display: flex"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
