import { Routes, Route } from 'react-router-dom';
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
      <Route index element={<ScannerPage />} />
      <Route path="home" element={<HomePage />} />
      <Route path="inventory" element={<InventoryPage />} />
      <Route path="shopping" element={<ShoppingPage />} />
      <Route path="meal-plan" element={<MealPlanPage />} />
      <Route path="recipes" element={<RecipesPage />} />
      <Route path="recipes/new" element={<RecipeFormPage />} />
      <Route path="recipes/:id" element={<RecipeFormPage />} />
      <Route path="macros" element={<MacroPage />} />
      <Route path="walmart" element={<WalmartPage />} />
      <Route path="settings" element={<SettingsPage />} />
    </Routes>
  );
}
