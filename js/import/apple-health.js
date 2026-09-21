// === APPLE HEALTH IMPORT ===
// Reads the `export.xml` produced by Health app → profile → Export All Health Data.
// This is the app's backbone: it carries the deep history, and since the Google Health
// iOS app now syncs two-way with Apple Health, it may also carry relayed Fitbit and
// Strava data — every source tagged with its own sourceName.
//
// The same collector serves two callers. The Inspector runs it with collect:false to
// tally what is in a file without importing anything; the importer runs it normally
// and gets canonical records out. One parse path means the report can never disagree
// with what the import actually does.

// Apple timestamps look like "2024-03-12 07:41:22 +0200". The offset matters: it is
// how we know which LOCAL day a record belongs to, regardless of where the browser
// doing the import happens to be.
const APPLE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?/;

function parseAppleDate(str) {
  const m = APPLE_DATE_RE.exec(String(str || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const offsetMin = sign ? (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60000;
  return { ms, offsetMin };
}

// Apple record types we store as daily figures. Everything else is still counted by
// the Inspector, but not persisted — the point is a small, fast database, not a
// mirror of HealthKit.
const APPLE_DAILY_METRICS = {
  HKQuantityTypeIdentifierStepCount:       { metric: 'steps',      agg: 'sum' },
  HKQuantityTypeIdentifierBodyMass:        { metric: 'weight',     agg: 'last', convert: 'mass' },
  HKQuantityTypeIdentifierRestingHeartRate:{ metric: 'resting_hr', agg: 'avg' }
};

// Sleep arrives as many short interval records with a stage in `value`. Only the
// genuinely-asleep stages count: InBed includes lying awake reading, and Awake is
// explicitly not sleep. Core/Deep/REM are disjoint stages, so summing them is correct.
const ASLEEP_VALUES = /AsleepUnspecified|AsleepCore|AsleepDeep|AsleepREM|^HKCategoryValueSleepAnalysisAsleep$/;

// Workout statistics types, mapped to the session field they populate.
const WORKOUT_STAT_FIELDS = {
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distanceM',
  HKQuantityTypeIdentifierDistanceCycling:        'distanceM',
  HKQuantityTypeIdentifierDistanceSwimming:       'distanceM',
  HKQuantityTypeIdentifierDistanceDownhillSnowSports: 'distanceM',
  HKQuantityTypeIdentifierActiveEnergyBurned:     'energyKcal',
  HKQuantityTypeIdentifierHeartRate:              'avgHr'
};

class AppleCollector {
  constructor(opts) {
    const o = opts || {};
    this.collect = o.collect !== false;
    this.importBatch = o.importBatch || null;
    this.importedAt = o.importedAt || Date.now();

    this.sessions = [];
    this.buckets = new Map();   // "metric|date|source" -> accumulator
    this.currentWorkout = null;
    this.meta = { exportDate: null, locale: null };
    this.tally = { records: 0, workouts: 0, types: Object.create(null),
                   sources: Object.create(null), from: null, to: null };
  }

  // --- tallying (drives the Inspector report) ------------------------------------
  _note(type, dateKey, sourceKey, unit) {
    let t = this.tally.types[type];
    if (!t) t = this.tally.types[type] = { count: 0, from: null, to: null,
                                           sources: Object.create(null), units: Object.create(null) };
    t.count++;
    if (dateKey) {
      if (!t.from || dateKey < t.from) t.from = dateKey;
      if (!t.to || dateKey > t.to) t.to = dateKey;
      if (!this.tally.from || dateKey < this.tally.from) this.tally.from = dateKey;
      if (!this.tally.to || dateKey > this.tally.to) this.tally.to = dateKey;
    }
    if (sourceKey) {
      t.sources[sourceKey] = (t.sources[sourceKey] || 0) + 1;
      this.tally.sources[sourceKey] = (this.tally.sources[sourceKey] || 0) + 1;
    }
    if (unit) t.units[unit] = (t.units[unit] || 0) + 1;
  }

  // --- daily accumulation --------------------------------------------------------
  // Values are folded in as they arrive rather than collected into arrays: a decade of
  // step samples is millions of numbers, and we only ever need their sum.
  _add(metric, localDate, source, value, agg, at) {
    if (!this.collect || value == null || !isFinite(value)) return;
    const key = metric + '|' + localDate + '|' + sourceLabel(source);
    let b = this.buckets.get(key);
    if (!b) {
      b = { metric, localDate, source, agg, sum: 0, count: 0, last: null, lastAt: -Infinity };
      this.buckets.set(key, b);
    }
    b.sum += value; b.count++;
    if (at >= b.lastAt) { b.last = value; b.lastAt = at; }
  }

  _source(attrs) {
    const app = attrs.sourceName || null;
    const device = deviceNameFrom(attrs.device) || normalizeSourceName(app);
    return { vendor: 'apple', app, device };
  }

  // --- tag dispatch ---------------------------------------------------------------
  onTag(name, attrs, kind) {
    if (kind === 'close') {
      if (name === 'Workout') this._endWorkout();
      return;
    }
    switch (name) {
      case 'ExportDate': this.meta.exportDate = attrs.value || null; break;
      case 'HealthData': this.meta.locale = attrs.locale || null; break;
      case 'Record': this._record(attrs); break;
      case 'Workout': this._startWorkout(attrs); if (kind === 'self') this._endWorkout(); break;
      case 'WorkoutStatistics': this._workoutStat(attrs); break;
      case 'ActivitySummary': this._note('ActivitySummary', attrs.dateComponents, null, null); break;
      default: break;
    }
  }

  _record(attrs) {
    const type = attrs.type;
    if (!type) return;
    this.tally.records++;
    const start = parseAppleDate(attrs.startDate);
    const end = parseAppleDate(attrs.endDate) || start;
    if (!start) { this._note(type, null, normalizeSourceName(attrs.sourceName), attrs.unit); return; }

    const source = this._source(attrs);
    const label = sourceLabel(source);

    if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
      // Attributed to the WAKE day: a night that starts Friday 23:30 and ends
      // Saturday 07:00 is Saturday's sleep, which is how anyone reading it thinks.
      const wakeDay = localDateOf(end.ms, end.offsetMin);
      this._note(type, wakeDay, label, attrs.value);
      if (ASLEEP_VALUES.test(attrs.value || '')) {
        this._add('sleep', wakeDay, source, (end.ms - start.ms) / 60000, 'sum', end.ms);
      }
      return;
    }

    const dateKey = localDateOf(start.ms, start.offsetMin);
    this._note(type, dateKey, label, attrs.unit);

    const spec = APPLE_DAILY_METRICS[type];
    if (!spec) return;
    let value = Number(attrs.value);
    if (spec.convert === 'mass') value = toKg(value, attrs.unit);
    this._add(spec.metric, dateKey, source, value, spec.agg, start.ms);
  }

  _startWorkout(attrs) {
    this.tally.workouts++;
    const start = parseAppleDate(attrs.startDate);
    const end = parseAppleDate(attrs.endDate);
    const source = this._source(attrs);
    this._note('Workout:' + (attrs.workoutActivityType || 'Unknown'),
               start ? localDateOf(start.ms, start.offsetMin) : null, sourceLabel(source), null);
    if (!start || !end) { this.currentWorkout = null; return; }

    this.currentWorkout = {
      rawActivity: attrs.workoutActivityType,
      activity: canonicalActivity('apple', attrs.workoutActivityType),
      start: start.ms, end: end.ms, tzOffset: start.offsetMin,
      durationSec: attrs.duration ? toSeconds(attrs.duration, attrs.durationUnit || 'min') : null,
      // Older exports put totals on the element itself; newer ones use nested
      // <WorkoutStatistics>. Both appear in a long-lived archive, so read both.
      distanceM: attrs.totalDistance ? toMetres(attrs.totalDistance, attrs.totalDistanceUnit) : null,
      energyKcal: attrs.totalEnergyBurned ? toKcal(attrs.totalEnergyBurned, attrs.totalEnergyBurnedUnit) : null,
      avgHr: null,
      source,
      importBatch: this.importBatch,
      importedAt: this.importedAt
    };
  }

  _workoutStat(attrs) {
    const w = this.currentWorkout;
    if (!w) return;
    const field = WORKOUT_STAT_FIELDS[attrs.type];
    if (!field) return;
    if (field === 'avgHr') {
      const v = Number(attrs.average);
      if (isFinite(v)) w.avgHr = Math.round(v);
      return;
    }
    if (attrs.sum == null) return;
    const v = field === 'distanceM' ? toMetres(attrs.sum, attrs.unit) : toKcal(attrs.sum, attrs.unit);
    // Nested statistics are authoritative when both forms are present.
    if (v != null) w[field] = v;
  }

  _endWorkout() {
    const w = this.currentWorkout;
    this.currentWorkout = null;
    if (!w || !this.collect) return;
    this.sessions.push(makeSession(w));
  }

  // --- output ---------------------------------------------------------------------
  finish() {
    const daily = [];
    for (const b of this.buckets.values()) {
      const value = b.agg === 'sum' ? b.sum
                  : b.agg === 'avg' ? b.sum / b.count
                  : b.last;
      if (value == null || !isFinite(value)) continue;
      daily.push(makeDaily({ metric: b.metric, localDate: b.localDate, value,
                             source: b.source, importBatch: this.importBatch,
                             importedAt: this.importedAt }));
    }
    return { sessions: this.sessions, daily, tally: this.tally, meta: this.meta };
  }
}

// Run a full pass over an Apple export stream. `opts.collect === false` inspects only.
function scanAppleExport(stream, opts) {
  const collector = new AppleCollector(opts);
  const onProgress = opts && opts.onProgress;
  return scanXmlStream(stream, (n, a, k) => collector.onTag(n, a, k), onProgress)
    .then(bytes => ({ ...collector.finish(), bytes }));
}
