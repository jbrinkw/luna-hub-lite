import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExtensionCard } from '@/components/hub/ExtensionCard';

const defaultProps = {
  extensionName: 'obsidian',
  displayName: 'Obsidian',
  description: 'Sync notes with Obsidian vault',
  enabled: false,
  hasCredentials: false,
  credentialFields: [
    { key: 'vault_path', label: 'Vault Path' },
  ],
  onToggle: vi.fn(),
  onSaveCredentials: vi.fn().mockResolvedValue({}),
};

describe('ExtensionCard', () => {
  afterEach(() => { vi.clearAllMocks(); });
  it('renders extension name and description', () => {
    render(<ExtensionCard {...defaultProps} />);
    expect(screen.getByText('Obsidian')).toBeInTheDocument();
    expect(screen.getByText('Sync notes with Obsidian vault')).toBeInTheDocument();
  });

  it('enable toggle calls onToggle', async () => {
    const onToggle = vi.fn();
    render(<ExtensionCard {...defaultProps} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('when enabled, credential form fields appear', () => {
    render(<ExtensionCard {...defaultProps} enabled />);
    expect(screen.getByText('Vault Path')).toBeInTheDocument();
    expect(screen.getByText('Save Credentials')).toBeInTheDocument();
  });

  it('save credentials calls onSaveCredentials with field values', async () => {
    const onSaveCredentials = vi.fn().mockResolvedValue({});
    render(<ExtensionCard {...defaultProps} enabled onSaveCredentials={onSaveCredentials} />);

    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/path/to/vault');
    await userEvent.click(screen.getByText('Save Credentials'));

    await waitFor(() => {
      expect(onSaveCredentials).toHaveBeenCalledWith({ vault_path: '/path/to/vault' });
    });
  });

  it('empty required credential shows validation error', async () => {
    render(<ExtensionCard {...defaultProps} enabled />);

    await userEvent.click(screen.getByText('Save Credentials'));
    expect(screen.getByText(/vault path is required/i)).toBeInTheDocument();
  });

  it('disabled state hides credential form', () => {
    render(<ExtensionCard {...defaultProps} enabled={false} />);
    expect(screen.queryByText('Save Credentials')).not.toBeInTheDocument();
  });

  it('hasCredentials shows configured text', () => {
    render(<ExtensionCard {...defaultProps} enabled hasCredentials />);
    expect(screen.getByText('Credentials configured')).toBeInTheDocument();
  });

  it('server error from onSaveCredentials', async () => {
    const onSaveCredentials = vi.fn().mockResolvedValue({ error: 'Network error' });
    render(<ExtensionCard {...defaultProps} enabled onSaveCredentials={onSaveCredentials} />);

    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/some/path');
    await userEvent.click(screen.getByText('Save Credentials'));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('toggle off calls onToggle(false)', async () => {
    const onToggle = vi.fn();
    render(<ExtensionCard {...defaultProps} enabled={true} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
