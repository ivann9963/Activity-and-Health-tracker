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

// A heart-rate sample records a reading, not a span: Apple stores an instant and
// leaves the duration implied by the gap to the next reading. So each sample's time
// is the distance to the one after it, capped — beyond a few minutes the wearable
// was not on a wrist and the gap is absence of data, not a long slow heartbeat.
const HR_GAP_CAP_MS = 5 * 60 * 1000;

class AppleCollector {
  constructor(opts) {
    const o = opts || {};
    this.collect = o.collect !== false;
    this.importBatch = o.importBatch || null;
    this.importedAt = o.importedAt || Date.now();

    this.sessions = [];
    this.buckets = new DailyBuckets();
    this.currentWorkout = null;
    this.lastHr = new Map();   // source label -> the previous reading, awaiting its span
    // One object per distinct source, shared by every record from it. Thousands of
    // identical {vendor, app, device} objects is pure overhead.
    this.sourceCache = new Map();
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

  _add(metric, localDate, source, value, agg, at) {
    if (!this.collect) return;
    this.buckets.add(metric, localDate, source, value, agg, at);
  }

  // Source objects are stored on every record, so their strings are interned: taken
  // straight from the parse buffer they would each keep a chunk of the export alive.
  _source(attrs) {
    const app = attrs.sourceName ? intern(attrs.sourceName) : null;
    const device = intern(deviceNameFrom(attrs.device) || normalizeSourceName(app));
    const key = (app || '') + '|' + device;
    let source = this.sourceCache.get(key);
    if (!source) {
      source = { vendor: 'apple', app, device };
      this.sourceCache.set(key, source);
    }
    return source;
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

    if (type === 'HKQuantityTypeIdentifierHeartRate') {
      this._heartRate(attrs, start, end, source, label);
      return;
    }

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

  // Time spent in each heart-rate band, accumulated per day.
  //
  // Readings are held back by one: a sample's duration only becomes known when the
  // next one arrives. Tracked per source, because an Apple Watch and a relayed Fitbit
  // interleave in the file and treating them as one stream would invent gaps.
  _heartRate(attrs, start, end, source, label) {
    const bpm = Number(attrs.value);
    const dateKey = localDateOf(start.ms, start.offsetMin);
    this._note('HKQuantityTypeIdentifierHeartRate', dateKey, label, attrs.unit);
    if (!isFinite(bpm) || bpm <= 0) return;

    const previous = this.lastHr.get(label);

    // Some sources write a real interval rather than an instant; trust it when given.
    const ownSpan = end && end.ms > start.ms ? Math.min(end.ms - start.ms, HR_GAP_CAP_MS) : 0;
    if (ownSpan > 0) {
      // Its duration is already known, so it must NOT stay pending — otherwise the
      // next reading credits it a second time via the gap rule below.
      this.lastHr.delete(label);
      if (this.collect) {
        this._add(hrBandMetric(hrBandFor(bpm)), dateKey, source, ownSpan / 1000, 'sum', start.ms);
      }
      return;
    }

    this.lastHr.set(label, { ms: start.ms, bpm, dateKey, offsetMin: start.offsetMin });
    if (!this.collect || !previous) return;
    const gap = start.ms - previous.ms;
    // Out-of-order records would otherwise contribute negative time.
    if (gap <= 0) return;
    this._add(hrBandMetric(hrBandFor(previous.bpm)), previous.dateKey, source,
              Math.min(gap, HR_GAP_CAP_MS) / 1000, 'sum', previous.ms);
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
      rawActivity: intern(attrs.workoutActivityType),
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
    return {
      sessions: this.sessions,
      daily: this.buckets.toRecords(this.importBatch, this.importedAt),
      tally: this.tally,
      meta: this.meta
    };
  }
}

// Run a full pass over an Apple export stream. `opts.collect === false` inspects only.
function scanAppleExport(stream, opts) {
  const collector = new AppleCollector(opts);
  const onProgress = opts && opts.onProgress;
  return scanXmlStream(stream, (n, a, k) => collector.onTag(n, a, k), onProgress)
    .then(bytes => ({ ...collector.finish(), bytes }));
}
