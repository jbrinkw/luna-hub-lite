import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  IonPage,
  IonContent,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonItem,
  IonInput,
  IonButton,
  IonText,
} from '@ionic/react';
import { useAuth } from '@/shared/auth/AuthProvider';

const DEMO_EMAIL = 'demo@lunahub.dev';
const DEMO_PASSWORD = 'demo1234';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

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
        navigate('/hub');
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
        navigate('/hub');
      }
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <IonPage>
      <IonContent className="ion-padding">
        <div style={{ maxWidth: 400, margin: '80px auto' }}>
          <IonCard>
            <IonCardHeader>
              <IonCardTitle>Sign In</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <form onSubmit={handleSubmit}>
                {error && (
                  <IonText color="danger">
                    <p>{error}</p>
                  </IonText>
                )}
                <IonItem>
                  <IonInput
                    label="Email"
                    labelPlacement="stacked"
                    type="email"
                    value={email}
                    onIonInput={(e) => setEmail(e.detail.value ?? '')}
                    autocomplete="email"
                    required
                  />
                </IonItem>
                <IonItem>
                  <IonInput
                    label="Password"
                    labelPlacement="stacked"
                    type="password"
                    value={password}
                    onIonInput={(e) => setPassword(e.detail.value ?? '')}
                    autocomplete="current-password"
                    required
                  />
                </IonItem>
                <IonButton expand="block" type="submit" disabled={loading || demoLoading} style={{ marginTop: 16 }}>
                  {loading ? 'Signing in...' : 'Sign In'}
                </IonButton>
              </form>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '16px 0',
                }}
              >
                <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--ion-color-step-200)' }} />
                <span style={{ color: 'var(--ion-color-medium)', fontSize: 13 }}>or</span>
                <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--ion-color-step-200)' }} />
              </div>
              <IonButton
                expand="block"
                fill="outline"
                color="medium"
                onClick={handleDemo}
                disabled={loading || demoLoading}
              >
                {demoLoading ? 'Loading demo...' : 'Try Demo Account'}
              </IonButton>
              <p style={{ textAlign: 'center', marginTop: 16 }}>
                Don&apos;t have an account? <Link to="/signup">Sign up</Link>
              </p>
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
}
