import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Timer, Play, Pause, RotateCcw, SkipForward, Clock } from 'lucide-react';
import { WEIGHT_UNIT } from '@/shared/constants';
import { formatWeightWithPlates } from '@/shared/plateCalc';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export interface PlannedSet {
  planned_set_id: string;
  exercise_id: string;
  exercise_name: string;
  target_reps: number | null;
  target_load: number | null;
  target_load_percentage: number | null;
  rest_seconds: number | null;
  order: number;
  completed: boolean;
}

export interface LastTimeStat {
  reps: number;
  load: number;
  daysAgo: number;
}

const TIMER_PRESETS = [60, 90, 120, 180];
const TIMER_EXTEND_SECONDS = [15, 30];

interface SetQueueProps {
  sets: PlannedSet[];
  onComplete: (reps: number, load: number) => void;
  onAdHoc: () => void;
  onUpdateSet?: (plannedSetId: string, field: string, value: number | null) => void;
  onDeleteSet?: (plannedSetId: string) => void;
  onAddSet?: () => void;
  timerState?: 'running' | 'paused' | 'expired' | 'idle';
  timerDisplay?: string;
  disabled?: boolean;
  /** Most recent set the user did for the upcoming exercise. Surfaced
   * directly under the prefilled targets — single most useful number
   * to show a lifter mid-workout. */
  lastTimeStat?: LastTimeStat | null;
  /** True while the Complete-Set mutation is in flight — used to flip
   * the button into a "Saving..." state. */
  completing?: boolean;
  // Timer control callbacks (inline controls)
  onTimerStart?: (seconds: number) => void;
  onTimerPause?: () => void;
  onTimerResume?: () => void;
  onTimerReset?: () => void;
  /** Add seconds to a running/paused timer (relative). When unset the
   * +15s / +30s buttons are hidden. */
  onTimerExtend?: (seconds: number) => void;
  /** Skip rest = end timer + jump to "ready for next set" without
   * deleting the sequence. Distinct from Reset. */
  onTimerSkip?: () => void;
}

