import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@luna-hub/ui-kit';
import { AuthProvider } from './shared/auth/AuthProvider';
import { AppLayout } from './shared/layout/AppLayout';
import { AuthGuard } from './components/AuthGuard';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { HubRoutes } from './modules/hub/routes';
import { CoachRoutes } from './modules/coachbyte/routes';
import { ChefRoutes } from './modules/chefbyte/routes';

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <AuthProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />

            {/* Protected routes */}
            <Route
              path="/*"
              element={
                <AuthGuard>
                  <AppLayout>
                    <Routes>
                      <Route path="/" element={<Navigate to="/hub" replace />} />
                      <Route path="/hub/*" element={<HubRoutes />} />
                      <Route path="/coach/*" element={<CoachRoutes />} />
                      <Route path="/chef/*" element={<ChefRoutes />} />
                    </Routes>
                  </AppLayout>
                </AuthGuard>
              }
            />
          </Routes>
        </AuthProvider>
      </AppShell>
    </BrowserRouter>
  );
}
