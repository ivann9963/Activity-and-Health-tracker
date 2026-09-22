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
  'pickleball': 'racket', 'racquetball': 'racket',
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
  'pickleball': 'racket',
  'hike': 'hiking',
  'rowing machine': 'rowing',
  'elliptical': 'elliptical',
  'interval workout': 'hiit',
  'yoga': 'yoga'
};

// Translate a vendor's activity name into our vocabulary. Always returns a valid key.
function canonicalActivity(vendor, raw) {
  if (!raw) return 'other';
  if (vendor === 'apple') {
    const bare = String(raw).replace(/^HKWorkoutActivityType/, '');
    return APPLE_ACTIVITY_MAP[bare] || 'other';
  }
  const key = String(raw).trim().toLowerCase();
  if (vendor === 'strava') return STRAVA_ACTIVITY_MAP[key] || 'other';
  if (vendor === 'fitbit') return FITBIT_ACTIVITY_MAP[key] || 'other';
  return 'other';
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
                     humaniseRawActivity, activityLabel, activityGroupKey,
                     APPLE_ACTIVITY_MAP, STRAVA_ACTIVITY_MAP, FITBIT_ACTIVITY_MAP };
}
