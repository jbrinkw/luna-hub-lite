import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';

const exercises: Exercise[] = [
  { exercise_id: 'ex-1', name: 'Squat' },
  { exercise_id: 'ex-2', name: 'Bench Press' },
  { exercise_id: 'ex-3', name: 'Deadlift' },
];

describe('AdHocSetForm', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders exercise select dropdown with all exercises', () => {
    render(<AdHocSetForm exercises={exercises} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByTestId('exercise-select') as HTMLSelectElement;
    // +1 for the placeholder "Select exercise..." option
    expect(select.options).toHaveLength(4);
    expect(select.options[0]).toHaveTextContent('Select exercise...');
    expect(select.options[1]).toHaveTextContent('Squat');
    expect(select.options[2]).toHaveTextContent('Bench Press');
    expect(select.options[3]).toHaveTextContent('Deadlift');
  });

  it('renders reps and load inputs', () => {
    render(<AdHocSetForm exercises={exercises} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('adhoc-reps')).toBeInTheDocument();
    expect(screen.getByTestId('adhoc-load')).toBeInTheDocument();
  });

  it('submit button is disabled when no exercise is selected', () => {
    render(<AdHocSetForm exercises={exercises} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('adhoc-submit')).toBeDisabled();
  });

  it('calls onSubmit with correct values when form is complete', async () => {
    const onSubmit = vi.fn();
    render(<AdHocSetForm exercises={exercises} onSubmit={onSubmit} onCancel={vi.fn()} />);

    // Select exercise
    const select = screen.getByTestId('exercise-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'ex-2');

    // Fill reps and load
    const repsInput = screen.getByTestId('adhoc-reps');
    const loadInput = screen.getByTestId('adhoc-load');
    await userEvent.type(repsInput, '5');
    await userEvent.type(loadInput, '135');

    await userEvent.click(screen.getByTestId('adhoc-submit'));
    expect(onSubmit).toHaveBeenCalledWith('ex-2', 5, 135);
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const onCancel = vi.fn();
    render(<AdHocSetForm exercises={exercises} onSubmit={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByTestId('adhoc-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders empty options when exercises array is empty', () => {
    render(<AdHocSetForm exercises={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByTestId('exercise-select') as HTMLSelectElement;
    // Only the placeholder option
    expect(select.options).toHaveLength(1);
    expect(select.options[0]).toHaveTextContent('Select exercise...');
  });
});
