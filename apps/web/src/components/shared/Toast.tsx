import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Toast notification system — UX_AUDIT_CHEFBYTE_USE_FLAGS top item.
 *
 * Audit referenced toasts 17 times across the chefbyte audit. Was
 * deferred in R1 because no shared component existed. Built here so
 * every page can `const toast = useToast()` and call
 * `toast.show('Imported', { variant: 'success' })`.
 *
 * Design notes:
 *   - Auto-dismiss after `durationMs` (default 4000). Hovering pauses
 *     the timer (forgiving for slow readers).
 *   - Click X to dismiss explicitly.
 *   - Stacked top-right; up to 4 visible at once.
 *   - Variants: success / error / info — drives the left bar color.
 *   - Accessible: role=status, aria-live=polite. Errors use
 *     aria-live=assertive so screen readers interrupt.
 */

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastContextValue {
  show: (message: string, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Map of toast id → outstanding setTimeout. We clear/restart these on
  // hover so the user can read long messages without losing them.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((tt) => tt.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id: number, durationMs: number) => {
      const t = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, t);
    },
    [dismiss],
  );

  const pauseDismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId++;
      const variant = opts.variant ?? 'info';
      const durationMs = opts.durationMs ?? 4000;
      // Cap visible stack at 4; drop the oldest so error toasts about
      // sustained problems can't push older context offscreen.
      setToasts((prev) => {
        const next = [...prev, { id, message, variant, durationMs }];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });
      scheduleDismiss(id, durationMs);
    },
    [scheduleDismiss],
  );

  // Cleanup all pending timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div
        data-testid="toast-stack"
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-[min(420px,calc(100vw-2rem))]"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid={`toast-${t.id}`}
            data-variant={t.variant}
            role="status"
            aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
            onMouseEnter={() => pauseDismiss(t.id)}
            onMouseLeave={() => scheduleDismiss(t.id, t.durationMs)}
            className={[
              'pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2.5 shadow-md text-sm bg-surface',
              'border-l-4',
              t.variant === 'success'
                ? 'border-l-success border-emerald-300 text-success-text bg-success-subtle'
                : t.variant === 'error'
                  ? 'border-l-danger border-rose-300 text-danger-text bg-danger-subtle'
                  : 'border-l-primary border-border text-text',
            ].join(' ')}
          >
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              data-testid={`toast-dismiss-${t.id}`}
              aria-label="Dismiss notification"
              className="shrink-0 text-text-tertiary hover:text-text font-bold w-5 h-5 flex items-center justify-center leading-none"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Subscribe to the toast surface. Falls back to a no-op when called
 * outside a `<ToastProvider>` so tests/storybook don't have to wrap
 * every render.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    show: () => {},
    dismiss: () => {},
  };
}
