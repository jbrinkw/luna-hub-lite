import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

/**
 * Resolve the browser's IANA timezone. Falls back to America/New_York
 * (matching the DB trigger default) when the platform doesn't expose
 * resolvedOptions or returns an empty string.
 */
function detectBrowserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}

export function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Detected once per mount — browsers don't change tz mid-session.
  // Surfaced as a banner so the user knows what we'll set, not a silent
  // default. They can still edit it later under Hub → Account.
  const detectedTz = useMemo(() => detectBrowserTimezone(), []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setLoading(true);
    try {
      const { error: signUpError } = await signUp(
        email,
        password,
        displayName,
        // Only pass when we actually resolved a value — passing null
        // would defeat the trigger's COALESCE-to-NY default.
        detectedTz ?? undefined,
      );
      if (signUpError) {
        setError(signUpError.message);
      } else {
        navigate('/hub');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-sunken">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}
            <Input
              label="Display Name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {/* Surface the detected timezone (or the fallback) before the user
                hits Sign Up. The DB trigger COALESCEs to America/New_York and
                day_start_hour=6 — saying so up-front avoids the "why is my
                day rolling over at the wrong time" surprise on first use. */}
            <div
              data-testid="signup-tz-banner"
              className="rounded-md bg-info-subtle border border-primary px-3 py-2 text-xs text-info-text"
            >
              {detectedTz ? (
                <>
                  We'll set your timezone to <span className="font-mono font-semibold">{detectedTz}</span> with a 6 AM
                  day-start. You can change both later in Hub → Account.
                </>
              ) : (
                <>
                  Couldn't detect your timezone — we'll default to{' '}
                  <span className="font-mono font-semibold">America/New_York</span> with a 6 AM day-start. You can
                  change both later in Hub → Account.
                </>
              )}
            </div>
            <Button type="submit" loading={loading} className="w-full">
              Sign Up
            </Button>
          </form>
          <p className="text-center text-sm text-text-secondary mt-4">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:text-primary-hover hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
