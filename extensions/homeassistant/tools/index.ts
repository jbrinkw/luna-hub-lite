import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { HOMEASSISTANT_get_devices } from './get-devices';
import { HOMEASSISTANT_get_entity_status } from './get-entity-status';
import { HOMEASSISTANT_turn_on } from './turn-on';
import { HOMEASSISTANT_turn_off } from './turn-off';
import { HOMEASSISTANT_tv_remote } from './tv-remote';

export const homeassistantTools: Record<string, ExtensionToolDefinition> = {
  HOMEASSISTANT_get_devices,
  HOMEASSISTANT_get_entity_status,
  HOMEASSISTANT_turn_on,
  HOMEASSISTANT_turn_off,
  HOMEASSISTANT_tv_remote,
};
