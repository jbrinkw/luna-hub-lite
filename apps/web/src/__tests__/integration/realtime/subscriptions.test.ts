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
    const status = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 10_000);
      channel.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          resolve(status);
        }
      });
    });
    expect(status).toBe('SUBSCRIBED');
    userClient.removeChannel(channel);
  });

  it('delivers broadcast events between channels', async () => {
    const userB = await createTestUser('rt-bcast');

    const receivedEvent = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Broadcast timeout')), 10_000);
      userClient
        .channel('broadcast-test', { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'test-event' }, (payload: any) => {
          clearTimeout(timeout);
          resolve(payload);
        })
        .subscribe(async (status: string) => {
          if (status === 'SUBSCRIBED') {
            // Give the subscription time to register
            await new Promise((r) => setTimeout(r, 1000));
            // Send broadcast from user B on the same channel
            const channelB = userB.client.channel('broadcast-test').subscribe(async (s: string) => {
              if (s === 'SUBSCRIBED') {
                await channelB.send({
                  type: 'broadcast',
                  event: 'test-event',
                  payload: { message: 'hello from B', ts: Date.now() },
                });
              }
            });
          }
        });
    });

    const event = await receivedEvent;
    expect(event.payload.message).toBe('hello from B');
    expect(event.payload.ts).toBeGreaterThan(0);

    userClient.removeChannel(userClient.channel('broadcast-test'));
    userB.client.removeAllChannels();
    await cleanupUser(userB.userId);
  }, 15_000);

  it('tracks presence state across users', async () => {
    const userB = await createTestUser('rt-presence');

    const channel = userClient.channel('presence-test', {
      config: { presence: { key: userId } },
    });

    const presenceJoin = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Presence timeout')), 10_000);
      channel.on('presence', { event: 'join' }, (payload: any) => {
        // Look for user B's join
        if (payload.newPresences?.some((p: any) => p.role === 'user-b')) {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 10_000);
      channel.subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          // Track user A's presence
          await channel.track({ role: 'user-a' });
          resolve();
        }
      });
    });

    // User B joins the same channel
    const channelB = userB.client.channel('presence-test', {
      config: { presence: { key: userB.userId } },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('B subscribe timeout')), 10_000);
      channelB.subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          await channelB.track({ role: 'user-b' });
          resolve();
        }
      });
    });

    const joinEvent = await presenceJoin;
    expect(joinEvent.newPresences).toBeDefined();
    expect(joinEvent.newPresences.length).toBeGreaterThan(0);
    expect(joinEvent.newPresences[0].role).toBe('user-b');

    userClient.removeChannel(channel);
    userB.client.removeAllChannels();
    await cleanupUser(userB.userId);
  }, 15_000);
});
