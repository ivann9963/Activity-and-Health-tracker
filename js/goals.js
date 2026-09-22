// === GOALS AND PACE ===
// Targets are derived from what you actually did, not asked for on a blank form.
// Nobody knows what a reasonable yearly running target is until they see that last
// year was 447 km — and once they have seen it, the answer is obvious.
//
// A goal is stored per (metric, period). Derived goals are recalculated as the
// history grows; a goal the user edited is never overwritten.

// Round a derived target to a number a person would actually choose. 512 km is a
// measurement; 500 km is a goal.
function niceTarget(value, metricId) {
  const metric = METRICS[metricId];
  if (!value || !isFinite(value) || value <= 0) return null;

  if (metric.display === 'km') {
    const km = value / 1000;
    const step = km >= 500 ? 50 : km >= 100 ? 25 : km >= 20 ? 5 : 1;
    return Math.round(km / step) * step * 1000;
  }
  if (metric.display === 'duration') {
    // Stored in seconds; round to whole hours, or to 15 minutes for small targets.
    const hours = value / 3600;
    if (hours >= 20) return Math.round(hours / 5) * 5 * 3600;
    if (hours >= 2) return Math.round(hours) * 3600;
    return Math.round(value / 900) * 900;
  }
  if (metricId === 'steps') {
    const step = value >= 2000000 ? 250000 : value >= 200000 ? 25000 : 1000;
    return Math.round(value / step) * step;
  }
  return Math.round(value);
}

// How much more than last time to ask for. Enough to be a stretch, not so much that
// the bar is unreachable and the whole thing gets ignored by February.
const STRETCH = 1.08;

// Propose a target from the trailing history. Uses a trailing window rather than the
// last calendar year, because in January the last calendar year is a stale memory and
// a part-finished one is not comparable to anything.
function deriveTarget(metricId, byDay, fromDate, toDate, period) {
  const metric = METRICS[metricId];
  if (!metric || !metric.goalable) return null;

  const days = dateRange(fromDate, toDate);
  if (days.length < 28) return null; // too little history to extrapolate from honestly

  let total = 0;
  for (const day of days) {
    const v = byDay[day];
    if (v != null && isFinite(v)) total += v;
  }
  if (total <= 0) return null;

  const perDay = total / days.length;
  const lengths = { week: 7, month: 30.44, year: 365.25 };
  return niceTarget(perDay * lengths[period] * STRETCH, metricId);
}

// Where you are against a target, and — more usefully — whether you are ahead of the
// pace needed to get there.
//
// `elapsed` is the fraction of the period gone. A year 40% through with 40% of the
// target done is exactly on pace, which is a far more useful thing to know in March
// than "40% complete".
function goalProgress(target, current, bounds, today) {
  if (!target || target <= 0) return null;
  const value = current || 0;
  const now = today || todayLocal();

  const totalDays = daysBetween(bounds.from, bounds.to) + 1;
  // Days elapsed counts today as done, so a one-day period is never 0% through.
  const elapsedDays = Math.min(totalDays, Math.max(0, daysBetween(bounds.from, now) + 1));
  const elapsed = totalDays > 0 ? elapsedDays / totalDays : 1;
  const finished = now > bounds.to;

  const expected = target * (finished ? 1 : elapsed);
  const ahead = value - expected;
  const remaining = Math.max(0, target - value);
  const daysLeft = Math.max(0, totalDays - elapsedDays);

  return {
    target,
    value,
    pct: Math.min(100, (value / target) * 100),
    hit: value >= target,
    elapsed,
    finished,
    expected,
    ahead,                                   // positive = ahead of pace
    remaining,
    daysLeft,
    // What it takes from here, which is the number that changes behaviour.
    perDayNeeded: daysLeft > 0 ? remaining / daysLeft : remaining
  };
}

// --- storage -----------------------------------------------------------------------
// One row per (metric, period). `source` records whether the number was proposed or
// chosen, so a proposal can be refreshed as history grows while a manual target is
// left alone.

function goalId(metricId, period) { return metricId + '|' + period; }

function loadGoals() {
  return dbGetAll('goals').then(rows => {
    const map = {};
    for (const g of rows) map[g.id] = g;
    return map;
  });
}

function setGoal(metricId, period, target, source) {
  return dbPut('goals', {
    id: goalId(metricId, period),
    metricId, period, target,
    source: source || 'manual',
    setAt: Date.now()
  });
}

// A daily target: the same record shape, with the comparison direction recorded so
// a stored target keeps its meaning even if the default for that metric ever changes.
function setDayTarget(metricId, threshold) {
  return dbPut('goals', {
    id: goalId(metricId, DAY_PERIOD),
    metricId, period: DAY_PERIOD, target: threshold,
    comparison: targetComparison(metricId),
    source: 'manual',
    setAt: Date.now()
  });
}

function clearGoal(metricId, period) {
  return dbDelete('goals', goalId(metricId, period));
}

// Targets for every goalable metric in a period: whatever is stored, and a proposal
// for anything without one. Proposals are not saved until accepted, so the app never
// silently invents commitments on someone's behalf.
function goalsForPeriod(period, bounds, historyFrom, historyTo) {
  return Promise.all([
    loadGoals(),
    rollupAllMetrics(historyFrom, historyTo, metricIds().filter(id => METRICS[id].goalable))
  ]).then(([stored, history]) => {
    const out = {};
    for (const id of metricIds()) {
      if (!METRICS[id].goalable) continue;
      const saved = stored[goalId(id, period)];
      const suggested = deriveTarget(id, history[id] ? history[id].byDay : {},
                                     historyFrom, historyTo, period);
      out[id] = {
        target: saved ? saved.target : null,
        suggested,
        source: saved ? saved.source : null
      };
    }
    return out;
  });
}

if (typeof module !== 'undefined') {
  module.exports = { niceTarget, deriveTarget, goalProgress, goalId, STRETCH };
}
