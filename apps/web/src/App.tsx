import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@luna-hub/ui-kit';
import { Analytics } from '@vercel/analytics/react';
import { AuthProvider } from './shared/auth/AuthProvider';
import { AppLayout } from './shared/layout/AppLayout';
import { AppProvider } from './shared/AppProvider';
import { AuthGuard } from './components/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivationGuard } from './components/ActivationGuard';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { ResetPassword } from './pages/hub/ResetPassword';
import { OAuthConsent } from './pages/OAuthConsent';

const HubRoutes = lazy(() => import('./modules/hub/routes').then((m) => ({ default: m.HubRoutes })));
const CoachRoutes = lazy(() => import('./modules/coachbyte/routes').then((m) => ({ default: m.CoachRoutes })));
const ChefRoutes = lazy(() => import('./modules/chefbyte/routes').then((m) => ({ default: m.ChefRoutes })));

function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-8 w-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <AuthProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/hub/reset-password" element={<ResetPassword />} />
            <Route path="/oauth/consent" element={<OAuthConsent />} />

            {/* Protected routes */}
            <Route
              path="/*"
              element={
                <AuthGuard>
                  <AppProvider>
                    <AppLayout>
                      <Suspense fallback={<PageSpinner />}>
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
                      </Suspense>
                    </AppLayout>
                  </AppProvider>
                </AuthGuard>
              }
            />
          </Routes>
        </AuthProvider>
        <Analytics />
      </AppShell>
    </BrowserRouter>
  );
}
