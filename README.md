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
- **Import** — Apple Health exports, parsed in a worker so the tab stays responsive,
  with progress, and undoable in full.
- **Deduplication** — overlapping workouts are grouped and one is elected; steps and
  other continuous metrics are never summed across devices. Every decision is visible
  and reversible on the Duplicates screen.
- **Week / month / year** — totals, comparison against the previous period, active
  days, per-day bars, and all-time totals since your data begins.

Next: goals and pace, streaks, a Year in Review, then Fitbit sync and Strava import.

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

**Google Health** (the app Google renamed from Fitbit in May 2026) — two routes:

*Easiest, and needs no second file.* Google Health can push its data back into Apple
Health, so one Apple export then covers both eras. In the Google Health app: profile
icon → **Partner apps** → **Apple Health** → **Get started** → **Agree**, granting every
metric you want. Then redo the Apple export. The Inspector will show `Google Health` as
a recording source, and its date range tells you how far back the sync actually reached
— which Google has not documented.

*Thorough.* [takeout.google.com](https://takeout.google.com) → *Deselect all* → tick
**Fitbit** (Google renamed the app but not the Takeout category). Drop the archive in
and the Inspector reports its folders and the real JSON shape of each kind of file.

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
    fitbit-takeout.js Google Health (Fitbit) Takeout archive inspection
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
tests/
  run.js · harness.js · ui-smoke.mjs · fixtures/
```
