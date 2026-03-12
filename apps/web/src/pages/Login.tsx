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
  Cpu,
  Puzzle,
  Zap,
  Package,
  ClipboardList,
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
      {/* Hero panel (after form on mobile so users see login first) */}
      <div className="order-2 md:order-1 md:w-[55%] bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 text-white flex flex-col justify-center px-6 py-8 md:px-14 md:py-0 md:overflow-y-auto md:max-h-screen">
        <div className="max-w-lg mx-auto md:mx-0 md:py-12">
          <h1 className="text-3xl md:text-5xl font-extrabold mb-1 md:mb-2 tracking-tight">Luna Hub</h1>
          <p className="text-sm md:text-lg text-slate-300 mb-5 md:mb-8">
            Your personal fitness &amp; nutrition command center.
          </p>

          {/* CoachByte section */}
          <div className="mb-4 md:mb-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                <Dumbbell className="h-5 w-5 text-blue-300" />
              </div>
              <div>
                <h2 className="text-lg font-bold leading-tight">CoachByte</h2>
                <p className="text-xs text-slate-400">Strength training copilot</p>
              </div>
            </div>
            <div className="hidden md:block space-y-2 pl-[52px]">
              <div className="flex items-start gap-2.5">
                <CalendarDays className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Weekly split planner with percentage-of-1RM relative loads
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <BarChart3 className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Sequential set tracking with auto plate-per-side breakdown
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Trophy className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Epley e1RM PR detection &mdash; automatic alerts on new records
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Timer className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Cloud-synced rest timer &mdash; pause &amp; resume across devices
                </span>
              </div>
            </div>
          </div>

          {/* ChefByte section */}
          <div className="mb-4 md:mb-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                <ChefHat className="h-5 w-5 text-emerald-300" />
              </div>
              <div>
                <h2 className="text-lg font-bold leading-tight">ChefByte</h2>
                <p className="text-xs text-slate-400">AI-powered nutrition system</p>
              </div>
            </div>
            <div className="hidden md:block space-y-2 pl-[52px]">
              <div className="flex items-start gap-2.5">
                <ScanBarcode className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  AI barcode scanner &mdash; auto-lookup via OpenFoodFacts &amp; Claude Haiku
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Package className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Lot-based inventory with expiry tracking &amp; stock color coding
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <UtensilsCrossed className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Dynamic recipe macros with real-time stock availability badges
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <ClipboardList className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Meal planning &mdash; regular mode &amp; batch meal prep with auto lot creation
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <ShoppingCart className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Shopping list auto-synced from 7-day meal plan &amp; Walmart deep links
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Scale className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Macro tracking with configurable day boundaries &amp; IoT scale support
                </span>
              </div>
            </div>
          </div>

          {/* Platform section */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                <Cpu className="h-5 w-5 text-violet-300" />
              </div>
              <div>
                <h2 className="text-lg font-bold leading-tight">AI-Native Platform</h2>
                <p className="text-xs text-slate-400">Built for agents &amp; automation</p>
              </div>
            </div>
            <div className="hidden md:block space-y-2 pl-[52px]">
              <div className="flex items-start gap-2.5">
                <Cpu className="h-3.5 w-3.5 text-violet-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  38+ MCP tools &mdash; AI agents manage workouts &amp; nutrition for you
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Puzzle className="h-3.5 w-3.5 text-violet-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">
                  Extensions: Obsidian, Todoist &amp; Home Assistant integrations
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <Zap className="h-3.5 w-3.5 text-violet-400 shrink-0 mt-0.5" />
                <span className="text-xs text-slate-300">Realtime sync across all your devices via Supabase</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Form panel (first on mobile) */}
      <div className="order-1 md:order-2 md:w-[45%] flex items-center justify-center px-6 py-12 md:py-0 bg-white">
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

              <Button
                variant="secondary"
                className="w-full font-semibold"
                onClick={handleDemo}
                disabled={loading || demoLoading}
                loading={demoLoading}
              >
                Try Demo Account
              </Button>
              <p className="text-center text-xs text-slate-400 mt-2">
                Pre-loaded with sample data &mdash; no signup needed
              </p>

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
