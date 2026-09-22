// === DAILY TARGETS AND RECORDS ===
// Two different questions that a period total cannot answer.
//
// A GOAL (js/goals.js) is a total to reach by the end of a period: 100km this month.
// A TARGET here is a standard a single day either meets or does not: seven hours of
// sleep, an hour of training. The interesting number is not the total, it is how
// many days cleared the bar and whether they were consecutive. "Slept 7h on 21 of 30
// days, best run 9 in a row" is a different fact from "slept 186 hours".
//
// They share the `goals` store, keyed with period 'day', because they are the same
// shape of commitment and this way they are backed up and restored with everything
// else. `goalsForPeriod` reads an explicit period, so day targets never leak into it.

const DAY_PERIOD = 'day';

// Which way the bar points. Most metrics are a floor; resting heart rate and weight
// are the two where lower is the achievement, and treating them as floors would
// congratulate the wrong days.
const TARGET_LOWER_IS_BETTER = { resting_hr: true, weight: true };

function targetComparison(metricId) {
  return TARGET_LOWER_IS_BETTER[metricId] ? 'atMost' : 'atLeast';
}

function meetsTarget(value, threshold, comparison) {
  if (value == null || !isFinite(value)) return false;
  return comparison === 'atMost' ? value <= threshold : value >= threshold;
}

// Metrics a daily standard makes sense for. A metric whose daily figure is a total
// you accumulate, or a reading you take, qualifies; there is nothing else.
function targetableMetrics() {
  return metricIds().filter(id => METRICS[id] && METRICS[id].display !== 'none');
}

// How a range of days measured up against one target.
//
// `today` is excluded from breaking a streak for the same reason as in streaks.js:
// the day is not over, and telling someone their run ended while they are still
// lacing their shoes is both wrong and discouraging.
function targetResult(byDay, fromDate, toDate, threshold, comparison, today) {
  const days = dateRange(fromDate, toDate);
  const now = today || todayLocal();
  const cmp = comparison || 'atLeast';

  let met = 0, recorded = 0;
  let longest = 0, longestEnd = null;
  let run = 0, runEnd = null;
  let lastMet = null;

  for (const day of days) {
    const value = byDay ? byDay[day] : null;
    if (value != null && isFinite(value)) recorded++;
    if (meetsTarget(value, threshold, cmp)) {
      met++;
      lastMet = day;
      run++;
      runEnd = day;
      if (run > longest) { longest = run; longestEnd = day; }
    } else if (day !== now) {
      run = 0;
    }
  }

  // A trailing run is only "current" if it reaches the present.
  const current = runEnd && (runEnd >= addDays(now, -1)) ? run : 0;

  return {
    met, recorded, total: days.length,
    pct: days.length ? (met / days.length) * 100 : 0,
    // Out of the days that actually have a reading — the honest denominator when a
    // watch was off for a fortnight. Reported alongside, never instead of.
    pctOfRecorded: recorded ? (met / recorded) * 100 : 0,
    current, longest, longestEnd,
    longestStart: longest && longestEnd ? addDays(longestEnd, -(longest - 1)) : null,
    lastMet
  };
}

// Days on which any workout happened, as a streak. The existing dayStreaks is
// per-metric, which answers "how many days running in a row" — this answers "how
// many days did I train at all", which is the one people actually mean.
//
// Set-aside activities are excluded, so it agrees with every other screen: if
// walking does not count as training, a week of walks is not a streak.
function workoutStreaks(sessions, fromDate, toDate, notWorkouts, today) {
  const byDay = {};
  for (const s of sessions) {
    if (s.supersededBy || !s.durationSec) continue;
    if (isExcluded(s, notWorkouts)) continue;
    if (s.localDate < fromDate || s.localDate > toDate) continue;
    byDay[s.localDate] = (byDay[s.localDate] || 0) + s.durationSec;
  }
  const r = targetResult(byDay, fromDate, toDate, 1, 'atLeast', today);
  return { ...r, trainedDays: r.met };
}

// --- records ------------------------------------------------------------------------
// The best single session of each kind. Distinct from "best day" (js/streaks.js),
// which sums a day: three short runs is a good day, not a long run, and somebody
// asking for their record wants the one effort they actually remember.

const RECORD_KINDS = [
  { id: 'longest',  label: 'Longest',  metric: 'time_gym',
    value: s => s.durationSec, needs: s => s.durationSec > 0 },
  { id: 'furthest', label: 'Furthest', metric: 'distance_run',
    value: s => s.distanceM, needs: s => s.distanceM > 0 },
  { id: 'fastest',  label: 'Fastest',  metric: null,
    // Lower is better, so this one is ranked inverted — see `lowerWins`.
    value: s => sessionPace(s), needs: s => sessionPace(s) != null, lowerWins: true },
  { id: 'hardest',  label: 'Hardest',  metric: null,
    value: s => s.avgHr, needs: s => s.avgHr > 0 }
];

// Best session per activity per kind. Returns one group per activity, so the screen
// can show "Running — longest, furthest, fastest" together rather than a flat list
// sorted by a number that means different things in different rows.
function sessionRecords(sessions, opts) {
  const o = opts || {};
  const groups = new Map();

  for (const s of sessions) {
    if (s.supersededBy) continue;
    if (isExcluded(s, o.exclude)) continue;
    const key = sessionKey(s);
    const named = activityLabel(s.activity, s.rawActivity);
    const g = groups.get(key) || {
      key,
      label: key === 'unlabelled' ? 'Uncategorised' : named,
      icon: key === 'unlabelled' ? 'unlabelled'
            : ((ACTIVITIES[s.activity] || {}).icon || 'other'),
      records: {}
    };

    for (const kind of RECORD_KINDS) {
      if (!kind.needs(s)) continue;
      const v = kind.value(s);
      const held = g.records[kind.id];
      const better = !held || (kind.lowerWins ? v < held.value : v > held.value);
      if (better) g.records[kind.id] = { value: v, session: s, kind };
    }
    groups.set(key, g);
  }

  // An activity with nothing worth calling a record is not a row.
  return [...groups.values()]
    .map(g => ({ ...g, list: RECORD_KINDS.map(k => g.records[k.id]).filter(Boolean) }))
    .filter(g => g.list.length)
    .sort((a, b) => {
      const at = a.records.longest ? a.records.longest.value : 0;
      const bt = b.records.longest ? b.records.longest.value : 0;
      return bt - at;
    });
}

// How a record reads. Pace has its own format; everything else borrows the formatter
// of a metric that shares its unit, so records and totals never disagree on how a
// figure is written.
function formatRecord(rec) {
  if (rec.kind.id === 'fastest') return formatPace(rec.value);
  if (rec.kind.id === 'hardest') return Math.round(rec.value) + ' bpm';
  return formatMetric(rec.kind.metric, rec.value);
}

if (typeof module !== 'undefined') {
  module.exports = {
    DAY_PERIOD, targetComparison, meetsTarget, targetableMetrics,
    targetResult, workoutStreaks, sessionRecords, formatRecord, RECORD_KINDS
  };
}
