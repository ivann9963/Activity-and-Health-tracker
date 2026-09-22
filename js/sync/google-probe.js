// === CONNECTION PROBE ===
// Asks the Google Health API a few questions and reports exactly what comes back.
//
// This exists for the same reason the File Inspector does: the shape of the data is
// not something to assume. The v4 API's paths and payloads cannot be verified from
// where this was written, and a parser built against a guessed schema fails in ways
// that are hard to see — plausible numbers that are quietly wrong. So the app asks,
// and the answer is what the parser gets written against.
//
// It is read-only: every request is a GET, with the access token the browser already
// holds. Nothing is stored and nothing is sent anywhere except Google.

const HEALTH_API = 'https://health.googleapis.com/v4';

// Candidate paths, ordered from most general to most specific. A 404 is as
// informative as a 200 here — it rules a shape out.
function probeTargets() {
  const to = todayLocal();
  const from = addDays(to, -7);
  return [
    { label: 'available data types', url: `${HEALTH_API}/users/me/dataTypes` },
    { label: 'steps data points',
      url: `${HEALTH_API}/users/me/dataTypes/com.google.step_count.delta/dataPoints` },
    { label: 'steps, last 7 days',
      url: `${HEALTH_API}/users/me/dataTypes/steps/dataPoints` +
           `?startTime=${from}T00:00:00Z&endTime=${to}T23:59:59Z` },
    { label: 'sessions', url: `${HEALTH_API}/users/me/sessions` },
    { label: 'user profile', url: `${HEALTH_API}/users/me` }
  ];
}

function probeGoogleHealth(onStep) {
  return googleAccessToken().then(token => {
    const targets = probeTargets();
    const results = [];

    const step = i => {
      if (i >= targets.length) return Promise.resolve(results);
      const target = targets[i];
      if (onStep) onStep(i + 1, targets.length, target.label);

      return fetch(target.url, { headers: { Authorization: 'Bearer ' + token } })
        .then(res => res.text().then(body => {
          results.push({
            label: target.label,
            url: target.url.replace(HEALTH_API, ''),
            status: res.status,
            ok: res.ok,
            // Enough to read the shape, not enough to carry a day of someone's
            // heart rate into a chat window.
            body: body.slice(0, 1200)
          });
        }))
        .catch(err => {
          results.push({ label: target.label, url: target.url.replace(HEALTH_API, ''),
                         status: 0, ok: false, body: 'request failed: ' + err.message });
        })
        .then(() => step(i + 1));
    };

    return step(0);
  });
}

// Plain text, for pasting somewhere. Deliberately not JSON: this is meant to be read.
function probeReportText(results) {
  const lines = ['GOOGLE HEALTH API PROBE', '=======================', ''];
  for (const r of results) {
    lines.push(`${r.ok ? 'OK  ' : 'FAIL'} ${r.status}  ${r.label}`);
    lines.push(`     GET ${r.url}`);
    lines.push('     ' + r.body.replace(/\s+/g, ' ').slice(0, 900));
    lines.push('');
  }
  return lines.join('\n');
}
