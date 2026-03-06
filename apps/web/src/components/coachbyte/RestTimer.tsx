import { useState, useEffect, useCallback, useRef } from 'react';

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

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(Math.max(0, totalSeconds) / 60);
  const secs = Math.max(0, totalSeconds) % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
    <div className="card timer-card" data-testid="rest-timer">
      <h3 className="card-header">Rest Timer</h3>
      <div className="card-body">
        <div className="timer-big" data-testid="timer-display">
          {formatTime(remaining)}
        </div>

        {state === 'expired' && (
          <p data-testid="timer-expired" style={{ textAlign: 'center', fontWeight: 'bold', color: '#dc3545' }}>
            Timer expired
          </p>
        )}

        <div className="timer-controls">
          {state === 'running' && (
            <button className="btn btn-blue" onClick={onPause} data-testid="pause-btn">
              Pause
            </button>
          )}
          {state === 'paused' && (
            <button className="btn btn-blue" onClick={onResume} data-testid="resume-btn">
              Resume
            </button>
          )}
          {(state === 'running' || state === 'paused' || state === 'expired') && (
            <button className="btn btn-gray" onClick={onReset} data-testid="reset-btn">
              Reset
            </button>
          )}
        </div>

        <div className="timer-custom">
          <div className="form-group" style={{ flex: 1 }}>
            <label>Custom (seconds)</label>
            <input
              type="number"
              value={customDuration}
              onChange={(e) => setCustomDuration(e.target.value)}
              className="input-full"
              data-testid="custom-duration-input"
            />
          </div>
          <button className="btn btn-blue" onClick={handleCustomStart} data-testid="custom-start-btn">
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

export { formatTime };
