import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppActivationCard } from '@/components/hub/AppActivationCard';

describe('AppActivationCard', () => {
  const defaultProps = {
    appName: 'coachbyte',
    displayName: 'CoachByte',
    active: false,
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
  };

  afterEach(() => { vi.clearAllMocks(); });

  it('shows app name and inactive status', () => {
    render(<AppActivationCard {...defaultProps} />);
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('shows active status when active', () => {
    render(<AppActivationCard {...defaultProps} active />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('activate button calls onActivate', async () => {
    const onActivate = vi.fn();
    render(<AppActivationCard {...defaultProps} onActivate={onActivate} />);

    await userEvent.click(screen.getByText('Activate'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('deactivate shows confirmation first', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    // Confirmation modal should appear
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    // onDeactivate not called yet
    expect(onDeactivate).not.toHaveBeenCalled();
  });

  it('confirm deactivation calls onDeactivate', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    await userEvent.click(screen.getByText('Confirm'));
    expect(onDeactivate).toHaveBeenCalledTimes(1);
  });

  it('cancel deactivation closes modal without calling onDeactivate', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    await userEvent.click(screen.getByText('Cancel'));
    expect(onDeactivate).not.toHaveBeenCalled();
  });

  it('loading disables buttons', () => {
    const { rerender } = render(<AppActivationCard {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();

    rerender(<AppActivationCard {...defaultProps} active={true} loading={true} />);
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeDisabled();
  });
});
