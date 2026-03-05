import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';

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
  { to: '/chef/walmart', label: 'Walmart', icon: '\ud83c\udfea' },
  { to: '/chef/settings', label: 'Settings', icon: '\u2699\ufe0f' },
];

export function ChefLayout({ children }: ChefLayoutProps) {
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f7f7f9',
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: '#111827',
      }}
    >
      {/* Navigation Bar */}
      <nav className="cb-nav-bar cb-container" data-testid="chef-nav">
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
      <div className={`cb-container cb-nav-drawer ${drawerOpen ? 'open' : ''}`}>
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
                navigate('/hub/account');
              }}
              className="cb-nav-link"
            >
              {'\ud83c\udfe0'} Hub
            </button>
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

      {/* Page Content */}
      <div className="cb-container" style={{ padding: '20px' }}>
        {children}
      </div>
    </div>
  );
}
