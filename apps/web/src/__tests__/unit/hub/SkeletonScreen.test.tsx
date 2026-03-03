import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ListSkeleton, CardSkeleton, MacroBarSkeleton, TableSkeleton } from '../../../components/SkeletonScreen';

describe('SkeletonScreen', () => {
  it('ListSkeleton renders correct number of items', () => {
    const { container } = render(<ListSkeleton rows={5} />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(5);
  });

  it('ListSkeleton defaults to 5 rows', () => {
    const { container } = render(<ListSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(5);
  });

  it('CardSkeleton renders exactly 3 skeleton elements', () => {
    const { container } = render(<CardSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(3);
  });

  it('MacroBarSkeleton renders 4 groups × 2 = 8 skeleton elements', () => {
    const { container } = render(<MacroBarSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(8);
  });

  it('TableSkeleton renders rows × cols skeleton items', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(12);
  });

  it('TableSkeleton defaults to 5 rows × 4 cols = 20 skeleton items', () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(20);
  });
});
