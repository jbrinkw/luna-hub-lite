import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModalOverlay } from '@/components/shared/ModalOverlay';

describe('ModalOverlay', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <ModalOverlay isOpen={false} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </ModalOverlay>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders overlay and content when isOpen is true', () => {
    render(
      <ModalOverlay isOpen={true} onClose={vi.fn()} title="My Modal" testId="test-modal">
        <p>Hello World</p>
      </ModalOverlay>,
    );
    expect(screen.getByTestId('test-modal')).toBeInTheDocument();
    expect(screen.getByText('My Modal')).toBeInTheDocument();
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay isOpen={true} onClose={onClose} title="Close Test" testId="backdrop">
        <p>Content</p>
      </ModalOverlay>,
    );
    // Click the backdrop (the outer div)
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when card content is clicked', () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay isOpen={true} onClose={onClose} title="No Close">
        <p data-testid="inner">Content</p>
      </ModalOverlay>,
    );
    fireEvent.click(screen.getByTestId('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies custom maxWidth to card container', () => {
    const { container } = render(
      <ModalOverlay isOpen={true} onClose={vi.fn()} title="Wide" maxWidth="800px" testId="wide-modal">
        <p>Content</p>
      </ModalOverlay>,
    );
    // The card has inline style with maxWidth — find the element with that style
    const cardEl = container.querySelector('[style*="max-width"]') as HTMLElement;
    expect(cardEl).toBeTruthy();
    expect(cardEl.style.maxWidth).toBe('800px');
  });

  it('uses default maxWidth of 500px', () => {
    const { container } = render(
      <ModalOverlay isOpen={true} onClose={vi.fn()} title="Default" testId="default-modal">
        <p>Content</p>
      </ModalOverlay>,
    );
    const cardEl = container.querySelector('[style*="max-width"]') as HTMLElement;
    expect(cardEl).toBeTruthy();
    expect(cardEl.style.maxWidth).toBe('500px');
  });
});
