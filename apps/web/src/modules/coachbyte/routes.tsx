import { Routes, Route } from 'react-router-dom';
import { TodayPage } from '@/pages/coachbyte/TodayPage';
import { HistoryPage } from '@/pages/coachbyte/HistoryPage';
import { SplitPage } from '@/pages/coachbyte/SplitPage';
import { PrsPage } from '@/pages/coachbyte/PrsPage';
import { SettingsPage } from '@/pages/coachbyte/SettingsPage';

export function CoachRoutes() {
  return (
    <Routes>
      <Route index element={<TodayPage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path="split" element={<SplitPage />} />
      <Route path="prs" element={<PrsPage />} />
      <Route path="settings" element={<SettingsPage />} />
    </Routes>
  );
}
