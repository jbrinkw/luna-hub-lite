import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatTime } from '@/shared/formatTime';

interface RestTimerProps {
  endTime?: string | null;
  state: 'running' | 'paused' | 'expired' | 'idle';
  durationSeconds: number;
  elapsedBeforePause: number;
  onStart: (seconds: number) => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onExpired?: () => void;
}

export function RestTimer({
  endTime,
  state,
  durationSeconds,
  elapsedBeforePause,
  onStart,
  onPause,
  onResume,
  onReset,
  onExpired,
}: RestTimerProps) {
  const [remaining, setRemaining] = useState(0);
  const [customDuration, setCustomDuration] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef(state);
  const endTimeRef = useRef(endTime);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    endTimeRef.current = endTime;
  }, [endTime]);

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const calcRemaining = useCallback(() => {
    if (!endTime) return 0;
    return Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
  }, [endTime]);

  useEffect(() => {
    clearTimer();

    if (state === 'running' && endTime) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRemaining(calcRemaining());
      intervalRef.current = setInterval(() => {
        const r = calcRemaining();
        setRemaining(r);
        if (r <= 0) {
          clearTimer();
          onExpired?.();
        }
      }, 1000);
    } else if (state === 'paused') {
      setRemaining(durationSeconds - elapsedBeforePause);
    } else if (state === 'expired') {
      setRemaining(0);
    } else {
      setRemaining(0);
    }

    return clearTimer;
  }, [state, endTime, durationSeconds, elapsedBeforePause, calcRemaining, clearTimer, onExpired]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && stateRef.current === 'running' && endTimeRef.current) {
        const r = Math.max(0, Math.ceil((new Date(endTimeRef.current).getTime() - Date.now()) / 1000));
        setRemaining(r);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const handleCustomStart = () => {
    const secs = parseInt(customDuration, 10);
    if (!isNaN(secs) && secs > 0) {
      onStart(secs);
      setCustomDuration('');
    }
  };

  return (
    <Card className="mb-5" data-testid="rest-timer">
      <CardHeader>
        <CardTitle>Rest Timer</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-5xl font-mono font-bold text-center my-4" data-testid="timer-display">
          {formatTime(remaining)}
        </div>

        {state === 'expired' && (
          <p data-testid="timer-expired" className="text-center font-bold text-red-600">
            Timer expired
          </p>
        )}

        <div className="flex gap-2 justify-center flex-wrap">
          {state === 'running' && (
            <Button variant="primary" onClick={onPause} data-testid="pause-btn">
              Pause
            </Button>
          )}
          {state === 'paused' && (
            <Button variant="primary" onClick={onResume} data-testid="resume-btn">
              Resume
            </Button>
          )}
          {(state === 'running' || state === 'paused' || state === 'expired') && (
            <Button variant="secondary" onClick={onReset} data-testid="reset-btn">
              Reset
            </Button>
          )}
        </div>

        <div className="flex gap-2 mt-3 items-end">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-sm font-semibold text-slate-700">Custom (seconds)</label>
            <input
              type="number"
              value={customDuration}
              onChange={(e) => setCustomDuration(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
              data-testid="custom-duration-input"
            />
          </div>
          <Button variant="primary" onClick={handleCustomStart} data-testid="custom-start-btn">
            Start
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { formatTime } from '@/shared/formatTime';
