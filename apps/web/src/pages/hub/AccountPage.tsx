import { useEffect, useState } from 'react';
import { IonButton, IonInput, IonSelect, IonSelectOption, IonText, IonSpinner } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';

const FALLBACK_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

function getTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

const TIMEZONES = getTimezones();

export function AccountPage() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [dayStartHour, setDayStartHour] = useState(6);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Password change
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', user.id)
      .single()
      .then(({ data, error: err }) => {
        if (err) {
          console.error('Failed to load profile:', err.message);
        } else if (data) {
          setDisplayName(data.display_name ?? '');
          setTimezone(data.timezone);
          setDayStartHour(data.day_start_hour);
        }
        setLoading(false);
      });
  }, [user]);

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    setMessage(null);

    const { error } = await supabase
      .schema('hub')
      .from('profiles')
      .update({ display_name: displayName, timezone, day_start_hour: dayStartHour })
      .eq('user_id', user.id);

    setSaving(false);
    if (error) {
      setMessage({ type: 'error', text: error.message });
    } else {
      setMessage({ type: 'success', text: 'Profile updated' });
    }
  };

  const handleChangePassword = async () => {
    setPwMessage(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPwMessage({ type: 'error', text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    setPwSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPwSaving(false);
    if (error) {
      setPwMessage({ type: 'error', text: error.message });
    } else {
      setPwMessage({ type: 'success', text: 'Password updated' });
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  return (
    <HubLayout title="Account">
      {loading ? (
        <IonSpinner />
      ) : (
        <>
          <h3>Profile</h3>
          <IonInput label="Display Name" value={displayName} onIonInput={(e) => setDisplayName(e.detail.value ?? '')} />
          <IonSelect label="Timezone" value={timezone} onIonChange={(e) => setTimezone(e.detail.value)}>
            {TIMEZONES.map((tz) => (
              <IonSelectOption key={tz} value={tz}>
                {tz}
              </IonSelectOption>
            ))}
          </IonSelect>
          <IonSelect
            label="Day Start Hour"
            value={dayStartHour}
            onIonChange={(e) => setDayStartHour(Number(e.detail.value))}
          >
            {Array.from({ length: 24 }, (_, i) => (
              <IonSelectOption key={i} value={i}>
                {i === 0 ? '12:00 AM' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM' : `${i - 12}:00 PM`}
              </IonSelectOption>
            ))}
          </IonSelect>

          <IonButton onClick={handleSaveProfile} disabled={saving}>
            {saving ? <IonSpinner /> : 'Save Profile'}
          </IonButton>

          {message && (
            <IonText color={message.type === 'success' ? 'success' : 'danger'}>
              <p>{message.text}</p>
            </IonText>
          )}

          <h3 style={{ marginTop: '24px' }}>Change Password</h3>
          <IonInput
            label="New Password"
            type="password"
            value={newPassword}
            onIonInput={(e) => setNewPassword(e.detail.value ?? '')}
          />
          <IonInput
            label="Confirm Password"
            type="password"
            value={confirmPassword}
            onIonInput={(e) => setConfirmPassword(e.detail.value ?? '')}
          />
          <IonButton onClick={handleChangePassword} disabled={pwSaving}>
            {pwSaving ? <IonSpinner /> : 'Change Password'}
          </IonButton>

          {pwMessage && (
            <IonText color={pwMessage.type === 'success' ? 'success' : 'danger'}>
              <p>{pwMessage.text}</p>
            </IonText>
          )}
        </>
      )}
    </HubLayout>
  );
}
