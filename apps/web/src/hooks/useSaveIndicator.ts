import { useState, useCallback, useRef } from 'react';

export function useSaveIndicator(durationMs = 2000) {
  const [showSaved, setShowSaved] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const flash = useCallback(() => {
    setShowSaved(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setShowSaved(false), durationMs);
  }, [durationMs]);

  return { showSaved, flash };
}
