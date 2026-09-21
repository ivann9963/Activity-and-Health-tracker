# Working on this project

Conventions and decisions that are not obvious from the code, so they do not have to
be rediscovered.

## Shape

Plain HTML/CSS/JS, loaded as ordinary `<script>` tags in dependency order from
`index.html`. **No bundler, no framework, no build of the source** — what you edit is
what runs. `npm run build` exists only to generate the service worker's precache list
and stamp a build id; it copies files, it does not transform them.

Everything shares one global scope. Two consequences that have already caused bugs:

- A `const` of the same name in two files is a syntax error that takes down every file
  loaded after it. (`GZIP_MAGIC` did exactly this.)
- `js/workers/import-worker.js` has its **own** `importScripts` list. Anything the
  parser starts depending on must be added there too, or every import throws while the
  unit tests stay green — they load modules directly. (`metrics.js` did exactly this.)

One file per component. Views register themselves with `registerView(...)`; the order
of the `<script>` tags is the order of the tab bar. `inNav: false` keeps a view
reachable by URL but out of the tabs.

## Data rules

These are the load-bearing decisions. Breaking one produces numbers that look
plausible and are wrong.

- **Everything is keyed by local date**, using each record's own UTC offset — never
  the importing browser's timezone.
- **Record ids are content-derived**, which is what makes re-importing an overlapping
  export a no-op. A daily record's id deliberately excludes its *value*, so two
  sources' figures for the same day collide by design and dedupe picks one.
- **Continuous metrics are never summed across sources.** One source is elected per
  day. The election is per-day, not global — that is what makes retiring a device a
  non-event instead of a cliff in the data.
- **Sessions match on overlap AND close start times.** Overlap alone lets a two-hour
  walk swallow the run inside it.
- **Unknown units yield `null`, never a guess.** Same for a weight whose unit the
  export does not state.
- Nothing is ever deleted by dedupe; losers carry `supersededBy` and a readable reason.

## Testing

```bash
npm test                 # unit tests over the real modules, ~1s
npm run check:worker     # the Worker's ES modules parse
npm run test:ui          # drives the real UI in Chromium
npm run test:ui:build    # the same, against the built output
npm run perf             # ~100MB export: parse speed, retained memory
```

`npm test` alone is not sufficient evidence. Every one of these has caught something
the others could not:

- The browser test found a worker missing a script, a goal saved under one key and
  read under another, and a chart crash from a declaration-order mistake.
- The build test exists because a dropped file or broken service worker passes
  everything else.
- `npm run perf` found a memory leak that would have failed a real import on a phone.
  Substrings in V8 pin their parent buffer; strings kept on records are interned in
  `import/normalize.js` for that reason.

**Look at the rendered app.** Axis ticks reading "0.00 km", a clipped axis, and empty
tiles eating a phone screen were all invisible to every test and obvious in a
screenshot.

## Charts

Single series throughout, so no legends — the heading names what is plotted. Thin
capped marks, rounded data-end, square baseline, hairline solid gridlines, a tooltip
on every mark including empty ones. Text never wears the data colour.

The heatmap ramp is validated, not chosen by eye; the first attempt failed with the
palest step invisible against both surfaces. Light and dark are separate ramps.

Pace is drawn as an inverted line, because lower is better and bars would make
improvement look like decline.

## Sources

Apple Health export is the historical backbone; there is no API and never will be.
Google renamed Fitbit to Google Health in 2026 and retired the Fitbit Web API
outright, so live sync means the Google Health API — which issues a client secret,
which is why `worker/` exists. The broker handles **tokens only**; health data goes
browser-to-Google directly and never passes through a server.
