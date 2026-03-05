import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { ModuleSwitcher } from '../ModuleSwitcher';

interface ChefLayoutProps {
  title: string;
  children: ReactNode;
}

const navLinks = [
  { to: '/chef/scanner', label: 'Scanner', icon: '\ud83d\udcf7' },
  { to: '/chef/home', label: 'Home', icon: '\ud83c\udfe0' },
  { to: '/chef/inventory', label: 'Inventory', icon: '\ud83d\udce6' },
  { to: '/chef/shopping', label: 'Shopping', icon: '\ud83d\uded2' },
  { to: '/chef/meal-plan', label: 'Meal Plan', icon: '\ud83d\udcc5' },
  { to: '/chef/recipes', label: 'Recipes', icon: '\ud83d\udcd6' },
  { to: '/chef/macros', label: 'Macros', icon: '\ud83c\udfaf' },
  { to: '/chef/walmart', label: 'Walmart', icon: '\ud83c\udfea' },
  { to: '/chef/settings', label: 'Settings', icon: '\u2699\ufe0f' },
];

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="chef-page">
      <div className="chef-container" style={{ paddingTop: 'var(--cb-space-4)' }}>
        {/* Navigation Bar */}
        <nav className="cb-nav-bar" data-testid="chef-nav">
          <Link to="/chef/home" className="cb-nav-brand" onClick={() => setDrawerOpen(false)}>
            <span style={{ fontSize: '22px' }}>{'\ud83c\udf73'}</span>
            <span style={{ letterSpacing: '-0.4px' }}>ChefByte</span>
          </Link>

          <button
            className="cb-nav-burger cb-mobile-only"
            aria-label="Toggle navigation"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {'\u2630'} Menu
          </button>

          <div className="cb-nav-links cb-desktop-only">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`cb-nav-link ${location.pathname.startsWith(link.to) ? 'cb-nav-link-active' : ''}`}
              >
                {link.icon} {link.label}
              </Link>
            ))}
            <div className="cb-nav-divider" />
            <button
              onClick={() => signOut()}
              className="cb-primary-btn"
              style={{ background: '#ef4444' }}
              data-testid="logout-btn"
            >
              Logout
            </button>
          </div>
        </nav>

        {/* Mobile Drawer */}
        <div className={`cb-nav-drawer chef-container ${drawerOpen ? 'open' : ''}`}>
          {drawerOpen && (
            <div className="cb-stack">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`cb-nav-link ${location.pathname.startsWith(link.to) ? 'cb-nav-link-active' : ''}`}
                  onClick={() => setDrawerOpen(false)}
                >
                  {link.icon} {link.label}
                </Link>
              ))}
              <button
                onClick={() => {
                  setDrawerOpen(false);
                  signOut();
                }}
                className="cb-primary-btn"
                style={{ background: '#ef4444' }}
              >
                Logout
              </button>
            </div>
          )}
        </div>

        <ModuleSwitcher />
      </div>

      {/* Page Content */}
      <div className="chef-content chef-container">{children}</div>
    </div>
  );
}
