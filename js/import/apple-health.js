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

// Which workout was happening at this instant, if any? Windows are sorted and
// non-overlapping, so this is a binary search rather than a scan — heart-rate samples
// are the most numerous record in an export and a linear check per sample would
// dominate the whole import.
function windowAt(windows, ms) {
  let lo = 0, hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid];
    if (ms < w[0]) hi = mid - 1;
    else if (ms > w[1]) lo = mid + 1;
    else return w;
  }
  return null;
}

function insideWindow(windows, ms) { return windowAt(windows, ms) != null; }

// Sessions become sorted, non-overlapping intervals, each still naming the workout it
// came from — banded time is credited to a session, not just to a day, so that hiding
// an activity hides its heart rate too.
//
// Overlaps have to be resolved rather than merged, because a merged interval cannot
// say whose it is. Two cases look alike and are not: two sources' copies of the same
// run (either answer is right, they dedupe later), and a half-hour run logged inside a
// two-hour walk (only one answer is right). The shorter workout wins the overlapping
// stretch, which settles both — the specific beats the containing.
function windowsFromSessions(sessions, padSec) {
  const pad = (padSec == null ? 60 : padSec) * 1000;
  const spans = sessions
    .filter(s => s.start != null && s.end != null && s.end > s.start)
    .map(s => ({ from: s.start - pad, to: s.end + pad, id: s.id,
                 length: s.end - s.start }));
  if (!spans.length) return [];

  // A sweep line: at every point where the set of workouts in progress changes, the
  // shortest one in progress owns the stretch until the next change.
  const events = [];
  for (const sp of spans) {
    events.push({ at: sp.from, open: true, span: sp });
    events.push({ at: sp.to, open: false, span: sp });
  }
  // Closes before opens at the same instant, so a workout ending where another begins
  // does not briefly look like an overlap.
  events.sort((a, b) => a.at - b.at || (a.open ? 1 : 0) - (b.open ? 1 : 0));

  const painted = [];
  const active = [];
  let at = events[0].at;

  for (const ev of events) {
    if (ev.at > at && active.length) {
      // Whoever is shortest owns [at, ev.at]. Ties go to the earlier start so the
      // result does not depend on the order sessions happened to be collected in.
      let owner = active[0];
      for (const sp of active) {
        if (sp.length < owner.length ||
            (sp.length === owner.length && sp.from < owner.from)) owner = sp;
      }
      const last = painted[painted.length - 1];
      // Consecutive stretches with the same owner are one interval; without this a
      // workout overlapped in the middle would come back as three.
      if (last && last[2] === owner.id && last[1] >= at) last[1] = ev.at;
      else painted.push([at, ev.at, owner.id]);
    }
    at = ev.at;
    if (ev.open) active.push(ev.span);
    else {
      const i = active.indexOf(ev.span);
      if (i !== -1) active.splice(i, 1);
    }
  }
  return painted;
}

class AppleCollector {
  constructor(opts) {
    const o = opts || {};
    this.collect = o.collect !== false;
    // Pass one of two: only workouts are read, to learn when they happened. An Apple
    // export lists records before workouts, so a single pass cannot know whether a
    // heart-rate sample falls inside one.
    this.windowsOnly = !!o.windowsOnly;
    // Pass two: heart rate is banded only inside these. Without them, a day's bands
    // are dominated by sitting still — thousands of hours below 100bpm that say
    // nothing about training.
    this.workoutWindows = o.workoutWindows || null;
    this.importBatch = o.importBatch || null;
    this.importedAt = o.importedAt || Date.now();

    this.sessions = [];
    // sessionId -> { bandFloor: seconds }. Banded time belongs to the workout it was
    // recorded during, not to the day: a day holding a run and a gym session has two
    // different efforts in it, and only the session knows which is which.
    this.sessionBands = new Map();
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
    if (this.windowsOnly) return;
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

  // Time spent in each heart-rate band, credited to the workout it happened during.
  //
  // Readings are held back by one: a sample's duration only becomes known when the
  // next one arrives. Tracked per source, because an Apple Watch and a relayed Fitbit
  // interleave in the file and treating them as one stream would invent gaps.
  _heartRate(attrs, start, end, source, label) {
    const bpm = Number(attrs.value);
    const dateKey = localDateOf(start.ms, start.offsetMin);
    this._note('HKQuantityTypeIdentifierHeartRate', dateKey, label, attrs.unit);
    if (!isFinite(bpm) || bpm <= 0) return;

    // Only heart rate recorded during a workout counts. Everything else is sitting,
    // sleeping and standing about, which swamps the bands and answers no question
    // anyone asked of a training log.
    const window = this.workoutWindows ? windowAt(this.workoutWindows, start.ms) : null;
    if (this.workoutWindows && !window) {
      this.lastHr.delete(label);
      return;
    }
    const owner = window ? window[2] : null;

    const previous = this.lastHr.get(label);

    // Some sources write a real interval rather than an instant; trust it when given.
    const ownSpan = end && end.ms > start.ms ? Math.min(end.ms - start.ms, HR_GAP_CAP_MS) : 0;
    if (ownSpan > 0) {
      // Its duration is already known, so it must NOT stay pending — otherwise the
      // next reading credits it a second time via the gap rule below.
      this.lastHr.delete(label);
      if (this.collect) this._band(owner, bpm, ownSpan / 1000);
      return;
    }

    this.lastHr.set(label, { ms: start.ms, bpm, owner });
    if (!this.collect || !previous) return;
    // Only a gap between two readings of the SAME workout is time that was measured.
    // Across a boundary it is not: the next reading might be an hour and a different
    // sport later, and crediting the difference would invent the end of a session
    // rather than report it. The last reading of a workout therefore contributes
    // nothing, which at a few seconds' sampling costs a few seconds.
    if (previous.owner !== owner) return;
    const gap = start.ms - previous.ms;
    // Out-of-order records would otherwise contribute negative time.
    if (gap <= 0) return;
    this._band(previous.owner, previous.bpm, Math.min(gap, HR_GAP_CAP_MS) / 1000);
  }

  _band(sessionId, bpm, seconds) {
    if (!sessionId || !(seconds > 0)) return;
    const bands = this.sessionBands.get(sessionId) || {};
    const floor = hrBandFor(bpm);
    bands[floor] = (bands[floor] || 0) + seconds;
    this.sessionBands.set(sessionId, bands);
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
    for (const session of this.sessions) {
      const bands = this.sessionBands.get(session.id);
      if (bands) session.hrBands = bands;
    }
    return {
      sessions: this.sessions,
      daily: this.buckets.toRecords(this.importBatch, this.importedAt),
      tally: this.tally,
      meta: this.meta
    };
  }
}

// The workout windows in an export, read on their own. Cheap: every Record is
// skipped, so this is a fraction of the cost of a full parse.
function scanAppleWorkoutWindows(stream, opts) {
  const o = opts || {};
  const collector = new AppleCollector({ ...o, collect: true, windowsOnly: true });
  return scanXmlStream(stream, (n, a, k) => collector.onTag(n, a, k), o.onProgress)
    .then(() => windowsFromSessions(collector.finish().sessions, o.padSec));
}

// Run a full pass over an Apple export stream. `opts.collect === false` inspects only.
function scanAppleExport(stream, opts) {
  const collector = new AppleCollector(opts);
  const onProgress = opts && opts.onProgress;
  return scanXmlStream(stream, (n, a, k) => collector.onTag(n, a, k), onProgress)
    .then(bytes => ({ ...collector.finish(), bytes }));
}
