import { useEffect, useState, useRef, useMemo } from 'react';
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
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { useSaveIndicator } from '@/hooks/useSaveIndicator';
import { ChevronDown } from 'lucide-react';

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
  const { showSaved, flash } = useSaveIndicator();

  // Timezone combobox state
  const [tzSearch, setTzSearch] = useState('');
  const [tzOpen, setTzOpen] = useState(false);
  const [tzHighlight, setTzHighlight] = useState(-1);
  const tzRef = useRef<HTMLDivElement>(null);
  const tzInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filteredTimezones = useMemo(() => {
    if (!tzSearch) return TIMEZONES;
    const lower = tzSearch.toLowerCase();
    return TIMEZONES.filter((tz) => tz.toLowerCase().includes(lower));
  }, [tzSearch]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tzRef.current && !tzRef.current.contains(e.target as Node)) {
        setTzOpen(false);
        // Reset search text to selected timezone when closing
        setTzSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (tzHighlight >= 0 && listRef.current) {
      const item = listRef.current.children[tzHighlight] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [tzHighlight]);

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
      flash();
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

  const handleTzSelect = (tz: string) => {
    setTimezone(tz);
    setTzSearch('');
    setTzOpen(false);
    setTzHighlight(-1);
  };

  const handleTzKeyDown = (e: React.KeyboardEvent) => {
    if (!tzOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setTzOpen(true);
        setTzHighlight(0);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setTzHighlight((prev) => Math.min(prev + 1, filteredTimezones.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setTzHighlight((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (tzHighlight >= 0 && tzHighlight < filteredTimezones.length) {
          handleTzSelect(filteredTimezones[tzHighlight]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setTzOpen(false);
        setTzSearch('');
        setTzHighlight(-1);
        break;
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
              <div className="flex items-center gap-2">
                <CardTitle>Profile</CardTitle>
                <SaveIndicator show={showSaved} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input label="Display Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

              {/* Timezone searchable combobox */}
              <div className="relative w-full" ref={tzRef}>
                <label htmlFor="timezone-search" className="block text-sm font-medium text-slate-700 mb-1">
                  Timezone
                </label>
                <div className="relative">
                  <input
                    ref={tzInputRef}
                    id="timezone-search"
                    type="text"
                    role="combobox"
                    aria-expanded={tzOpen}
                    aria-controls="timezone-listbox"
                    aria-autocomplete="list"
                    aria-activedescendant={tzHighlight >= 0 ? `tz-option-${tzHighlight}` : undefined}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                    value={tzOpen ? tzSearch : timezone}
                    placeholder="Search timezones..."
                    onChange={(e) => {
                      setTzSearch(e.target.value);
                      setTzHighlight(0);
                      if (!tzOpen) setTzOpen(true);
                    }}
                    onFocus={() => {
                      setTzOpen(true);
                      setTzSearch('');
                    }}
                    onKeyDown={handleTzKeyDown}
                    data-testid="timezone-combobox"
                  />
                  <ChevronDown
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                </div>
                {tzOpen && (
                  <ul
                    ref={listRef}
                    id="timezone-listbox"
                    role="listbox"
                    className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg"
                  >
                    {filteredTimezones.length === 0 ? (
                      <li className="px-3 py-2 text-sm text-slate-500">No matching timezones</li>
                    ) : (
                      filteredTimezones.map((tz, i) => (
                        <li
                          key={tz}
                          id={`tz-option-${i}`}
                          role="option"
                          aria-selected={tz === timezone}
                          className={[
                            'cursor-pointer px-3 py-2 text-sm',
                            i === tzHighlight ? 'bg-blue-50 text-blue-900' : 'text-slate-900',
                            tz === timezone ? 'font-medium' : '',
                          ].join(' ')}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleTzSelect(tz);
                          }}
                          onMouseEnter={() => setTzHighlight(i)}
                        >
                          {tz}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>

              <Select
                label="Day Start Hour"
                value={dayStartHour}
                onChange={(e) => setDayStartHour(Number(e.target.value))}
                hint="Your day resets at this hour for macro tracking"
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
