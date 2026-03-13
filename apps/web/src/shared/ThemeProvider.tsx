import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** Resolved theme (never 'system') */
  theme: 'light' | 'dark';
  /** User preference (may be 'system') */
  preference: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'luna-theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'system';
}

function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme>(getStoredPreference);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);

  const resolved = preference === 'system' ? systemTheme : preference;

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Apply .dark class whenever resolved theme changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    setPreference(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // localStorage unavailable
    }
  }, []);

  return <ThemeContext.Provider value={{ theme: resolved, preference, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
