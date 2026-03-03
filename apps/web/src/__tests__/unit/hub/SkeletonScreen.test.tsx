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

  it('CardSkeleton renders skeleton elements', () => {
    const { container } = render(<CardSkeleton />);
    expect(container.querySelectorAll('div[data-animated]').length).toBeGreaterThanOrEqual(2);
  });

  it('MacroBarSkeleton renders 4 groups', () => {
    const { container } = render(<MacroBarSkeleton />);
    // 4 macro groups × 2 skeleton lines each = 8
    expect(container.querySelectorAll('div[data-animated]').length).toBeGreaterThanOrEqual(4);
  });

  it('TableSkeleton renders rows × cols skeleton items', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    expect(container.querySelectorAll('div[data-animated]')).toHaveLength(12);
  });
});
