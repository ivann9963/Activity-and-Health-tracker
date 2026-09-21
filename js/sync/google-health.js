// === GOOGLE HEALTH CONNECTION ===
// The browser half of the OAuth flow. It never handles a client secret and never
// holds a refresh token — those live in the Pages Function and in an httpOnly cookie
// respectively. This file only asks "are we connected?", sends the user off to
// consent, and fetches short-lived access tokens when a sync needs one.
//
// Google renamed Fitbit to Google Health and is retiring the old Fitbit Web API
// outright, so this is the only route to live data. It is an aggregation layer: one
// connection returns whatever is attached to the Google account, Fitbit included.

// Held in memory only, deliberately. Persisting it would turn an hour-long credential
// into a permanent one sitting in storage.
let _accessToken = null;
let _expiresAt = 0;

// The broker only exists on the deployed site. Locally, and on any static host
// without Functions, these endpoints are simply absent — worth saying plainly rather
// than showing a broken button.
function brokerAvailable() {
  return fetch('/api/oauth/status', { credentials: 'same-origin' })
    .then(res => (res.ok ? res.json() : null))
    .catch(() => null);
}

function googleStatus() {
  return brokerAvailable().then(status => {
    if (!status) return { available: false, connected: false, configured: false };
    return { available: true, ...status };
  });
}

function connectGoogle() {
  // A full-page navigation, not a popup: iOS Safari blocks popups aggressively and a
  // redirect is what the OAuth flow expects anyway.
  location.href = '/api/oauth/start';
}

function disconnectGoogle() {
  return fetch('/api/oauth/disconnect', { method: 'POST', credentials: 'same-origin' })
    .then(res => res.json())
    .then(() => { _accessToken = null; _expiresAt = 0; });
}

// A valid access token, refreshed through the broker when the cached one is close to
// expiring. The 60-second margin stops a token expiring mid-request.
function googleAccessToken() {
  if (_accessToken && Date.now() < _expiresAt - 60000) return Promise.resolve(_accessToken);
  return fetch('/api/oauth/access-token', { method: 'POST', credentials: 'same-origin' })
    .then(res => res.json().then(body => {
      if (!res.ok) throw new Error(body.error || 'could not refresh the Google connection');
      return body;
    }))
    .then(body => {
      _accessToken = body.access_token;
      _expiresAt = Date.now() + (body.expires_in || 3600) * 1000;
      return _accessToken;
    });
}

// The callback bounces back to #/settings?google=connected. Read it, tell the user
// what happened, then strip it so a refresh does not re-announce it.
function consumeGoogleCallback() {
  const hash = location.hash || '';
  const qIndex = hash.indexOf('?');
  if (qIndex === -1) return null;
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  const result = params.get('google');
  if (!result) return null;
  const reason = params.get('reason');
  history.replaceState(null, '', location.pathname + location.search + hash.slice(0, qIndex));
  return { result, reason };
}

const GOOGLE_ERRORS = {
  denied: 'Connection cancelled — nothing was changed.',
  state_mismatch: 'That sign-in link did not match this browser. Please try again.',
  no_refresh_token: 'Google did not return a long-lived token. Remove the app under ' +
                    'your Google account permissions, then connect again.',
  no_code: 'Google did not send an authorization code back.'
};

function googleCallbackMessage(cb) {
  if (cb.result === 'connected') return { text: 'Connected to Google Health', kind: 'success' };
  return { text: GOOGLE_ERRORS[cb.reason] || `Could not connect: ${cb.reason || cb.result}`,
           kind: cb.result === 'denied' ? 'info' : 'error' };
}
