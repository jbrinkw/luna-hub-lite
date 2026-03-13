import { useLocation, useNavigate } from 'react-router-dom';
import { User, LayoutGrid, Wrench, Puzzle, KeyRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { label: 'Account', path: '/hub/account', icon: User },
  { label: 'Apps', path: '/hub/apps', icon: LayoutGrid },
  { label: 'Tools', path: '/hub/tools', icon: Wrench },
  { label: 'Extensions', path: '/hub/extensions', icon: Puzzle },
  { label: 'MCP Settings', path: '/hub/mcp', icon: KeyRound },
];

export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav aria-label="Hub navigation" className="py-2">
      <ul className="flex flex-col gap-0.5">
        {navItems.map((item) => {
          const active = location.pathname.startsWith(item.path);
          const Icon = item.icon;
          return (
            <li key={item.path}>
              <button
                type="button"
                onClick={() => navigate(item.path)}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium rounded-r-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset',
                  active
                    ? 'border-l-[3px] border-hub-accent bg-primary-subtle text-primary'
                    : 'border-l-[3px] border-transparent text-text-secondary hover:bg-surface-hover hover:text-text',
                ].join(' ')}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
