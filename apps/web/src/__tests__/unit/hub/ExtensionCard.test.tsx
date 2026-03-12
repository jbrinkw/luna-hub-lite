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
  credentialFields: [{ key: 'vault_path', label: 'Vault Path' }],
  onToggle: vi.fn(),
  onSaveCredentials: vi.fn().mockResolvedValue({}),
};

describe('ExtensionCard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  it('renders extension name and description', () => {
    render(<ExtensionCard {...defaultProps} />);
    expect(screen.getByText('Obsidian')).toBeInTheDocument();
    expect(screen.getByText('Sync notes with Obsidian vault')).toBeInTheDocument();
  });

  it('enable toggle calls onToggle', async () => {
    const onToggle = vi.fn();
    render(<ExtensionCard {...defaultProps} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole('switch'));
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

  it('hasCredentials shows configured badge', () => {
    render(<ExtensionCard {...defaultProps} enabled hasCredentials />);
    expect(screen.getByText('Credentials configured')).toBeInTheDocument();
  });

  it('no credentials shows not configured badge', () => {
    render(<ExtensionCard {...defaultProps} enabled hasCredentials={false} />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('save button is disabled while save is in progress', async () => {
    // Create a promise that never resolves to keep the saving state active
    const onSaveCredentials = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ExtensionCard {...defaultProps} enabled onSaveCredentials={onSaveCredentials} />);

    // Fill in the required credential field to pass validation
    const input = screen.getByLabelText('Vault Path');
    await userEvent.type(input, '/some/path');

    // Click save — this will set saving=true and await the never-resolving promise
    await userEvent.click(screen.getByText('Save Credentials'));

    // The button should now be disabled while save is in progress
    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: /save credentials/i });
      expect(saveButton).toBeDisabled();
    });
  });

  it('URL fields use text type, API key fields use password type', () => {
    const fields = [
      { key: 'obsidian_url', label: 'Obsidian URL' },
      { key: 'obsidian_api_key', label: 'API Key' },
    ];
    render(<ExtensionCard {...defaultProps} enabled credentialFields={fields} />);

    const urlInput = screen.getByLabelText('Obsidian URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    expect(urlInput).toHaveAttribute('type', 'text');
    expect(apiKeyInput).toHaveAttribute('type', 'password');
  });

  it('enabled card has green left border', () => {
    const { container } = render(<ExtensionCard {...defaultProps} enabled />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-l-emerald-500');
  });

  it('disabled card has reduced opacity', () => {
    const { container } = render(<ExtensionCard {...defaultProps} enabled={false} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('opacity-60');
  });
});
