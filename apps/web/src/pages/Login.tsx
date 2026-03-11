import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

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
  const [showForgot, setShowForgot] = useState(false);
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
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign In</CardTitle>
        </CardHeader>
        <CardContent>
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
              className="text-sm text-blue-600 hover:text-blue-700 hover:underline"
              onClick={() => {
                setShowForgot(!showForgot);
                setError(null);
                setForgotMessage(null);
              }}
              data-testid="forgot-password-link"
            >
              Forgot password?
            </button>
          </div>

          {showForgot && (
            <form onSubmit={handleForgotPassword} data-testid="forgot-password-form" className="mt-3 space-y-3">
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
          )}

          <div className="flex items-center gap-3 my-4">
            <hr className="flex-1 border-slate-200" />
            <span className="text-sm text-slate-500">or</span>
            <hr className="flex-1 border-slate-200" />
          </div>

          <Button
            variant="secondary"
            className="w-full"
            onClick={handleDemo}
            disabled={loading || demoLoading}
            loading={demoLoading}
          >
            Try Demo Account
          </Button>

          <p className="text-center text-sm text-slate-600 mt-4">
            Don&apos;t have an account?{' '}
            <Link to="/signup" className="text-blue-600 hover:text-blue-700 hover:underline font-medium">
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
