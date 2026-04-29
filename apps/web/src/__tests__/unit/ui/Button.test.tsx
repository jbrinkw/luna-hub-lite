/**
 * G-01: Unit tests for the shared Button primitive.
 *
 * The Button component is a shared primitive used across all modules. A
 * regression removing the disabled prop forward or loading spinner would
 * silently break double-submit guards across the whole SPA. These tests pin
 * the critical behaviours so any such refactor fails immediately at CI time.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/Button';

describe('Button — rendering', () => {
  it('renders children text', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('defaults to type="button" so it does not submit forms accidentally', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('renders all variant classes without crashing', () => {
    const variants = ['primary', 'secondary', 'ghost', 'danger', 'success'] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>Label</Button>);
      expect(screen.getByRole('button')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders all size classes without crashing', () => {
    const sizes = ['sm', 'md', 'lg', 'xl'] as const;
    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>Label</Button>);
      expect(screen.getByRole('button')).toBeInTheDocument();
      unmount();
    }
  });

  it('forwards extra HTML attributes (e.g. data-testid)', () => {
    render(<Button data-testid="my-btn">OK</Button>);
    expect(screen.getByTestId('my-btn')).toBeInTheDocument();
  });
});

describe('Button — disabled state', () => {
  it('sets the disabled attribute when disabled=true', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does NOT call onClick when disabled', async () => {
    const handler = vi.fn();
    render(
      <Button disabled onClick={handler}>
        Save
      </Button>,
    );
    // fireEvent bypasses pointer-events:none; use the DOM disabled attribute
    // to simulate what the browser actually does.
    fireEvent.click(screen.getByRole('button'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies opacity-50 class when disabled (visual feedback)', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button').className).toContain('opacity-50');
  });

  it('applies cursor-not-allowed class when disabled', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button').className).toContain('cursor-not-allowed');
  });
});

describe('Button — loading state', () => {
  it('renders a spinner SVG when loading=true', () => {
    const { container } = render(<Button loading>Saving…</Button>);
    const svg = container.querySelector('svg[aria-hidden="true"]');
    expect(svg).toBeInTheDocument();
    // SVGAnimatedString — use getAttribute for class check instead of .className
    expect(svg!.getAttribute('class')).toContain('animate-spin');
  });

  it('disables the button when loading=true', () => {
    render(<Button loading>Saving…</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does NOT call onClick when loading', () => {
    const handler = vi.fn();
    render(
      <Button loading onClick={handler}>
        Saving…
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT render spinner when loading=false (default)', () => {
    const { container } = render(<Button>Save</Button>);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeInTheDocument();
  });
});

describe('Button — click handler', () => {
  it('calls onClick when enabled', async () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click me</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards ref to the underlying button element', () => {
    const ref = vi.fn();
    render(<Button ref={ref}>Save</Button>);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  });
});