export function SetQueue({
  sets,
  onComplete,
  onAdHoc,
  onUpdateSet,
  onDeleteSet,
  onAddSet,
  timerState,
  timerDisplay,
  disabled,
  lastTimeStat,
  completing,
  onTimerStart,
  onTimerPause,
  onTimerResume,
  onTimerReset,
  onTimerExtend,
  onTimerSkip,
}: SetQueueProps) {
  const nextSet = sets.find((s) => !s.completed);
  const [reps, setReps] = useState<string>(nextSet?.target_reps?.toString() ?? '');
  const [load, setLoad] = useState<string>(nextSet?.target_load?.toString() ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [customDuration, setCustomDuration] = useState('');
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReps(nextSet?.target_reps?.toString() ?? '');

    setLoad(nextSet?.target_load?.toString() ?? '');

    setValidationError(null);
  }, [nextSet?.planned_set_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  const pendingSets = sets.filter((s) => !s.completed && s !== nextSet);
  const previewSets = pendingSets.slice(0, 3);
  const hasMoreSets = pendingSets.length > 3;

  const formatLoadDisplay = (set: PlannedSet) => {
    if (set.target_load_percentage && set.target_load) {
      return `${formatWeightWithPlates(set.target_load)} ${WEIGHT_UNIT} (${set.target_load_percentage}%)`;
    }
    if (set.target_load_percentage && !set.target_load) {
      return `--- (${set.target_load_percentage}% — no PR)`;
    }
    if (set.target_load) {
      return `${formatWeightWithPlates(set.target_load)} ${WEIGHT_UNIT}`;
    }
    return '---';
  };

  const handleComplete = () => {
    const r = parseInt(reps, 10);
    const l = parseFloat(load);
    if (isNaN(r) || isNaN(l)) {
      setValidationError('Please enter valid numbers for reps and load.');
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = setTimeout(() => setValidationError(null), 4000);
      return;
    }
    setValidationError(null);
    onComplete(r, l);
  };

  const handleCustomTimerStart = () => {
    const secs = parseInt(customDuration, 10);
    if (!isNaN(secs) && secs > 0) {
      onTimerStart?.(secs);
      setCustomDuration('');
    }
  };

  if (sets.length === 0) {
    return (
      <div className="text-center py-10 border-2 border-dashed border-border-strong rounded-xl bg-surface-sunken text-text-secondary">
        <h3 className="text-lg font-semibold mb-1">No workout planned for today.</h3>
        <p className="text-sm">Add sets manually or configure your weekly split.</p>
        <Link
          to="/coach/split"
          className="inline-block mt-3 text-sm font-medium text-coach-accent hover:text-coach-accent no-underline hover:underline"
        >
          Set up your weekly split &rarr;
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Next In Queue Section */}
      <div className="border border-success rounded-xl p-5 mb-5 bg-success-subtle/50" data-testid="next-in-queue">
        <h3 className="mt-0 mb-5 text-xl text-success-text font-bold">Next in Queue:</h3>

        {nextSet ? (
          <>
            <div
              className="bg-success-subtle p-4 rounded-lg mb-4 border-2 border-success flex flex-col sm:flex-row justify-between items-start gap-3"
              data-testid="next-exercise"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xl sm:text-2xl font-bold text-success-text mb-1.5 break-words">
                  {nextSet.exercise_name}
                </div>
                <div className="text-base sm:text-lg font-bold text-text">
                  {nextSet.target_reps} reps @ {formatLoadDisplay(nextSet)}
                </div>
                <div className="text-sm text-text-secondary mt-1">Rest: {nextSet.rest_seconds ?? 60} seconds</div>
              </div>
              <div
                className={[
                  'font-bold sm:text-right sm:ml-5 shrink-0',
                  timerState === 'running'
                    ? 'text-coach-accent'
                    : timerState === 'expired'
                      ? 'text-danger-text'
                      : 'text-text-secondary',
                ].join(' ')}
                data-testid="inline-timer"
              >
                <div className="text-xs mb-0.5">{timerState === 'expired' ? 'Timer' : 'Rest Timer'}</div>
                <div className="text-3xl sm:text-5xl font-mono leading-none">
                  {timerState === 'expired' ? 'expired!' : timerDisplay || '0:00'}
                </div>
              </div>
            </div>

            {/* Inline Timer Controls — `lg` size (44px) for sweaty-hand
                mid-workout taps. Skip is distinct from Reset; +15s/+30s
                let users non-destructively extend rest. */}
            <div className="flex gap-2 items-center flex-wrap mb-4" data-testid="timer-controls">
              {timerState === 'running' && onTimerPause && (
                <Button variant="secondary" size="lg" onClick={onTimerPause} data-testid="pause-btn">
                  <Pause className="w-4 h-4 mr-1 inline" />
                  Pause
                </Button>
              )}
              {timerState === 'paused' && onTimerResume && (
                <Button variant="secondary" size="lg" onClick={onTimerResume} data-testid="resume-btn">
                  <Play className="w-4 h-4 mr-1 inline" />
                  Resume
                </Button>
              )}
              {(timerState === 'running' || timerState === 'paused') &&
                onTimerExtend &&
                TIMER_EXTEND_SECONDS.map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    size="lg"
                    onClick={() => onTimerExtend(s)}
                    data-testid={`extend-${s}-btn`}
                    aria-label={`Add ${s} seconds to timer`}
                  >
                    +{s}s
                  </Button>
                ))}
              {(timerState === 'running' || timerState === 'paused' || timerState === 'expired') && onTimerSkip && (
                <Button variant="primary" size="lg" onClick={onTimerSkip} data-testid="skip-btn">
                  <SkipForward className="w-4 h-4 mr-1 inline" />
                  Skip
                </Button>
              )}
              {(timerState === 'running' || timerState === 'paused' || timerState === 'expired') && onTimerReset && (
                <Button variant="secondary" size="lg" onClick={onTimerReset} data-testid="reset-btn">
                  <RotateCcw className="w-4 h-4 mr-1 inline" />
                  Reset
                </Button>
              )}
              {(timerState === 'idle' || timerState === 'expired') && onTimerStart && (
                <div className="flex flex-wrap gap-1.5 items-center ml-auto" data-testid="timer-presets">
                  <Timer className="w-4 h-4 text-text-tertiary" />
                  {TIMER_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => onTimerStart(preset)}
                      className="px-3 py-2 text-sm rounded border border-border-strong text-text-secondary bg-surface-sunken hover:bg-surface-hover hover:border-border-strong min-h-[40px] min-w-[44px]"
                      data-testid={`timer-preset-${preset}`}
                      aria-label={`Start ${preset} second timer`}
                    >
                      {preset}s
                    </button>
                  ))}
                  <input
                    type="number"
                    value={customDuration}
                    onChange={(e) => setCustomDuration(e.target.value)}
                    placeholder="sec"
                    className="w-16 px-2 py-2 text-sm border border-border-strong rounded-md focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary min-h-[40px]"
                    data-testid="custom-duration-input"
                  />
                  <Button variant="secondary" size="lg" onClick={handleCustomTimerStart} data-testid="custom-start-btn">
                    Start
                  </Button>
                </div>
              )}
            </div>

            {lastTimeStat && (
              <div className="flex items-center gap-2 text-sm text-text-secondary mb-3" data-testid="last-time-stat">
                <Clock className="w-3.5 h-3.5" />
                <span>
                  Last time:{' '}
                  <strong className="text-text">
                    {lastTimeStat.reps}r @ {lastTimeStat.load} {WEIGHT_UNIT}
                  </strong>{' '}
                  <span className="text-text-tertiary">
                    (
                    {lastTimeStat.daysAgo === 0
                      ? 'today'
                      : lastTimeStat.daysAgo === 1
                        ? 'yesterday'
                        : `${lastTimeStat.daysAgo}d ago`}
                    )
                  </span>
                </span>
              </div>
            )}

            <form
              className="grid grid-cols-2 sm:grid-cols-[auto_auto_1fr_auto] gap-2 items-end"
              onSubmit={(e) => {
                e.preventDefault();
                handleComplete();
              }}
              data-testid="completion-form"
            >
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-text-secondary">Reps Done</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  className="w-full px-3 py-3 text-base text-center border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary min-h-[44px]"
                  data-testid="override-reps"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-text-secondary">Weight ({WEIGHT_UNIT})</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={load}
                  onChange={(e) => setLoad(e.target.value)}
                  className="w-full px-3 py-3 text-base text-center border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary min-h-[44px]"
                  data-testid="override-load"
                />
              </div>
              <Button
                type="submit"
                variant="success"
                size="xl"
                /* `disabled={completing}` is redundant with the
                   Button's `loading` prop (which already sets
                   `aria-disabled` and blocks pointer events), but
                   we set it explicitly here so a double-tap during
                   the optimistic-update window cannot fire mutate()
                   twice — even if `loading` were dropped in a
                   future refactor, the form-submit guard holds. */
                disabled={disabled || completing}
                loading={completing}
                data-testid="complete-set-btn"
                className="col-span-2 sm:col-span-1"
              >
                {completing ? 'Saving…' : 'Complete Set'}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={onAdHoc}
                disabled={disabled}
                data-testid="adhoc-btn"
                className="col-span-2 sm:col-span-1"
              >
                + Ad-Hoc Set
              </Button>
            </form>

            {validationError && (
              <p className="text-danger-text text-sm mt-2" data-testid="validation-error">
                {validationError}
              </p>
            )}
          </>
        ) : (
          <div className="bg-surface-sunken border-2 border-border-strong p-4 rounded-lg text-center">
            <div className="text-xl font-bold text-text-secondary py-2.5">All sets completed!</div>
          </div>
        )}
      </div>

      {/* Coming Up Preview + Expandable Full Queue */}
      {pendingSets.length > 0 && (
        <div className="mb-5">
          {/* Coming Up Preview — compact cards for next 2-3 sets */}
          {!queueExpanded && (
            <div data-testid="coming-up-preview">
              <h4 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">Coming Up</h4>
              <div className="space-y-1.5">
                {previewSets.map((set) => (
                  <div
                    key={set.planned_set_id}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 bg-surface border border-border rounded-lg px-3 py-2"
                    data-testid={`preview-set-${set.order}`}
                  >
                    <span className="font-medium text-text text-sm truncate">{set.exercise_name}</span>
                    <span className="text-sm text-text-secondary sm:text-right shrink-0">
                      {set.target_reps ?? '—'} reps @ {formatLoadDisplay(set)}
                    </span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setQueueExpanded(true)}
                className="mt-2 text-sm text-coach-accent hover:text-coach-accent font-medium flex items-center gap-1 cursor-pointer bg-transparent border-none p-0"
                data-testid="expand-queue-btn"
                aria-expanded={queueExpanded}
              >
                <ChevronDown className="w-4 h-4" />
                {hasMoreSets
                  ? `Show all (${pendingSets.length} remaining)`
                  : `Edit queue (${pendingSets.length} remaining)`}
              </button>
            </div>
          )}

          {/* Expanded Full Queue Table */}
          {queueExpanded && (
            <Card data-testid="full-queue-table">
              <CardHeader>
                <div className="flex items-center justify-between w-full">
                  <CardTitle>Set Queue ({pendingSets.length} remaining)</CardTitle>
                  <button
                    type="button"
                    onClick={() => setQueueExpanded(false)}
                    className="text-sm text-coach-accent hover:text-coach-accent font-medium flex items-center gap-1 cursor-pointer bg-transparent border-none p-0"
                    data-testid="collapse-queue-btn"
                    aria-expanded={queueExpanded}
                  >
                    <ChevronUp className="w-4 h-4" />
                    Collapse
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                          Exercise
                        </th>
                        <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                          Reps
                        </th>
                        <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                          Load
                        </th>
                        <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                          Rest
                        </th>
                        <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingSets.map((set) => (
                        <tr
                          key={set.planned_set_id}
                          data-testid={`queue-row-${set.order}`}
                          className="border-b border-border-light last:border-b-0"
                        >
                          <td className="px-3 py-2 align-middle">{set.exercise_name}</td>
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="number"
                              className="w-15 text-center px-2 py-1 text-sm border border-border-strong rounded-md focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                              defaultValue={set.target_reps ?? ''}
                              onBlur={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null;
                                if (val !== set.target_reps) onUpdateSet?.(set.planned_set_id, 'target_reps', val);
                              }}
                              data-testid={`edit-reps-${set.order}`}
                            />
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="number"
                              className="w-20 text-center px-2 py-1 text-sm border border-border-strong rounded-md focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                              defaultValue={set.target_load_percentage ?? set.target_load ?? ''}
                              onBlur={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null;
                                const field = set.target_load_percentage ? 'target_load_percentage' : 'target_load';
                                if (val !== (set.target_load_percentage ?? set.target_load))
                                  onUpdateSet?.(set.planned_set_id, field, val);
                              }}
                              data-testid={`edit-load-${set.order}`}
                            />
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="number"
                              className="w-[70px] text-center px-2 py-1 text-sm border border-border-strong rounded-md focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                              defaultValue={set.rest_seconds ?? 60}
                              onBlur={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null;
                                if (val !== set.rest_seconds) onUpdateSet?.(set.planned_set_id, 'rest_seconds', val);
                              }}
                              data-testid={`edit-rest-${set.order}`}
                            />
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <Button
                              variant="danger"
                              size="md"
                              onClick={() => onDeleteSet?.(set.planned_set_id)}
                              data-testid={`delete-set-${set.order}`}
                              aria-label={`Remove set ${set.order}: ${set.exercise_name}`}
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {onAddSet && (
                  <Button variant="success" size="sm" onClick={onAddSet} className="mt-2">
                    + Add Set
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Add Set button when queue is collapsed or empty */}
      {pendingSets.length === 0 && !nextSet && (
        <Card className="mb-5">
          <CardContent>
            <p className="text-text-secondary italic text-center text-sm">No sets remaining</p>
            {onAddSet && (
              <Button variant="success" size="sm" onClick={onAddSet} className="mt-2">
                + Add Set
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
