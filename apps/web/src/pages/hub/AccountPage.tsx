import { useEffect, useState } from 'react';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

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
        <div className="space-y-4">
          <Skeleton className="h-5 w-1/4" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input label="Display Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Select label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
              <Select
                label="Day Start Hour"
                value={dayStartHour}
                onChange={(e) => setDayStartHour(Number(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? '12:00 AM' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM' : `${i - 12}:00 PM`}
                  </option>
                ))}
              </Select>

              <Button onClick={handleSaveProfile} loading={saving}>
                Save Profile
              </Button>

              {message && <Alert variant={message.type === 'success' ? 'success' : 'error'}>{message.text}</Alert>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Change Password</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="New Password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <Input
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <Button onClick={handleChangePassword} loading={pwSaving}>
                Change Password
              </Button>

              {pwMessage && (
                <Alert variant={pwMessage.type === 'success' ? 'success' : 'error'}>{pwMessage.text}</Alert>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </HubLayout>
  );
}
