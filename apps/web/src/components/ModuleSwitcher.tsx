import { useLocation, useNavigate } from 'react-router-dom';
import { useAppContext } from '../shared/AppProvider';

const allModules = [
  { label: 'Hub', path: '/hub', appName: null as string | null },
  { label: 'CoachByte', path: '/coach', appName: 'coachbyte' },
  { label: 'ChefByte', path: '/chef', appName: 'chefbyte' },
];

export function ModuleSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();
  const { activations } = useAppContext();

  const modules = allModules.filter((m) => m.appName === null || activations[m.appName]);

  const current = modules.find((m) => location.pathname.startsWith(m.path))?.path ?? '/hub';

  return (
    <nav aria-label="Module switcher">
      <div className="flex bg-slate-100 rounded-lg p-1 gap-1">
        {modules.map((m) => (
          <button
            key={m.path}
            type="button"
            className={[
              'px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer',
              m.path === current ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
            onClick={() => {
              if (m.path !== current) navigate(m.path);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
