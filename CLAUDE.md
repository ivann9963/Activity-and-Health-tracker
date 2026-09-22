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
- **A metric may cover a FAMILY of activities, not one key** (`METRICS[id].activities`,
  read through `metricActivities()`). Gym covers `strength` and `hiit`: Apple calls a
  circuit `HighIntensityIntervalTraining`, `hiit` has no tile of its own, and counting
  only `strength` left nine gym sessions in a month totalling 35 minutes — stored,
  listed on Insights, and in no total anywhere. `other` is deliberately NOT in any
  family: it is the catch-all, and folding it in would quietly turn dance into gym
  time. An activity in no family is visible on Insights and on Data → Recent workouts
  but in no tile, which is the cost of not guessing.
- **A session whose tracked field is missing is counted, not skipped.** `distance_run`
  reads `distanceM`; a treadmill run records none, and a workout relayed between apps
  often loses it. Dropping it made the dashboard show a dash on a day the user had
  trained — the one answer that is certainly wrong. `computeRollups` returns
  `sessions`, `withoutValue` and `secondsWithoutValue` alongside the total so a view
  can say "1 session, no distance recorded" instead. The total itself stays `null`,
  never `0`: "no distance recorded" and "ran zero kilometres" are different claims.
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

When a total is disputed, **Data → Recent workouts** lists the sessions as stored,
including the copies dedupe set aside and the rows whose figures are incomplete, each
naming its source. Every other screen aggregates; this is the only one that shows the
rows, and it is the first place to look when someone says a number is wrong.

**Data → Check a date range** (`js/diagnose.js`) prints the same records through the
same rules as plain text: every session with its source and dedupe status, totals by
source and by activity, the daily figures, and every pair of sessions that overlap in
time without having been merged — each of those is a candidate double count, with the
rule that kept them apart named. It reports, never acts: merging on suspicion is how a
real second workout gets erased. It is the right answer to "the totals are off",
because it is pasteable.

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

## Icons

`js/icons.js` is the only source of glyphs. Records carry an icon **name**
(`icon: 'running'`), never a character, and views render it through `icon(name, size)`
or `iconOrText(...)` — the latter passes an unknown string through so a stray value
degrades instead of throwing.

Interface icons are Untitled UI's own, lifted from `@untitledui/icons`
(`npm pack @untitledui/icons`, then read the `d` out of `dist/<Name>.mjs`). Untitled UI
ships no sport glyphs, so those are hand-authored to the same spec: 24×24 box, 2px
stroke, round caps and joins, no fill, `currentColor`. `ICON_PATHS` holds raw SVG
children, so an icon may use `<circle>` or `<ellipse>` where a path would be clumsy.

These replaced emoji. Emoji render differently on every platform, cannot take a
colour, and are the loudest possible signal that nobody chose them.

**Judge a new icon at 20px, not at 200.** Render the contact sheet — every icon in a
grid at its real size — before believing one works. Doing that caught a racket that
read as a no-entry sign and a flexed arm that read as a raised palm.

## Motion

`js/motion.js` plus the MOTION block in `css/style.css`. Three rules:

1. **Motion explains a change.** Views rise as they replace one another, items arrive
   in reading order, bars grow from the baseline because that is where they are
   measured from. Nothing moves decoratively.
2. **Transform and opacity only**, so every frame composites and nothing reflows.
3. **`prefers-reduced-motion` turns all of it off** — the CSS kill-switch zeroes
   durations and `motionOff()` stops the JS-driven counters.

`animateView(host)` runs from the router after every render, including a period
switch, so changing week to month looks like the data moved rather than the page
blinking.

**A counting number reads its target from its own rendered text**, never from the
stored value. The first version counted the record's value into the formatted string
— 5200 metres inside the template `"5.20 km"` — and displayed `3376.66 km` on the way
up. Storage units and display units are different things. `data-count` is a flag with
no value for the same reason. While a counter runs the element carries
`data-counting`, which is how tests and screenshots wait for the settled figure
instead of sampling a frame mid-count.

**Never put `data-count` on an element that wraps markup.** Counting rewrites
`textContent`, which deletes child elements — it already cost a bolded figure its
`<strong>`. `countUp` now refuses an element with children, and the smoke test fails
if any marked element has any.

## Goals vs targets

Two different commitments, and conflating them produces a number that answers neither.

- A **goal** (`js/goals.js`) is a total to reach by the end of a period: 100km this
  month. Progress is a fraction of a sum.
- A **target** (`js/targets.js`) is a standard one day either meets or misses: seven
  hours of sleep, an hour of training. The answer is a count of days and the longest
  run of them. "Slept 7h on 21 of 30 nights, best run 9" is a different fact from
  "slept 186 hours", and the second cannot be derived from the first.

Targets share the `goals` store, keyed with period `'day'`, so they are backed up and
restored with everything else. `goalsForPeriod` reads an explicit period, so day
targets never leak into period goals.

Rules that are easy to get wrong:

- **A day with no reading never counts as met**, in either direction. For a ceiling
  like resting heart rate, silence is not success.
- **Lower is better for `resting_hr` and `weight`** (`TARGET_LOWER_IS_BETTER`), and a
  stored target records its own comparison so it keeps its meaning if the default
  ever changes.
- **Today never breaks a streak** — same rule as `streaks.js`, and for the same
  reason: the day is not over.
- `workoutStreaks` is days with *any* counted workout, which is what people mean by a
  streak. `dayStreaks` in `streaks.js` is per-metric and reads 1 for anyone who
  cross-trains. Set-aside activities are excluded from both.
- **A record is a single session, not a day.** `bestDay` sums a day; three short runs
  is a good day, not a long run. Records group by activity because "longest" is a
  duration for the gym and a distance for a swim.

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

## Deploying

Cloudflare Worker with static assets (`[assets]` + `main` in `wrangler.toml`), not
Pages. `npm run build` writes `_site/` and stamps the commit into the page and into
`_site/build.json`, which `/api/oauth/status` reports — so **"which version is live"
is answerable from a browser**, and that endpoint is the first thing to check when a
change seems not to have shipped. It is the one path the service worker is forbidden
to cache.

Two routes to production, and they do not conflict:

- Cloudflare's dashboard Git integration. It **silently disconnected once** and
  nothing deployed for a day — pushes green, CI green, live site frozen on an old
  commit, no failure anywhere to notice. If the live build id is stale, look at
  Workers → the Worker → Builds for "disconnected from your Git account" before
  suspecting a cache.
- `.github/workflows/ci.yml`, which deploys after the tests pass. It skips unless
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set as repository secrets.
  This exists so a failed deploy looks like a failed deploy.

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` go on the Worker as **Secrets**, not
plaintext Variables. A Variable that `wrangler.toml` does not declare is removed by
the next deploy, so one added that way works until the next push and then stops.

## Sources

Apple Health export is the historical backbone; there is no API and never will be.
Google renamed Fitbit to Google Health in 2026 and retired the Fitbit Web API
outright, so live sync means the Google Health API — which issues a client secret,
which is why `worker/` exists. The broker handles **tokens only**; health data goes
browser-to-Google directly and never passes through a server.
