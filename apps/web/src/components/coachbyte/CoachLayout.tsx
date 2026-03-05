import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';

interface CoachLayoutProps {
  title: string;
  children: ReactNode;
}

const tabs = [
  { to: '/coach', label: 'Today' },
  { to: '/coach/history', label: 'History' },
  { to: '/coach/split', label: 'Split' },
  { to: '/coach/prs', label: 'PRs' },
  { to: '/coach/settings', label: 'Settings' },
];

function isTabActive(tabTo: string, pathname: string): boolean {
  if (tabTo === '/coach') return pathname === '/coach';
  return pathname.startsWith(tabTo);
}

export function CoachLayout({ children }: CoachLayoutProps) {
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="coach-root">
      {/* Header */}
      <header className="coach-header" data-testid="coach-header">
        <div className="coach-brand">
          <Link
            to="/hub/account"
            style={{ color: 'inherit', textDecoration: 'none' }}
            onClick={() => setDrawerOpen(false)}
          >
            Luna Hub
          </Link>
          <span style={{ color: '#999', margin: '0 6px' }}>/</span>
          <Link to="/coach" style={{ color: 'inherit', textDecoration: 'none' }} onClick={() => setDrawerOpen(false)}>
            CoachByte
          </Link>
        </div>
        <div className="coach-header-actions">
          <button className="coach-hamburger" aria-label="Toggle navigation" onClick={() => setDrawerOpen(!drawerOpen)}>
            {'\u2630'}
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="coach-tabs" data-testid="coach-tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`coach-tab${isTabActive(tab.to, location.pathname) ? ' active' : ''}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {/* Mobile drawer */}
      <div className={`coach-drawer${drawerOpen ? ' open' : ''}`}>
        {drawerOpen && (
          <div className="coach-drawer-links">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={`coach-drawer-link${isTabActive(tab.to, location.pathname) ? ' active' : ''}`}
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
              className="coach-drawer-link"
            >
              Hub
            </button>
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="coach-drawer-link danger"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="coach-content">{children}</div>
    </div>
  );
}
