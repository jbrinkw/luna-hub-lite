/**
 * Lightweight JSON Schema validation for MCP tool arguments.
 * Checks required properties and basic type matching against inputSchema.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateToolArgs(args: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  if (schema.type !== 'object') return null; // Only validate object schemas

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  // Check required properties
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return `Missing required argument: ${key}`;
    }
  }

  // Check property types for provided values
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema || value === undefined || value === null) continue;

    const expectedType = propSchema.type as string | undefined;
    if (!expectedType) continue;

    const typeError = checkType(key, value, expectedType);
    if (typeError) return typeError;
  }

  return null;
}

function checkType(key: string, value: unknown, expectedType: string): string | null {
  switch (expectedType) {
    case 'string':
      if (typeof value !== 'string') return `Argument "${key}" must be a string`;
      break;
    case 'number':
      if (typeof value !== 'number') return `Argument "${key}" must be a number`;
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `Argument "${key}" must be an integer`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `Argument "${key}" must be a boolean`;
      break;
    case 'array':
      if (!Array.isArray(value)) return `Argument "${key}" must be an array`;
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) return `Argument "${key}" must be an object`;
      break;
  }
  return null;
}
