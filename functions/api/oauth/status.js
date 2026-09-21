// GET /api/oauth/status — whether this browser has a Google connection.
// Deliberately says nothing about the token itself, only that one exists.
import { REFRESH_COOKIE, readCookie, json } from './_shared.js';

export function onRequestGet({ request, env }) {
  return json({
    connected: !!readCookie(request, REFRESH_COOKIE),
    configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  });
}
