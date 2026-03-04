import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { supabase } from '@/shared/supabase';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Password is required');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) {
        setError(updateError.message);
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
              <IonCardTitle>Reset Password</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <form onSubmit={handleSubmit} data-testid="reset-password-form">
                {error && (
                  <IonText color="danger" data-testid="reset-password-error">
                    <p>{error}</p>
                  </IonText>
                )}
                <IonItem>
                  <IonInput
                    label="New Password"
                    labelPlacement="stacked"
                    type="password"
                    value={password}
                    onIonInput={(e) => setPassword(e.detail.value ?? '')}
                    autocomplete="new-password"
                    required
                    data-testid="new-password-input"
                  />
                </IonItem>
                <IonItem>
                  <IonInput
                    label="Confirm Password"
                    labelPlacement="stacked"
                    type="password"
                    value={confirmPassword}
                    onIonInput={(e) => setConfirmPassword(e.detail.value ?? '')}
                    autocomplete="new-password"
                    required
                    data-testid="confirm-password-input"
                  />
                </IonItem>
                <IonButton
                  expand="block"
                  type="submit"
                  disabled={loading}
                  style={{ marginTop: 16 }}
                  data-testid="reset-password-button"
                >
                  {loading ? 'Updating...' : 'Update Password'}
                </IonButton>
              </form>
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
}
