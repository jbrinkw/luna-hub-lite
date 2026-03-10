import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  IonPage,
  IonContent,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonButton,
  IonText,
} from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

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
        } else if (data?.redirect_to) {
          // User already consented — redirect immediately
          window.location.href = data.redirect_to;
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
      } else {
        window.location.href = data.redirect_to;
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
      } else {
        window.location.href = data.redirect_to;
      }
    } catch (e: any) {
      setError(e.message || 'Failed to deny');
      setDeciding(false);
    }
  };

  if (!authorizationId) {
    return (
      <IonPage>
        <IonContent className="ion-padding">
          <div style={{ maxWidth: 500, margin: '80px auto' }}>
            <IonCard>
              <IonCardContent>
                <IonText color="danger">
                  <p>Missing authorization_id parameter.</p>
                </IonText>
              </IonCardContent>
            </IonCard>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  if (loading) {
    return (
      <IonPage>
        <IonContent className="ion-padding">
          <div style={{ maxWidth: 500, margin: '80px auto', textAlign: 'center' }}>
            Loading authorization details...
          </div>
        </IonContent>
      </IonPage>
    );
  }

  return (
    <IonPage>
      <IonContent className="ion-padding">
        <div style={{ maxWidth: 500, margin: '80px auto' }}>
          <IonCard>
            <IonCardHeader>
              <IonCardTitle>Authorize Application</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              {error && (
                <IonText color="danger">
                  <p>{error}</p>
                </IonText>
              )}

              {details && (
                <>
                  <p style={{ fontSize: '16px', marginBottom: '16px' }}>
                    <strong>{details.client.name}</strong> wants to access your Luna Hub account.
                  </p>

                  <div style={{ background: '#f7f7f9', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#666' }}>
                      <strong>Redirect URI:</strong> {details.redirect_uri}
                    </p>
                    {details.scope && details.scope.trim() && (
                      <p style={{ margin: 0, fontSize: '13px', color: '#666' }}>
                        <strong>Scopes:</strong> {details.scope}
                      </p>
                    )}
                  </div>

                  <p style={{ fontSize: '13px', color: '#666', marginBottom: '20px' }}>
                    This will allow the application to use your MCP tools (CoachByte, ChefByte, extensions) on your
                    behalf.
                  </p>

                  <div style={{ display: 'flex', gap: '12px' }}>
                    <IonButton expand="block" onClick={handleApprove} disabled={deciding} style={{ flex: 1 }}>
                      {deciding ? 'Processing...' : 'Approve'}
                    </IonButton>
                    <IonButton
                      expand="block"
                      fill="outline"
                      color="medium"
                      onClick={handleDeny}
                      disabled={deciding}
                      style={{ flex: 1 }}
                    >
                      Deny
                    </IonButton>
                  </div>
                </>
              )}
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
}
