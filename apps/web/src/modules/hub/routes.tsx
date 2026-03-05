import { Routes, Route, Navigate } from 'react-router-dom';
import { AccountPage } from '@/pages/hub/AccountPage';
import { AppsPage } from '@/pages/hub/AppsPage';
import { ToolsPage } from '@/pages/hub/ToolsPage';
import { ExtensionsPage } from '@/pages/hub/ExtensionsPage';
import { McpSettingsPage } from '@/pages/hub/McpSettingsPage';

export function HubRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="/hub/account" replace />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="apps" element={<AppsPage />} />
      <Route path="tools" element={<ToolsPage />} />
      <Route path="extensions" element={<ExtensionsPage />} />
      <Route path="mcp" element={<McpSettingsPage />} />
      <Route
        path="*"
        element={
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <h2>Page not found</h2>
            <p>The page you requested does not exist.</p>
            <a href="/hub" style={{ color: '#3880ff' }}>
              Go to Hub
            </a>
          </div>
        }
      />
    </Routes>
  );
}
