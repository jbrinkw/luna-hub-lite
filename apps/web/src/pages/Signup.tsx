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
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';

export function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      const { error: signUpError } = await signUp(email, password, displayName);
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
    <IonPage>
      <IonContent className="ion-padding">
        <div style={{ maxWidth: 400, margin: '80px auto' }}>
          <IonCard>
            <IonCardHeader>
              <IonCardTitle>Create Account</IonCardTitle>
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
                    label="Display Name"
                    labelPlacement="stacked"
                    type="text"
                    value={displayName}
                    onIonInput={(e) => setDisplayName(e.detail.value ?? '')}
                    autocomplete="name"
                  />
                </IonItem>
                <IonItem>
                  <IonInput
                    label="Email"
                    labelPlacement="stacked"
                    type="email"
                    value={email}
                    onIonInput={(e) => setEmail(e.detail.value ?? '')}
                    autocomplete="email"
                  />
                </IonItem>
                <IonItem>
                  <IonInput
                    label="Password"
                    labelPlacement="stacked"
                    type="password"
                    value={password}
                    onIonInput={(e) => setPassword(e.detail.value ?? '')}
                    autocomplete="new-password"
                  />
                </IonItem>
                <IonButton expand="block" type="submit" disabled={loading} style={{ marginTop: 16 }}>
                  {loading ? 'Creating account...' : 'Sign Up'}
                </IonButton>
              </form>
              <p style={{ textAlign: 'center', marginTop: 16 }}>
                Already have an account? <Link to="/login">Sign in</Link>
              </p>
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
}
