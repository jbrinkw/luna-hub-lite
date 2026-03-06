import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const HOMEASSISTANT_get_entity_state: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_get_entity_state',
  extensionName: 'homeassistant',
  description: 'Get the current state and attributes of a Home Assistant entity.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'Entity ID (e.g. "light.living_room", "sensor.temperature")' },
    },
    required: ['entity_id'],
  },
  handler: async (args, ctx) => {
    const { ha_api_key, ha_url } = (ctx as ExtensionToolContext).credentials;
    if (!ha_api_key || !ha_url) {
      return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');
    }

    try {
      const url = `${ha_url}/api/states/${encodeURIComponent(args.entity_id)}`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ha_api_key}`,
          'Content-Type': 'application/json',
        },
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return toolError(
          `Home Assistant API error: ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`,
        );
      }

      const data = await resp.json();
      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
