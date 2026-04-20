/**
 * Mutation-hardening tests for ScalesTab.isValidLanIp.
 *
 * Context: the stored value is interpolated into an href on the Inventory
 * "Review (N)" deep-link, so regressions in the per-octet range check or
 * scheme-rejection become XSS vectors. These cases exercise mutation-prone
 * branches (per-octet range, deny-list, length cap, IPv4-vs-hostname switch).
 */
import { describe, it, expect } from 'vitest';
import { isValidLanIp } from '@/components/chefbyte/ScalesTab';

describe('isValidLanIp — IPv4 per-octet range', () => {
  it('accepts canonical LAN IP', () => {
    expect(isValidLanIp('192.168.0.181')).toBe(true);
  });

  it('accepts every boundary: 0.0.0.0 and 255.255.255.255', () => {
    expect(isValidLanIp('0.0.0.0')).toBe(true);
    expect(isValidLanIp('255.255.255.255')).toBe(true);
  });

  it('rejects 256.x.x.x (first-octet overflow)', () => {
    // If the per-octet range gate is dropped and replaced with `return true`
    // under the 4-dotted-quad shape, 256.1.2.3 slips through as an "IPv4".
    expect(isValidLanIp('256.1.2.3')).toBe(false);
  });

  it('rejects 999.999.999.999 (the documented gap-case)', () => {
    // Docblock calls this out explicitly — keep it as a smoke case.
    expect(isValidLanIp('999.999.999.999')).toBe(false);
  });

  it('rejects last-octet overflow (192.168.0.256)', () => {
    expect(isValidLanIp('192.168.0.256')).toBe(false);
  });

  it('rejects middle-octet overflow (1.300.1.1)', () => {
    expect(isValidLanIp('1.300.1.1')).toBe(false);
  });
});

describe('isValidLanIp — deny-list and shape gates', () => {
  it('rejects empty string', () => {
    expect(isValidLanIp('')).toBe(false);
  });

  it('rejects values over 253 chars', () => {
    expect(isValidLanIp('a'.repeat(254))).toBe(false);
  });

  it('rejects scheme-injection (javascript://evil.com)', () => {
    // This is the load-bearing reason the function exists — a false-positive
    // here would ship as XSS on Inventory → Review.
    expect(isValidLanIp('javascript://evil.com')).toBe(false);
  });

  it('rejects http:// prefix', () => {
    expect(isValidLanIp('http://10.0.0.1')).toBe(false);
  });

  it('rejects embedded port (host:8000)', () => {
    expect(isValidLanIp('192.168.0.1:8000')).toBe(false);
  });

  it('rejects path segment (host/foo)', () => {
    expect(isValidLanIp('192.168.0.1/admin')).toBe(false);
  });

  it('rejects whitespace inside value', () => {
    expect(isValidLanIp('192.168. 0.1')).toBe(false);
  });

  it('rejects angle brackets', () => {
    expect(isValidLanIp('<script>')).toBe(false);
  });

  it('rejects query/hash/at signs', () => {
    expect(isValidLanIp('host?x=1')).toBe(false);
    expect(isValidLanIp('host#frag')).toBe(false);
    expect(isValidLanIp('user@host')).toBe(false);
  });
});

describe('isValidLanIp — hostnames', () => {
  it('accepts simple hostname', () => {
    expect(isValidLanIp('my-pi.local')).toBe(true);
  });

  it('accepts alphanumeric with dots', () => {
    expect(isValidLanIp('node1.lan')).toBe(true);
  });

  it('rejects leading hyphen', () => {
    expect(isValidLanIp('-bad.local')).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(isValidLanIp('  192.168.0.1  ')).toBe(true);
  });
});
