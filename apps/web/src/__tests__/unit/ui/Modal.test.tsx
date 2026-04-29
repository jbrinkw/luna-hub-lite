/**
 * G-01: Unit tests for the shared Modal component.
 *
 * Modal is used across all modules for confirmation dialogs, detail views,
 * and forms. Testing ensures close behaviour (X button, backdrop click,
 * Escape key) and accessibility attributes are always wired.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '@/components/ui/Modal';

function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn();
  const result = render(
    <Modal open={true} onClose={onClose} title="Test Modal" {...props}>
      <p>Modal content</p>
    </Modal>,
  );
  return { ...result, onClose };
}

describe('Modal — rendering', () => {
  it('renders children when open=true', () => {
    renderModal();
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('renders the title', () => {
    renderModal({ title: 'My Dialog' });
    expect(screen.getByText('My Dialog')).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={vi.fn()}>
        <p>Hidden content</p>
      </Modal>,
    );
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('has role="dialog" and aria-modal="true"', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('has aria-label matching the title', () => {
    renderModal({ title: 'Confirm Delete' });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'Confirm Delete');
  });
});

describe('Modal — close behaviour', () => {
  it('calls onClose when the X button is clicked', async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const { onClose } = renderModal();
    // The backdrop has aria-hidden="true" so we query it by class presence
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeInTheDocument();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose on non-Escape keydown', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal — without title', () => {
  it('renders children without a title header', () => {
    render(
      <Modal open={true} onClose={vi.fn()}>
        <p>Content only</p>
      </Modal>,
    );
    expect(screen.getByText('Content only')).toBeInTheDocument();
    // No close X button when there is no title header
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});

describe('Modal — body scroll lock', () => {
  it('sets overflow:hidden on body when open', () => {
    renderModal();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body overflow when unmounted', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = renderModal();
    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });
});
