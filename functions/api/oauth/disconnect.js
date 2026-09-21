// POST /api/oauth/disconnect — forget the connection, and tell Google to forget it too.
import { REFRESH_COOKIE, cookie, readCookie, json } from './_shared.js';

export async function onRequestPost({ request }) {
  const refresh = readCookie(request, REFRESH_COOKIE);
  // Revoking at Google matters: clearing our cookie alone would leave a live grant
  // sitting in the user's Google account that they never see us drop.
  if (refresh) {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh),
                { method: 'POST' }).catch(() => {});
  }
  return json({ connected: false }, 200, { 'Set-Cookie': cookie(REFRESH_COOKIE, '', 0) });
}
