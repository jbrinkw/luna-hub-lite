import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Alert } from '@/components/ui/Alert';
import { Menu, X } from 'lucide-react';

interface CoachLayoutProps {
  title: string;
  children: ReactNode;
}

const tabItems: TabItem[] = [
  { label: 'Today', value: '/coach', href: '/coach' },
  { label: 'History', value: '/coach/history', href: '/coach/history' },
  { label: 'Split', value: '/coach/split', href: '/coach/split' },
  { label: 'PRs', value: '/coach/prs', href: '/coach/prs' },
  { label: 'Settings', value: '/coach/settings', href: '/coach/settings' },
];

function getActiveTab(pathname: string): string {
  if (pathname === '/coach') return '/coach';
  const match = tabItems.find((t) => t.value !== '/coach' && pathname.startsWith(t.value));
  return match?.value ?? '/coach';
}

export function CoachLayout({ children }: CoachLayoutProps) {
  const { signOut } = useAuth();
  const { online } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeTab = getActiveTab(location.pathname);

  return (
    <div className="flex flex-col h-full overflow-y-hidden bg-slate-50 text-slate-900">
      {/* Header */}
      <header
        className="flex items-center justify-between h-14 px-4 sm:px-6 bg-white border-b border-slate-200 shrink-0"
        data-testid="coach-header"
      >
        <div className="flex items-center font-bold text-lg sm:text-xl text-slate-900">
          <Link
            to="/hub"
            className="text-inherit no-underline hover:text-violet-600 transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            Luna Hub
          </Link>
          <span className="text-slate-400 mx-1 sm:mx-1.5">/</span>
          <Link
            to="/coach"
            className="text-inherit no-underline hover:text-violet-600 transition-colors"
            onClick={() => setDrawerOpen(false)}
          >
            CoachByte
          </Link>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Tab bar — desktop */}
      <nav
        className="hidden md:flex items-center bg-white border-b border-slate-200 px-4 shrink-0"
        data-testid="coach-tabs"
      >
        <Tabs items={tabItems} activeValue={activeTab} />
      </nav>

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
                  activeTab === tab.value ? 'text-violet-600 bg-violet-50' : 'text-slate-700 hover:bg-slate-100',
                ].join(' ')}
                onClick={() => setDrawerOpen(false)}
              >
                {tab.label}
              </Link>
            ))}
            <button
              onClick={() => {
                setDrawerOpen(false);
                navigate('/hub');
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
        className="flex-1 overflow-y-auto p-4 sm:p-5 max-w-[1200px] w-full mx-auto"
        style={online ? undefined : { pointerEvents: 'none', opacity: 0.6 }}
      >
        {children}
      </div>
    </div>
  );
}
