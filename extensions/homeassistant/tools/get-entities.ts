import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const HOMEASSISTANT_get_entities: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_get_entities',
  extensionName: 'homeassistant',
  description: 'List all Home Assistant entities, optionally filtered by domain prefix (e.g. "light", "sensor").',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Filter entities by domain prefix (e.g. "light", "sensor", "switch")' },
    },
  },
  handler: async (args, ctx) => {
    const { ha_api_key, ha_url } = (ctx as ExtensionToolContext).credentials;
    if (!ha_api_key || !ha_url) {
      return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');
    }

    try {
      const resp = await fetch(`${ha_url}/api/states`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ha_api_key}`,
          'Content-Type': 'application/json',
        },
      });

      if (!resp.ok) return toolError(`Home Assistant API error: ${resp.status} ${resp.statusText}`);

      let data: any[] = await resp.json();

      // Filter by domain prefix if provided
      if (args.domain) {
        const prefix = `${args.domain}.`;
        data = data.filter((entity: any) => entity.entity_id?.startsWith(prefix));
      }

      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
