import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getHACredentials, resolveEntityId, getEntityState } from './ha-api';
import { formatEntityStatus } from './nl-formatters';

export const HOMEASSISTANT_get_entity_status: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_get_entity_status',
  extensionName: 'homeassistant',
  description: 'Get the current status of a Home Assistant device by entity ID or friendly name.',
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

      const state = await getEntityState(creds, entityId);
      if (!state) return toolError(`Entity '${entityId}' not found`);

      const formatted = formatEntityStatus(
        entityId,
        state.state,
        state.attributes || {},
        state.attributes?.friendly_name,
      );

      return toolSuccess({
        formatted,
        entity_id: entityId,
        state: state.state,
        attributes: state.attributes || {},
      });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
