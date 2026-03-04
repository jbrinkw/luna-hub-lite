import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';

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

  it('shows pending sets in the SET QUEUE table (excluding next and completed)', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Set 1 is "next", sets 2 and 3 should be in queue
    expect(screen.getByTestId('queue-row-2')).toHaveTextContent('Bench Press');
    expect(screen.getByTestId('queue-row-3')).toHaveTextContent('Squat');
  });

  it('displays relative load as "load lb (percentage%)" when target_load_percentage is set', () => {
    render(<SetQueue sets={makeSets()} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    // Set 3 has percentage 80% and load 240
    expect(screen.getByTestId('queue-row-3')).toHaveTextContent('240 lb (80%)');
  });

  it('displays "--- (percentage% — no PR)" when target_load_percentage set but target_load is null', () => {
    const sets = makeSets();
    sets[2].target_load = null;
    sets[2].target_load_percentage = 75;
    render(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('queue-row-3')).toHaveTextContent('--- (75% — no PR)');
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
    // The NEXT IN QUEUE card should not appear
    expect(screen.queryByTestId('next-in-queue')).not.toBeInTheDocument();
  });
});
