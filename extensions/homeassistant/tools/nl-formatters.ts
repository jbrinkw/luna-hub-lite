export function formatDevicesList(
  devices: Array<{ entity_id: string; domain: string; state: string; friendly_name: string }>,
): string {
  if (!devices.length) return 'No devices found in your Home Assistant setup.';

  const groups: Record<string, typeof devices> = {
    light: [],
    switch: [],
    fan: [],
    media_player: [],
  };
  for (const d of devices) {
    if (groups[d.domain]) groups[d.domain].push(d);
  }

  const labels: Record<string, string> = {
    light: 'Lights',
    switch: 'Switches',
    fan: 'Fans',
    media_player: 'Media Players',
  };
  const parts: string[] = [];
  for (const [domain, label] of Object.entries(labels)) {
    const items = groups[domain];
    if (!items?.length) continue;
    parts.push(`\n**${label}:**`);
    for (const d of items) {
      parts.push(`  - ${d.friendly_name} (${d.entity_id}): ${d.state}`);
    }
  }

  return `Found ${devices.length} device${devices.length !== 1 ? 's' : ''} in your home:\n${parts.join('\n')}`;
}

export function formatEntityStatus(
  entityId: string,
  state: string | null,
  attributes: Record<string, any>,
  friendlyName?: string,
): string {
  const name = friendlyName || attributes?.friendly_name || entityId;
  if (!state) return `The ${name} (${entityId}) status is unknown.`;

  const domain = entityId.split('.')[0];
  if (domain === 'media_player' && state === 'playing') {
    const parts = [`The ${name} (${entityId}) is playing`];
    const title = attributes?.media_title;
    const artist = attributes?.media_artist;
    if (title) parts.push(artist ? `'${title}' by ${artist}` : `'${title}'`);
    if (attributes?.app_name) parts.push(`via ${attributes.app_name}`);
    if (attributes?.volume_level != null) parts.push(`at ${Math.round(attributes.volume_level * 100)}% volume`);
    return parts.join(' ') + '.';
  }

  return `The ${name} (${entityId}) is ${state}.`;
}

export function formatActionResult(
  entityId: string,
  action: string,
  success: boolean,
  friendlyName?: string,
  errorMessage?: string,
): string {
  const name = friendlyName || entityId;
  if (!success) return errorMessage || `I couldn't ${action.replace('_', ' ')} the ${name}.`;
  if (action === 'turn_on') return `I've turned on the ${name}.`;
  if (action === 'turn_off') return `I've turned off the ${name}.`;
  return `I've performed the ${action.replace('_', ' ')} action on the ${name}.`;
}

export function formatTvRemoteAction(
  button: string,
  remoteEntity: string,
  success: boolean,
  errorMessage?: string,
): string {
  if (!success) return errorMessage || `I couldn't send the '${button}' command to your TV.`;

  const deviceName = remoteEntity.includes('.')
    ? remoteEntity
        .split('.')[1]
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : 'your TV';
  const b = button.toLowerCase().trim();

  // App launches
  if (b.startsWith('open ') || b.startsWith('launch ')) {
    const app = b.split(' ').slice(1).join(' ');
    return `I've launched ${app.charAt(0).toUpperCase() + app.slice(1)} on ${deviceName}.`;
  }
  const apps = ['youtube', 'netflix', 'spotify', 'disney', 'disney+'];
  if (apps.includes(b)) return `I've launched ${b.charAt(0).toUpperCase() + b.slice(1)} on ${deviceName}.`;

  const nav: Record<string, string> = {
    up: 'moved up',
    down: 'moved down',
    left: 'moved left',
    right: 'moved right',
    ok: 'pressed OK',
    enter: 'pressed Enter',
    select: 'pressed Select',
    center: 'pressed Center',
    back: 'pressed Back',
    home: 'pressed Home',
  };
  if (nav[b]) return `I've ${nav[b]} on ${deviceName}.`;

  const media: Record<string, string> = {
    play: 'started playback',
    pause: 'paused playback',
    'play/pause': 'toggled playback',
    stop: 'stopped playback',
    next: 'skipped to the next track',
    previous: 'gone back to the previous track',
    prev: 'gone back to the previous track',
    rewind: 'rewound',
    'fast forward': 'fast forwarded',
    ff: 'fast forwarded',
  };
  if (media[b]) return `I've ${media[b]} on ${deviceName}.`;

  const vol: Record<string, string> = {
    mute: 'muted',
    'volume up': 'turned up the volume',
    'vol up': 'turned up the volume',
    'volume down': 'turned down the volume',
    'vol down': 'turned down the volume',
  };
  if (vol[b]) return `I've ${vol[b]} on ${deviceName}.`;

  return `I've sent the '${button}' command to ${deviceName}.`;
}
