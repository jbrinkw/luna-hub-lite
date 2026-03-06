import { describe, it, expect, beforeAll } from 'vitest';
import { homeassistantTools } from '../../../../../extensions/homeassistant/tools';
import type { ExtensionToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Home Assistant Live Integration Tests
// ---------------------------------------------------------------------------
// These tests hit a real Home Assistant Docker instance with template entities:
//   light.luna_test_light   — friendly_name "Luna Test Light", starts "off"
//   switch.luna_test_switch — friendly_name "Luna Test Switch", starts "off"
//   input_boolean.luna_backing_light  — backing for light template (NOT in ALLOWED_DOMAINS)
//   input_boolean.luna_backing_switch — backing for switch template (NOT in ALLOWED_DOMAINS)
//
// Requires:
//   HA_TOKEN — a valid long-lived access token
//   HA_URL   — base URL (default: http://localhost:8123)
// ---------------------------------------------------------------------------

const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL || 'http://localhost:8123';
const skip = !HA_TOKEN;

function ctx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: { ha_api_key: HA_TOKEN!, ha_url: HA_URL },
  };
}

function noCredsCtx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: {},
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(skip)('Home Assistant Live Integration Tests', () => {
  // -------------------------------------------------------------------------
  // Setup: reset all entities to "off" and verify connectivity
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    const headers = {
      Authorization: `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Verify connectivity
    const healthResp = await fetch(`${HA_URL}/api/`, { headers });
    if (!healthResp.ok) {
      throw new Error(`HA connectivity check failed: ${healthResp.status} ${healthResp.statusText}`);
    }

    // Reset light to off
    await fetch(`${HA_URL}/api/services/light/turn_off`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entity_id: 'light.luna_test_light' }),
    });

    // Reset switch to off
    await fetch(`${HA_URL}/api/services/switch/turn_off`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entity_id: 'switch.luna_test_switch' }),
    });

    // Allow state to settle
    await delay(500);
  });

  // =========================================================================
  // State-reading tests
  // =========================================================================

  // 1. get_devices lists real devices
  it('get_devices lists real devices with domain grouping', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, ctx());
    const data = parse(result);

    // Should find at least our two test entities
    expect(data.devices.length).toBeGreaterThanOrEqual(2);

    // Check domain grouping — both light and switch present
    const domains = new Set(data.devices.map((d: any) => d.domain));
    expect(domains.has('light')).toBe(true);
    expect(domains.has('switch')).toBe(true);

    // Check friendly names in formatted output
    expect(data.formatted).toContain('Luna Test Light');
    expect(data.formatted).toContain('Luna Test Switch');

    // Verify device objects have correct fields
    const lightDev = data.devices.find((d: any) => d.entity_id === 'light.luna_test_light');
    expect(lightDev).toBeDefined();
    expect(lightDev.domain).toBe('light');
    expect(lightDev.friendly_name).toBe('Luna Test Light');
    expect(lightDev.state).toEqual(expect.any(String));

    const switchDev = data.devices.find((d: any) => d.entity_id === 'switch.luna_test_switch');
    expect(switchDev).toBeDefined();
    expect(switchDev.domain).toBe('switch');
    expect(switchDev.friendly_name).toBe('Luna Test Switch');
    expect(switchDev.state).toEqual(expect.any(String));
  });

  // 2. get_devices domain filtering — input_boolean NOT listed
  it('get_devices excludes entities not in ALLOWED_DOMAINS', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, ctx());
    const data = parse(result);

    // input_boolean entities should not appear
    const entityIds = data.devices.map((d: any) => d.entity_id);
    expect(entityIds).not.toContain('input_boolean.luna_backing_light');
    expect(entityIds).not.toContain('input_boolean.luna_backing_switch');

    // No input_boolean domain at all
    const domains = data.devices.map((d: any) => d.domain);
    expect(domains).not.toContain('input_boolean');

    // Also no sun, person, zone, etc.
    expect(domains).not.toContain('sun');
    expect(domains).not.toContain('person');
    expect(domains).not.toContain('zone');
  });

  // 3. get_entity_status by entity_id
  it('get_entity_status by entity_id returns correct data', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'light.luna_test_light' },
      ctx(),
    );
    const data = parse(result);

    expect(data.formatted).toContain('Luna Test Light');
    expect(data.state).toBe('off');
    expect(data.entity_id).toBe('light.luna_test_light');
  });

  // 4. get_entity_status by friendly_name
  it('get_entity_status by friendly_name resolves correctly', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { friendly_name: 'Luna Test Light' },
      ctx(),
    );
    const data = parse(result);

    expect(data.entity_id).toBe('light.luna_test_light');
    expect(data.formatted).toContain('Luna Test Light');
    expect(data.state).toBe('off');
  });

  // 5. get_entity_status partial name match
  it('get_entity_status resolves partial name match', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { friendly_name: 'Test Switch' },
      ctx(),
    );
    const data = parse(result);

    expect(data.entity_id).toBe('switch.luna_test_switch');
  });

  // 6. get_entity_status ambiguous name — matches both light and switch
  it('get_entity_status errors on ambiguous name matching multiple entities', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { friendly_name: 'Luna Test' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Multiple entities/i);
  });

  // 7. get_entity_status non-existent entity
  it('get_entity_status errors for non-existent entity', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'light.nonexistent' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // 8. get_entity_status no identifier
  it('get_entity_status errors when no identifier provided', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/entity_id|friendly_name/i);
  });

  // 8b. get_entity_status media_player with playing state (NL formatting)
  it('get_entity_status formats media_player playing state with details', async () => {
    // Seed a media_player entity in "playing" state via POST /api/states
    const headers = {
      Authorization: `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
    };
    await fetch(`${HA_URL}/api/states/media_player.luna_test_tv`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        state: 'playing',
        attributes: {
          friendly_name: 'Luna Test TV',
          media_title: 'Test Song',
          media_artist: 'Test Artist',
          app_name: 'Spotify',
          volume_level: 0.75,
        },
      }),
    });

    const result = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'media_player.luna_test_tv' },
      ctx(),
    );
    const data = parse(result);

    expect(data.entity_id).toBe('media_player.luna_test_tv');
    expect(data.state).toBe('playing');
    expect(data.formatted).toContain('Luna Test TV');
    expect(data.formatted).toContain('playing');
    expect(data.formatted).toContain('Test Song');
    expect(data.formatted).toContain('Test Artist');
    expect(data.formatted).toContain('Spotify');
    expect(data.formatted).toContain('75%');
  });

  // =========================================================================
  // Mutation tests (sequential — they change shared state)
  // =========================================================================

  // 9. turn_on by entity_id
  it('turn_on by entity_id turns on switch and verifies state', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler(
      { entity_id: 'switch.luna_test_switch' },
      ctx(),
    );
    const data = parse(result);

    expect(data.formatted).toContain("I've turned on the Luna Test Switch");
    expect(data.entity_id).toBe('switch.luna_test_switch');
    expect(data.action).toBe('turn_on');
    expect(data.success).toBe(true);

    // Verify state changed
    await delay(500);
    const statusResult = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'switch.luna_test_switch' },
      ctx(),
    );
    const statusData = parse(statusResult);
    expect(statusData.state).toBe('on');
  });

  // 10. turn_off by entity_id
  it('turn_off by entity_id turns off switch and verifies state', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_off.handler(
      { entity_id: 'switch.luna_test_switch' },
      ctx(),
    );
    const data = parse(result);

    expect(data.formatted).toContain("I've turned off the Luna Test Switch");
    expect(data.entity_id).toBe('switch.luna_test_switch');
    expect(data.action).toBe('turn_off');
    expect(data.success).toBe(true);

    // Verify state changed
    await delay(500);
    const statusResult = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'switch.luna_test_switch' },
      ctx(),
    );
    const statusData = parse(statusResult);
    expect(statusData.state).toBe('off');
  });

  // 11. turn_on by friendly_name
  it('turn_on by friendly_name resolves and turns on light', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({ friendly_name: 'Luna Test Light' }, ctx());
    const data = parse(result);

    expect(data.formatted).toContain("I've turned on the Luna Test Light");
    expect(data.entity_id).toBe('light.luna_test_light');
    expect(data.success).toBe(true);

    // Verify state changed
    await delay(500);
    const statusResult = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'light.luna_test_light' },
      ctx(),
    );
    const statusData = parse(statusResult);
    expect(statusData.state).toBe('on');
  });

  // 12. turn_off by friendly_name
  it('turn_off by friendly_name resolves and turns off light', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_off.handler({ friendly_name: 'Luna Test Light' }, ctx());
    const data = parse(result);

    expect(data.formatted).toContain("I've turned off the Luna Test Light");
    expect(data.entity_id).toBe('light.luna_test_light');
    expect(data.success).toBe(true);

    // Verify state changed
    await delay(500);
    const statusResult = await homeassistantTools.HOMEASSISTANT_get_entity_status.handler(
      { entity_id: 'light.luna_test_light' },
      ctx(),
    );
    const statusData = parse(statusResult);
    expect(statusData.state).toBe('off');
  });

  // 13. turn_on non-existent entity
  it('turn_on errors for non-existent entity', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({ entity_id: 'light.fake' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // 14. turn_on no identifier
  it('turn_on errors when no identifier provided', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/entity_id|friendly_name/i);
  });

  // =========================================================================
  // tv_remote tests
  // =========================================================================

  // 15. tv_remote unknown button
  it('tv_remote errors for unknown button', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: 'not_a_button' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown button/i);
  });

  // 16. tv_remote missing button
  it('tv_remote errors when no button provided', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/button/i);
  });

  // 17. tv_remote empty string
  it('tv_remote errors for empty string button', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: '' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/button/i);
  });

  // =========================================================================
  // Missing credentials tests
  // =========================================================================

  // 18. Missing credentials for get_devices
  it('get_devices errors with missing credentials', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_get_devices.handler({}, noCredsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });

  // 19. Missing credentials for turn_on
  it('turn_on errors with missing credentials', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_turn_on.handler({ entity_id: 'light.fake' }, noCredsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });

  // 20. Missing credentials for tv_remote
  it('tv_remote errors with missing credentials', async () => {
    const result = await homeassistantTools.HOMEASSISTANT_tv_remote.handler({ button: 'home' }, noCredsCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing Home Assistant credentials/i);
  });
});
