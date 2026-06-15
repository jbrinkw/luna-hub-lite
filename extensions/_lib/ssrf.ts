/**
 * Shared SSRF block list for any extension that accepts a user-supplied URL
 * and forwards traffic from a Cloudflare Worker (or comparable server-side
 * runtime) to it. Originally lifted out of two near-identical validators
 * that lived in:
 *   - `extensions/obsidian/tools/git-api.ts`  (`validateGitApiUrl`)
 *   - `extensions/homeassistant/tools/ha-api.ts`  (inlined inside
 *     `getHACredentials`)
 *
 * Both copies covered the same surface; centralising it ensures one source
 * of truth, so a future SSRF technique or new metadata endpoint only needs
 * patching once.
 *
 * Block list (must stay in lockstep with `obsidian-ssrf.test.ts` and the
 * "HA SSRF protection" describe block in `extensions.test.ts`):
 *   - IPv4 loopback         (`127.0.0.0/8`)
 *   - Link-local             (`169.254.0.0/16` — includes cloud metadata)
 *   - RFC1918 private        (`10/8`, `172.16-31/12`, `192.168/16`)
 *   - INADDR_ANY             (`0.0.0.0`)
 *   - IPv6 loopback          (`::1`, `::`)
 *   - IPv6 link-local        (`fe80::/10`)
 *   - IPv6 ULA               (`fc00::/7`)
 *   - IPv4-mapped IPv6       (`::ffff:0:0/96`)
 *   - `localhost` hostname
 *   - `*.internal` hostnames (Azure, GCE)
 *   - Cloud metadata hostnames (`metadata.google.internal`,
 *     `169.254.169.254`)
 *   - Non-http(s) schemes (file://, ftp://, gopher://, javascript:, …)
 */

export interface ValidateExternalUrlResult {
  /**
   * Normalized base URL (`protocol://host[:port][/base/path]`) when safe, else
   * null. Userinfo, query and fragment are stripped; any configured base path
   * is preserved (trailing slash removed).
   */
  origin: string | null;
}

/**
 * Validate a user-supplied URL against the SSRF block list. Returns the
 * normalized base URL (`URL.origin` + `URL.pathname` with trailing slashes
 * stripped — lower-cases the host, preserves explicit ports, preserves any
 * configured base path such as Gitea's `/api/v1`, and strips userinfo / query
 * / fragment) when the URL is safe, or `null` when:
 *   - The URL is unparseable (`new URL(...)` throws).
 *   - The protocol is not `http:` or `https:`.
 *   - The host matches any block-list rule above.
 *
 * Callers should treat `null` as "refuse to forward traffic" — the upstream
 * request must not be made. Handlers in this codebase translate `null` into
 * a missing-credentials tool error (see `getGitCredentials`,
 * `getHACredentials`).
 */
export function validateExternalUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // WHATWG URL preserves the brackets on IPv6 hostnames (e.g. "[::1]"). Strip
  // them so downstream IPv6 range checks match the raw address.
  const rawHost = parsed.hostname;
  const ipv6 = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : null;
  const host = ipv6 ?? rawHost;
  // IPv4-mapped IPv6 address (e.g. ::ffff:10.0.0.1 / ::ffff:a00:1) — extract
  // the embedded IPv4 so the RFC1918 / loopback regexes below can match.
  let mappedV4: string | null = null;
  if (ipv6) {
    const mapped = ipv6.match(/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d{1,3}(?:\.\d{1,3}){3}))$/i);
    if (mapped) {
      if (mapped[3]) {
        mappedV4 = mapped[3];
      } else {
        const hi = parseInt(mapped[1]!, 16);
        const lo = parseInt(mapped[2]!, 16);
        mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      }
    }
  }
  const v4Candidates = [host, mappedV4].filter((h): h is string => !!h);
  const isBlocked =
    host === 'localhost' ||
    host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^fe80:/i.test(host) ||
    /^fd[0-9a-f]{0,2}:/i.test(host) ||
    /^fc[0-9a-f]{0,2}:/i.test(host) ||
    v4Candidates.some((h) => /^127\./.test(h)) ||
    v4Candidates.some((h) => /^10\./.test(h)) ||
    v4Candidates.some((h) => /^192\.168\./.test(h)) ||
    v4Candidates.some((h) => /^169\.254\./.test(h)) ||
    v4Candidates.some((h) => /^172\.(1[6-9]|2\d|3[01])\./.test(h));
  if (isBlocked) return null;
  // Preserve the configured base path (e.g. Gitea "/api/v1", GHE "/api/v3")
  // so callers that append "/repos/..." resolve against the right endpoint.
  // `origin` already strips userinfo/query/fragment and normalizes the host
  // case + default ports; we re-append only the pathname. Trailing slashes
  // are stripped (WHATWG sets pathname to "/" for an empty path, which would
  // otherwise become a stray trailing slash and produce "//repos/..." once a
  // caller appends its own leading-slash segment) — matching the legacy
  // `(api_url || DEFAULT).replace(/\/+$/, '')` normalization.
  const path = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + path;
}
