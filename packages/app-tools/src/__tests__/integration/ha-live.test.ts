import { describe, it, expect } from 'vitest';
import { homeassistantTools } from '../../../../../extensions/homeassistant/tools';
import type { ExtensionToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Home Assistant Live Integration Tests
// ---------------------------------------------------------------------------
// These tests hit a real Home Assistant instance. They require:
//   HA_URL  — base URL (default: http://localhost:8123)
//   HA_TOKEN — a valid short-lived or long-lived access token
//
// On a fresh HA install the only entities are sun.sun, person.*, zone.home,
// etc. None of those are in the ALLOWED_DOMAINS (light, switch, fan,
// media_player), so most "happy path" calls return errors or empty lists.
// That is expected — the tests verify API connectivity, auth, error handling,
// and NL formatting.
// ---------------------------------------------------------------------------

const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL || 'http://localhost:8123';
const skip = !HA_TOKEN;

function ctx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: {
      ha_api_key: HA_TOKEN!,
      ha_url: HA_URL,
    },
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe.skipIf(skip)('Home Assistant Live Integration Tests', () => {
  // -------------------------------------------------------------------------
  // 1. API connectivity — proves the token + URL work
  // -------------------------------------------------------------------------
  it('should connect to HA API without network errors', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, ctx());
    // Should not be a network error (those include "Network error:" prefix)
    if (result.isError) {
      expect(result.content[0].text).not.toMatch(/Network error/);
    } else {
      expect(result.content[0].text).toBeTruthy();
    }
  });

  // -------------------------------------------------------------------------
  // 2. get_devices — returns empty list on fresh install (no allowed domains)
  // -------------------------------------------------------------------------
  it('should return empty device list on fresh install', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, ctx());
    const data = parse(result);

    expect(data.formatted).toEqual(expect.any(String));
    expect(data.formatted).toContain('No devices found');
    expect(data.devices).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. get_entity_status — non-existent light entity
  // -------------------------------------------------------------------------
  it('should return error for non-existent entity', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'light.nonexistent' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // 4. get_entity_status — missing identifier
  // -------------------------------------------------------------------------
  it('should return error when no identifier is provided', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/entity_id|friendly_name/i);
  });

  // -------------------------------------------------------------------------
  // 5. turn_on — non-existent entity
  // -------------------------------------------------------------------------
  it('should return error when turning on a non-existent entity', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({ entity_id: 'light.fake' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // 6. turn_off — non-existent entity
  // -------------------------------------------------------------------------
  it('should return error when turning off a non-existent entity', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_off.handler({ entity_id: 'switch.nonexistent' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // 7. tv_remote — no remote entity on fresh install
  // -------------------------------------------------------------------------
  it('should return error for tv_remote on fresh install', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: 'home' }, ctx());

    // callService POST to remote.living_room_tv will fail (entity doesn't exist)
    expect(result.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. tv_remote — unknown button
  // -------------------------------------------------------------------------
  it('should return error for unknown tv_remote button', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: 'not_a_real_button' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown button/i);
  });

  // -------------------------------------------------------------------------
  // 9. Missing credentials — get_devices
  // -------------------------------------------------------------------------
  it('should return error when credentials are missing', async () => {
    const badCtx: ExtensionToolContext = {
      userId: 'test',
      supabase: {} as any,
      credentials: {},
    };

    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, badCtx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });

  // -------------------------------------------------------------------------
  // 10. Missing credentials — turn_on
  // -------------------------------------------------------------------------
  it('should return error when credentials are missing for turn_on', async () => {
    const badCtx: ExtensionToolContext = {
      userId: 'test',
      supabase: {} as any,
      credentials: {},
    };

    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({ entity_id: 'light.fake' }, badCtx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });

  // -------------------------------------------------------------------------
  // 11. Missing credentials — tv_remote
  // -------------------------------------------------------------------------
  it('should return error when credentials are missing for tv_remote', async () => {
    const badCtx: ExtensionToolContext = {
      userId: 'test',
      supabase: {} as any,
      credentials: {},
    };

    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: 'home' }, badCtx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });

  // -------------------------------------------------------------------------
  // 12. turn_on — missing identifier
  // -------------------------------------------------------------------------
  it('should return error when turn_on has no identifier', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/entity_id|friendly_name/i);
  });

  // -------------------------------------------------------------------------
  // 13. tv_remote — missing button
  // -------------------------------------------------------------------------
  it('should return error when tv_remote has no button', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/button/i);
  });
});
