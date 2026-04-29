/**
 * SetQueue — "Mark as failed" affordance (CoachByte FLAG F1).
 *
 * The button submits the set with `actual_reps = 0` so the
 * server-side PR detection (`coachbyte_functions.sql:110` filter on
 * `actual_reps > 0`) skips it. Distinct from "Complete Set" so a
 * lifter can record a failed attempt for trend visibility without
 * false PRs and without typing 0.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';

vi.mock('@/shared/plateCalc', () => ({
  formatWeightWithPlates: (w: number) => `${w}`,
}));

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

function renderQueue(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('SetQueue — Mark as failed (FLAG F1)', () => {
  it('renders the failed-set button when onFailed is provided', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onFailed={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.getByTestId('failed-set-btn')).toBeInTheDocument();
    expect(screen.getByTestId('failed-set-btn')).toHaveTextContent(/failed/i);
  });

  it('hides the failed button when onFailed is not provided', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onAdHoc={vi.fn()} />);
    expect(screen.queryByTestId('failed-set-btn')).not.toBeInTheDocument();
  });

  it('passes the typed-in load to onFailed (so partial-rep records still capture the weight on the bar)', async () => {
    const onFailed = vi.fn();
    const user = userEvent.setup();
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onFailed={onFailed} onAdHoc={vi.fn()} />);

    // The form prefills target_load=225 — change it to 235 to simulate
    // the lifter loaded the bar heavier and failed at the new weight.
    const loadInput = screen.getByTestId('override-load') as HTMLInputElement;
    await user.clear(loadInput);
    await user.type(loadInput, '235');

    await user.click(screen.getByTestId('failed-set-btn'));
    expect(onFailed).toHaveBeenCalledWith(235);
  });

  it('falls back to target_load when the load input is cleared (zero-typing path)', async () => {
    const onFailed = vi.fn();
    const user = userEvent.setup();
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onFailed={onFailed} onAdHoc={vi.fn()} />);

    const loadInput = screen.getByTestId('override-load') as HTMLInputElement;
    await user.clear(loadInput);

    await user.click(screen.getByTestId('failed-set-btn'));
    // Empty input → NaN → fallback to nextSet.target_load (225).
    expect(onFailed).toHaveBeenCalledWith(225);
  });

  it('disables the failed button while completing=true (prevents double-fire alongside Complete Set)', () => {
    renderQueue(<SetQueue sets={sets} onComplete={vi.fn()} onFailed={vi.fn()} onAdHoc={vi.fn()} completing={true} />);
    expect(screen.getByTestId('failed-set-btn')).toBeDisabled();
  });
});
