// === OAUTH HANDLERS ===
// The five endpoints that make up the token broker. The client secret is used in
// exactly two of them and never leaves this file's requests to Google.

import {
  GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, SCOPES,
  REFRESH_COOKIE, STATE_COOKIE,
  cookie, readCookie, randomToken, isConfigured, redirectUri, json
} from './oauth-config.js';

// GET /api/oauth/start — begin the Google consent flow.
export function handleStart(request, env) {
  if (!isConfigured(env)) {
    return new Response('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set for ' +
                        'this Worker. Add them under Settings → Variables and Secrets.',
                        { status: 500 });
  }

  // CSRF protection: the same random value goes into the Google URL and into a
  // short-lived cookie. The callback proceeds only if they agree, so a link someone
  // else crafted cannot attach their account to this browser.
  const state = randomToken();

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  // offline + consent is what actually yields a refresh token. Without them Google
  // returns an access token only, and "automatic" sync would mean re-consenting every
  // hour — the exact thing this exists to avoid.
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
      ['Set-Cookie', cookie(STATE_COOKIE, '', 0)],   // it has done its job either way
      ...extraCookies.map(c => ['Set-Cookie', c])
    ]
  });
}

// GET /api/oauth/callback — Google returns here with an authorization code.
export async function handleCallback(request, env) {
  if (!isConfigured(env)) return new Response('Not configured', { status: 500 });

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

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: 'authorization_code'
    })
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.refresh_token) {
    // Google withholds a refresh token when the account has already granted consent.
    // Distinguishing that from an outright exchange failure saves a lot of guessing.
    const reason = !res.ok ? (data.error || 'token_exchange_failed') : 'no_refresh_token';
    return backToApp(request, { google: 'error', reason });
  }

  // 180 days: comfortably longer than the refresh token's own lifetime, so the cookie
  // is never the thing that expires first.
  return backToApp(request, { google: 'connected' },
                   [cookie(REFRESH_COOKIE, data.refresh_token, 60 * 60 * 24 * 180)]);
}

// POST /api/oauth/access-token — trade the stored refresh token for a fresh access
// token. Deliberately POST-only: a token endpoint reachable by navigation is a token
// endpoint reachable by an <img> tag on somebody else's site.
export async function handleAccessToken(request, env) {
  if (!isConfigured(env)) return json({ error: 'not_configured' }, 500);

  const refresh = readCookie(request, REFRESH_COOKIE);
  if (!refresh) return json({ error: 'not_connected' }, 401);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // invalid_grant means the grant was revoked or expired, so the connection is gone.
    // Clear the cookie rather than leave the app retrying a dead token forever.
    if (data.error === 'invalid_grant') {
      return json({ error: 'reconnect_required' }, 401,
                  { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
    }
    return json({ error: data.error || 'refresh_failed' }, 502);
  }

  return json({ access_token: data.access_token, expires_in: data.expires_in });
}

// GET /api/oauth/status — whether this browser has a connection. Says nothing about
// the token itself, only that one exists.
//
// When the deployment is not configured it names which variables are absent. Setting
// these up involves a dashboard with more than one place to put a variable, and
// "configured: false" alone cannot tell a misspelled name from one added in the wrong
// section. Reporting the missing NAMES leaks nothing — they are in this file — while
// turning a dead end into a single obvious fix.
export async function handleStatus(request, env) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter(name => !env[name]);
  const body = {
    connected: !!readCookie(request, REFRESH_COOKIE),
    configured: isConfigured(env),
    // Which commit is actually deployed. The page in front of someone can be an older
    // cached copy while the deployment is current, so "have my changes shipped?" needs
    // an answer that does not itself come through the cache — and this endpoint is
    // excluded from caching for exactly that reason.
    build: await deployedBuild(env)
  };
  if (missing.length) {
    body.missing = missing;
    body.hint = 'Add these as runtime Secrets on the Worker (Settings → Variables and ' +
                'Secrets), not as build variables, then redeploy.';
  }
  return json(body);
}

// Written by the build alongside the site. Read through the asset binding rather than
// baked into config, so a build never has to modify a tracked file.
async function deployedBuild(env) {
  try {
    const res = await env.ASSETS.fetch(new Request('https://placeholder/build.json'));
    if (!res.ok) return 'unknown';
    return (await res.json()).build || 'unknown';
  } catch {
    return 'unknown';
  }
}

// POST /api/oauth/disconnect — forget the connection, and tell Google to forget it.
export async function handleDisconnect(request) {
  const refresh = readCookie(request, REFRESH_COOKIE);
  // Revoking at Google matters: clearing our cookie alone would leave a live grant
  // sitting in the user's Google account that they never saw us drop.
  if (refresh) {
    await fetch(GOOGLE_REVOKE_URL + '?token=' + encodeURIComponent(refresh),
                { method: 'POST' }).catch(() => {});
  }
  return json({ connected: false }, 200, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
}
