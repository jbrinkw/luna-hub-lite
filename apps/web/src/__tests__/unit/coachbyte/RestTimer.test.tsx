import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RestTimer, formatTime } from '@/components/coachbyte/RestTimer';

describe('RestTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const defaultProps = {
    endTime: null,
    state: 'idle' as const,
    durationSeconds: 0,
    elapsedBeforePause: 0,
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onReset: vi.fn(),
  };

  it('renders 0:00 in idle state', () => {
    render(<RestTimer {...defaultProps} />);
    expect(screen.getByTestId('timer-display')).toHaveTextContent('0:00');
  });

  it('displays countdown when running', () => {
    const endTime = new Date(Date.now() + 90_000).toISOString();
    render(
      <RestTimer {...defaultProps} state="running" endTime={endTime} durationSeconds={90} />,
    );
    expect(screen.getByTestId('timer-display')).toHaveTextContent('1:30');
  });

  it('shows Pause button when running', () => {
    const endTime = new Date(Date.now() + 60_000).toISOString();
    render(
      <RestTimer {...defaultProps} state="running" endTime={endTime} durationSeconds={60} />,
    );
    expect(screen.getByTestId('pause-btn')).toBeInTheDocument();
  });

  it('calls onPause when Pause button is clicked', async () => {
    vi.useRealTimers();
    const onPause = vi.fn();
    const endTime = new Date(Date.now() + 60_000).toISOString();
    render(
      <RestTimer {...defaultProps} state="running" endTime={endTime} durationSeconds={60} onPause={onPause} />,
    );
    await userEvent.click(screen.getByTestId('pause-btn'));
    expect(onPause).toHaveBeenCalled();
  });

  it('shows Resume button when paused', () => {
    render(
      <RestTimer {...defaultProps} state="paused" durationSeconds={60} elapsedBeforePause={20} />,
    );
    expect(screen.getByTestId('resume-btn')).toBeInTheDocument();
  });

  it('displays remaining time when paused (duration - elapsed)', () => {
    render(
      <RestTimer {...defaultProps} state="paused" durationSeconds={90} elapsedBeforePause={30} />,
    );
    expect(screen.getByTestId('timer-display')).toHaveTextContent('1:00');
  });

  it('calls onResume when Resume button is clicked', async () => {
    vi.useRealTimers();
    const onResume = vi.fn();
    render(
      <RestTimer {...defaultProps} state="paused" durationSeconds={60} elapsedBeforePause={20} onResume={onResume} />,
    );
    await userEvent.click(screen.getByTestId('resume-btn'));
    expect(onResume).toHaveBeenCalled();
  });

  it('shows "Timer expired" when state is expired', () => {
    render(<RestTimer {...defaultProps} state="expired" durationSeconds={60} />);
    expect(screen.getByTestId('timer-expired')).toHaveTextContent('Timer expired');
    expect(screen.getByTestId('timer-display')).toHaveTextContent('0:00');
  });

  it('shows Reset button in running, paused, and expired states', () => {
    const { rerender } = render(
      <RestTimer {...defaultProps} state="running" endTime={new Date(Date.now() + 60_000).toISOString()} durationSeconds={60} />,
    );
    expect(screen.getByTestId('reset-btn')).toBeInTheDocument();

    rerender(<RestTimer {...defaultProps} state="paused" durationSeconds={60} elapsedBeforePause={20} />);
    expect(screen.getByTestId('reset-btn')).toBeInTheDocument();

    rerender(<RestTimer {...defaultProps} state="expired" durationSeconds={60} />);
    expect(screen.getByTestId('reset-btn')).toBeInTheDocument();
  });

  it('calls onReset when Reset is clicked', async () => {
    vi.useRealTimers();
    const onReset = vi.fn();
    render(
      <RestTimer {...defaultProps} state="expired" durationSeconds={60} onReset={onReset} />,
    );
    await userEvent.click(screen.getByTestId('reset-btn'));
    expect(onReset).toHaveBeenCalled();
  });

  it('countdown tick decrements the display after 1 second', async () => {
    const endTime = new Date(Date.now() + 90_000).toISOString();
    render(
      <RestTimer {...defaultProps} state="running" endTime={endTime} durationSeconds={90} />,
    );
    expect(screen.getByTestId('timer-display')).toHaveTextContent('1:30');

    // Advance by 1 second — the interval fires and remaining should drop
    // Use act to flush React state updates triggered by the interval
    const { act } = await import('@testing-library/react');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('timer-display')).toHaveTextContent('1:29');
  });

  it('custom duration input calls onStart with seconds', async () => {
    vi.useRealTimers();
    const onStart = vi.fn();
    render(<RestTimer {...defaultProps} onStart={onStart} />);

    const input = screen.getByTestId('custom-duration-input');
    await userEvent.type(input, '120');
    await userEvent.click(screen.getByTestId('custom-start-btn'));
    expect(onStart).toHaveBeenCalledWith(120);
  });
});

describe('formatTime', () => {
  it('formats 0 as 0:00', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('formats 90 as 1:30', () => {
    expect(formatTime(90)).toBe('1:30');
  });

  it('formats 5 as 0:05', () => {
    expect(formatTime(5)).toBe('0:05');
  });

  it('formats 3600 as 60:00', () => {
    expect(formatTime(3600)).toBe('60:00');
  });

  it('treats negative values as 0:00', () => {
    expect(formatTime(-10)).toBe('0:00');
  });
});
