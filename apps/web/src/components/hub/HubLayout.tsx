import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { HubHeader } from './HubHeader';
import { SideNav } from './SideNav';
import { ModuleSwitcher } from '../ModuleSwitcher';
import { Menu, X, User, LayoutGrid, Wrench, Puzzle, KeyRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface HubLayoutProps {
  title: string;
  children: ReactNode;
}

interface MobileNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const mobileNavItems: MobileNavItem[] = [
  { label: 'Account', path: '/hub/account', icon: User },
  { label: 'Apps', path: '/hub/apps', icon: LayoutGrid },
  { label: 'Tools', path: '/hub/tools', icon: Wrench },
  { label: 'Extensions', path: '/hub/extensions', icon: Puzzle },
  { label: 'MCP Settings', path: '/hub/mcp', icon: KeyRound },
];

export function HubLayout({ title, children }: HubLayoutProps) {
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50">
      <HubHeader title={title}>
        <button
          className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
          aria-label="Toggle navigation"
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </HubHeader>

      {/* Mobile drawer */}
      <div
        className={[
          'md:hidden flex-col bg-white border-b border-slate-200 overflow-hidden transition-all duration-200',
          drawerOpen ? 'flex' : 'hidden',
        ].join(' ')}
        data-testid="hub-mobile-drawer"
      >
        {drawerOpen && (
          <div className="flex flex-col py-2 px-4">
            {mobileNavItems.map((item) => {
              const active = location.pathname.startsWith(item.path);
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  onClick={() => {
                    setDrawerOpen(false);
                    navigate(item.path);
                  }}
                  className={[
                    'flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors text-left',
                    active ? 'text-blue-700 bg-blue-50' : 'text-slate-700 hover:bg-slate-100',
                  ].join(' ')}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  {item.label}
                </button>
              );
            })}
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 text-left transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      <div className="px-6 py-2 border-b border-slate-200 bg-white">
        <ModuleSwitcher />
      </div>
      {/* min-h subtracts header (3.5rem) + module switcher row (~2.75rem) */}
      <div className="flex min-h-[calc(100vh-6.25rem)]">
        <aside className="hidden md:block w-60 border-r border-slate-200 bg-white">
          <SideNav />
        </aside>
        <main className="flex-1 p-6 max-w-4xl">{children}</main>
      </div>
    </div>
  );
}
