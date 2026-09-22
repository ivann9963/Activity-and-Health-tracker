// === ACTIVITY TAXONOMY ===
// One canonical vocabulary for "what kind of exercise was this", plus the lookup
// tables that translate each vendor's own naming into it. Keeping the mapping in a
// single file means adding a new source is a data change, not a code change.

const ACTIVITIES = {
  running:    { label: 'Running',       icon: 'running', tracks: 'distance' },
  walking:    { label: 'Walking',       icon: 'walking', tracks: 'distance' },
  cycling:    { label: 'Cycling',       icon: 'cycling', tracks: 'distance' },
  swimming:   { label: 'Swimming',      icon: 'swimming', tracks: 'distance' },
  strength:   { label: 'Gym',           icon: 'strength', tracks: 'duration' },
  racket:     { label: 'Racket sports', icon: 'racket', tracks: 'duration' },
  hiking:     { label: 'Hiking',        icon: 'hiking', tracks: 'distance' },
  rowing:     { label: 'Rowing',        icon: 'rowing', tracks: 'distance' },
  elliptical: { label: 'Elliptical',    icon: 'elliptical', tracks: 'duration' },
  hiit:       { label: 'HIIT',          icon: 'hiit', tracks: 'duration' },
  yoga:       { label: 'Yoga',          icon: 'yoga', tracks: 'duration' },
  other:      { label: 'Other',         icon: 'other', tracks: 'duration' }
};

// Apple's HKWorkoutActivityType values, minus the shared prefix (stripped before
// lookup). Anything unlisted falls through to 'other' but keeps its raw name on the
// record, so an unmapped type shows up in the Inspector rather than vanishing.
const APPLE_ACTIVITY_MAP = {
  Running: 'running', TrackAndField: 'running',
  Walking: 'walking',
  Cycling: 'cycling', Handcycling: 'cycling',
  Swimming: 'swimming', SwimBikeRun: 'other', WaterFitness: 'swimming',
  TraditionalStrengthTraining: 'strength', FunctionalStrengthTraining: 'strength',
  CoreTraining: 'strength', Flexibility: 'strength',
  // All racket sports collapse into one bucket, as requested — a year total of
  // "racket sports" is more meaningful than five sparse separate totals.
  Tennis: 'racket', Squash: 'racket', Badminton: 'racket', TableTennis: 'racket',
  Racquetball: 'racket', Pickleball: 'racket', Padel: 'racket',
  Hiking: 'hiking',
  Rowing: 'rowing',
  Elliptical: 'elliptical',
  HighIntensityIntervalTraining: 'hiit',
  Yoga: 'yoga', MindAndBody: 'yoga', Pilates: 'yoga', Barre: 'yoga',
  // Anything unmapped keeps its own name rather than collapsing into "Other" — see
  // activityLabel below. These are mapped because they belong with something the app
  // already tracks, not merely to avoid the fallback.
  Boxing: 'strength', Kickboxing: 'strength', MartialArts: 'strength',
  Wrestling: 'strength', CrossTraining: 'strength', PlayGround: 'other',
  StairClimbing: 'strength', Stairs: 'strength', StepTraining: 'strength',
  JumpRope: 'hiit', MixedCardio: 'hiit', MixedMetabolicCardioTraining: 'hiit',
  Cooldown: 'other', PreparationAndRecovery: 'other'
};

// A readable name for a session, falling back to its own recorded type when the app
// has no category for it.
//
// Collapsing an unrecognised workout into "Other" hides the one piece of information
// that would explain it: a card reading "Other — 19% of your time" is useless, while
// "Climbing — 19%" is an answer. Apple's own identifier is right there on the record,
// so it is used rather than discarded.
// Names a vendor uses that read badly once they are on screen. "Cardio dance" is what
// Apple calls the type; "Dance" is what the person did.
const RAW_ACTIVITY_NAMES = {
  CardioDance: 'Dance',
  SocialDance: 'Dance',
  DanceInspiredTraining: 'Dance',
  Dance: 'Dance',
  MixedMetabolicCardioTraining: 'Mixed cardio',
  PreparationAndRecovery: 'Warm-up and recovery',
  HighIntensityIntervalTraining: 'HIIT',
  TraditionalStrengthTraining: 'Strength training',
  FunctionalStrengthTraining: 'Functional training',
  WaterFitness: 'Water fitness',
  PlayGround: 'Play',
  SnowSports: 'Snow sports',
  CrossCountrySkiing: 'Cross-country skiing',
  DownhillSkiing: 'Skiing'
};

