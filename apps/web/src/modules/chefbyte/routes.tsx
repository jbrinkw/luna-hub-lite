import { Routes, Route, Navigate } from 'react-router-dom';
import { ScannerPage } from '@/pages/chefbyte/ScannerPage';
import { HomePage } from '@/pages/chefbyte/HomePage';
import { InventoryPage } from '@/pages/chefbyte/InventoryPage';
import { ShoppingPage } from '@/pages/chefbyte/ShoppingPage';
import { MealPlanPage } from '@/pages/chefbyte/MealPlanPage';
import { RecipesPage } from '@/pages/chefbyte/RecipesPage';
import { RecipeFormPage } from '@/pages/chefbyte/RecipeFormPage';
import { MacroPage } from '@/pages/chefbyte/MacroPage';
import { WalmartPage } from '@/pages/chefbyte/WalmartPage';
import { SettingsPage } from '@/pages/chefbyte/SettingsPage';

export function ChefRoutes() {
  return (
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
      <Route path="walmart" element={<WalmartPage />} />
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
  );
}
