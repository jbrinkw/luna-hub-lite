import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolToggle } from '@/components/hub/ToolToggle';

const tools = [
  { tool_name: 'COACHBYTE_LOG_SET', description: 'Log a completed set', enabled: true },
  { tool_name: 'CHEFBYTE_SCAN_BARCODE', description: 'Scan a barcode', enabled: false },
];

describe('ToolToggle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders tool names and descriptions', () => {
    render(<ToolToggle tools={tools} onToggle={vi.fn()} />);
    expect(screen.getByText('COACHBYTE_LOG_SET')).toBeInTheDocument();
    expect(screen.getByText('Log a completed set')).toBeInTheDocument();
    expect(screen.getByText('CHEFBYTE_SCAN_BARCODE')).toBeInTheDocument();
  });

  it('each tool has a toggle showing enabled/disabled', () => {
    render(<ToolToggle tools={tools} onToggle={vi.fn()} />);
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAttribute('aria-checked', 'true');
    expect(toggles[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling calls onToggle with correct args', async () => {
    const onToggle = vi.fn();
    render(<ToolToggle tools={tools} onToggle={onToggle} />);

    const toggles = screen.getAllByRole('switch');
    await userEvent.click(toggles[1]); // Toggle CHEFBYTE_SCAN_BARCODE
    expect(onToggle).toHaveBeenCalledWith('CHEFBYTE_SCAN_BARCODE', true);
  });

  it('shows empty message when no tools', () => {
    render(<ToolToggle tools={[]} onToggle={vi.fn()} />);
    expect(screen.getByText(/no tools configured/i)).toBeInTheDocument();
  });

  it('shows skeleton when loading', () => {
    const { container } = render(<ToolToggle tools={[]} loading onToggle={vi.fn()} />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('toggle enabled tool off', async () => {
    const onToggle = vi.fn();
    render(<ToolToggle tools={tools} onToggle={onToggle} />);

    const toggles = screen.getAllByRole('switch');
    await userEvent.click(toggles[0]); // Toggle COACHBYTE_LOG_SET (currently enabled)
    expect(onToggle).toHaveBeenCalledWith('COACHBYTE_LOG_SET', false);
  });
});