function humaniseRawActivity(raw) {
  if (!raw) return null;
  const bare = String(raw)
    .replace(/^HKWorkoutActivityType/, '')
    .replace(/^HKWorkoutActivity/, '');
  if (!bare || bare === 'Other') return null;
  if (RAW_ACTIVITY_NAMES[bare]) return RAW_ACTIVITY_NAMES[bare];
  // CamelCase to words: "TraditionalStrengthTraining" -> "Traditional strength training"
  const words = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// What to call a session in the interface. Known categories use their own label;
// anything else uses the name the source gave it.
function activityLabel(activity, rawActivity) {
  if (activity && activity !== 'other') {
    return (ACTIVITIES[activity] || {}).label || activity;
  }
  return humaniseRawActivity(rawActivity) || 'Unlabelled';
}

// Grouping key: known categories group together, unrecognised ones group by their own
// type so two different unmapped sports never merge into one bar.
function activityGroupKey(activity, rawActivity) {
  if (activity && activity !== 'other') return activity;
  const named = humaniseRawActivity(rawActivity);
  return named ? 'raw:' + named : 'other';
}

// Strava's `Activity Type` column in activities.csv is human-readable text.
const STRAVA_ACTIVITY_MAP = {
  'run': 'running', 'trail run': 'running', 'treadmill run': 'running', 'virtual run': 'running',
  'walk': 'walking',
  'ride': 'cycling', 'virtual ride': 'cycling', 'e-bike ride': 'cycling', 'gravel ride': 'cycling',
  'swim': 'swimming',
  'weight training': 'strength', 'workout': 'strength', 'crossfit': 'strength',
  'tennis': 'racket', 'squash': 'racket', 'badminton': 'racket', 'table tennis': 'racket',
  'pickleball': 'racket', 'racquetball': 'racket', 'padel': 'racket', 'padel tennis': 'racket',
  'paddle tennis': 'racket', 'ping pong': 'racket', 'racquetball': 'racket', 'padel': 'racket', 'padel tennis': 'racket',
  'hike': 'hiking',
  'rowing': 'rowing', 'kayaking': 'rowing', 'canoeing': 'rowing',
  'elliptical': 'elliptical',
  'hiit': 'hiit',
  'yoga': 'yoga'
};

// Fitbit's activity names as returned by the Web API's activity log.
const FITBIT_ACTIVITY_MAP = {
  'run': 'running', 'treadmill': 'running', 'jog': 'running',
  'walk': 'walking', 'outdoor walk': 'walking',
  'bike': 'cycling', 'outdoor bike': 'cycling', 'spinning': 'cycling',
  'swim': 'swimming',
  'weights': 'strength', 'workout': 'strength', 'strength training': 'strength',
  'circuit training': 'strength', 'bootcamp': 'strength',
  'tennis': 'racket', 'squash': 'racket', 'badminton': 'racket', 'table tennis': 'racket',
  'pickleball': 'racket', 'racquetball': 'racket', 'padel': 'racket', 'padel tennis': 'racket',
  'paddle tennis': 'racket', 'ping pong': 'racket',
  'hike': 'hiking',
  'rowing machine': 'rowing',
  'elliptical': 'elliptical',
  'interval workout': 'hiit',
  'yoga': 'yoga'
};

// A last resort for names no table lists. Apple's types are a closed vocabulary, but
// Fitbit and Strava let a name be very nearly free text — "Padel", "Padel Tennis",
// "Weight lifting", "Indoor Run" — and a table can only ever list the ones somebody
// has already hit. Missing one is not cosmetic: it sends the workout to 'other',
// which belongs to no metric, so the session is stored and visible yet absent from
// every total. That is how a week of padel came to read as nothing at all.
//
// Ordered, because the first match wins and some words appear inside others: "table
// tennis" must be tested before "tennis", "treadmill" is running rather than walking.
const ACTIVITY_KEYWORDS = [
  [/table tennis|ping.?pong/, 'racket'],
  [/padel|paddle tennis|racquet|racket|tennis|squash|badminton|pickle/, 'racket'],
  [/treadmill|\brun|jog/, 'running'],
  [/swim|pool|open.?water/, 'swimming'],
  [/cycl|bike|biking|spin(ning)?\b/, 'cycling'],
  [/hike|hiking|trek/, 'hiking'],
  [/row(ing)?\b|erg\b/, 'rowing'],
  [/elliptical|cross.?trainer/, 'elliptical'],
  [/yoga|pilates|stretch/, 'yoga'],
  [/hiit|interval|tabata|circuit/, 'hiit'],
  [/weight|strength|lift|gym|resistance|bodyweight|calisthen/, 'strength'],
  [/walk/, 'walking']
];

function activityFromKeywords(name) {
  for (const [re, activity] of ACTIVITY_KEYWORDS) if (re.test(name)) return activity;
  return null;
}

// Translate a vendor's activity name into our vocabulary. Always returns a valid key.
function canonicalActivity(vendor, raw) {
  if (!raw) return 'other';
  if (vendor === 'apple') {
    const bare = String(raw).replace(/^HKWorkoutActivityType/, '');
    // Apple's vocabulary is closed, so an unlisted type is genuinely unknown to us
    // rather than a spelling we failed to anticipate — but the words in it are still
    // the best evidence available, and 'other' is a worse answer than a good guess
    // from the name the vendor chose.
    return APPLE_ACTIVITY_MAP[bare] ||
           activityFromKeywords(bare.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()) ||
           'other';
  }
  const key = String(raw).trim().toLowerCase();
  const table = vendor === 'strava' ? STRAVA_ACTIVITY_MAP
              : vendor === 'fitbit' ? FITBIT_ACTIVITY_MAP : null;
  if (!table) return 'other';
  return table[key] || activityFromKeywords(key) || 'other';
}

// Two sessions can only be duplicates of each other if their activities are
// compatible. They need not be identical: Strava logs a pool swim as 'Swim' while
// Apple may have split it differently, and a gym session is variously 'strength',
// 'hiit' or 'other' depending on which app recorded it.
const COMPATIBLE_ACTIVITIES = [
  ['strength', 'hiit', 'other'],
  ['running', 'walking'],   // short runs are often auto-detected as walks and vice versa
  ['cycling', 'other'],
  ['racket', 'other']
];

function activitiesCompatible(a, b) {
  if (a === b) return true;
  return COMPATIBLE_ACTIVITIES.some(group => group.includes(a) && group.includes(b));
}

if (typeof module !== 'undefined') {
  module.exports = { ACTIVITIES, canonicalActivity, activitiesCompatible,
                     activityFromKeywords,
                     humaniseRawActivity, activityLabel, activityGroupKey,
                     APPLE_ACTIVITY_MAP, STRAVA_ACTIVITY_MAP, FITBIT_ACTIVITY_MAP };
}
