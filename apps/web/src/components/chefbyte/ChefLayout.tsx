import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { useSettingsAlerts } from '@/hooks/useSettingsAlerts';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Alert } from '@/components/ui/Alert';
import { Menu, X, Camera } from 'lucide-react';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

const tabItems: TabItem[] = [
  { label: 'Dashboard', value: '/chef', href: '/chef' },
  { label: 'Meal Plan', value: '/chef/meal-plan', href: '/chef/meal-plan' },
  { label: 'Recipes', value: '/chef/recipes', href: '/chef/recipes' },
  { label: 'Shopping', value: '/chef/shopping', href: '/chef/shopping' },
  { label: 'Inventory', value: '/chef/inventory', href: '/chef/inventory' },
  { label: 'Settings', value: '/chef/settings', href: '/chef/settings' },
];

function getActiveTab(pathname: string): string {
  if (pathname === '/chef' || pathname === '/chef/home' || pathname.startsWith('/chef/macros')) {
    return '/chef';
  }
  const match = tabItems.find((t) => t.value !== '/chef' && pathname.startsWith(t.value));
  return match?.value ?? '/chef';
}

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();
  const { online } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isScanner = location.pathname === '/chef/scanner';

  const activeTab = getActiveTab(location.pathname);

  return (
    <div className="flex flex-col h-full overflow-y-hidden bg-slate-50 text-slate-900">
      {/* Header */}
      <header
        className="flex items-center justify-between h-14 px-6 bg-white border-b border-slate-200 shrink-0"
        data-testid="chef-header"
      >
        <div className="flex items-center gap-2 font-bold text-xl text-slate-900">
          <Link
            to="/hub/account"
            className="text-inherit no-underline hover:text-emerald-600 transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            Luna Hub
          </Link>
          <span className="text-slate-400 mx-1.5">/</span>
          <Link
            to="/chef"
            className="text-inherit no-underline hover:text-emerald-600 transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            ChefByte
          </Link>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
              isScanner ? 'bg-emerald-700 text-white shadow-inner' : 'bg-emerald-600 text-white hover:bg-emerald-700',
            ].join(' ')}
            onClick={() => navigate('/chef/scanner')}
            data-testid="scanner-btn"
          >
            <Camera className="h-4 w-4" />
            Scanner
          </button>
          <button
            className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Tab bar — desktop, hidden on scanner page */}
      {!isScanner && (
        <nav
          className="hidden md:flex items-center bg-white border-b border-slate-200 px-4 shrink-0"
          data-testid="chef-tabs"
        >
          <Tabs items={tabItems} activeValue={activeTab} />
          <SettingsDot />
        </nav>
      )}

      {/* Mobile drawer */}
      <div
        className={[
          'md:hidden flex-col bg-white border-b border-slate-200 overflow-hidden transition-all duration-200',
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
                  activeTab === tab.value ? 'text-emerald-600 bg-emerald-50' : 'text-slate-700 hover:bg-slate-100',
                ].join(' ')}
                onClick={() => setDrawerOpen(false)}
              >
                {tab.label}
              </Link>
            ))}
            <button
              onClick={() => {
                setDrawerOpen(false);
                navigate('/hub/account');
              }}
              className="block px-3 py-2.5 text-sm font-medium rounded-lg text-slate-700 hover:bg-slate-100 text-left transition-colors"
            >
              Hub
            </button>
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="block px-3 py-2.5 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 text-left transition-colors"
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
        className="flex-1 overflow-y-auto p-5 max-w-[1200px] w-full mx-auto"
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
