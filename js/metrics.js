// === METRIC REGISTRY ===
// Every number the app can show is declared here once. Views, goals, rollups and the
// year review all read this table rather than hard-coding metric names, so adding a
// metric is a single entry plus whatever parsing feeds it.
//
// Two aggregations, because they genuinely differ:
//   dayAgg    — how several records on the SAME day combine into one daily figure
//   periodAgg — how daily figures combine across a week / month / year
// Steps sum both ways; sleep sums within a day (naps) but AVERAGES across a week,
// because "42 hours of sleep this week" is a useless number and "6h 01m a night" is not.

const METRICS = {
  steps: {
    label: 'Steps', icon: '👟', kind: 'total', from: 'daily',
    unit: 'steps', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_run: {
    label: 'Running', icon: '🏃', kind: 'total', from: 'sessions',
    activity: 'running', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_swim: {
    label: 'Swimming', icon: '🏊', kind: 'total', from: 'sessions',
    activity: 'swimming', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_cycle: {
    label: 'Cycling', icon: '🚴', kind: 'total', from: 'sessions',
    activity: 'cycling', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  time_gym: {
    label: 'Gym', icon: '🏋️', kind: 'total', from: 'sessions',
    activity: 'strength', field: 'durationSec',
    unit: 's', display: 'duration', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  time_racket: {
    label: 'Racket sports', icon: '🎾', kind: 'total', from: 'sessions',
    activity: 'racket', field: 'durationSec',
    unit: 's', display: 'duration', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  weight: {
    label: 'Weight', icon: '⚖️', kind: 'trend', from: 'daily',
    // 'last' within a day: weighing yourself twice does not mean you weigh the average,
    // it means the later reading supersedes the earlier one.
    unit: 'kg', dayAgg: 'last', periodAgg: 'avg', goalable: false, decimals: 1
  },
  resting_hr: {
    label: 'Resting heart rate', icon: '❤️', kind: 'trend', from: 'daily',
    unit: 'bpm', dayAgg: 'avg', periodAgg: 'avg', goalable: false,
    lowerIsBetter: true
  },
  sleep: {
    label: 'Sleep', icon: '😴', kind: 'trend', from: 'daily',
    unit: 'min', display: 'duration', dayAgg: 'sum', periodAgg: 'avg', goalable: false
  }
};

// The order metrics appear in the dashboard and year review.
const METRIC_ORDER = ['distance_run', 'time_gym', 'distance_swim', 'steps',
                      'time_racket', 'distance_cycle', 'sleep', 'weight', 'resting_hr'];

function metricIds() { return METRIC_ORDER.filter(id => METRICS[id]); }

// The metrics the dashboard should actually render, in display order.
function visibleMetricIds(settings) {
  const hidden = new Set((settings && settings.hiddenMetrics) || []);
  return metricIds().filter(id => !hidden.has(id));
}

// Combine a list of numbers according to an aggregation name. Returns null for an
// empty list rather than 0, so "no data" and "genuinely zero" stay distinguishable —
// a day with no weight reading must not plot as 0 kg.
function aggregate(values, how) {
  const nums = values.filter(v => typeof v === 'number' && isFinite(v));
  if (!nums.length) return null;
  if (how === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (how === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (how === 'last') return nums[nums.length - 1];
  if (how === 'max') return Math.max(...nums);
  if (how === 'min') return Math.min(...nums);
  throw new Error('unknown aggregation: ' + how);
}

// Render a raw stored value (metres, seconds, steps…) as display text.
function formatMetric(metricId, value, opts) {
  const m = METRICS[metricId];
  if (value == null || !m) return '—';
  const o = opts || {};
  if (m.display === 'km') {
    const km = value / 1000;
    return km >= 100 ? Math.round(km) + ' km'
         : km.toFixed(km >= 10 ? 1 : 2) + ' km';
  }
  if (m.display === 'duration') {
    // Stored in seconds for sessions, minutes for sleep. Normalise first.
    const totalMin = m.unit === 'min' ? value : value / 60;
    const h = Math.floor(totalMin / 60);
    const min = Math.round(totalMin % 60);
    if (o.compact && h > 0) return h + 'h';
    return h > 0 ? `${h}h ${String(min).padStart(2, '0')}m` : `${min}m`;
  }
  if (m.decimals != null) return value.toFixed(m.decimals) + ' ' + m.unit;
  return Math.round(value).toLocaleString() + (m.unit === 'steps' ? '' : ' ' + m.unit);
}

if (typeof module !== 'undefined') {
  module.exports = { METRICS, METRIC_ORDER, metricIds, visibleMetricIds,
                     aggregate, formatMetric };
}
