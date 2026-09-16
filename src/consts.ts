/**
 * Package constants, in a leaf module so services and the client can both
 * import them without a cycle.
 */

/** VERSION is the client version, reported in the User-Agent header.
 * Keep in sync with the "version" field in package.json. */
export const VERSION = '0.1.1';

/** DEFAULT_BASE_URL is the hosted JustRouting API endpoint. */
export const DEFAULT_BASE_URL = 'https://api.justrouting.tech';

/** DEFAULT_PROFILE is the routing profile used when a request leaves
 * profile empty. */
export const DEFAULT_PROFILE = 'driving';

/** profileOrDefault returns the profile to use in a request path. */
export function profileOrDefault(profile: string): string {
  if (!profile) return DEFAULT_PROFILE;
  return pathEscape(profile);
}

const PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;

/**
 * pathEscape escapes s like Go's url.PathEscape: every character that is
 * not a valid RFC 3986 "pchar" is percent-encoded, while sub-delimiters
 * such as ":" and "@" survive unescaped.
 */
export function pathEscape(s: string): string {
  let out = '';
  for (const ch of s) {
    out += PATH_SAFE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}
