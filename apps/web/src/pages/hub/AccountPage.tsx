import { useState, useRef, useMemo, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { MIN_PASSWORD_LENGTH } from '@/shared/constants';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { CardSkeleton } from '@/components/ui/Skeleton';
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
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load profile via useQuery
  const { data: profile, isLoading } = useQuery({
    queryKey: queryKeys.profile(user!.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('display_name, timezone, day_start_hour')
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Sync local form state when profile data loads
  /* eslint-disable react-hooks/set-state-in-effect -- legitimate: sync server state → local form fields */
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name ?? '');
      setTimezone(profile.timezone);
      setDayStartHour(profile.day_start_hour);
    }
  }, [profile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Save profile mutation
  const saveProfileMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .schema('hub')
        .from('profiles')
        .update({ display_name: displayName, timezone, day_start_hour: dayStartHour })
        .eq('user_id', user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage({ type: 'success', text: 'Profile updated' });
      flash();
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  // Change password mutation
  const changePasswordMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },
    onSuccess: () => {
      setPwMessage({ type: 'success', text: 'Password updated' });
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (error: Error) => {
      setPwMessage({ type: 'error', text: error.message });
    },
  });

  const handleSaveProfile = () => {
    setMessage(null);
    saveProfileMutation.mutate();
  };

  const handleChangePassword = () => {
    setPwMessage(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPwMessage({ type: 'error', text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    changePasswordMutation.mutate();
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
      {isLoading ? (
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
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
                <label htmlFor="timezone-search" className="block text-sm font-medium text-text-secondary mb-1">
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
                    className="block w-full rounded-lg border border-border-strong bg-surface px-3 py-2 pr-10 text-sm text-text placeholder:text-text-tertiary transition-colors focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
                    aria-hidden="true"
                  />
                </div>
                {tzOpen && (
                  <ul
                    ref={listRef}
                    id="timezone-listbox"
                    role="listbox"
                    className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-surface-raised shadow-lg"
                  >
                    {filteredTimezones.length === 0 ? (
                      <li className="px-3 py-2 text-sm text-text-secondary">No matching timezones</li>
                    ) : (
                      filteredTimezones.map((tz, i) => (
                        <li
                          key={tz}
                          id={`tz-option-${i}`}
                          role="option"
                          aria-selected={tz === timezone}
                          className={[
                            'cursor-pointer px-3 py-2 text-sm',
                            i === tzHighlight ? 'bg-primary-subtle text-primary' : 'text-text',
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

              <Button onClick={handleSaveProfile} loading={saveProfileMutation.isPending}>
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
              <Button onClick={handleChangePassword} loading={changePasswordMutation.isPending}>
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
