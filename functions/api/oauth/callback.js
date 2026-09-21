// GET /api/oauth/callback — Google sends the user back here with an authorization code.
//
// This is the only place the client secret is used. The resulting refresh token is
// stored in an httpOnly cookie and never handed to the page.
import { GOOGLE_TOKEN_URL, REFRESH_COOKIE, STATE_COOKIE, cookie, readCookie,
         requireConfig, redirectUri } from './_shared.js';

// Send the user back into the app with a result, rather than leaving them on a blank
// endpoint wondering whether it worked.
function backToApp(request, params, extraCookies = []) {
  const url = new URL('/', request.url);
  url.hash = '/settings?' + new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: [
      ['Location', url.toString()],
      ['Cache-Control', 'no-store'],
      // The state cookie has done its job either way.
      ['Set-Cookie', cookie(STATE_COOKIE, '', 0)],
      ...extraCookies.map(c => ['Set-Cookie', c])
    ]
  });
}

export async function onRequestGet({ request, env }) {
  try {
    requireConfig(env);
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // The user pressed Cancel on the consent screen. Not an error worth a stack trace.
  if (error) return backToApp(request, { google: 'denied', reason: error });
  if (!code) return backToApp(request, { google: 'error', reason: 'no_code' });

  const expected = readCookie(request, STATE_COOKIE);
  if (!expected || expected !== state) {
    return backToApp(request, { google: 'error', reason: 'state_mismatch' });
  }

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(request),
    grant_type: 'authorization_code'
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.refresh_token) {
    // Google withholds a refresh token if the account has already granted consent and
    // prompt=consent was not honoured. Saying which of the two went wrong saves a lot
    // of guessing.
    const reason = !res.ok ? (data.error || 'token_exchange_failed') : 'no_refresh_token';
    return backToApp(request, { google: 'error', reason });
  }

  // 180 days: comfortably longer than Google's own refresh token lifetime for an app
  // in testing, so the cookie is never the thing that expires first.
  return backToApp(request, { google: 'connected' },
                   [cookie(REFRESH_COOKIE, data.refresh_token, 60 * 60 * 24 * 180)]);
}
