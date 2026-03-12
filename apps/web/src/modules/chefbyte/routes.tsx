import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { HomePage } from '@/pages/chefbyte/HomePage';

const ScannerPage = lazy(() => import('@/pages/chefbyte/ScannerPage').then((m) => ({ default: m.ScannerPage })));
const InventoryPage = lazy(() => import('@/pages/chefbyte/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const ShoppingPage = lazy(() => import('@/pages/chefbyte/ShoppingPage').then((m) => ({ default: m.ShoppingPage })));
const MealPlanPage = lazy(() => import('@/pages/chefbyte/MealPlanPage').then((m) => ({ default: m.MealPlanPage })));
const RecipesPage = lazy(() => import('@/pages/chefbyte/RecipesPage').then((m) => ({ default: m.RecipesPage })));
const RecipeFormPage = lazy(() =>
  import('@/pages/chefbyte/RecipeFormPage').then((m) => ({ default: m.RecipeFormPage })),
);
const MacroPage = lazy(() => import('@/pages/chefbyte/MacroPage').then((m) => ({ default: m.MacroPage })));
const SettingsPage = lazy(() => import('@/pages/chefbyte/SettingsPage').then((m) => ({ default: m.SettingsPage })));

function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-8 w-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

export function ChefRoutes() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route index element={<Navigate to="/chef/home" replace />} />
        <Route path="home" element={<HomePage />} />
        <Route path="scanner" element={<ScannerPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="shopping" element={<ShoppingPage />} />
        <Route path="meal-plan" element={<MealPlanPage />} />
        <Route path="recipes" element={<RecipesPage />} />
        <Route path="recipes/new" element={<RecipeFormPage />} />
        <Route path="recipes/:id" element={<RecipeFormPage />} />
        <Route path="macros" element={<MacroPage />} />
        <Route path="walmart" element={<Navigate to="/chef/settings?tab=walmart" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <h2>Page not found</h2>
              <p>The page you requested does not exist.</p>
              <a href="/chef" style={{ color: '#3880ff' }}>
                Go to ChefByte
              </a>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}
