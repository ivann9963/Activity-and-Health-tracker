# Activity Ledger

A private record of everything you have run, lifted, swum and walked — pulled out of
Apple Health, Fitbit and Strava, reconciled into one history, and turned into weekly,
monthly and yearly progress.

Plain HTML, CSS and JavaScript. No build step, no framework, no dependencies, no
server. Your data never leaves the device.

## Why it exists

Apple Health and the Google Health app each know part of the story, and neither will
tell you what you did last year. Worse, they overlap: an Apple Watch and an iPhone both
counted the same steps, and a run can appear in Apple Health *and* in Strava. Adding
those up gives nonsense. This app's job is to reconcile them honestly and then show
you the total you actually earned.

## Status

Under construction, in phases. Working today:

- **File Inspector** — drop in an Apple Health `export.zip`/`export.xml` or a Strava
  `activities.csv` and see exactly what is inside: record types, counts, date coverage
  and which device recorded what. Nothing is written to storage.
- **Import** — Apple Health exports *and* Google Health (Fitbit) Takeout archives,
  parsed in a worker so the tab stays responsive, with progress, and undoable in full.
- **Deduplication** — overlapping workouts are grouped and one is elected; steps and
  other continuous metrics are never summed across devices. Every decision is visible
  and reversible on the Duplicates screen.
- **Week / month / year** — totals, comparison against the previous period, active
  days, per-day bars, and all-time totals since your data begins.
- **Goals** derived from your own history, shown as a meter with a pace marker: not
  just how far along you are, but whether that is ahead of where the calendar says
  you should be.
- **Per-metric detail** — each measure's whole history, its records, the streaks
  behind them, and the individual sessions.
- **Insights** — where your time actually went (as a share of time, not of sessions),
  active days versus walking-only days, time spent in each heart-rate band, average
  heart rate per sport weighted by session length, and running pace month by month.
- **Year in Review** — the annual payoff, with totals given a scale you can picture.
- **Backup and restore** — one gzipped file holding everything, because otherwise it
  all lives in a single browser's database.

Next: live sync through the Google Health API, and Strava import.

## Live

Deployed to Cloudflare Pages on every push to the default branch. Open it in Safari on
your iPhone and use **Share → Add to Home Screen** to install it. It works offline once
installed, and your data never leaves the device.

Open it in Safari on your iPhone and use **Share → Add to Home Screen** to install it.
It works offline once installed, and your data never leaves the device.

## Running it locally

The app is static, but it needs to be served over `http://` — a `file://` origin cannot
register a service worker or create the import worker:

```bash
npm run serve      # python3 -m http.server 8000
```

Then open http://localhost:8000.

## Build and deploy

There is no bundler and the app does not want one — what you edit is what runs. The
build step exists for the two things that genuinely cannot be done at edit time:

```bash
npm run build      # -> _site/
```

It collects the real asset list out of `index.html` (plus the import worker and
everything it `importScripts`), bakes that into the service worker's precache manifest
so the two can never drift apart, and stamps the commit as a build id so a deploy
invalidates the previous cache instead of stranding people on a stale copy.

Hosting is a **Cloudflare Worker with static assets**, connected directly to this
repository — no deploy workflow needed, Cloudflare builds on push. (Not Cloudflare
Pages: the current dashboard creates Workers, and Pages is no longer the path new
projects are steered down. The practical difference is that routing is explicit in
`worker.js` rather than inferred from a `functions/` directory.)

One-time setup in the Cloudflare dashboard:

1. **Workers & Pages → Create → Import a repository**, pick this repository.
2. Build command `npm run build`, deploy command `npx wrangler deploy`. Everything
   else comes from `wrangler.toml`.
3. **Settings → Variables and Secrets**, added as **Secret** (not plaintext):
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Without them the app runs fine and
   simply reports that sync is not set up.
4. A custom domain is **Settings → Domains & Routes** — no repository change.

GitHub Pages was tried first and abandoned: it cannot host the OAuth broker, and
enabling it in the first place turned out to need repository-admin rights that a
workflow token never receives.

To run the whole thing locally, including the Worker:

```bash
npm run build && npx wrangler dev
```

Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in a `.dev.vars` file (gitignored)
to exercise the OAuth flow locally.

## Automatic sync

Fitbit's own Web API was retired in September 2026 — hard cutoff, registrations closed,
tokens not transferable. Its replacement is the **Google Health API**, which is an
aggregation layer rather than a device API: one connection to a Google account returns
data from everything attached to it, Fitbit included.

