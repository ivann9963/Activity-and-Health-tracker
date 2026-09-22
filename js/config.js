// === APP CONFIGURATION ===
// Constants and defaults. Nothing here touches the DOM or the database, so this file
// loads first and every other module can rely on it.

const APP = {
  name: 'Activity Ledger',
  dbName: 'activity-ledger',
  dbVersion: 1,
  // Replaced by tools/build.js with the commit being deployed. Left as the literal
  // placeholder in a source checkout, which is how the app knows to call itself a
  // development copy — and how you can tell at a glance whether the thing in front of
  // you is the deployed build or the files you just edited.
  build: '__BUILD_ID__'
};

function buildLabel() {
  return APP.build === '__BUILD' + '_ID__' ? 'development copy' : 'build ' + APP.build;
}

// Every source of data we can ingest. `vendor` is the stable key written onto each
// record's source object; the label is what the UI shows.
const VENDORS = {
  apple:  { label: 'Apple Health', short: 'Apple' },
  fitbit: { label: 'Fitbit',       short: 'Fitbit' },
  strava: { label: 'Strava',       short: 'Strava' },
  manual: { label: 'Entered by hand', short: 'Manual' }
};

// Default ranking used to elect a winner when several sources recorded the same thing.
// Higher number wins. These are only DEFAULTS — the ranking is user-editable in
// Settings, and (crucially) it is applied per-day against the sources actually present
// that day, never as a global winner. See js/dedupe/rules.js for why that matters.
const DEFAULT_SOURCE_PRIORITY = {
  'Apple Watch': 100,   // dedicated wrist wearable, most trustworthy while it was worn
  'Fitbit': 90,         // the current wearable
  'Google Health': 85,  // the relay that carries Fitbit data into Apple Health
  'Strava': 80,         // accurate for the workouts it knows, blind to everything else
  'iPhone': 50,         // pocket-carried: undercounts, but better than nothing
  'Manual': 40
};

const DEFAULT_SETTINGS = {
  units: 'metric',          // 'metric' | 'imperial'
  // Metric ids the dashboard should not show. Not everyone does every sport, and a
  // permanently empty tile is worse than no tile — it reads as missing data.
  hiddenMetrics: [],
  // Activities that are recorded but are not training. Walking is the default case:
  // a phone logs the walk to the kitchen, and counting it makes every day look active
  // and swamps every share of time. What belongs here is a judgement — some people
  // walk deliberately and for hours — so it is a setting, not a rule.
  notWorkouts: ['walking'],
  firstDayOfWeek: 'monday', // matches the sibling finance app's default
  theme: 'dark',
  sourcePriority: { ...DEFAULT_SOURCE_PRIORITY },
  dedupe: {
    // Two sessions are candidates for being "the same workout" when they overlap in
    // time by at least this fraction of the SHORTER session. Chosen empirically: a
    // Strava run and its Apple Health twin usually differ by a few seconds of start
    // time, while two genuinely separate workouts in one day rarely touch at all.
    minOverlapRatio: 0.5,
    // Sessions whose start times differ by more than this are never merged, even if
    // one wholly contains the other (a 2h "walk" containing a 20min run is two things).
    maxStartDriftSec: 600
  }
};

// How far back we are willing to look when nothing else bounds a query. The Apple
// archive can reach back a decade; there is no reason to guess a narrower window.
const EARLIEST_PLAUSIBLE_YEAR = 2008; // first iPhone fitness apps; anything older is a parse bug
