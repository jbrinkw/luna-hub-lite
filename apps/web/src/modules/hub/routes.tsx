import { Routes, Route, Link } from 'react-router-dom';
import { HubHomePage } from '@/pages/hub/HubHomePage';
import { AccountPage } from '@/pages/hub/AccountPage';
import { AppsPage } from '@/pages/hub/AppsPage';
import { ToolsPage } from '@/pages/hub/ToolsPage';
import { ExtensionsPage } from '@/pages/hub/ExtensionsPage';
import { McpSettingsPage } from '@/pages/hub/McpSettingsPage';
import { AgentPage } from '@/pages/hub/AgentPage';
import { AlertsPage } from '@/pages/hub/AlertsPage';

export function HubRoutes() {
  return (
    <Routes>
      <Route index element={<HubHomePage />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="apps" element={<AppsPage />} />
      <Route path="tools" element={<ToolsPage />} />
      <Route path="extensions" element={<ExtensionsPage />} />
      <Route path="mcp" element={<McpSettingsPage />} />
      <Route path="agent" element={<AgentPage />} />
      <Route path="alerts" element={<AlertsPage />} />
      <Route
        path="*"
        element={
          <div className="p-8 text-center">
            <h2>Page not found</h2>
            <p>The page you requested does not exist.</p>
            <Link to="/hub" className="text-primary">
              Go to Hub
            </Link>
          </div>
        }
      />
    </Routes>
  );
}
