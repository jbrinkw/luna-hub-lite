import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { useSettingsAlerts } from '@/hooks/useSettingsAlerts';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

const tabs = [
  { to: '/chef', label: 'Dashboard' },
  { to: '/chef/meal-plan', label: 'Meal Plan' },
  { to: '/chef/recipes', label: 'Recipes' },
  { to: '/chef/shopping', label: 'Shopping' },
  { to: '/chef/inventory', label: 'Inventory' },
  { to: '/chef/settings', label: 'Settings' },
];

function isTabActive(tabTo: string, pathname: string): boolean {
  if (tabTo === '/chef') {
    return pathname === '/chef' || pathname === '/chef/home' || pathname.startsWith('/chef/macros');
  }
  return pathname.startsWith(tabTo);
}

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();
  const { online } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isScanner = location.pathname === '/chef/scanner';

  return (
    <div className="chef-root">
      {/* Header */}
      <header className="chef-header" data-testid="chef-header">
        <div className="chef-brand">
          <Link
            to="/hub/account"
            style={{ color: 'inherit', textDecoration: 'none' }}
            onClick={() => setDrawerOpen(false)}
          >
            Luna Hub
          </Link>
          <span style={{ color: '#999', margin: '0 6px' }}>/</span>
          <Link to="/chef" style={{ color: 'inherit', textDecoration: 'none' }} onClick={() => setDrawerOpen(false)}>
            <span className="chef-brand-icon">{'\u{1F373}'}</span>
            <span className="chef-brand-text">ChefByte</span>
          </Link>
        </div>
        <div className="chef-header-actions">
          <button
            className={`chef-scanner-btn${isScanner ? ' active' : ''}`}
            onClick={() => navigate('/chef/scanner')}
            data-testid="scanner-btn"
          >
            {'\u{1F4F7}'} Scanner
          </button>
          <button
            className="chef-hamburger mobile-only"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {'\u2630'}
          </button>
        </div>
      </header>

      {/* Tab bar — hidden on scanner page */}
      {!isScanner && (
        <nav className="chef-tabs" data-testid="chef-tabs">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={`chef-tab${isTabActive(tab.to, location.pathname) ? ' active' : ''}`}
            >
              {tab.label}
              {tab.to === '/chef/settings' && <SettingsDot />}
            </Link>
          ))}
        </nav>
      )}

      {/* Mobile drawer */}
      <div className={`chef-drawer${drawerOpen ? ' open' : ''}`}>
        {drawerOpen && (
          <div className="chef-drawer-links">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={`chef-drawer-link${isTabActive(tab.to, location.pathname) ? ' active' : ''}`}
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
              className="chef-drawer-link"
            >
              {'\u{1F3E0}'} Hub
            </button>
            <button
              onClick={() => {
                setDrawerOpen(false);
                signOut();
              }}
              className="chef-drawer-link danger"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      {/* Offline banner */}
      {!online && (
        <div className="offline-banner" data-testid="offline-banner">
          You are offline — actions are disabled until connection is restored.
        </div>
      )}

      {/* Content */}
      <div className="chef-content" style={online ? undefined : { pointerEvents: 'none', opacity: 0.6 }}>
        {children}
      </div>
    </div>
  );
}

function SettingsDot() {
  const hasAlerts = useSettingsAlerts();
  if (!hasAlerts) return null;
  return <span className="settings-dot" data-testid="settings-dot" />;
}
