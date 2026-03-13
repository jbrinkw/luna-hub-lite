import { Link, useNavigate } from 'react-router-dom';
import { Dumbbell, ChefHat, LogOut, User, LayoutGrid, Wrench, Puzzle, KeyRound } from 'lucide-react';
import { useAppContext } from '@/shared/AppProvider';
import { useAuth } from '@/shared/auth/AuthProvider';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import type { LucideIcon } from 'lucide-react';

interface AppDef {
  name: string;
  route: string;
  icon: LucideIcon;
  bgClass: string;
  displayName: string;
  description: string;
}

const APPS: AppDef[] = [
  {
    name: 'coachbyte',
    route: '/coach',
    icon: Dumbbell,
    bgClass: 'bg-blue-600 hover:bg-blue-700',
    displayName: 'CoachByte',
    description: 'Workout plans, set tracking, PRs & rest timer',
  },
  {
    name: 'chefbyte',
    route: '/chef',
    icon: ChefHat,
    bgClass: 'bg-emerald-600 hover:bg-emerald-700',
    displayName: 'ChefByte',
    description: 'Inventory, recipes, meal plans & macro tracking',
  },
];

interface SettingsLink {
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
}

const SETTINGS_LINKS: SettingsLink[] = [
  { label: 'Account', path: '/hub/account', icon: User, description: 'Profile, timezone & password' },
  { label: 'Apps', path: '/hub/apps', icon: LayoutGrid, description: 'Activate or deactivate modules' },
  { label: 'Tools', path: '/hub/tools', icon: Wrench, description: 'MCP tool toggles' },
  { label: 'Extensions', path: '/hub/extensions', icon: Puzzle, description: 'Obsidian, Todoist & more' },
  { label: 'MCP Settings', path: '/hub/mcp', icon: KeyRound, description: 'API keys & endpoints' },
];

export function HubHomePage() {
  const { activations, activationsLoading } = useAppContext();
  const { signOut, user } = useAuth();
  const navigate = useNavigate();

  const activeApps = APPS.filter((app) => activations[app.name]);

  return (
    <div className="min-h-screen bg-surface-sunken">
      {/* Header */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 h-14">
          <h1 className="text-lg font-bold text-text">Luna Hub</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-text-secondary truncate max-w-[160px] sm:max-w-none">{user?.email}</span>
            <button
              onClick={signOut}
              data-testid="hub-logout-btn"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Two-column layout */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Left column — Settings (after apps on mobile) */}
          <div className="md:w-[340px] shrink-0 order-2 md:order-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">Settings</h2>
            <nav className="bg-surface rounded-xl border border-border overflow-hidden" data-testid="hub-settings-link">
              {SETTINGS_LINKS.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className={`flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-surface-hover ${
                      idx < SETTINGS_LINKS.length - 1 ? 'border-b border-border-light' : ''
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                      <Icon className="h-4 w-4 text-text-secondary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{item.label}</p>
                      <p className="text-xs text-text-secondary truncate">{item.description}</p>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right column — App Launcher (first on mobile) */}
          <div className="flex-1 order-1 md:order-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">Your Apps</h2>

            {activationsLoading ? (
              <div data-testid="launcher-loading" className="grid grid-cols-1 gap-4">
                {[0, 1].map((i) => (
                  <div key={i} className="animate-pulse rounded-2xl bg-skeleton p-8">
                    <div className="mb-4 h-14 w-14 rounded-full bg-skeleton-highlight" />
                    <div className="mb-2 h-6 w-28 rounded bg-skeleton-highlight" />
                    <div className="h-4 w-48 rounded bg-skeleton-highlight" />
                  </div>
                ))}
              </div>
            ) : activeApps.length === 0 ? (
              <div data-testid="no-active-apps" className="bg-surface rounded-xl border border-border p-12 text-center">
                <p className="mb-4 text-lg text-text-secondary">No apps activated yet.</p>
                <Link
                  to="/hub/apps"
                  className="inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                >
                  Activate an app to get started
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {activeApps.map((app) => {
                  const Icon = app.icon;
                  return (
                    <Link
                      key={app.name}
                      to={app.route}
                      data-testid={`app-card-${app.name}`}
                      className={`group rounded-2xl ${app.bgClass} p-8 shadow-lg transition-all hover:shadow-xl hover:scale-[1.01]`}
                    >
                      <div className="flex items-start gap-5">
                        <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-white/20 shrink-0">
                          <Icon className="h-8 w-8 text-white" />
                        </div>
                        <div>
                          <h3 className="text-2xl font-bold text-white mb-1">{app.displayName}</h3>
                          <p className="text-white/80 text-sm">{app.description}</p>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
