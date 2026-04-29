/**
 * G-01: Unit tests for Skeleton loading-state components.
 *
 * Skeleton components give visual feedback during data loads. Tests pin the
 * structural shape (animate-pulse class, correct element count) so refactors
 * that break the loading state are caught immediately.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, ListSkeleton, CardSkeleton, TableSkeleton } from '@/components/ui/Skeleton';

describe('Skeleton — base', () => {
  it('renders a div with animate-pulse class', () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('animate-pulse');
  });

  it('accepts and forwards custom className', () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('h-4');
    expect(el.className).toContain('w-full');
  });

  it('forwards additional HTML attributes', () => {
    const { container } = render(<Skeleton data-testid="sk" style={{ width: 100 }} />);
    expect(container.querySelector('[data-testid="sk"]')).toBeInTheDocument();
  });
});

describe('ListSkeleton', () => {
  it('renders 5 items by default', () => {
    const { container } = render(<ListSkeleton />);
    // Each item is a flex row with two nested Skeleton elements
    const items = container.querySelectorAll('.flex.items-center');
    expect(items).toHaveLength(5);
  });

  it('renders the requested count of items', () => {
    const { container } = render(<ListSkeleton count={3} />);
    const items = container.querySelectorAll('.flex.items-center');
    expect(items).toHaveLength(3);
  });

  it('renders animate-pulse elements inside each item', () => {
    const { container } = render(<ListSkeleton count={2} />);
    const pulseEls = container.querySelectorAll('.animate-pulse');
    // Each item has 3 Skeleton divs (icon + 2 text lines)
    expect(pulseEls.length).toBeGreaterThanOrEqual(6);
  });
});

describe('CardSkeleton', () => {
  it('renders a card with animate-pulse children', () => {
    const { container } = render(<CardSkeleton />);
    const pulseEls = container.querySelectorAll('.animate-pulse');
    // Title + 3 text lines = 4 minimum
    expect(pulseEls.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts custom className', () => {
    const { container } = render(<CardSkeleton className="my-card" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('my-card');
  });
});

describe('TableSkeleton', () => {
  it('renders header + 5 body rows by default (6 total rows)', () => {
    const { container } = render(<TableSkeleton cols={3} />);
    // Header row + 5 data rows
    const rows = container.querySelectorAll('.flex.gap-4');
    expect(rows).toHaveLength(6);
  });

  it('renders the specified number of body rows', () => {
    const { container } = render(<TableSkeleton rows={3} cols={2} />);
    // Header (1) + body (3) = 4 flex rows
    const rows = container.querySelectorAll('.flex.gap-4');
    expect(rows).toHaveLength(4);
  });

  it('renders the specified number of column cells per row', () => {
    const { container } = render(<TableSkeleton rows={1} cols={4} />);
    // Each .flex.gap-4 has `cols` Skeleton divs
    const rows = container.querySelectorAll('.flex.gap-4');
    // Both header and body row should have 4 cells
    for (const row of Array.from(rows)) {
      const cells = row.querySelectorAll('.animate-pulse');
      expect(cells).toHaveLength(4);
    }
  });
});
