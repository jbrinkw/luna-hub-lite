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
    </Routes>
  );
}
