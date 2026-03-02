import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolToggle } from '@/components/hub/ToolToggle';

const tools = [
  { tool_name: 'COACHBYTE_LOG_SET', description: 'Log a completed set', enabled: true },
  { tool_name: 'CHEFBYTE_SCAN_BARCODE', description: 'Scan a barcode', enabled: false },
];

describe('ToolToggle', () => {
  it('renders tool names and descriptions', () => {
    render(<ToolToggle tools={tools} onToggle={vi.fn()} />);
    expect(screen.getByText('COACHBYTE_LOG_SET')).toBeInTheDocument();
    expect(screen.getByText('Log a completed set')).toBeInTheDocument();
    expect(screen.getByText('CHEFBYTE_SCAN_BARCODE')).toBeInTheDocument();
  });

  it('each tool has a toggle showing enabled/disabled', () => {
    render(<ToolToggle tools={tools} onToggle={vi.fn()} />);
    const toggles = screen.getAllByRole('checkbox');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toBeChecked();
    expect(toggles[1]).not.toBeChecked();
  });

  it('toggling calls onToggle with correct args', async () => {
    const onToggle = vi.fn();
    render(<ToolToggle tools={tools} onToggle={onToggle} />);

    const toggles = screen.getAllByRole('checkbox');
    await userEvent.click(toggles[1]); // Toggle CHEFBYTE_SCAN_BARCODE
    expect(onToggle).toHaveBeenCalledWith('CHEFBYTE_SCAN_BARCODE', true);
  });

  it('shows empty message when no tools', () => {
    render(<ToolToggle tools={[]} onToggle={vi.fn()} />);
    expect(screen.getByText(/no tools configured/i)).toBeInTheDocument();
  });

  it('shows spinner when loading', () => {
    render(<ToolToggle tools={[]} loading onToggle={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
