// GET /api/oauth/start — begins the Google consent flow.
//
// The page links here rather than building the Google URL itself, so the client id,
// the scope list and the redirect URI all live in exactly one place.
import { GOOGLE_AUTH_URL, SCOPES, STATE_COOKIE, cookie, randomToken,
         requireConfig, redirectUri } from './_shared.js';

export function onRequestGet({ request, env }) {
  try {
    requireConfig(env);
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }

  // CSRF protection: a random value goes both into the Google URL and into a
  // short-lived cookie. The callback only proceeds if the two agree, so a link
  // someone else crafted cannot attach their account to this browser.
  const state = randomToken();

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  // offline + consent is what actually yields a refresh token. Without them Google
  // returns an access token only, and "automatic" sync would mean re-consenting
  // every hour, which is the thing this exists to avoid.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': cookie(STATE_COOKIE, state, 600),
      'Cache-Control': 'no-store'
    }
  });
}
