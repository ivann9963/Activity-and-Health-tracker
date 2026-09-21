// === ROLLUPS ===
// Turns stored records into the numbers the views show. Every query here filters out
// anything the dedupe engine suppressed, so a total can never include two devices'
// versions of the same day or the same run.
//
// Sessions and daily points are read through the same interface because the views
// should not care that running distance comes from workouts while steps come from
// daily aggregates — that distinction belongs in the metric registry, not in the UI.

const isCounted = r => !r.supersededBy;

// A date -> value map for one metric across a range.
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
        // After the election there is at most one surviving source per day, so this
        // is an assignment rather than an aggregation.
        out[r.localDate] = r.value;
      }
      return out;
    });
}

// One number for a whole period, using the metric's own period aggregation: totals
// sum, trends average.
function rollupPeriod(metricId, fromDate, toDate) {
  const metric = METRICS[metricId];
  if (!metric) return Promise.resolve(null);
  return rollupDaily(metricId, fromDate, toDate).then(byDay => {
    const values = Object.values(byDay);
    return {
      value: aggregate(values, metric.periodAgg),
      activeDays: values.filter(v => v > 0).length,
      byDay
    };
  });
}

// Everything the period view needs, for every metric, in one pass.
function rollupAllMetrics(fromDate, toDate) {
  return Promise.all(metricIds().map(id =>
    rollupPeriod(id, fromDate, toDate).then(r => [id, r])
  )).then(Object.fromEntries);
}

// The span of dates the database actually holds, so views can refuse to page back
// past the beginning of the data.
function dataBounds() {
  return Promise.all([dbGetAll('imports')]).then(([imports]) => {
    let from = null, to = null;
    for (const b of imports) {
      if (b.range && b.range.from && (!from || b.range.from < from)) from = b.range.from;
      if (b.range && b.range.to && (!to || b.range.to > to)) to = b.range.to;
    }
    return { from, to };
  });
}

if (typeof module !== 'undefined') {
  module.exports = { rollupDaily, rollupPeriod, rollupAllMetrics };
}
