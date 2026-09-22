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
    label: 'Steps', icon: 'steps', kind: 'total', from: 'daily',
    unit: 'steps', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_run: {
    label: 'Running', icon: 'running', kind: 'total', from: 'sessions',
    activity: 'running', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_swim: {
    label: 'Swimming', icon: 'swimming', kind: 'total', from: 'sessions',
    activity: 'swimming', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  distance_cycle: {
    label: 'Cycling', icon: 'cycling', kind: 'total', from: 'sessions',
    activity: 'cycling', field: 'distanceM',
    unit: 'm', display: 'km', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  time_gym: {
    label: 'Gym', icon: 'strength', kind: 'total', from: 'sessions',
    activity: 'strength', field: 'durationSec',
    unit: 's', display: 'duration', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  time_racket: {
    label: 'Racket sports', icon: 'racket', kind: 'total', from: 'sessions',
    activity: 'racket', field: 'durationSec',
    unit: 's', display: 'duration', dayAgg: 'sum', periodAgg: 'sum', goalable: true
  },
  weight: {
    label: 'Weight', icon: 'weight', kind: 'trend', from: 'daily',
    // 'last' within a day: weighing yourself twice does not mean you weigh the average,
    // it means the later reading supersedes the earlier one.
    unit: 'kg', dayAgg: 'last', periodAgg: 'avg', goalable: false, decimals: 1
  },
  resting_hr: {
    label: 'Resting heart rate', icon: 'heart', kind: 'trend', from: 'daily',
    unit: 'bpm', dayAgg: 'avg', periodAgg: 'avg', goalable: false,
    lowerIsBetter: true
  },
  sleep: {
    label: 'Sleep', icon: 'sleep', kind: 'trend', from: 'daily',
    unit: 'min', display: 'duration', dayAgg: 'sum', periodAgg: 'avg', goalable: false
  }
};

// Heart-rate bands.
//
// Bands are exclusive rather than cumulative, so "time above 140" is the sum of every
// band from 140 up. Storing "over 120", "over 140" and so on directly would overlap,
// and overlapping figures cannot be added.
//
// Time in each band is stored on the SESSION it was recorded during, not against the
// day — a day holding a run and a gym session contains two different efforts, and
// only the session knows which is which. That is also what lets an activity set aside
// take its heart rate with it, and what stops two sources' copies of one workout from
// being resolved by a per-day election that was designed for step counts.
const HR_BANDS = [0, 100, 120, 140, 160, 180];

function hrBandFor(bpm) {
  let band = HR_BANDS[0];
  for (const floor of HR_BANDS) if (bpm >= floor) band = floor;
  return band;
}

function hrBandLabel(floor) {
  const i = HR_BANDS.indexOf(floor);
  const next = HR_BANDS[i + 1];
  return next ? `${floor}–${next - 1} bpm` : `${floor}+ bpm`;
}

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

// Axis ticks and other cramped places. Full formatting gives "0.00 km" for zero and
// "20,000" where there is room for four characters, so ticks get their own rendering:
// short, no trailing zeros, and a bare "0" for nothing.
function formatMetricAxis(metricId, value) {
  const m = METRICS[metricId];
  if (value == null || !m) return '';
  if (value === 0) return '0';

  if (m.display === 'km') {
    const km = value / 1000;
    return (km >= 10 ? Math.round(km) : Number(km.toFixed(1))) + ' km';
  }
  if (m.display === 'duration') {
    const totalMin = m.unit === 'min' ? value : value / 60;
    if (totalMin >= 60) {
      const h = totalMin / 60;
      return (h >= 10 ? Math.round(h) : Number(h.toFixed(1))) + 'h';
    }
    return Math.round(totalMin) + 'm';
  }
  if (value >= 1000000) return Number((value / 1000000).toFixed(1)) + 'M';
  if (value >= 1000) return Math.round(value / 1000) + 'k';
  if (m.decimals != null) return value.toFixed(m.decimals);
  return String(Math.round(value));
}

if (typeof module !== 'undefined') {
  module.exports = { METRICS, METRIC_ORDER, metricIds, visibleMetricIds,
                     aggregate, formatMetric, formatMetricAxis,
                     HR_BANDS, hrBandFor, hrBandLabel };
}
