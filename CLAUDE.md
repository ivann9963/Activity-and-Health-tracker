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
- **Heart-rate bands live on the session, not on the day.** A day holding a run and a
  gym session contains two different efforts. Storing them per day also meant the
  per-day source election — which exists for step counts — threw away one device's
  heart rate whenever two devices recorded different workouts on the same day. Because
  the importer credits time to whichever copy of a workout owned the clock, and that
  need not be the copy dedupe keeps, **the winner inherits the fullest band set in its
  group** (`dedupe/sessions.js`); the richest set, never the sum.
- **A reading is worth the gap to the next reading of the SAME workout.** Across a
  boundary it is worth nothing. Closing the last reading of a workout against the end
  of the workout would invent up to five minutes of effort per session.

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

## Design system

The look is **Untitled UI**. Its React library needs React, Tailwind and a build
step — none of which this project has — so what is adopted is the token layer, not
the components. The values in `css/style.css` are transcribed from Untitled UI's own
theme file, not eyeballed: `npm pack untitledui` and read
`package/config/v7/styles/theme.css`. Go back to that file before inventing a value.

The stylesheet has two layers and they must not be collapsed:

1. **Ramps** (`--gray-*`, `--brand-*`, `--success-*`, …) — raw scales. Never
   referenced outside layer 2.
2. **Semantic** (`--text-primary`, `--bg-primary`, `--border-secondary`, …) — what a
   colour is *for*. Everything below uses only these, which is why the light theme is
   a block of reassignments rather than a second stylesheet.

The short aliases at the end of layer 2 (`--bg`, `--surface`, `--text`, `--accent`,
`--heat-*`) exist because `js/charts.js` writes those names straight into SVG
attributes. Keep them pointing at semantic tokens so there is one definition of each
colour rather than two that drift.

Dark is the default and light is the variant — the opposite of Untitled UI's own
default, because this app is opened at the end of a workout. Both are Untitled UI's
stated assignments for that mode, not an inversion of the other; the greys step
differently in each direction. The theme is a saved setting applied in `js/app.js` on
boot and changed under Settings → Appearance.

No web font is loaded. The stack asks for Inter and falls back to the system face,
which is what Untitled UI's own stack does — a font file is a request that can fail
on a phone in a car park.

## Charts

Single series throughout, so no legends — the heading names what is plotted. Thin
capped marks, rounded data-end, square baseline, hairline solid gridlines, a tooltip
on every mark including empty ones. Text never wears the data colour.

The heatmap ramp is validated, not chosen by eye, with the dataviz skill's
`scripts/validate_palette.js --ordinal` against each mode's own surface. It has now
failed the same check twice on first attempt — the palest step invisible against its
surface — most recently with Untitled UI's `brand-200` at 1.34:1 on white, which is
why the light ramp starts two steps deeper at `brand-400`. Light and dark are
separate ramps.

Pace is drawn as an inverted line, because lower is better and bars would make
improvement look like decline.

## Sources

Apple Health export is the historical backbone; there is no API and never will be.
Google renamed Fitbit to Google Health in 2026 and retired the Fitbit Web API
outright, so live sync means the Google Health API — which issues a client secret,
which is why `worker/` exists. The broker handles **tokens only**; health data goes
browser-to-Google directly and never passes through a server.
