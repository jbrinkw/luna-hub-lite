import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { TodayPage } from '@/pages/coachbyte/TodayPage';

const HistoryPage = lazy(() => import('@/pages/coachbyte/HistoryPage').then((m) => ({ default: m.HistoryPage })));
const SplitPage = lazy(() => import('@/pages/coachbyte/SplitPage').then((m) => ({ default: m.SplitPage })));
const PrsPage = lazy(() => import('@/pages/coachbyte/PrsPage').then((m) => ({ default: m.PrsPage })));
const SettingsPage = lazy(() => import('@/pages/coachbyte/SettingsPage').then((m) => ({ default: m.SettingsPage })));

function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-8 w-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

export function CoachRoutes() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route index element={<TodayPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="split" element={<SplitPage />} />
        <Route path="prs" element={<PrsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <h2>Page not found</h2>
              <p>The page you requested does not exist.</p>
              <a href="/coach" style={{ color: '#3880ff' }}>
                Go to CoachByte
              </a>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}
