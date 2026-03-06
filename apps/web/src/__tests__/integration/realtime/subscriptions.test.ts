/**
 * Supabase Realtime Integration Tests
 *
 * Tests that Supabase Realtime channels connect and deliver events.
 * Uses real Supabase Realtime WebSocket against the local instance.
 *
 * Note: postgres_changes CDC tests are skipped in local dev because the
 * Realtime CDC extension doesn't reliably deliver events for non-public
 * schemas in the local Supabase setup. Broadcast/presence tests validate
 * that the real-time WebSocket transport works end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

/** Wait for a channel to reach SUBSCRIBED status, resolved via event callback. */
function waitForSubscription(channel: any, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscribe timeout')), timeoutMs);
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
}

describe('Realtime Subscriptions', () => {
  let userId: string;
  let userClient: any;

  beforeAll(async () => {
    const user = await createTestUser('rt-sub');
    userId = user.userId;
    userClient = user.client;
  });

  afterAll(async () => {
    userClient.removeAllChannels();
    await cleanupUser(userId);
  });

  it('subscribes to a channel successfully', async () => {
    const channel = userClient.channel('test-subscribe');
    const status = await waitForSubscription(channel);
    expect(status).toBe('SUBSCRIBED');
    userClient.removeChannel(channel);
  });

  it('delivers broadcast events between channels', async () => {
    const userB = await createTestUser('rt-bcast');

    // Set up receiver channel for user A
    const receiverChannel = userClient.channel('broadcast-test', {
      config: { broadcast: { self: false } },
    });

    // Promise that resolves when the broadcast event is received
    const receivedEvent = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Broadcast receive timeout')), 10_000);
      receiverChannel.on('broadcast', { event: 'test-event' }, (payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    // Subscribe receiver and wait for SUBSCRIBED status via event callback
    await waitForSubscription(receiverChannel);

    // Now that receiver is subscribed, set up sender on the same channel.
    // Subscribe sender and wait for SUBSCRIBED, then send — no setTimeout needed.
    const senderChannel = userB.client.channel('broadcast-test');
    await waitForSubscription(senderChannel);
    await senderChannel.send({
      type: 'broadcast',
      event: 'test-event',
      payload: { message: 'hello from B', ts: Date.now() },
    });

    const event = await receivedEvent;
    expect(event.payload.message).toBe('hello from B');
    expect(event.payload.ts).toBeGreaterThan(0);

    userClient.removeChannel(receiverChannel);
    userB.client.removeAllChannels();
    await cleanupUser(userB.userId);
  }, 15_000);

  it('tracks presence state across users', async () => {
    const userB = await createTestUser('rt-presence');

    const channel = userClient.channel('presence-test', {
      config: { presence: { key: userId } },
    });

    // Promise that resolves when user B's join event is detected
    const presenceJoin = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Presence join timeout')), 10_000);
      channel.on('presence', { event: 'join' }, (payload: any) => {
        if (payload.newPresences?.some((p: any) => p.role === 'user-b')) {
          clearTimeout(timer);
          resolve(payload);
        }
      });
    });

    // Subscribe user A and track presence via event callback
    await waitForSubscription(channel);
    await channel.track({ role: 'user-a' });

    // Subscribe user B and track presence via event callback
    const channelB = userB.client.channel('presence-test', {
      config: { presence: { key: userB.userId } },
    });
    await waitForSubscription(channelB);
    await channelB.track({ role: 'user-b' });

    const joinEvent = await presenceJoin;
    expect(joinEvent.newPresences).toBeDefined();
    expect(joinEvent.newPresences.length).toBeGreaterThan(0);
    expect(joinEvent.newPresences[0].role).toBe('user-b');

    userClient.removeChannel(channel);
    userB.client.removeAllChannels();
    await cleanupUser(userB.userId);
  }, 15_000);
});
