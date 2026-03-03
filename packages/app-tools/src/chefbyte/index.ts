import type { ToolDefinition } from '../types';
import { getInventory } from './get-inventory';
import { getProductLots } from './get-product-lots';
import { addStock } from './add-stock';
import { consume } from './consume';
import { getProducts } from './get-products';
import { createProduct } from './create-product';
import { getShoppingList } from './get-shopping-list';
import { addToShopping } from './add-to-shopping';
import { clearShopping } from './clear-shopping';
import { belowMinStock } from './below-min-stock';
import { getMealPlan } from './get-meal-plan';
import { addMeal } from './add-meal';
import { markDone } from './mark-done';
import { getRecipes } from './get-recipes';
import { getCookable } from './get-cookable';
import { createRecipe } from './create-recipe';
import { getMacros } from './get-macros';
import { logTempItem } from './log-temp-item';
import { setPrice } from './set-price';

export const chefbyteTools: Record<string, ToolDefinition> = {
  [getInventory.name]: getInventory,
  [getProductLots.name]: getProductLots,
  [addStock.name]: addStock,
  [consume.name]: consume,
  [getProducts.name]: getProducts,
  [createProduct.name]: createProduct,
  [getShoppingList.name]: getShoppingList,
  [addToShopping.name]: addToShopping,
  [clearShopping.name]: clearShopping,
  [belowMinStock.name]: belowMinStock,
  [getMealPlan.name]: getMealPlan,
  [addMeal.name]: addMeal,
  [markDone.name]: markDone,
  [getRecipes.name]: getRecipes,
  [getCookable.name]: getCookable,
  [createRecipe.name]: createRecipe,
  [getMacros.name]: getMacros,
  [logTempItem.name]: logTempItem,
  [setPrice.name]: setPrice,
};
