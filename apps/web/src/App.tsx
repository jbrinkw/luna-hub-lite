import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@luna-hub/ui-kit';
import { AuthProvider } from './shared/auth/AuthProvider';
import { AppLayout } from './shared/layout/AppLayout';
import { AppProvider } from './shared/AppProvider';
import { AuthGuard } from './components/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivationGuard } from './components/ActivationGuard';
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
                  <AppProvider>
                    <AppLayout>
                      <Routes>
                        <Route path="/" element={<Navigate to="/hub" replace />} />
                        <Route
                          path="/hub/*"
                          element={
                            <ErrorBoundary module="Hub">
                              <HubRoutes />
                            </ErrorBoundary>
                          }
                        />
                        <Route
                          path="/coach/*"
                          element={
                            <ErrorBoundary module="CoachByte">
                              <ActivationGuard appName="coachbyte">
                                <CoachRoutes />
                              </ActivationGuard>
                            </ErrorBoundary>
                          }
                        />
                        <Route
                          path="/chef/*"
                          element={
                            <ErrorBoundary module="ChefByte">
                              <ActivationGuard appName="chefbyte">
                                <ChefRoutes />
                              </ActivationGuard>
                            </ErrorBoundary>
                          }
                        />
                      </Routes>
                    </AppLayout>
                  </AppProvider>
                </AuthGuard>
              }
            />
          </Routes>
        </AuthProvider>
      </AppShell>
    </BrowserRouter>
  );
}
