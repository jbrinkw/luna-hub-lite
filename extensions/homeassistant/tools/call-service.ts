import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const HOMEASSISTANT_call_service: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_call_service',
  extensionName: 'homeassistant',
  description:
    'Call a Home Assistant service (e.g. turn on a light, lock a door). Specify domain, service, and optional entity/data.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Service domain (e.g. "light", "switch", "lock")' },
      service: { type: 'string', description: 'Service name (e.g. "turn_on", "turn_off", "toggle")' },
      entity_id: { type: 'string', description: 'Target entity ID (e.g. "light.living_room")' },
      data: { type: 'object', description: 'Additional service data (e.g. { "brightness": 255 })' },
    },
    required: ['domain', 'service'],
  },
  handler: async (args, ctx) => {
    const { ha_api_key, ha_url } = (ctx as ExtensionToolContext).credentials;
    if (!ha_api_key || !ha_url) {
      return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');
    }

    try {
      const url = `${ha_url}/api/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}`;

      const body: Record<string, unknown> = {};
      if (args.entity_id) body.entity_id = args.entity_id;
      if (args.data && typeof args.data === 'object') {
        Object.assign(body, args.data);
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ha_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const respBody = await resp.text().catch(() => '');
        return toolError(
          `Home Assistant API error: ${resp.status} ${resp.statusText}${respBody ? ` — ${respBody.slice(0, 500)}` : ''}`,
        );
      }

      const data = await resp.json();
      return toolSuccess(data);
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
