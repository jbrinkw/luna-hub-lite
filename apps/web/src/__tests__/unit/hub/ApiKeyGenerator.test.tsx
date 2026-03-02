import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeyGenerator } from '@/components/hub/ApiKeyGenerator';

describe('ApiKeyGenerator', () => {
  const defaultProps = {
    activeKeys: [],
    onGenerate: vi.fn().mockResolvedValue('sk-test-key-123'),
    onRevoke: vi.fn(),
  };

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
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ApiKeyGenerator {...defaultProps} />);

    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => {
      expect(screen.getByTestId('key-plaintext')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Copy'));
    expect(writeText).toHaveBeenCalledWith('sk-test-key-123');
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
});
