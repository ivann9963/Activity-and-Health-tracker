// === WORKER ENTRY ===
// Serves the app and hosts the OAuth token broker.
//
// Cloudflare serves any request that matches a built file straight from the asset
// store without running this code at all. Only misses arrive here, which in practice
// means the /api/... routes below — so this stays a router and nothing more.
//
// The broker exists because the Google Health API issues a client secret and a static
// page cannot hold one. It handles ONLY the token dance: health data is fetched by
// the browser directly from health.googleapis.com, so no step count or heart rate
// ever passes through this Worker.

import { handleStart, handleCallback, handleAccessToken, handleStatus, handleDisconnect }
  from './worker/oauth-handlers.js';

const ROUTES = {
  'GET /api/oauth/start': handleStart,
  'GET /api/oauth/callback': handleCallback,
  'POST /api/oauth/access-token': handleAccessToken,
  'GET /api/oauth/status': handleStatus,
  'POST /api/oauth/disconnect': handleDisconnect
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const handler = ROUTES[`${request.method} ${url.pathname}`];
      if (!handler) return new Response('Not found', { status: 404 });
      try {
        return await handler(request, env);
      } catch (err) {
        // Never leak an internal error to the browser: an OAuth failure message can
        // carry request details we would rather not publish.
        console.error('[worker]', url.pathname, err && err.stack || err);
        return new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }
    }

    // Anything else that got this far was not a built file. Let the asset store
    // answer, so its own 404 handling applies rather than a bare string from here.
    return env.ASSETS.fetch(request);
  }
};
