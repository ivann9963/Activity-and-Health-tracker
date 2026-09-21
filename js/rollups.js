// === ROLLUPS ===
// Turns stored records into the numbers the views show. Every query here filters out
// anything the dedupe engine suppressed, so a total can never include two devices'
// versions of the same day or the same run.
//
// Sessions and daily points are read through one interface because the views should
// not care that running distance comes from workouts while steps come from daily
// aggregates — that distinction belongs in the metric registry, not in the UI.

const isCounted = r => !r.supersededBy;

// The pure core: given the records for a range, produce every metric's numbers in a
// single pass. Kept free of the database so it can be tested directly, and so the
// dashboard reads each store ONCE instead of once per metric — with seven years of
// history that is the difference between one scan and eighteen.
function computeRollups(sessions, daily, fromDate, toDate, ids) {
  const wanted = ids && ids.length ? ids : metricIds();
  const byMetric = {};
  for (const id of wanted) byMetric[id] = {};

  // Sessions feed the distance/duration metrics, matched on activity.
  const sessionMetrics = wanted.filter(id => METRICS[id].from === 'sessions');
  const byActivity = {};
  for (const id of sessionMetrics) byActivity[METRICS[id].activity] = id;

  for (const s of sessions) {
    if (!isCounted(s) || s.localDate < fromDate || s.localDate > toDate) continue;
    const id = byActivity[s.activity];
    if (!id) continue;
    const v = s[METRICS[id].field];
    if (v == null) continue;
    byMetric[id][s.localDate] = (byMetric[id][s.localDate] || 0) + v;
  }

  // Daily points are already one-per-day-per-metric after the source election.
  const dailyWanted = new Set(wanted.filter(id => METRICS[id].from === 'daily'));
  for (const r of daily) {
    if (!isCounted(r) || !dailyWanted.has(r.metric)) continue;
    if (r.localDate < fromDate || r.localDate > toDate) continue;
    byMetric[r.metric][r.localDate] = r.value;
  }

  const out = {};
  for (const id of wanted) {
    const byDay = byMetric[id];
    const values = Object.values(byDay);
    out[id] = {
      value: aggregate(values, METRICS[id].periodAgg),
      activeDays: values.filter(v => v > 0).length,
      byDay
    };
  }
  return out;
}

// Everything the period view needs, for the metrics it is actually showing.
function rollupAllMetrics(fromDate, toDate, ids) {
  return Promise.all([
    dbRange('sessions', 'byDate', fromDate, toDate),
    dbRange('daily', 'byDate', fromDate, toDate)
  ]).then(([sessions, daily]) => computeRollups(sessions, daily, fromDate, toDate, ids));
}

// One metric on its own — used by the metric detail view, where reading both stores
// for a single number would be wasteful.
function rollupDaily(metricId, fromDate, toDate) {
  const metric = METRICS[metricId];
  if (!metric) return Promise.resolve({});

  if (metric.from === 'sessions') {
    return dbRange('sessions', 'byDate', fromDate, toDate).then(rows => {
      const out = {};
      for (const s of rows) {
        if (!isCounted(s) || s.activity !== metric.activity) continue;
        const v = s[metric.field];
        if (v == null) continue;
        out[s.localDate] = (out[s.localDate] || 0) + v;
      }
      return out;
    });
  }

  return dbRange('daily', 'byMetricDate', [metricId, fromDate], [metricId, toDate])
    .then(rows => {
      const out = {};
      for (const r of rows) {
        if (!isCounted(r) || r.metric !== metricId) continue;
        out[r.localDate] = r.value;
      }
      return out;
    });
}

function rollupPeriod(metricId, fromDate, toDate) {
  const metric = METRICS[metricId];
  if (!metric) return Promise.resolve(null);
  return rollupDaily(metricId, fromDate, toDate).then(byDay => {
    const values = Object.values(byDay);
    return { value: aggregate(values, metric.periodAgg),
             activeDays: values.filter(v => v > 0).length, byDay };
  });
}

// The span of dates the database actually holds, so views can refuse to page back
// past the beginning of the data.
function dataBounds() {
  return dbGetAll('imports').then(imports => {
    let from = null, to = null;
    for (const b of imports) {
      if (b.range && b.range.from && (!from || b.range.from < from)) from = b.range.from;
      if (b.range && b.range.to && (!to || b.range.to > to)) to = b.range.to;
    }
    return { from, to };
  });
}

// Which metrics have ever recorded anything, so Settings can point out the ones that
// are only taking up space.
function metricsWithData() {
  return Promise.all([dbGetAll('sessions'), dbGetAll('daily')]).then(([sessions, daily]) => {
    const present = new Set();
    for (const s of sessions) {
      if (!isCounted(s)) continue;
      for (const id of metricIds()) {
        const m = METRICS[id];
        if (m.from === 'sessions' && m.activity === s.activity && s[m.field] != null) present.add(id);
      }
    }
    for (const r of daily) if (isCounted(r) && r.value != null) present.add(r.metric);
    return present;
  });
}

if (typeof module !== 'undefined') {
  module.exports = { computeRollups, rollupDaily, rollupPeriod };
}
