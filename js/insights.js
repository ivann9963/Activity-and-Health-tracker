// === INSIGHTS ===
// Questions that cut across metrics rather than following one: where the time
// actually goes, how hard each sport is, whether the running is getting faster, and
// how many days were genuinely active.
//
// All pure functions over session records, so they are tested directly and the views
// stay free of arithmetic.

const counted = s => !s.supersededBy;

// --- where the time goes ------------------------------------------------------------
// The answer to "what did I actually spend the year doing". Share of time, not share
// of sessions: twelve short runs and twelve long gym sessions are not the same year.
function timeByActivity(sessions, opts) {
  const o = opts || {};
  const totals = new Map();
  let grand = 0;

  for (const s of sessions) {
    if (!counted(s)) continue;
    const seconds = s.durationSec || 0;
    if (seconds <= 0) continue;
    // Walking is usually ambient rather than chosen, and counting it swamps
    // everything else. Callers decide; the year review leaves it out.
    if (o.excludeWalking && s.activity === 'walking') continue;

    // Unrecognised workouts group by their own type rather than pooling into one
    // "Other" bar, which would hide the only thing that explains them.
    const key = activityGroupKey(s.activity, s.rawActivity);
    const entry = totals.get(key) ||
      { seconds: 0, activity: s.activity, label: activityLabel(s.activity, s.rawActivity) };
    entry.seconds += seconds;
    totals.set(key, entry);
    grand += seconds;
  }

  return [...totals.entries()]
    .map(([key, entry]) => ({
      activity: entry.activity,
      key,
      label: entry.label,
      icon: (ACTIVITIES[entry.activity] || {}).icon || '💪',
      seconds: entry.seconds,
      pct: grand > 0 ? (entry.seconds / grand) * 100 : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

// --- effort per sport ----------------------------------------------------------------
// Weighted by duration, not a mean of means: a 10-minute warm-up and a two-hour ride
// should not count equally toward an average heart rate.
function avgHrByActivity(sessions) {
  const acc = new Map();

  for (const s of sessions) {
    if (!counted(s) || !s.avgHr || !s.durationSec) continue;
    const key = activityGroupKey(s.activity, s.rawActivity);
    const a = acc.get(key) ||
      { weighted: 0, seconds: 0, count: 0, max: 0,
        label: activityLabel(s.activity, s.rawActivity) };
    a.weighted += s.avgHr * s.durationSec;
    a.seconds += s.durationSec;
    a.count++;
    a.max = Math.max(a.max, s.avgHr);
    acc.set(key, a);
  }

  return [...acc.entries()]
    .map(([activity, a]) => ({
      activity,
      label: a.label,
      icon: (ACTIVITIES[activity] || {}).icon || '💪',
      avgHr: Math.round(a.weighted / a.seconds),
      highestSessionAvg: a.max,
      sessions: a.count,
      seconds: a.seconds
    }))
    .sort((a, b) => b.avgHr - a.avgHr);
}

// --- running pace ---------------------------------------------------------------------
// Pace is seconds per kilometre. Lower is faster, which every comparison here has to
// respect — the usual "up is good" reading is exactly backwards.
const MIN_PLAUSIBLE_PACE = 120;   // 2:00/km — faster than a world record, so a data error
const MAX_PLAUSIBLE_PACE = 1200;  // 20:00/km — slower than walking, so not a run

function sessionPace(session) {
  if (!session.distanceM || !session.durationSec) return null;
  const km = session.distanceM / 1000;
  if (km < 0.5) return null; // too short for pace to mean anything
  const pace = session.durationSec / km;
  if (pace < MIN_PLAUSIBLE_PACE || pace > MAX_PLAUSIBLE_PACE) return null;
  return pace;
}

function formatPace(secPerKm) {
  if (secPerKm == null || !isFinite(secPerKm)) return '—';
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} /km`;
}

// Month by month, weighted by distance: a month's pace is its total time over its
// total distance, so one short sprint does not outweigh a long steady run.
function paceProgression(sessions, activity) {
  const months = new Map();
  const kind = activity || 'running';

  for (const s of sessions) {
    if (!counted(s) || s.activity !== kind) continue;
    if (sessionPace(s) == null) continue;
    const key = s.localDate.slice(0, 7);
    const m = months.get(key) || { seconds: 0, metres: 0, runs: 0, best: null };
    m.seconds += s.durationSec;
    m.metres += s.distanceM;
    m.runs++;
    const pace = sessionPace(s);
    if (m.best == null || pace < m.best) m.best = pace;
    months.set(key, m);
  }

  return [...months.entries()].sort()
    .map(([month, m]) => ({
      month,
      pace: m.seconds / (m.metres / 1000),
      best: m.best,
      runs: m.runs,
      km: m.metres / 1000
    }));
}

// The fastest single efforts, which is what anyone actually wants to see next to a
// trend line.
function bestPaces(sessions, activity, limit) {
  return sessions
    .filter(s => counted(s) && s.activity === (activity || 'running') && sessionPace(s) != null)
    .map(s => ({ date: s.localDate, pace: sessionPace(s), distanceM: s.distanceM,
                 durationSec: s.durationSec }))
    .sort((a, b) => a.pace - b.pace)
    .slice(0, limit || 5);
}

// --- active days ------------------------------------------------------------------------
// "Active" means a deliberate activity, which is why walking does not qualify: a day
// spent entirely at a desk still records a walk to the kitchen, and counting it would
// make every day look active and the measure worthless.
const AMBIENT_ACTIVITIES = new Set(['walking']);

function activeDays(sessions, fromDate, toDate) {
  const active = new Set();
  const ambientOnly = new Set();

  for (const s of sessions) {
    if (!counted(s)) continue;
    if (s.localDate < fromDate || s.localDate > toDate) continue;
    if (AMBIENT_ACTIVITIES.has(s.activity)) ambientOnly.add(s.localDate);
    else active.add(s.localDate);
  }
  for (const day of active) ambientOnly.delete(day);

  const total = dateRange(fromDate, toDate).length;
  return {
    active: active.size,
    walkingOnly: ambientOnly.size,
    inactive: total - active.size - ambientOnly.size,
    total,
    pct: total > 0 ? (active.size / total) * 100 : 0,
    dates: active
  };
}

if (typeof module !== 'undefined') {
  module.exports = { timeByActivity, avgHrByActivity, sessionPace, formatPace,
                     paceProgression, bestPaces, activeDays };
}
