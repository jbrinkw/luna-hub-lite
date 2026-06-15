/**
 * Shared SSRF block-list contract for `extensions/_lib/ssrf.ts`.
 *
 * Both the Obsidian (`getGitCredentials`) and Home Assistant
 * (`getHACredentials`) URL validators delegate to `validateExternalUrl`. If
 * either ever drifts (or someone adds a new metadata endpoint without
 * updating the shared module), this suite is the single canonical guard:
 * every block-list rule listed in extensions/_lib/ssrf.ts is exercised
 * here by URL category, not by tool. The per-tool regression tests in
 * `obsidian-ssrf.test.ts` and the "HA SSRF protection" describe block in
 * `extensions.test.ts` cover the wiring (handler returns isError, no
 * fetch call) — this suite covers the validator itself.
 */
import { describe, expect, it } from 'vitest';
import { validateExternalUrl } from '../../../../extensions/_lib/ssrf';

describe('validateExternalUrl — block list', () => {
  const BLOCKED_URLS: Array<[label: string, url: string]> = [
    // Cloud metadata + link-local
    ['AWS metadata IPv4 (link-local)', 'http://169.254.169.254/'],
    ['AWS metadata with explicit port + path', 'http://169.254.169.254:80/latest/meta-data/'],
    ['link-local IPv4 range', 'http://169.254.1.2/'],
    ['GCE metadata hostname', 'http://metadata.google.internal/'],
    ['Azure-style internal TLD', 'http://foo.internal/'],

    // Loopback + bind-any
    ['localhost hostname', 'http://localhost/'],
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['IPv4 loopback with port', 'http://127.0.0.1:8080/api'],
    ['IPv4 loopback subnet (127.0.0.0/8)', 'http://127.255.255.254/'],
    ['INADDR_ANY', 'http://0.0.0.0/'],

    // RFC1918
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12 lower bound', 'http://172.16.0.1/'],
    ['RFC1918 172.31/12 upper bound', 'http://172.31.255.254/'],
    // Path preservation must NOT weaken host validation: a private host with
    // a plausible Gitea base path is still blocked (regression guard for H-15).
    ['RFC1918 host with /api/v1 base path', 'http://10.0.0.1/api/v1'],
    ['localhost with /api/v1 base path', 'http://localhost/api/v1'],

    // IPv6 loopback / link-local / ULA
    ['IPv6 loopback [::1]', 'http://[::1]/'],
    ['IPv6 unspecified [::]', 'http://[::]/'],
    ['IPv6 link-local [fe80::1]', 'http://[fe80::1]/'],
    ['IPv6 ULA fc00::/7 (fc00)', 'http://[fc00::1]/'],
    ['IPv6 ULA fc00::/7 (fd00)', 'http://[fd00::1]/'],

    // IPv4-mapped IPv6
    ['IPv4-mapped IPv6 dotted (RFC1918 10/8)', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-mapped IPv6 hex form (RFC1918 10/8)', 'http://[::ffff:a00:1]/'],
    ['IPv4-mapped IPv6 dotted (RFC1918 192.168)', 'http://[::ffff:192.168.1.1]/'],
    ['IPv4-mapped IPv6 dotted (loopback)', 'http://[::ffff:127.0.0.1]/'],
  ];

  for (const [label, url] of BLOCKED_URLS) {
    it(`returns null for ${label} (${url})`, () => {
      expect(validateExternalUrl(url)).toBeNull();
    });
  }

  it('returns null for non-http(s) protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://ftp.example.com/',
      'gopher://example.com/',
      'javascript:alert(1)',
      'data:text/plain;base64,SGVsbG8=',
    ]) {
      expect(validateExternalUrl(url)).toBeNull();
    }
  });

  it('returns null for malformed URLs', () => {
    for (const raw of ['not a url', '://badscheme', '', 'http:///', 'http://']) {
      expect(validateExternalUrl(raw)).toBeNull();
    }
  });
});

describe('validateExternalUrl — allow list', () => {
  it('allows public hostnames over https', () => {
    expect(validateExternalUrl('https://api.github.com')).toBe('https://api.github.com');
  });

  it('allows public hostnames over http', () => {
    expect(validateExternalUrl('http://example.com/')).toBe('http://example.com');
  });

  it('preserves explicit ports in the normalized origin', () => {
    expect(validateExternalUrl('https://homeassistant.example.com:8123/')).toBe(
      'https://homeassistant.example.com:8123',
    );
  });

  it('preserves the configured API base path (Gitea / GitHub Enterprise)', () => {
    // H-15 regression: the normalizer must NOT drop the path. A self-hosted
    // Gitea host is configured as ".../api/v1"; if the path is stripped,
    // every `${base}/repos/...` call 404s. The returned base must keep it.
    expect(validateExternalUrl('https://git.corp/api/v1')).toBe('https://git.corp/api/v1');
    expect(validateExternalUrl('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/v3');
  });

  it('strips a trailing slash from a configured base path (no // double-slash)', () => {
    // A user who enters ".../api/v1/" must get ".../api/v1" so callers that
    // append "/repos/..." don't produce "//repos/...".
    expect(validateExternalUrl('https://git.corp/api/v1/')).toBe('https://git.corp/api/v1');
  });

  it('returns the bare origin (no trailing slash) when there is no base path', () => {
    // github.com / a root-path URL must collapse to just the origin so
    // `${base}/repos/...` stays single-slashed. pathname "/" must NOT leak
    // through as a trailing slash.
    expect(validateExternalUrl('https://api.github.com')).toBe('https://api.github.com');
    expect(validateExternalUrl('https://api.github.com/')).toBe('https://api.github.com');
  });

  it('strips embedded credentials from the base URL (keeps origin + path only)', () => {
    // userinfo must never survive into the returned base — otherwise it would
    // be carried into every downstream fetch URL.
    expect(validateExternalUrl('https://user:pass@git.corp/api/v1')).toBe('https://git.corp/api/v1');
  });

  it('strips query string and fragment from the base URL (keeps path)', () => {
    expect(validateExternalUrl('https://git.corp/api/v1?token=secret#frag')).toBe('https://git.corp/api/v1');
  });

  it('lowercases the hostname (URL spec normalization)', () => {
    expect(validateExternalUrl('https://API.GitHub.COM/')).toBe('https://api.github.com');
  });
});
