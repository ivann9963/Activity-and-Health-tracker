// POST /api/oauth/access-token — trades the stored refresh token for a fresh access
// token. The page calls this when it needs to talk to the Health API, holds the
// result in memory only, and then calls health.googleapis.com directly.
//
// GET /api/oauth/access-token is not offered: a token endpoint reachable by navigation
// is a token endpoint reachable by an <img> tag on somebody else's site.
import { GOOGLE_TOKEN_URL, REFRESH_COOKIE, cookie, readCookie,
         requireConfig, json } from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    requireConfig(env);
  } catch (err) {
    return json({ error: err.message }, 500);
  }

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
    // invalid_grant means the grant was revoked or expired — the connection is gone,
    // so clear the cookie rather than leaving the app retrying a dead token forever.
    if (data.error === 'invalid_grant') {
      return json({ error: 'reconnect_required' }, 401,
                  { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
    }
    return json({ error: data.error || 'refresh_failed' }, 502);
  }

  return json({ access_token: data.access_token, expires_in: data.expires_in });
}
