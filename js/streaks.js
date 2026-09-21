// === STREAKS AND CONSISTENCY ===
// Consistency is the thing that actually compounds, and it is invisible in a total:
// 447 km could be one heroic month or a steady year. These functions read a day-keyed
// map of values and describe the shape of the effort behind it.
//
// No judgement is attached here — a streak is a fact about the data, and the UI
// presents it as one.

// A day counts as active when the metric recorded anything above the threshold.
// The default of zero means "did something at all", which is the honest reading for
// distance and duration; steps take a real threshold, since a phone in a pocket
// registers a few hundred steps on a day spent entirely on the sofa.
const ACTIVE_THRESHOLDS = { steps: 1000 };

function activeThreshold(metricId) {
  return ACTIVE_THRESHOLDS[metricId] != null ? ACTIVE_THRESHOLDS[metricId] : 0;
}

// Longest and current run of consecutive active days within a range.
//
// `today` matters: a streak is still "current" if it ran up to yesterday, because
// today is not over yet. Ending it at midnight would tell someone their 40-day streak
// was broken while they were still lacing their shoes.
function dayStreaks(byDay, fromDate, toDate, metricId, today) {
  const threshold = activeThreshold(metricId);
  const days = dateRange(fromDate, toDate);
  const now = today || todayLocal();

  let longest = 0, longestEnd = null;
  let run = 0, runEnd = null;
  let current = 0;

  for (const day of days) {
    const value = byDay[day];
    if (value != null && value > threshold) {
      run++;
      runEnd = day;
      if (run > longest) { longest = run; longestEnd = day; }
    } else {
      // A gap ends the run — unless the gap is today, which has not finished.
      if (day !== now) run = 0;
    }
  }

  // The trailing run only counts as current if it actually reaches the present.
  if (runEnd && (runEnd === now || runEnd === addDays(now, -1) || runEnd >= now)) {
    current = run;
  }

  return {
    current,
    longest,
    longestEnd,
    longestStart: longest && longestEnd ? addDays(longestEnd, -(longest - 1)) : null,
    activeDays: days.filter(d => byDay[d] != null && byDay[d] > threshold).length,
    totalDays: days.length
  };
}

// Weeks in which the metric saw any activity at all. For anything you do two or three
// times a week, a day streak is always 1 and tells you nothing; a week streak is the
// measure that matches the behaviour.
function weekStreaks(byDay, fromDate, toDate, metricId, firstDayOfWeek, today) {
  const threshold = activeThreshold(metricId);
  const active = new Set();
  for (const [day, value] of Object.entries(byDay)) {
    if (value != null && value > threshold) active.add(startOfWeek(day, firstDayOfWeek));
  }
  if (!active.size) return { current: 0, longest: 0, activeWeeks: 0, totalWeeks: 0 };

  const now = today || todayLocal();
  const firstWeek = startOfWeek(fromDate, firstDayOfWeek);
  const lastWeek = startOfWeek(toDate, firstDayOfWeek);
  const thisWeek = startOfWeek(now, firstDayOfWeek);

  const weeks = [];
  for (let w = firstWeek; w <= lastWeek; w = addDays(w, 7)) weeks.push(w);

  let longest = 0, run = 0, current = 0;
  for (const week of weeks) {
    if (active.has(week)) {
      run++;
      longest = Math.max(longest, run);
      // Running up to and including the current week, or the one just gone.
      if (week === thisWeek || week === addDays(thisWeek, -7)) current = run;
    } else if (week !== thisWeek) {
      // The week in progress cannot break a streak; there is still time in it.
      run = 0;
      if (week < thisWeek) current = 0;
    }
  }

  return { current, longest, activeWeeks: active.size, totalWeeks: weeks.length };
}

// The single best day in a range, which is often the memory behind a total.
function bestDay(byDay) {
  let best = null;
  for (const [day, value] of Object.entries(byDay)) {
    if (value == null) continue;
    if (!best || value > best.value) best = { date: day, value };
  }
  return best;
}

// The best calendar month, and the best week, for the year review.
function bestPeriod(byDay, period, firstDayOfWeek) {
  const buckets = {};
  for (const [day, value] of Object.entries(byDay)) {
    if (value == null) continue;
    const key = period === 'month' ? day.slice(0, 7) : startOfWeek(day, firstDayOfWeek);
    buckets[key] = (buckets[key] || 0) + value;
  }
  let best = null;
  for (const [key, value] of Object.entries(buckets)) {
    if (!best || value > best.value) best = { key, value };
  }
  return best;
}

if (typeof module !== 'undefined') {
  module.exports = { dayStreaks, weekStreaks, bestDay, bestPeriod, activeThreshold };
}
