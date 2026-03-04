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

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
                <IonButton expand="block" type="submit" disabled={loading} style={{ marginTop: 16 }}>
                  {loading ? 'Signing in...' : 'Sign In'}
                </IonButton>
              </form>
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
