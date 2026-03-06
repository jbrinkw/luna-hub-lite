import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getHACredentials, callService } from './ha-api';
import { formatTvRemoteAction } from './nl-formatters';

const COMMAND_MAP: Record<string, string> = {
  // Navigation
  up: 'DPAD_UP',
  down: 'DPAD_DOWN',
  left: 'DPAD_LEFT',
  right: 'DPAD_RIGHT',
  ok: 'DPAD_CENTER',
  enter: 'DPAD_CENTER',
  select: 'DPAD_CENTER',
  back: 'BACK',
  home: 'HOME',
  // Media
  play: 'MEDIA_PLAY_PAUSE',
  pause: 'MEDIA_PLAY_PAUSE',
  'play/pause': 'MEDIA_PLAY_PAUSE',
  stop: 'MEDIA_STOP',
  next: 'MEDIA_NEXT',
  previous: 'MEDIA_PREVIOUS',
  rewind: 'MEDIA_REWIND',
  'fast forward': 'MEDIA_FAST_FORWARD',
  ff: 'MEDIA_FAST_FORWARD',
  // Volume
  mute: 'MUTE',
  'volume up': 'VOLUME_UP',
  'vol up': 'VOLUME_UP',
  'volume down': 'VOLUME_DOWN',
  'vol down': 'VOLUME_DOWN',
};

const APP_MAP: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  netflix: 'com.netflix.ninja',
  spotify: 'com.spotify.tv.android',
  disney: 'com.disney.disneyplus',
  'disney+': 'com.disney.disneyplus',
};

function parseIntent(button: string): { type: 'command'; command: string } | { type: 'app'; activity: string } | null {
  const b = button.toLowerCase().trim();

  // Check for "open X" / "launch X" pattern
  if (b.startsWith('open ') || b.startsWith('launch ')) {
    const appName = b.split(' ').slice(1).join(' ').trim();
    const activity = APP_MAP[appName];
    if (activity) return { type: 'app', activity };
    return null;
  }

  // Check direct app name
  if (APP_MAP[b]) return { type: 'app', activity: APP_MAP[b] };

  // Check command map
  if (COMMAND_MAP[b]) return { type: 'command', command: COMMAND_MAP[b] };

  return null;
}

export const HOMEASSISTANT_tv_remote: ExtensionToolDefinition = {
  name: 'HOMEASSISTANT_tv_remote',
  extensionName: 'homeassistant',
  description:
    'Control your TV remote — navigation (up/down/left/right/ok/back/home), media (play/pause/stop/next/previous), volume (mute/volume up/volume down), or launch apps (youtube/netflix/spotify/disney).',
  inputSchema: {
    type: 'object',
    properties: {
      button: {
        type: 'string',
        description:
          'The action to perform: navigation (up, down, left, right, ok, back, home), media (play, pause, stop, next, previous, rewind, ff), volume (mute, volume up, volume down), or app name (youtube, netflix, spotify, disney, "open youtube")',
      },
    },
    required: ['button'],
  },
  handler: async (args, ctx) => {
    const creds = getHACredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing Home Assistant credentials (ha_api_key, ha_url)');

    const button: string = args.button;
    if (!button?.trim()) return toolError('Missing required argument: button');

    const remoteEntity = (ctx as ExtensionToolContext).credentials.ha_remote_entity_id || 'remote.living_room_tv';

    const intent = parseIntent(button);
    if (!intent) {
      return toolError(
        `Unknown button '${button}'. Supported: navigation (up/down/left/right/ok/back/home), media (play/pause/stop/next/previous/rewind/ff), volume (mute/volume up/volume down), apps (youtube/netflix/spotify/disney).`,
      );
    }

    try {
      if (intent.type === 'command') {
        await callService(creds, 'remote', 'send_command', {
          entity_id: remoteEntity,
          command: intent.command,
        });
      } else {
        await callService(creds, 'remote', 'turn_on', {
          entity_id: remoteEntity,
          activity: intent.activity,
        });
      }

      const formatted = formatTvRemoteAction(button, remoteEntity, true);
      return toolSuccess({
        formatted,
        remote_entity: remoteEntity,
        button,
        success: true,
      });
    } catch (e) {
      const formatted = formatTvRemoteAction(button, remoteEntity, false, (e as Error).message);
      return toolError(formatted);
    }
  },
};
