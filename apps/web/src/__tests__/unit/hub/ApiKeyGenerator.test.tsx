import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeyGenerator } from '@/components/hub/ApiKeyGenerator';

describe('ApiKeyGenerator', () => {
  const defaultProps = {
    activeKeys: [] as { id: string; label: string | null; created_at: string }[],
    onGenerate: vi.fn().mockResolvedValue('sk-test-key-123'),
    onRevoke: vi.fn(),
  };

  afterEach(() => { vi.clearAllMocks(); });

  it('click generate calls onGenerate and displays key', async () => {
    const onGenerate = vi.fn().mockResolvedValue('sk-plaintext-key');
    render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(screen.getByTestId('key-plaintext')).toHaveTextContent('sk-plaintext-key');
    });
    expect(onGenerate).toHaveBeenCalled();
  });

  it('key hidden after dismiss', async () => {
    render(<ApiKeyGenerator {...defaultProps} />);

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(screen.getByTestId('key-plaintext')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByTestId('key-plaintext')).not.toBeInTheDocument();
  });

  it('copy button copies key to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    try {
      render(<ApiKeyGenerator {...defaultProps} />);

      await userEvent.click(screen.getByText('Generate'));
      await waitFor(() => {
        expect(screen.getByTestId('key-plaintext')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Copy'));
      expect(writeText).toHaveBeenCalledWith('sk-test-key-123');
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      }
    }
  });

  it('shows error message when error prop set', () => {
    render(<ApiKeyGenerator {...defaultProps} error="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('multiple generates produce new keys each time', async () => {
    const onGenerate = vi.fn()
      .mockResolvedValueOnce('key-1')
      .mockResolvedValueOnce('key-2');

    render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(screen.getByTestId('key-plaintext')).toHaveTextContent('key-1');
    });

    // Dismiss first key
    await userEvent.click(screen.getByText('Dismiss'));

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(screen.getByTestId('key-plaintext')).toHaveTextContent('key-2');
    });

    expect(onGenerate).toHaveBeenCalledTimes(2);
  });

  it('label passed to onGenerate', async () => {
    const onGenerate = vi.fn().mockResolvedValue('sk-key');
    render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

    const input = screen.getByPlaceholderText('My API Key');
    await userEvent.type(input, 'Production Key');
    await userEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(onGenerate).toHaveBeenCalledWith('Production Key');
    });
  });

  it('active keys list rendering', () => {
    const activeKeys = [
      { id: 'key-1', label: 'My Key', created_at: '2026-01-01T00:00:00Z' },
      { id: 'key-2', label: null, created_at: '2026-02-01T00:00:00Z' },
    ];
    render(<ApiKeyGenerator {...defaultProps} activeKeys={activeKeys} />);

    expect(screen.getByText('My Key')).toBeInTheDocument();
    expect(screen.getByText('Untitled')).toBeInTheDocument();
    const revokeButtons = screen.getAllByText('Revoke');
    expect(revokeButtons).toHaveLength(2);
  });

  it('onRevoke called with correct ID', async () => {
    const onRevoke = vi.fn();
    const activeKeys = [
      { id: 'key-abc-123', label: 'Test Key', created_at: '2026-01-01T00:00:00Z' },
    ];
    render(<ApiKeyGenerator {...defaultProps} activeKeys={activeKeys} onRevoke={onRevoke} />);

    await userEvent.click(screen.getByText('Revoke'));
    expect(onRevoke).toHaveBeenCalledWith('key-abc-123');
  });

  it('empty state', () => {
    render(<ApiKeyGenerator {...defaultProps} activeKeys={[]} />);
    expect(screen.getByText('No active API keys')).toBeInTheDocument();
  });

  it('loading disables generate', () => {
    render(<ApiKeyGenerator {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
  });

  it('onGenerate returning null does not show key display', async () => {
    const onGenerate = vi.fn().mockResolvedValue(null);
    render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(onGenerate).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('key-plaintext')).not.toBeInTheDocument();
  });
});
