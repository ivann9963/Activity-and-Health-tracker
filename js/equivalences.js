// === SCALE COMPARISONS ===
// A number like 447 km is accurate and means nothing. "The length of Bulgaria, twice"
// is the same number with a size attached to it.
//
// The rule here is that comparisons must be true and checkable — real distances, real
// durations — and stated plainly. No praise, no exclamation marks: the scale is the
// point, and inflating it with encouragement would undercut it.

// Distances in metres, smallest first. `unit` reads naturally after a multiplier
// ("3 marathons"), `whole` reads naturally on its own ("the length of Bulgaria").
const DISTANCE_MARKS = [
  { m: 400,       unit: 'laps of a running track' },
  { m: 5000,      unit: '5K races' },
  { m: 21097.5,   unit: 'half marathons' },
  { m: 33800,     unit: 'crossings of the English Channel', whole: 'the English Channel' },
  { m: 42195,     unit: 'marathons' },
  { m: 330000,    unit: 'lengths of Bulgaria', whole: 'the length of Bulgaria' },
  { m: 440000,    unit: 'trips from Sofia to Varna', whole: 'the distance from Sofia to Varna' },
  { m: 1407000,   unit: 'lengths of Great Britain', whole: 'the length of Great Britain' },
  { m: 2850000,   unit: 'lengths of the Danube', whole: 'the Danube, end to end' },
  { m: 4345000,   unit: 'crossings of the United States', whole: 'a crossing of the United States' },
  { m: 40075000,  unit: 'laps of the Earth', whole: 'a lap of the Earth' },
  { m: 384400000, unit: 'trips to the Moon', whole: 'the distance to the Moon' }
];

// Swimming needs its own scale: a pool length is the unit anyone who swims thinks in.
const SWIM_MARKS = [
  { m: 25,     unit: 'lengths of a 25m pool' },
  { m: 50,     unit: 'lengths of an Olympic pool' },
  { m: 1500,   unit: 'Olympic 1500m races' },
  { m: 3862,   unit: 'Ironman swims' },
  { m: 33800,  unit: 'crossings of the English Channel', whole: 'the English Channel' }
];

// How far past a mark a value has to be before the multiplier says anything useful.
const MIN_MULTIPLE = 1.15;

// Pick the largest mark the value meaningfully clears, so the multiplier stays small
// and legible: "2.4 marathons", not "106 laps of a track".
function pickMark(value, marks) {
  const fits = marks.filter(m => value >= m.m);
  if (!fits.length) return null;
  const largest = fits[fits.length - 1];
  // Barely past the largest mark: name it outright if it has a name, otherwise drop
  // to the one below rather than report a multiple of one.
  if (value / largest.m < MIN_MULTIPLE && !largest.whole && fits.length > 1) {
    return fits[fits.length - 2];
  }
  return largest;
}

function formatMultiple(n) {
  if (n >= 10) return Math.round(n).toLocaleString();
  return n.toFixed(1).replace(/\.0$/, '');
}

// A single sentence fragment, or null when the value is too small to compare usefully.
// Callers render it as-is; nothing here assumes a particular sentence around it.
function distanceEquivalence(metres, kind) {
  const marks = kind === 'swimming' ? SWIM_MARKS : DISTANCE_MARKS;
  const mark = pickMark(metres, marks);
  if (!mark) return null;
  const times = metres / mark.m;
  // Close enough to exactly one: name the thing rather than say "1.0 of it".
  if (mark.whole && times < MIN_MULTIPLE) return mark.whole;
  return `${formatMultiple(times)} ${mark.unit}`;
}

// Time spent, for the metrics measured in hours rather than kilometres.
function durationEquivalence(seconds) {
  const hours = seconds / 3600;
  if (hours < 24) return null;
  const days = hours / 24;
  if (days < 7) return `${formatMultiple(days)} full days`;
  const weeks = hours / 40; // a working week, which is the comparison people feel
  if (weeks < 52) return `${formatMultiple(weeks)} working weeks`;
  return `${formatMultiple(hours / 2080)} working years`;
}

// Steps convert to a distance first: the count itself is too abstract to compare, but
// the ground it covers is not. 0.75m is a common adult stride.
const STRIDE_M = 0.75;

function stepsEquivalence(steps) {
  return distanceEquivalence(steps * STRIDE_M);
}

// The right comparison for a metric, or null when there is not a useful one.
function equivalenceFor(metricId, value) {
  if (value == null || !isFinite(value) || value <= 0) return null;
  const metric = METRICS[metricId];
  if (!metric) return null;
  if (metricId === 'steps') return stepsEquivalence(value);
  if (metric.display === 'km') {
    return distanceEquivalence(value, metric.activity === 'swimming' ? 'swimming' : null);
  }
  if (metric.display === 'duration' && metric.unit === 's') return durationEquivalence(value);
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { distanceEquivalence, durationEquivalence, stepsEquivalence,
                     equivalenceFor, DISTANCE_MARKS, SWIM_MARKS };
}
