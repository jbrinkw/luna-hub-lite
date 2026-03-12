import { Link } from 'react-router-dom';
import { Dumbbell, ChefHat, Settings, LogOut } from 'lucide-react';
import { useAppContext } from '@/shared/AppProvider';
import { useAuth } from '@/shared/auth/AuthProvider';
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

export function HubHomePage() {
  const { activations, activationsLoading } = useAppContext();
  const { signOut } = useAuth();

  const activeApps = APPS.filter((app) => activations[app.name]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-bold text-slate-900">Luna Hub</h1>
          <div className="flex items-center gap-3">
            <Link
              to="/hub/account"
              data-testid="hub-settings-link"
              className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </Link>
            <button
              onClick={signOut}
              data-testid="hub-logout-btn"
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-4xl px-4 py-12">
        {activationsLoading ? (
          /* Skeleton loading state */
          <div data-testid="launcher-loading" className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="animate-pulse rounded-2xl bg-slate-200 p-8">
                <div className="mb-4 h-14 w-14 rounded-full bg-slate-300" />
                <div className="mb-2 h-6 w-28 rounded bg-slate-300" />
                <div className="h-4 w-48 rounded bg-slate-300" />
              </div>
            ))}
          </div>
        ) : activeApps.length === 0 ? (
          /* Empty state */
          <div data-testid="no-active-apps" className="flex flex-col items-center justify-center py-20 text-center">
            <p className="mb-4 text-lg text-slate-500">No apps activated yet.</p>
            <Link
              to="/hub/apps"
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Activate Apps
            </Link>
          </div>
        ) : (
          /* App cards grid */
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {activeApps.map((app) => {
              const Icon = app.icon;
              return (
                <Link
                  key={app.name}
                  to={app.route}
                  data-testid={`app-card-${app.name}`}
                  className={`group rounded-2xl ${app.bgClass} p-8 shadow-lg transition-all hover:shadow-xl`}
                >
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/20">
                    <Icon className="h-7 w-7 text-white" />
                  </div>
                  <h2 className="mb-1 text-xl font-bold text-white">{app.displayName}</h2>
                  <p className="text-sm text-white/80">{app.description}</p>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
