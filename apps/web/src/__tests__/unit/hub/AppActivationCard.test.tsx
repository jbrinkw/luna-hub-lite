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

  afterEach(() => {
    vi.clearAllMocks();
  });

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

  it('deactivate shows confirmation first with destructive copy', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    // Confirmation modal should appear with explicit destructive language
    expect(screen.getByText(/permanently delete all of its data/i)).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument();
    // CoachByte-specific deletion bullets surface
    expect(screen.getByTestId('deactivate-data-list')).toBeInTheDocument();
    // onDeactivate not called yet
    expect(onDeactivate).not.toHaveBeenCalled();
  });

  it('confirm deactivation calls onDeactivate', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    await userEvent.click(screen.getByTestId('deactivate-confirm'));
    expect(onDeactivate).toHaveBeenCalledTimes(1);
  });

  it('cancel deactivation closes modal without calling onDeactivate', async () => {
    const onDeactivate = vi.fn();
    render(<AppActivationCard {...defaultProps} active onDeactivate={onDeactivate} />);

    await userEvent.click(screen.getByText('Deactivate'));
    await userEvent.click(screen.getByText('Cancel'));
    expect(onDeactivate).not.toHaveBeenCalled();
  });

  it('shows ChefByte-specific deletion bullets', async () => {
    render(<AppActivationCard {...defaultProps} appName="chefbyte" displayName="ChefByte" active />);
    await userEvent.click(screen.getByText('Deactivate'));
    expect(screen.getByText(/Inventory, products, and recipes/i)).toBeInTheDocument();
    expect(screen.getByText(/Meal plans, macro logs, and shopping list/i)).toBeInTheDocument();
  });

  it('loading disables buttons', () => {
    const { rerender } = render(<AppActivationCard {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();

    rerender(<AppActivationCard {...defaultProps} active={true} loading={true} />);
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeDisabled();
  });
});
