// Helpers shared by the OAuth endpoints.
//
// The broker exists for one reason: the Google Health API issues a client secret, and
// a static page cannot keep one. It handles ONLY the token dance. Health data is never
// routed through it — the browser calls health.googleapis.com directly with the
// short-lived access token — so nothing here ever sees a heart rate or a step count.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Read-only access to the three groups this app actually shows. Requesting write
// scopes for an app that only reads would be asking for permission we never use.
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
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  return parts.join('; ');
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// URL-safe random string, used for the CSRF state parameter.
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function requireConfig(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set for this ' +
                    'Pages project. Add them under Settings → Environment variables.');
  }
}

// The redirect URI has to match what is registered in Google Cloud exactly, and it
// has to be derived from the request rather than hard-coded, so preview deployments
// and the production domain both work.
export function redirectUri(request) {
  return new URL('/api/oauth/callback', request.url).toString();
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
