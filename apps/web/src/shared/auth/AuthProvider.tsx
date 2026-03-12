import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  sessionError: string | null;
  clearSessionError: () => void;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string, displayName?: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Simple auto-dismissing toast (replaces IonToast). */
function SessionToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="alert"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 px-4 py-3 shadow-lg text-sm font-medium"
    >
      {message}
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Track whether the initial session load has completed so we can distinguish
  // "no session on first load" from "session expired / token refresh failed".
  const initialLoadDone = useRef(false);

  const clearSessionError = useCallback(() => setSessionError(null), []);

  useEffect(() => {
    // Timeout: if auth doesn't resolve within 10s, stop blocking the UI
    const authTimeout = setTimeout(() => {
      if (!initialLoadDone.current) {
        setLoading(false);
      }
    }, 10_000);

    // onAuthStateChange fires INITIAL_SESSION on subscribe, providing the session.
    // No separate getSession() call needed — that would race with INITIAL_SESSION.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      setLoading(false);

      if (event === 'INITIAL_SESSION') {
        clearTimeout(authTimeout);
        initialLoadDone.current = true;
        return;
      }

      // After initial load, a null session means the token refresh failed or
      // the session was revoked server-side. Clear user state so the UI shows
      // the login page instead of a broken "looks logged in" state.
      if (!newSession && initialLoadDone.current && event !== 'SIGNED_OUT') {
        setSessionError('Your session has expired. Please sign in again.');
      }
    });

    return () => {
      clearTimeout(authTimeout);
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.session) {
      setSession(data.session);
      setUser(data.session.user);
    }
    return { error: error as Error | null };
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: displayName ? { data: { display_name: displayName } } : undefined,
    });
    if (!error && data.session) {
      setSession(data.session);
      setUser(data.session.user);
    }
    return { error: error as Error | null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ user, session, loading, sessionError, clearSessionError, signIn, signUp, signOut }),
    [user, session, loading, sessionError, clearSessionError, signIn, signUp, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {sessionError && <SessionToast message={sessionError} onDismiss={clearSessionError} />}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
