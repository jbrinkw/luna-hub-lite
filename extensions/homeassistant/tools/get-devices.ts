import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getHACredentials, fetchStates } from './ha-api';
import { ALLOWED_DOMAINS } from './constants';
import { formatDevicesList } from './nl-formatters';

export const HOMEASSISTANT_get_devices: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_get_devices',
  extensionName: 'homeassistant',
  description: 'List all controllable devices (lights, switches, fans, media players) in your Home Assistant setup.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const creds = getHACredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');

    try {
      const states = await fetchStates(creds);

      const devices: Array<{
        entity_id: string;
        domain: string;
        state: string;
        friendly_name: string;
      }> = [];

      for (const st of states) {
        const eid: string = st.entity_id;
        if (!eid || !eid.includes('.')) continue;
        const domain = eid.split('.')[0];
        if (!(ALLOWED_DOMAINS as readonly string[]).includes(domain)) continue;
        devices.push({
          entity_id: eid,
          domain,
          state: st.state,
          friendly_name: st.attributes?.friendly_name || eid,
        });
      }

      const formatted = formatDevicesList(devices);
      return toolSuccess({ formatted, devices });
    } catch (e) {
      return toolError(`Network error: ${(e as Error).message}`);
    }
  },
};
