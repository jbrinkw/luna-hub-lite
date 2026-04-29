/**
 * SetQueue — UX-audit follow-ups (April 2026 audit batch).
 *
 * Verifies the new prop-driven affordances we added:
 *   - lastTimeStat surfaces "Last time: Nr @ X lb (Yd ago)"
 *   - completing flag turns Complete-Set into a "Saving…" loading state
 *   - +15s / +30s extend buttons render in running/paused states
 *   - Skip button renders in running/paused/expired states
 *   - timer-presets render in idle/expired states
 *   - The redundant readonly "Exercise" input was removed
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';

vi.mock('@/shared/plateCalc', () => ({
  formatWeightWithPlates: (w: number) => `${w}`,
}));

function renderQueue(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const sets: PlannedSet[] = [
  {
    planned_set_id: 'ps-1',
    exercise_id: 'ex-1',
    exercise_name: 'Squat',
    target_reps: 5,
    target_load: 225,
    target_load_percentage: null,
    rest_seconds: 180,
    order: 1,
    completed: false,
  },
];

describe('SetQueue — last-time stat', () => {
  it('shows "Last time: Nr @ X lb (today)" when daysAgo=0', () => {
    renderQueue(
      <SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} lastTimeStat={{ reps: 8, load: 185, daysAgo: 0 }} />,
    );
    const stat = screen.getByTestId('last-time-stat');
    expect(stat).toBeInTheDocument();
    expect(stat).toHaveTextContent('Last time:');
    expect(stat).toHaveTextContent('8r @ 185');
    expect(stat).toHaveTextContent('today');
  });

  it('formats "yesterday" for daysAgo=1', () => {
    renderQueue(
      <SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} lastTimeStat={{ reps: 6, load: 200, daysAgo: 1 }} />,
    );
    expect(screen.getByTestId('last-time-stat')).toHaveTextContent('yesterday');
  });

  it('formats "Nd ago" for daysAgo>1', () => {
    renderQueue(
      <SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} lastTimeStat={{ reps: 5, load: 225, daysAgo: 7 }} />,
    );
    expect(screen.getByTestId('last-time-stat')).toHaveTextContent('7d ago');
  });

  it('hides the last-time card when no stat is provided (first time doing this exercise)', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} lastTimeStat={null} />);
    expect(screen.queryByTestId('last-time-stat')).not.toBeInTheDocument();
  });
});

describe('SetQueue — completing flag', () => {
  it('shows "Saving…" label and disables the Complete button when completing=true', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} completing={true} />);
    const btn = screen.getByTestId('complete-set-btn');
    expect(btn).toHaveTextContent(/Saving/i);
    expect(btn).toBeDisabled();
  });

  it('shows normal "Complete Set" label when completing=false', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} completing={false} />);
    expect(screen.getByTestId('complete-set-btn')).toHaveTextContent(/Complete Set/i);
  });
});

describe('SetQueue — extend timer buttons', () => {
  it('renders +15s and +30s when timer is running and onTimerExtend is provided', () => {
    const onExtend = vi.fn();
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={vi.fn()}
        onTimerExtend={onExtend}
      />,
    );
    expect(screen.getByTestId('extend-15-btn')).toBeInTheDocument();
    expect(screen.getByTestId('extend-30-btn')).toBeInTheDocument();
  });

  it('calls onTimerExtend with 15 when +15s is clicked', async () => {
    const onExtend = vi.fn();
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={vi.fn()}
        onTimerExtend={onExtend}
      />,
    );
    await userEvent.click(screen.getByTestId('extend-15-btn'));
    expect(onExtend).toHaveBeenCalledWith(15);
  });

  it('hides extend buttons when onTimerExtend is not provided', () => {
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('extend-15-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('extend-30-btn')).not.toBeInTheDocument();
  });

  it('hides extend buttons when timer is idle', () => {
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="idle"
        onTimerStart={vi.fn()}
        onTimerExtend={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('extend-15-btn')).not.toBeInTheDocument();
  });
});

describe('SetQueue — skip timer button', () => {
  it('renders Skip button when timer is running', () => {
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={vi.fn()}
        onTimerSkip={vi.fn()}
      />,
    );
    expect(screen.getByTestId('skip-btn')).toBeInTheDocument();
  });

  it('calls onTimerSkip when Skip is clicked (NOT onTimerReset)', async () => {
    const onSkip = vi.fn();
    const onReset = vi.fn();
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={onReset}
        onTimerSkip={onSkip}
      />,
    );
    await userEvent.click(screen.getByTestId('skip-btn'));
    expect(onSkip).toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});

describe('SetQueue — timer presets', () => {
  it('renders 60/90/120/180s preset buttons when timer is idle', () => {
    renderQueue(
      <SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="idle" onTimerStart={vi.fn()} />,
    );
    expect(screen.getByTestId('timer-preset-60')).toBeInTheDocument();
    expect(screen.getByTestId('timer-preset-90')).toBeInTheDocument();
    expect(screen.getByTestId('timer-preset-120')).toBeInTheDocument();
    expect(screen.getByTestId('timer-preset-180')).toBeInTheDocument();
  });

  it('calls onTimerStart with the preset value when a preset is clicked', async () => {
    const onStart = vi.fn();
    renderQueue(
      <SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="idle" onTimerStart={onStart} />,
    );
    await userEvent.click(screen.getByTestId('timer-preset-90'));
    expect(onStart).toHaveBeenCalledWith(90);
  });
});

describe('SetQueue — redundant Exercise input removed', () => {
  it('does NOT render the readonly "Exercise" override input on the completion form', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // The exercise name shows as a 2xl-bold heading inside next-exercise;
    // the form inputs are reps + load only.
    expect(screen.queryByTestId('override-exercise')).not.toBeInTheDocument();
    expect(screen.getByTestId('override-reps')).toBeInTheDocument();
    expect(screen.getByTestId('override-load')).toBeInTheDocument();
  });
});

describe('SetQueue — tap-target sizes (lg = 44px)', () => {
  it('Pause/Resume/Reset/Skip use the lg size class (44px tall) in running state', () => {
    renderQueue(
      <SetQueue
        sets={sets}
        onComplete={vi.fn()}
        onAdHoc={vi.fn()}
        timerState="running"
        timerDisplay="1:30"
        onTimerPause={vi.fn()}
        onTimerReset={vi.fn()}
        onTimerSkip={vi.fn()}
      />,
    );
    // Tailwind class min-h-[44px] is what Button size="lg" renders.
    expect(screen.getByTestId('pause-btn').className).toContain('min-h-[44px]');
    expect(screen.getByTestId('reset-btn').className).toContain('min-h-[44px]');
    expect(screen.getByTestId('skip-btn').className).toContain('min-h-[44px]');
  });
});
