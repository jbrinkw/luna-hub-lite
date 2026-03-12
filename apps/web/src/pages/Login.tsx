import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import {
  Dumbbell,
  ChefHat,
  BarChart3,
  Timer,
  Trophy,
  CalendarDays,
  ScanBarcode,
  UtensilsCrossed,
  ShoppingCart,
  Scale,
} from 'lucide-react';

// Intentional demo account credentials — allows one-click demo login.
// Override via VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD env vars if needed.
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || 'demo@lunahub.dev';
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || 'demo1234';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [view, setView] = useState<'login' | 'reset'>('login');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const rawRedirect = searchParams.get('redirect');
  const redirectTo = rawRedirect && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/hub';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }

    setLoading(true);
    try {
      const { error: signInError } = await signIn(email, password);
      if (signInError) {
        setError(signInError.message);
      } else {
        navigate(redirectTo);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = async () => {
    setError(null);
    setDemoLoading(true);
    try {
      const { error: signInError } = await signIn(DEMO_EMAIL, DEMO_PASSWORD);
      if (signInError) {
        setError('Demo account unavailable. Please create an account.');
      } else {
        // Shift all date-relative demo data to be relative to today
        await (supabase.schema('hub') as any).rpc('reset_demo_dates');
        navigate(redirectTo);
      }
    } finally {
      setDemoLoading(false);
    }
  };

  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault();
    setForgotMessage(null);
    setError(null);

    if (!forgotEmail.trim()) {
      setError('Email is required');
      return;
    }

    setForgotLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
        redirectTo: window.location.origin + '/hub/reset-password',
      });
      if (resetError) {
        setError(resetError.message);
      } else {
        setForgotMessage('Check your email for a reset link.');
      }
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Hero panel */}
      <div className="md:w-[55%] bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 text-white flex flex-col justify-center px-8 py-10 md:px-14 md:py-0 md:overflow-y-auto md:max-h-screen">
        <div className="max-w-lg mx-auto md:mx-0 md:py-12">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-2 tracking-tight">Luna Hub</h1>
          <p className="text-lg text-slate-300 mb-8">Your personal fitness &amp; nutrition command center.</p>

          {/* CoachByte section */}
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                <Dumbbell className="h-5 w-5 text-blue-300" />
              </div>
              <h2 className="text-lg font-bold">CoachByte</h2>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pl-[52px]">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <span className="text-xs text-slate-300">Weekly split planner</span>
              </div>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <span className="text-xs text-slate-300">Sequential set tracking</span>
              </div>
              <div className="flex items-center gap-2">
                <Timer className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <span className="text-xs text-slate-300">Built-in rest timer</span>
              </div>
              <div className="flex items-center gap-2">
                <Trophy className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <span className="text-xs text-slate-300">PR tracking &amp; e1RM</span>
              </div>
            </div>
          </div>

          {/* ChefByte section */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                <ChefHat className="h-5 w-5 text-emerald-300" />
              </div>
              <h2 className="text-lg font-bold">ChefByte</h2>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pl-[52px]">
              <div className="flex items-center gap-2">
                <ScanBarcode className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs text-slate-300">Barcode scanner</span>
              </div>
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs text-slate-300">Smart shopping lists</span>
              </div>
              <div className="flex items-center gap-2">
                <UtensilsCrossed className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs text-slate-300">Recipes &amp; meal plans</span>
              </div>
              <div className="flex items-center gap-2">
                <Scale className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs text-slate-300">Macro &amp; calorie tracking</span>
              </div>
            </div>
          </div>

          {/* Demo CTA — large and prominent */}
          <div className="bg-white/[0.07] rounded-xl p-5 border border-white/10">
            <p className="text-sm text-slate-300 mb-3">See it in action with sample data — no signup needed</p>
            <Button
              variant="secondary"
              className="w-full !bg-white !border-white !text-slate-900 hover:!bg-slate-100 font-bold text-base py-3"
              onClick={handleDemo}
              disabled={loading || demoLoading}
              loading={demoLoading}
            >
              Try Demo Account
            </Button>
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="md:w-[45%] flex items-center justify-center px-6 py-12 md:py-0 bg-white">
        <div className="w-full max-w-sm">
          {view === 'login' ? (
            <>
              <h2 className="text-2xl font-bold text-slate-900 mb-1">Welcome back</h2>
              <p className="text-sm text-slate-500 mb-6">Sign in to your account</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && <Alert variant="error">{error}</Alert>}
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <Button type="submit" loading={loading} disabled={loading || demoLoading} className="w-full">
                  Sign In
                </Button>
              </form>

              <div className="text-right mt-2">
                <button
                  type="button"
                  className="text-sm text-blue-600 hover:text-blue-700 hover:underline bg-transparent border-none cursor-pointer p-0"
                  onClick={() => {
                    setView('reset');
                    setError(null);
                    setForgotMessage(null);
                  }}
                  data-testid="forgot-password-link"
                >
                  Forgot password?
                </button>
              </div>

              <div className="flex items-center gap-3 my-4">
                <hr className="flex-1 border-slate-200" />
                <span className="text-sm text-slate-500">or</span>
                <hr className="flex-1 border-slate-200" />
              </div>

              <p className="text-center text-sm text-slate-600 mt-4">
                Don&apos;t have an account?{' '}
                <Link to="/signup" className="text-blue-600 hover:text-blue-700 hover:underline font-medium">
                  Sign up
                </Link>
              </p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-slate-900 mb-4">Reset Password</h2>
              <form onSubmit={handleForgotPassword} data-testid="forgot-password-form" className="space-y-3">
                {error && <Alert variant="error">{error}</Alert>}
                {forgotMessage && (
                  <Alert variant="success" data-testid="forgot-password-success">
                    {forgotMessage}
                  </Alert>
                )}
                <Input
                  label="Email"
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  autoComplete="email"
                  required
                  data-testid="forgot-email-input"
                />
                <Button type="submit" loading={forgotLoading} className="w-full" data-testid="send-reset-link-button">
                  Send Reset Link
                </Button>
              </form>
              <div className="text-center mt-4">
                <button
                  type="button"
                  className="text-sm text-blue-600 hover:text-blue-700 hover:underline bg-transparent border-none cursor-pointer p-0"
                  onClick={() => {
                    setView('login');
                    setError(null);
                    setForgotMessage(null);
                  }}
                  data-testid="back-to-login-link"
                >
                  &larr; Back to login
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
