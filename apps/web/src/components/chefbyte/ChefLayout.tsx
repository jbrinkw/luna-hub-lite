import { useState, useMemo, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { useSettingsAlerts } from '@/hooks/useSettingsAlerts';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { chefbyte } from '@/shared/supabase';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Alert } from '@/components/ui/Alert';
import { Menu, X, ScanLine } from 'lucide-react';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

const TAB_VALUES = [
  '/chef',
  '/chef/inventory',
  '/chef/shopping',
  '/chef/meal-plan',
  '/chef/recipes',
  '/chef/settings',
];

function getActiveTab(pathname: string): string {
  if (pathname === '/chef' || pathname === '/chef/home' || pathname.startsWith('/chef/macros')) {
    return '/chef';
  }
  // /chef/events lives inside Settings now — highlight Settings when on it.
  if (pathname.startsWith('/chef/events')) {
    return '/chef/settings';
  }
  const match = TAB_VALUES.find((v) => v !== '/chef' && pathname.startsWith(v));
  return match ?? '/chef';
}

export function ChefLayout({ children }: ChefLayoutProps) {
  const { user, signOut } = useAuth();
  const { online } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isScanner = location.pathname === '/chef/scanner';
  // Note: `isScanner` is retained only to style the header's Scanner button as
  // "active" (pressed-in shade). The desktop tab bar below always renders —
  // hiding it on the scanner page stranded users with no visible module nav.

  const activeTab = getActiveTab(location.pathname);

  /* ---- Events needing attention (applied=false OR classifier_status='review') ---- */
  const attentionKey = ['chef-events-attention', user?.id ?? 'anon'] as const;
  const { data: attentionCount = 0 } = useQuery({
    queryKey: attentionKey,
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const [rejectedRes, reviewRes] = await Promise.all([
        chefbyte()
          .from('shelf_event_log')
          .select('event_id', { count: 'exact', head: true })
          .eq('user_id', user!.id)
          .eq('applied', false),
        chefbyte()
          .from('shelf_event_log')
          .select('event_id', { count: 'exact', head: true })
          .eq('user_id', user!.id)
          .eq('classifier_status', 'review'),
      ]);
      // Two disjoint queries — there's no cheap SQL-side dedup for the
      // rare overlap (applied=false AND classifier_status='review').
      // Cap at the sum; an overcount by ≤ one or two when both apply to
      // the same row is acceptable for a visual "needs attention" hint.
      return (rejectedRes.count ?? 0) + (reviewRes.count ?? 0);
    },
  });

  useRealtimeInvalidation('chef-layout-attention', [
    { schema: 'chefbyte', table: 'shelf_event_log', queryKeys: [attentionKey] },
    { schema: 'chefbyte', table: 'event_overrides', queryKeys: [attentionKey] },
  ]);

  // Events lives inside Settings → Events sub-tab now. Surface the
  // attention-needs badge on Settings so users still see "N items need
  // review" without a dedicated top-level tab.
  const tabItems: TabItem[] = useMemo(
    () => [
      { label: 'Dashboard', value: '/chef', href: '/chef' },
      { label: 'Inventory', value: '/chef/inventory', href: '/chef/inventory' },
      { label: 'Shopping', value: '/chef/shopping', href: '/chef/shopping' },
      { label: 'Meal Plan', value: '/chef/meal-plan', href: '/chef/meal-plan' },
      { label: 'Recipes', value: '/chef/recipes', href: '/chef/recipes' },
      {
        label: 'Settings',
        value: '/chef/settings',
        href: attentionCount > 0 ? '/chef/settings?tab=events' : '/chef/settings',
        badge: attentionCount > 0 ? String(attentionCount) : undefined,
      },
    ],
    [attentionCount],
  );

  return (
    <div className="flex flex-col h-full overflow-y-hidden bg-surface-sunken text-text">
      {/* Header */}
      <header
        className="flex items-center justify-between h-14 px-4 sm:px-6 bg-surface border-b border-border shrink-0"
        data-testid="chef-header"
      >
        <div className="flex items-center font-bold text-lg sm:text-xl text-text">
          <Link
            to="/hub"
            className="text-inherit no-underline hover:text-chef-accent transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            Luna Hub
          </Link>
          <span className="text-text-tertiary mx-1 sm:mx-1.5">/</span>
          <Link
            to="/chef"
            className="text-inherit no-underline hover:text-chef-accent transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            ChefByte
          </Link>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Scanner button — uses ScanLine (barcode strip) icon rather
              than Camera. The previous Camera icon implied a phone-camera
              scanner that doesn't exist (no BarcodeDetector / getUserMedia
              wired up); the barcode icon correctly reflects the
              hardware-USB / manual-typed scan flow that ScannerPage
              actually supports. */}
          <button
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
              isScanner ? 'bg-emerald-700 text-white shadow-inner' : 'bg-emerald-600 text-white hover:bg-emerald-700',
            ].join(' ')}
            onClick={() => navigate('/chef/scanner')}
            data-testid="scanner-btn"
          >
            <ScanLine className="h-4 w-4" />
            Scanner
          </button>
          <button
            className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-border-strong text-text-secondary hover:bg-surface-hover transition-colors"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Tab bar — desktop, always visible so users can navigate away from any page */}
      <nav
        className="hidden md:flex items-center bg-surface border-b border-border px-4 shrink-0"
        data-testid="chef-tabs"
      >
        <Tabs items={tabItems} activeValue={activeTab} />
        <SettingsDot />
      </nav>

      {/* Mobile drawer */}
      <div
        className={[
          'md:hidden flex-col bg-surface border-b border-border overflow-hidden transition-all duration-200',
          drawerOpen ? 'flex' : 'hidden',
        ].join(' ')}
      >
        {drawerOpen && (
          <div className="flex flex-col py-2 px-4">
            {tabItems.map((tab) => (
              <Link
                key={tab.value}
                to={tab.href!}
                className={[
                  'block px-3 py-2.5 text-sm font-medium rounded-lg transition-colors no-underline',
                  activeTab === tab.value
                    ? 'text-chef-accent bg-success-subtle'
                    : 'text-text-secondary hover:bg-surface-hover',
                ].join(' ')}
                onClick={() => setDrawerOpen(false)}
              >
                <span className="inline-flex items-center gap-1.5">
                  {tab.label}
                  {tab.badge && (
                    <span
                      className="inline-flex items-center rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-semibold text-warning-text"
                      data-testid={`chef-tab-badge-${tab.value}`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </span>
              </Link>
            ))}
            <button
              onClick={() => {
                setDrawerOpen(false);
                navigate('/hub');
              }}
              className="block px-3 py-2.5 text-sm font-medium rounded-lg text-text-secondary hover:bg-surface-hover text-left transition-colors"
            >
              Hub
            </button>
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="block px-3 py-2.5 text-sm font-medium rounded-lg text-danger-text hover:bg-danger-subtle text-left transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      {/* Offline banner */}
      {!online && (
        <div className="px-4 pt-3" data-testid="offline-banner">
          <Alert variant="warning">You are offline — actions are disabled until connection is restored.</Alert>
        </div>
      )}

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto p-4 sm:p-5 max-w-[1200px] w-full mx-auto"
        style={online ? undefined : { pointerEvents: 'none', opacity: 0.6 }}
      >
        {children}
      </div>
    </div>
  );
}

function SettingsDot() {
  const hasAlerts = useSettingsAlerts();
  if (!hasAlerts) return null;
  return <span className="w-2 h-2 rounded-full bg-red-500 ml-1" data-testid="settings-dot" />;
}
