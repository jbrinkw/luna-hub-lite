import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { HubHeader } from './HubHeader';
import { SideNav } from './SideNav';
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
    <div className="min-h-screen bg-surface-sunken">
      <HubHeader title={title}>
        <button
          className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-border-strong text-text hover:bg-surface-hover transition-colors"
          aria-label="Toggle navigation"
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </HubHeader>

      {/* Mobile drawer */}
      <div
        className={[
          'md:hidden flex-col bg-surface border-b border-border overflow-hidden transition-all duration-200',
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
                    active ? 'text-primary bg-primary-subtle' : 'text-text hover:bg-surface-hover',
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
              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg text-danger hover:bg-danger-subtle text-left transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <aside className="hidden md:block w-60 border-r border-border bg-surface">
          <SideNav />
        </aside>
        <main className="flex-1 p-4 sm:p-6 max-w-4xl">{children}</main>
      </div>
    </div>
  );
}
