/**
 * Shared constants used across the ChefByte and Hub modules.
 * Centralizes magic strings and default values to avoid duplication.
 */

/** Default macro goals when no user config exists */
export const DEFAULT_MACRO_GOALS = {
  calories: 2000,
  protein: 150,
  carbs: 250,
  fat: 65,
} as const;

/** Sentinel value for products explicitly marked as not available on Walmart */
export const NOT_ON_WALMART = 'NOT_ON_WALMART';

/** Default weight unit for CoachByte */
export const WEIGHT_UNIT = 'lb';

/** Minimum password length for account creation / password change */
export const MIN_PASSWORD_LENGTH = 8;
