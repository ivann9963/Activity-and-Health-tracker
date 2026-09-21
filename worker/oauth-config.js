// === OAUTH CONFIGURATION AND COOKIE HELPERS ===
// Constants and the small amount of plumbing the handlers share.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Read-only access to the three groups this app shows. Requesting write scopes for an
// app that only reads would be asking for permission we never use — and these are
// restricted scopes, so the consent screen spells out every one of them.
export const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly'
];

export const REFRESH_COOKIE = 'gh_refresh';
export const STATE_COOKIE = 'gh_state';

// The refresh token is kept in an httpOnly cookie rather than handed to the page.
// Script on the page cannot read it, so an XSS bug cannot walk off with long-lived
// access to someone's health record. The page only ever holds an access token, in
// memory, good for an hour.
export function cookie(name, value, maxAgeSec) {
  return [
    `${name}=${value}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ].join('; ');
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// URL-safe random string for the CSRF state parameter.
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// Derived from the request rather than hard-coded, so a preview deployment and the
// production domain both work. It must match a redirect URI registered in Google
// Cloud exactly.
export function redirectUri(request) {
  return new URL('/api/oauth/callback', request.url).toString();
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
