import { useState, useEffect, useCallback, useRef } from 'react';
import { IonButton, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonInput } from '@ionic/react';

interface RestTimerProps {
  /** Timer end time (server-derived) */
  endTime?: string | null;
  /** Timer state from DB */
  state: 'running' | 'paused' | 'expired' | 'idle';
  /** Duration in seconds */
  durationSeconds: number;
  /** Elapsed before pause (for paused timers) */
  elapsedBeforePause: number;
  /** Called to start/restart timer */
  onStart: (seconds: number) => void;
  /** Called to pause */
  onPause: () => void;
  /** Called to resume */
  onResume: () => void;
  /** Called to reset/dismiss */
  onReset: () => void;
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
}: RestTimerProps) {
  const [remaining, setRemaining] = useState(0);
  const [customDuration, setCustomDuration] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Calculate remaining from end_time (handles tab recovery)
  const calcRemaining = useCallback(() => {
    if (!endTime) return 0;
    return Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
  }, [endTime]);

  useEffect(() => {
    clearTimer();

    if (state === 'running' && endTime) {
      setRemaining(calcRemaining());
      intervalRef.current = setInterval(() => {
        const r = calcRemaining();
        setRemaining(r);
        if (r <= 0) clearTimer();
      }, 1000);
    } else if (state === 'paused') {
      setRemaining(durationSeconds - elapsedBeforePause);
    } else if (state === 'expired') {
      setRemaining(0);
    } else {
      setRemaining(0);
    }

    return clearTimer;
  }, [state, endTime, durationSeconds, elapsedBeforePause, calcRemaining, clearTimer]);

  // Tab focus recovery
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && state === 'running' && endTime) {
        setRemaining(calcRemaining());
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [state, endTime, calcRemaining]);

  const handleCustomStart = () => {
    const secs = parseInt(customDuration, 10);
    if (!isNaN(secs) && secs > 0) {
      onStart(secs);
      setCustomDuration('');
    }
  };

  return (
    <IonCard data-testid="rest-timer">
      <IonCardHeader>
        <IonCardTitle>Rest Timer</IonCardTitle>
      </IonCardHeader>
      <IonCardContent>
        <div
          data-testid="timer-display"
          style={{ fontSize: '3rem', fontFamily: 'monospace', textAlign: 'center', margin: '16px 0' }}
        >
          {formatTime(remaining)}
        </div>

        {state === 'expired' && (
          <p data-testid="timer-expired" style={{ textAlign: 'center', fontWeight: 'bold' }}>
            Timer expired
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          {state === 'running' && (
            <IonButton onClick={onPause} data-testid="pause-btn">Pause</IonButton>
          )}
          {state === 'paused' && (
            <IonButton onClick={onResume} data-testid="resume-btn">Resume</IonButton>
          )}
          {(state === 'running' || state === 'paused' || state === 'expired') && (
            <IonButton onClick={onReset} data-testid="reset-btn">Reset</IonButton>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'end' }}>
          <IonInput
            label="Custom (seconds)"
            type="number"
            value={customDuration}
            onIonInput={(e) => setCustomDuration(e.detail.value ?? '')}
            data-testid="custom-duration-input"
          />
          <IonButton onClick={handleCustomStart} data-testid="custom-start-btn">
            Start
          </IonButton>
        </div>
      </IonCardContent>
    </IonCard>
  );
}

export { formatTime };
