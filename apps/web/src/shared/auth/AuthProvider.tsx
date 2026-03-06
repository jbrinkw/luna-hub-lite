import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { IonToast } from '@ionic/react';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Track whether the initial session load has completed so we can distinguish
  // "no session on first load" from "session expired / token refresh failed".
  const initialLoadDone = useRef(false);

  const clearSessionError = () => setSessionError(null);

  useEffect(() => {
    // onAuthStateChange fires INITIAL_SESSION on subscribe, providing the session.
    // No separate getSession() call needed — that would race with INITIAL_SESSION.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      setLoading(false);

      if (event === 'INITIAL_SESSION') {
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

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.session) {
      setSession(data.session);
      setUser(data.session.user);
    }
    return { error: error as Error | null };
  };

  const signUp = async (email: string, password: string, displayName?: string) => {
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
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, sessionError, clearSessionError, signIn, signUp, signOut }}>
      {children}
      <IonToast
        isOpen={sessionError !== null}
        message={sessionError ?? ''}
        duration={5000}
        color="warning"
        position="top"
        onDidDismiss={clearSessionError}
      />
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
