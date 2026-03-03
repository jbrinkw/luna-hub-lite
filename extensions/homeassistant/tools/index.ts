import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { HOMEASSISTANT_get_entity_state } from './get-entity-state';
import { HOMEASSISTANT_call_service } from './call-service';
import { HOMEASSISTANT_get_entities } from './get-entities';

export const homeassistantTools: Record<string, ExtensionToolDefinition> = {
  HOMEASSISTANT_get_entity_state,
  HOMEASSISTANT_call_service,
  HOMEASSISTANT_get_entities,
};
