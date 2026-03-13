import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

interface AuthorizationDetails {
  client: { name: string };
  redirect_uri: string;
  scope?: string;
}

export function OAuthConsent() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const authorizationId = searchParams.get('authorization_id');

  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);

  // If not logged in, redirect to login with return URL
  useEffect(() => {
    if (authLoading) return;
    if (!user && authorizationId) {
      const returnUrl = `/oauth/consent?authorization_id=${authorizationId}`;
      navigate(`/login?redirect=${encodeURIComponent(returnUrl)}`, { replace: true });
    }
  }, [user, authLoading, authorizationId, navigate]);

  // Fetch authorization details
  useEffect(() => {
    if (!user || !authorizationId) return;

    const fetchDetails = async () => {
      try {
        const { data, error: fetchErr } = await (supabase.auth as any).oauth.getAuthorizationDetails(authorizationId);
        if (fetchErr) {
          setError(fetchErr.message);
        } else if (data?.redirect_url) {
          // User already consented — redirect immediately
          window.location.href = data.redirect_url;
          return;
        } else {
          setDetails(data);
        }
      } catch (e: any) {
        setError(e.message || 'Failed to load authorization details');
      }
      setLoading(false);
    };

    fetchDetails();
  }, [user, authorizationId]);

  const handleApprove = async () => {
    if (!authorizationId) return;
    setDeciding(true);
    setError(null);
    try {
      const { data, error: approveErr } = await (supabase.auth as any).oauth.approveAuthorization(authorizationId);
      if (approveErr) {
        setError(approveErr.message);
        setDeciding(false);
      } else if (data?.redirect_url) {
        window.location.href = data.redirect_url;
      } else {
        setError('No redirect URL in approval response');
        setDeciding(false);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to approve');
      setDeciding(false);
    }
  };

  const handleDeny = async () => {
    if (!authorizationId) return;
    setDeciding(true);
    setError(null);
    try {
      const { data, error: denyErr } = await (supabase.auth as any).oauth.denyAuthorization(authorizationId);
      if (denyErr) {
        setError(denyErr.message);
        setDeciding(false);
      } else if (data?.redirect_url) {
        window.location.href = data.redirect_url;
      } else {
        setError('No redirect URL in denial response');
        setDeciding(false);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to deny');
      setDeciding(false);
    }
  };

  if (!authorizationId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-sunken">
        <Card className="w-full max-w-md">
          <CardContent>
            <Alert variant="error">Missing authorization_id parameter.</Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-sunken">
        <p className="text-sm text-text-secondary">Loading authorization details...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-sunken">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Authorize Application</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert variant="error">{error}</Alert>}

          {details && (
            <>
              <p className="text-base text-text">
                <span className="font-semibold">{details.client.name}</span> wants to access your Luna Hub account.
              </p>

              <div className="bg-surface-sunken border border-border rounded-lg p-3 space-y-1 break-all">
                <p className="text-xs text-text-secondary">
                  <span className="font-medium">Redirect URI:</span> {details.redirect_uri}
                </p>
                {details.scope && details.scope.trim() && (
                  <p className="text-xs text-text-secondary">
                    <span className="font-medium">Scopes:</span> {details.scope}
                  </p>
                )}
              </div>

              <p className="text-xs text-text-secondary">
                This will allow the application to use your MCP tools (CoachByte, ChefByte, extensions) on your behalf.
              </p>

              <div className="flex gap-3">
                <Button className="flex-1" onClick={handleApprove} disabled={deciding} loading={deciding}>
                  Approve
                </Button>
                <Button variant="secondary" className="flex-1" onClick={handleDeny} disabled={deciding}>
                  Deny
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