That API issues a **client secret**, which a static page cannot hold. So the Worker
carries a small OAuth broker alongside the static files:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/oauth/start` | Begins consent; sets a CSRF state cookie |
| `GET /api/oauth/callback` | Exchanges the code; stores the refresh token |
| `POST /api/oauth/access-token` | Trades the refresh token for a short-lived access token |
| `GET /api/oauth/status` | Whether this browser is connected |
| `POST /api/oauth/disconnect` | Revokes at Google and clears the cookie |

Requests that match a built file are served from Cloudflare's asset store and never
reach the Worker; only the `/api/...` misses do.

Two deliberate choices:

- **The broker never sees health data.** It handles tokens only; the page calls
  `health.googleapis.com` directly. A step count never passes through a server.
- **The refresh token lives in an httpOnly cookie**, not in storage the page can read.
  Script on the page cannot reach it, so an XSS bug cannot walk off with long-lived
  access to a health record. The page only ever holds an access token, in memory,
  valid for an hour.

Google Health scopes are restricted, which means verification is required to launch
publicly — but an unverified app serves up to 100 users, so a personal deployment
simply adds itself as a test user and needs no review.

## Tests

```bash
npm test                 # unit tests — no dependencies, no browser, ~1s
npm run check:worker     # the Worker sources parse (they never run in the unit tests)
npm run test:ui          # drives the real UI in Chromium (needs: npm install)
npm run test:ui:build    # the same checks against the built output in _site/
```

The unit tests load the real `js/` modules into a sandboxed Node context via
`tests/harness.js`, so they exercise shipped code rather than a copy. They cover the
parsers, the unit and timezone conversions, deterministic record ids, deduplication,
and — importantly — that feeding the XML in 7-byte chunks produces byte-identical
results to reading it in one go, which is the failure mode a streaming parser is prone
to.

The smoke test runs twice in CI: against the source tree, and against `_site/`. A build
that drops a file or breaks the service worker passes every other check, so the thing
that actually ships is tested directly.

## Getting your data out

**Apple Health** — Health app → profile picture (top right) → *Export All Health Data*.
Takes several minutes and produces `export.zip`. Drop it in as-is.

**Strava** — strava.com → Settings → My Account → *Download or Delete Your Account* →
*Get Started* → *Request your archive*. Emailed within a few hours.

**Google Health** (the app Google renamed from Fitbit in May 2026) — two routes:

*Easiest, and needs no second file.* Google Health can push its data back into Apple
Health, so one Apple export then covers both eras. In the Google Health app: profile
icon → **Partner apps** → **Apple Health** → **Get started** → **Agree**, granting every
metric you want. Then redo the Apple export. The Inspector will show `Google Health` as
a recording source, and its date range tells you how far back the sync actually reached
— which Google has not documented.

*Thorough, and imports directly.* [takeout.google.com](https://takeout.google.com) →
*Deselect all* → tick **Fitbit** (Google renamed the app but not the Takeout category).
Drop the archive in: the Inspector reports its folders and the real JSON shape of each
kind of file, and the importer reads steps, workouts, sleep, resting heart rate and
weight out of it.

Fitbit's export states no timezone anywhere, so its wall-clock times are resolved
against your browser's zone using the rules in force on each date. That is what keeps a
Fitbit run aligned with its Apple Health twin — without it the two would never be
recognised as the same run and it would be counted twice.

## Layout

```
index.html            app shell; scripts are loaded in dependency order
css/style.css
js/
  config.js           constants, defaults, source-priority defaults
  dates.js            local-day arithmetic and period boundaries
  metrics.js          the metric registry — every number the app can show
  activity-types.js   canonical activity taxonomy + per-vendor mappings
  records.js          canonical record shapes and deterministic ids
  db.js               IndexedDB layer
  routing.js          hash router; views register themselves
  ui-components.js    toast, dialog, progress bar, escaping
  dashboard.js · settings.js · pwa-init.js · app.js
  sync/
    google-health.js  the browser half of the OAuth flow; never touches a secret
  import/
    zip.js            streaming ZIP reader built on DecompressionStream
    csv.js            RFC4180 parser
    xml-stream.js     streaming XML tag scanner
    normalize.js      units and source names
    apple-health.js   the Apple export parser
    fitbit-parse.js   Fitbit record parsers (dates, steps, sleep, exercise, weight)
    fitbit-takeout.js Takeout archive walking, inspection and import
    sniffer.js        works out what a dropped file is
    inspector.js      reports a file's contents without importing
    importer.js       parse in a worker, store, reconcile, undo
    import-ui.js      the Data screen
  workers/
    import-worker.js  keeps a 1GB parse off the UI thread
  dedupe/
    rules.js          source ranking and what counts as the same event
    sessions.js       overlapping-workout grouping and election
    streams.js        per-day source election for steps and the like
    engine.js         runs both passes and writes back what changed
    review-ui.js      the Duplicates screen
  rollups.js          records -> week / month / year numbers
worker.js             Worker entry: routes /api/... and serves everything else
worker/               the OAuth token broker, split by concern
wrangler.toml         Cloudflare Worker config (static assets + entry point)
sw.js                 service worker; its precache list is generated by the build
tools/build.js        collects assets, generates the service worker, stamps a build id
.github/workflows/    ci.yml — tests on every push; Cloudflare deploys on its own
tests/
  run.js · harness.js · ui-smoke.mjs · fixtures/
```
