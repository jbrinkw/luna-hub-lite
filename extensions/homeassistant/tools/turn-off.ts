import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getHACredentials, resolveEntityId, getEntityState, callService } from './ha-api';
import { formatActionResult } from './nl-formatters';

export const HOMEASSISTANT_turn_off: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_turn_off',
  extensionName: 'homeassistant',
  description: 'Turn off a Home Assistant device by entity ID or friendly name.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description: 'Entity ID (e.g. "light.living_room")',
      },
      friendly_name: {
        type: 'string',
        description: 'Friendly name of the device (e.g. "Living Room Light")',
      },
    },
  },
  handler: async (args, ctx) => {
    const creds = getHACredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');

    const identifier = args.entity_id || args.friendly_name;
    if (!identifier) return toolError('Provide either entity_id or friendly_name');

    try {
      const [entityId, resolveErr] = await resolveEntityId(creds, identifier);
      if (resolveErr || !entityId) return toolError(resolveErr || 'Entity not found');

      // Get friendly name for the response
      const state = await getEntityState(creds, entityId);
      const friendlyName = state?.attributes?.friendly_name || entityId;
      const domain = entityId.split('.')[0];

      await callService(creds, domain, 'turn_off', { entity_id: entityId });

      const formatted = formatActionResult(entityId, 'turn_off', true, friendlyName);
      return toolSuccess({ formatted, entity_id: entityId, action: 'turn_off', success: true });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
