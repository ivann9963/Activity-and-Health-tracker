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
- Streaming Apple Health parser, a zero-dependency ZIP reader, the canonical record
  schema and the metric registry underneath it.

Next: the import itself, then the deduplication engine, then the week/month/year views.
Totals are deliberately not shown yet — until the reconciliation step lands they would
double-count anything two devices both recorded, and a wrong total is worse than none.

## Running it

The app is static, but it needs to be served over `http://` for the service worker and
IndexedDB to behave:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Tests

```bash
node tests/run.js        # unit tests — no dependencies, no browser
node tests/ui-smoke.mjs  # drives the real UI in Chromium (needs: npm install)
```

The unit tests load the real `js/` modules into a sandboxed Node context via
`tests/harness.js`, so they exercise shipped code rather than a copy. They cover the
parsers, the unit and timezone conversions, deterministic record ids, and — importantly
— that feeding the XML in 7-byte chunks produces byte-identical results to reading it in
one go, which is the failure mode a streaming parser is prone to.

## Getting your data out

**Apple Health** — Health app → profile picture (top right) → *Export All Health Data*.
Takes several minutes and produces `export.zip`. Drop it in as-is.

**Strava** — strava.com → Settings → My Account → *Download or Delete Your Account* →
*Get Started* → *Request your archive*. Emailed within a few hours.

**Fitbit** — nothing to export: Fitbit's API can sync directly, and that arrives in a
later phase. In the meantime, if the Google Health app on your iPhone is sharing with
Apple Health, your Fitbit data is already inside the Apple export.

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
  dashboard.js · settings.js · app.js
  import/
    zip.js            streaming ZIP reader built on DecompressionStream
    csv.js            RFC4180 parser
    xml-stream.js     streaming XML tag scanner
    normalize.js      units and source names
    apple-health.js   the Apple export parser
    sniffer.js        works out what a dropped file is
    inspector.js      reports a file's contents without importing
    import-ui.js      the Data screen
tests/
  run.js · harness.js · ui-smoke.mjs · fixtures/
```
