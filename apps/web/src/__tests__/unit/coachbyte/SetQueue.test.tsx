import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';

// Mock plateCalc so tests don't depend on plate breakdown formatting
vi.mock('@/shared/plateCalc', () => ({
  formatWeightWithPlates: (w: number) => `${w}`,
}));

const makeSets = (overrides?: Partial<PlannedSet>[]): PlannedSet[] => [
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
    ...overrides?.[0],
  },
  {
    planned_set_id: 'ps-2',
    exercise_id: 'ex-2',
    exercise_name: 'Bench Press',
    target_reps: 8,
    target_load: 185,
    target_load_percentage: null,
    rest_seconds: 120,
    order: 2,
    completed: false,
    ...overrides?.[1],
  },
  {
    planned_set_id: 'ps-3',
    exercise_id: 'ex-1',
    exercise_name: 'Squat',
    target_reps: 5,
    target_load: 240,
    target_load_percentage: 80,
    rest_seconds: 180,
    order: 3,
    completed: false,
    ...overrides?.[2],
  },
];

describe('SetQueue', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No workout planned" when sets array is empty', () => {
    render(<SetQueue sets={[]} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByText(/no workout planned/i)).toBeInTheDocument();
  });

  it('renders the next incomplete set in the NEXT IN QUEUE card', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('next-in-queue')).toBeInTheDocument();
    expect(screen.getByTestId('next-exercise')).toHaveTextContent('Squat');
    expect(screen.getByTestId('next-exercise')).toHaveTextContent('225 lb');
  });

  it('pre-fills override inputs with target values of the next set', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    const repsInput = screen.getByTestId('override-reps');
    const loadInput = screen.getByTestId('override-load');
    expect(repsInput).toHaveValue(5);
    expect(loadInput).toHaveValue(225);
  });

  it('calls onComplete with target (pre-filled) values when Complete Set is clicked without overriding', async () => {
    const onComplete = vi.fn();
    render(<SetQueue sets={makeSets()} onComplete={onComplete} onAdHoc={vi.fn()} />);

    // Click Complete without modifying the pre-filled inputs
    await userEvent.click(screen.getByTestId('complete-set-btn'));
    expect(onComplete).toHaveBeenCalledWith(5, 225);
  });

  it('calls onComplete with override values when Complete Set is clicked', async () => {
    const onComplete = vi.fn();
    render(<SetQueue sets={makeSets()} onComplete={onComplete} onAdHoc={vi.fn()} />);

    const repsInput = screen.getByTestId('override-reps');
    const loadInput = screen.getByTestId('override-load');
    await userEvent.clear(repsInput);
    await userEvent.type(repsInput, '6');
    await userEvent.clear(loadInput);
    await userEvent.type(loadInput, '230');

    await userEvent.click(screen.getByTestId('complete-set-btn'));
    expect(onComplete).toHaveBeenCalledWith(6, 230);
  });

  it('shows pending sets as compact preview cards (Coming Up section)', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Set 1 is "next", sets 2 and 3 should be in "Coming Up" preview
    expect(screen.getByTestId('coming-up-preview')).toBeInTheDocument();
    expect(screen.getByTestId('preview-set-2')).toHaveTextContent('Bench Press');
    expect(screen.getByTestId('preview-set-3')).toHaveTextContent('Squat');
  });

  it('shows expand button to reveal full editable queue table', async () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    const expandBtn = screen.getByTestId('expand-queue-btn');
    expect(expandBtn).toBeInTheDocument();

    // Full queue table is NOT visible before expanding
    expect(screen.queryByTestId('full-queue-table')).not.toBeInTheDocument();

    // Expand
    await userEvent.click(expandBtn);
    expect(screen.getByTestId('full-queue-table')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-2')).toHaveTextContent('Bench Press');
    expect(screen.getByTestId('queue-row-3')).toHaveTextContent('Squat');
  });

  it('displays load percentage in editable input when queue is expanded', async () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Expand the queue
    await userEvent.click(screen.getByTestId('expand-queue-btn'));
    // Set 3 has percentage 80% — the load input shows the percentage value
    const loadInput = screen.getByTestId('edit-load-3');
    expect(loadInput).toHaveValue(80);
  });

  it('displays null load when target_load_percentage set but target_load is null (expanded)', async () => {
    const sets = makeSets();
    sets[2].target_load = null;
    sets[2].target_load_percentage = 75;
    render(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    await userEvent.click(screen.getByTestId('expand-queue-btn'));
    const loadInput = screen.getByTestId('edit-load-3');
    expect(loadInput).toHaveValue(75);
  });

  it('skips completed sets when finding the next incomplete set', () => {
    const sets = makeSets([{ completed: true }]);
    render(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('next-exercise')).toHaveTextContent('Bench Press');
  });

  it('calls onAdHoc when Ad-Hoc Set button is clicked', async () => {
    const onAdHoc = vi.fn();
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={onAdHoc} />);
    await userEvent.click(screen.getByTestId('adhoc-btn'));
    expect(onAdHoc).toHaveBeenCalled();
  });

  it('syncs reps/load inputs when nextSet changes (useEffect)', async () => {
    const sets1 = makeSets();
    const { rerender } = render(<SetQueue sets={sets1} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Initially pre-filled with set 1 values
    expect(screen.getByTestId('override-reps')).toHaveValue(5);
    expect(screen.getByTestId('override-load')).toHaveValue(225);

    // Mark set 1 as completed — nextSet should now be set 2
    const sets2 = makeSets([{ completed: true }]);
    rerender(<SetQueue sets={sets2} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('override-reps')).toHaveValue(8);
    expect(screen.getByTestId('override-load')).toHaveValue(185);
  });

  it('syncs to third set when first two are completed', async () => {
    const sets = makeSets([{ completed: true }, { completed: true }]);
    render(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('override-reps')).toHaveValue(5);
    expect(screen.getByTestId('override-load')).toHaveValue(240);
  });

  it('disables Complete Set and Ad-Hoc buttons when disabled prop is true', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} disabled />);
    expect(screen.getByTestId('complete-set-btn')).toBeDisabled();
    expect(screen.getByTestId('adhoc-btn')).toBeDisabled();
  });

  it('shows "All sets completed!" when every set has completed: true', () => {
    const allDone = makeSets([{ completed: true }, { completed: true }, { completed: true }]);
    render(<SetQueue sets={allDone} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByText('All sets completed!')).toBeInTheDocument();
    // The next-exercise box should not appear
    expect(screen.queryByTestId('next-exercise')).not.toBeInTheDocument();
  });

  it('can collapse the expanded queue table', async () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Expand
    await userEvent.click(screen.getByTestId('expand-queue-btn'));
    expect(screen.getByTestId('full-queue-table')).toBeInTheDocument();

    // Collapse
    await userEvent.click(screen.getByTestId('collapse-queue-btn'));
    expect(screen.queryByTestId('full-queue-table')).not.toBeInTheDocument();
    // Preview should be back
    expect(screen.getByTestId('coming-up-preview')).toBeInTheDocument();
  });

  describe('inline timer controls', () => {
    it('shows Pause button when timer is running', () => {
      render(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="running"
          timerDisplay="1:30"
          onTimerPause={vi.fn()}
          onTimerReset={vi.fn()}
        />,
      );
      expect(screen.getByTestId('pause-btn')).toBeInTheDocument();
    });

    it('calls onTimerPause when Pause is clicked', async () => {
      const onPause = vi.fn();
      render(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="running"
          timerDisplay="1:30"
          onTimerPause={onPause}
          onTimerReset={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId('pause-btn'));
      expect(onPause).toHaveBeenCalled();
    });

    it('shows Resume button when timer is paused', () => {
      render(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="paused"
          timerDisplay="0:45"
          onTimerResume={vi.fn()}
          onTimerReset={vi.fn()}
        />,
      );
      expect(screen.getByTestId('resume-btn')).toBeInTheDocument();
    });

    it('calls onTimerResume when Resume is clicked', async () => {
      const onResume = vi.fn();
      render(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="paused"
          timerDisplay="0:45"
          onTimerResume={onResume}
          onTimerReset={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId('resume-btn'));
      expect(onResume).toHaveBeenCalled();
    });

    it('shows Reset button in running, paused, and expired states', () => {
      const { rerender } = render(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="running"
          timerDisplay="1:30"
          onTimerPause={vi.fn()}
          onTimerReset={vi.fn()}
        />,
      );
      expect(screen.getByTestId('reset-btn')).toBeInTheDocument();

      rerender(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="paused"
          timerDisplay="0:45"
          onTimerResume={vi.fn()}
          onTimerReset={vi.fn()}
        />,
      );
      expect(screen.getByTestId('reset-btn')).toBeInTheDocument();

      rerender(
        <SetQueue
          sets={makeSets()}
          onComplete={vi.fn()}
          onAdHoc={vi.fn()}
          timerState="expired"
          timerDisplay="expired!"
          onTimerReset={vi.fn()}
        />,
      );
      expect(screen.getByTestId('reset-btn')).toBeInTheDocument();
    });

    it('shows custom timer start input when idle', () => {
      render(
        <SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="idle" onTimerStart={vi.fn()} />,
      );
      expect(screen.getByTestId('custom-duration-input')).toBeInTheDocument();
      expect(screen.getByTestId('custom-start-btn')).toBeInTheDocument();
    });

    it('calls onTimerStart with custom duration', async () => {
      const onStart = vi.fn();
      render(
        <SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="idle" onTimerStart={onStart} />,
      );
      const input = screen.getByTestId('custom-duration-input');
      await userEvent.type(input, '120');
      await userEvent.click(screen.getByTestId('custom-start-btn'));
      expect(onStart).toHaveBeenCalledWith(120);
    });

    it('does not call onTimerStart with invalid duration', async () => {
      const onStart = vi.fn();
      render(
        <SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="idle" onTimerStart={onStart} />,
      );
      // Click start without entering a value
      await userEvent.click(screen.getByTestId('custom-start-btn'));
      expect(onStart).not.toHaveBeenCalled();
    });

    it('does not show timer controls when no timer callbacks provided', () => {
      render(
        <SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} timerState="running" timerDisplay="1:30" />,
      );
      // No pause/resume/reset without callbacks
      expect(screen.queryByTestId('pause-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('resume-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reset-btn')).not.toBeInTheDocument();
    });
  });
});
